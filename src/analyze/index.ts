/**
 * @fileoverview Analysis orchestrator.
 *
 * Discovers the project, works out which files still need reading, hands those to the
 * language plugins, wraps the results in the containment tree (app → modules → files →
 * functions/types), and produces a complete Atlas. This is the only place that knows
 * the whole pipeline.
 */
import type {
  Atlas,
  AtlasEdge,
  AtlasNode,
  AtlasStats,
  EndpointMeta,
  SignInCall,
  Zone,
} from '../model/types.js';
import { classifyOpenDoors, isAuthRelevant, tallyOpenDoors } from '../model/exposure.js';
import { authProviderForPackage } from './boundaries/catalog.js';
import { countStaleDocs } from '../model/staleness.js';
import { FORMAT_VERSION, makeAppId, makeEdgeId } from '../model/types.js';
import { appendAll } from '../util/append.js';
import { hashParts } from '../util/hash.js';
import { classifyArchetype } from './archetype.js';
import { buildBoundaryGraph } from './boundaries/build.js';
import { buildExportDoors } from './boundaries/exports.js';
import type { BoundaryFinding } from './boundaries/types.js';
import { AnalysisCache, fingerprintProject } from './cache.js';
import { buildModuleTree } from './modules.js';
import { buildSchemaNodes, buildSqlSchemaNodes } from './schema.js';
import type { FileSlice, LanguagePlugin } from './plugin.js';
import { discoverProject } from './project.js';
import type { ProjectInfo } from './project.js';
import { genericPlugins } from './generic/index.js';
import { pythonPlugin } from './py/index.js';
import { typescriptPlugin } from './ts/index.js';
import { dominantZone } from './zones.js';

/**
 * What this build of App Atlas calls itself, and the answer to two questions that are
 * easy to mistake for bookkeeping.
 *
 * It is mixed into the incremental cache's fingerprint, so raising it throws away every
 * cached finding — which is the point. A cache entry records what *an analyzer* saw, not
 * what the file says, and a reader that has learned to recognise a new shape disagrees
 * with the one that filled the cache.
 *
 * It also decides whether the last run counts as a baseline for `diffAtlas`. Leaving it
 * behind is worse than untidy: a stale atlas gets accepted as comparable, and every door
 * the newer reader can see for the first time is reported as a door that appeared since
 * yesterday. Going from 0.6.0 to 0.7.0 moved gitea from 757 doors to 1,053, so that is
 * three hundred routes announced as new to somebody who changed nothing.
 *
 * Raise it whenever the analyzer's answers change, not only when its interface does.
 */
export const TOOL_VERSION = '0.7.0';

export interface AnalyzeOptions {
  maxFiles?: number;
  /**
   * Extra glob patterns to leave out, on top of the usual build output and
   * dependencies. Example apps and vendored code belong here: they are real files, but
   * they are not *this* app, and counting their routes in this app's auth coverage
   * makes the one number that matters wrong.
   */
  ignore?: string[];
  followReferences?: boolean;
  /** Run the boundary detectors (SPEC.md 5.3). On by default. */
  detectBoundaries?: boolean;
  /**
   * What to do with the per-file cache in `.app-atlas`:
   *   `use`     — reuse unchanged files, then record this run (the default)
   *   `refresh` — read everything again, then record this run
   *   `off`     — do not read it and do not write it, leaving the project untouched
   */
  cache?: 'use' | 'refresh' | 'off';
  /**
   * The directory the caller asked about, when `rootDir` is one app chosen from inside
   * it. Defaults to `rootDir`.
   *
   * App Atlas lands a large repo on its main app (#34), which is a readability decision
   * about the *code* — and a deployment file describes the whole stack from the top of
   * the repo, so narrowing the code must not narrow that too. Nothing above this
   * directory is ever read, so naming a sub-directory on the command line still means
   * exactly what it says.
   */
  repoRoot?: string;
  onProgress?: (stage: string, done: number, total: number) => void;
}

export interface AnalyzeResult {
  atlas: Atlas;
  project: ProjectInfo;
}

/**
 * Order matters. The two deep tiers claim their files first and the tree-sitter tier
 * takes what is left, so adding a grammar can never quietly downgrade a language that
 * already had a compiler reading it.
 */
const PLUGINS: LanguagePlugin[] = [typescriptPlugin, pythonPlugin, ...genericPlugins];

export async function analyzeProject(rootDir: string, options: AnalyzeOptions = {}): Promise<AnalyzeResult> {
  const started = Date.now();
  const maxFiles = options.maxFiles ?? 5000;
  const followReferences = options.followReferences ?? true;
  const detectBoundaries = options.detectBoundaries ?? true;
  const pluginOptions = { followReferences, detectBoundaries };

  options.onProgress?.('Finding source files', 0, 1);
  const project = await discoverProject(rootDir, {
    maxFiles,
    extraIgnores: options.ignore,
    repoRoot: options.repoRoot,
  });
  options.onProgress?.('Finding source files', 1, 1);

  // --- what can be skipped ---
  // Opened before any parsing so the plugins can be handed their reusable results.
  // A cache that cannot be opened or read is simply an empty one: worst case is a full
  // analysis, which is what every first run does anyway. `off` writes nothing at all,
  // so calling this as a library never leaves a directory behind in someone's project.
  const caching = options.cache ?? 'use';
  const cache =
    caching === 'off'
      ? null
      : AnalysisCache.open(rootDir, fingerprintProject(project, TOOL_VERSION, pluginOptions));
  if (cache && caching === 'refresh') cache.clear();
  const plan = cache?.plan(project.files) ?? null;

  const warnings = [...project.warnings];
  const nodes: AtlasNode[] = [];
  const edges: AtlasEdge[] = [];
  const languages = new Set<string>();

  const appId = makeAppId(project.name);
  const appNode: AtlasNode = {
    id: appId,
    kind: 'app',
    name: project.name,
    label: null,
    parentId: null,
    language: null,
    path: '',
    startLine: null,
    endLine: null,
    zone: 'unknown',
    summary: null,
    summarySource: null,
    docHash: null,
    bodyHash: null,
    hash: hashParts('app', project.name, String(project.files.length)),
    provenance: 'static',
    meta: {
      root: project.root,
      frameworks: project.frameworks,
      workspaces: project.workspaces,
    },
  };
  nodes.push(appNode);

  // --- language plugins ---
  const findings: BoundaryFinding[] = [];
  const slices: FileSlice[] = [];
  let reused = 0;
  let analyzed = 0;
  for (const plugin of PLUGINS) {
    const claimed = project.files.filter((file) => plugin.claims(file));
    if (claimed.length === 0) continue;
    languages.add(plugin.id);
    const result = await plugin.analyze({
      project,
      files: claimed,
      options: pluginOptions,
      reuse: plan?.reusable,
      hashes: plan?.hashes,
      onProgress: options.onProgress,
    });
    appendAll(nodes, result.nodes);
    appendAll(edges, result.edges);
    appendAll(findings, result.boundaries);
    appendAll(warnings, result.warnings);
    appendAll(slices, result.slices ?? []);
    reused += result.reused ?? 0;
    analyzed += claimed.length - (result.reused ?? 0);
  }

  if (cache) {
    try {
      cache.save(slices, new Set(project.files.map((file) => file.relPath)));
    } catch (err) {
      warnings.push(`Could not save the analysis cache: ${(err as Error).message}`);
    } finally {
      cache.close();
    }
  }

  // --- the database schema ---
  // Read before the containment tree is built, because the schema file has to be in
  // the folder tree like any other file for its tables to have somewhere to live.
  const schema = buildSchemaNodes(project.signals.prisma);
  appendAll(nodes, schema.nodes);
  appendAll(edges, schema.edges);
  const sqlSchema = buildSqlSchemaNodes(project.signals.sqlSchema, project.signals.prisma);
  appendAll(nodes, sqlSchema.nodes);
  appendAll(edges, sqlSchema.edges);

  // --- boundaries ---
  // Merged once across every language, so a Python route and a TypeScript route land
  // in the same list rather than two parallel ones.
  if (detectBoundaries) {
    const boundary = buildBoundaryGraph({
      findings,
      appId,
      signals: project.signals,
      knownNodeIds: new Set(nodes.map((n) => n.id)),
      // What the compiler already resolved about who mentions whom, so a guard written
      // in a helper can be followed back to the handler that runs it.
      references: edges.filter((edge) => edge.kind === 'references'),
      nodeNames: new Map(nodes.map((node) => [node.id, node.name])),
    });
    appendAll(nodes, boundary.nodes);
    appendAll(edges, boundary.edges);
  }

  // --- what kind of project this is ---
  // Here and not earlier: the doors the detectors just found are the strongest signal
  // available, and here and not later because one archetype changes what gets built
  // next. A library's boundary is its public API surface, so its exported names become
  // doors — on an app that would turn every helper into one and say nothing.
  const archetype = classifyArchetype({ project, nodes });
  if (detectBoundaries && archetype.archetype === 'library') {
    const surface = buildExportDoors({ nodes, appId });
    appendAll(nodes, surface.nodes);
    appendAll(edges, surface.edges);
  }

  // --- containment tree ---
  options.onProgress?.('Building the map', 0, 1);
  const treeFiles = project.files.map((f) => ({ relPath: f.relPath, zone: f.zone as Zone }));
  if (schema.filePath) treeFiles.push({ relPath: schema.filePath, zone: 'data' });
  for (const relPath of sqlSchema.filePaths) treeFiles.push({ relPath, zone: 'data' });
  const { modules, parentForFile } = buildModuleTree(treeFiles, appId);
  appendAll(nodes, modules);

  for (const node of nodes) {
    if (node.kind !== 'file' || !node.path) continue;
    node.parentId = parentForFile.get(node.path) ?? appId;
  }

  assignModuleZones(nodes);

  for (const node of nodes) {
    if (!node.parentId) continue;
    edges.push({
      id: makeEdgeId('contains', node.parentId, node.id),
      kind: 'contains',
      fromId: node.parentId,
      toId: node.id,
      weight: 1,
      confidence: 'certain',
      provenance: 'static',
      meta: {},
    });
  }

  // Drop edges that point at nodes we never created (e.g. a file that failed to parse).
  const known = new Set(nodes.map((n) => n.id));
  const liveEdges = edges.filter((e) => known.has(e.fromId) && known.has(e.toId));

  // Which files bring an auth library in. Stamped here, where the catalog lives, so
  // that `src/model` can read a plain field instead of importing the analyzer — and so
  // the fact survives into `atlas.json` for anything reading it later. Kept separate
  // from the service boxes on purpose: `next-auth` runs inside the app and is not a
  // company anybody sends data to, but it is still what makes a wildcard route the
  // door people sign in through.
  for (const node of nodes) {
    if (node.kind !== 'file') continue;
    const imports = node.meta.externalImports;
    if (!Array.isArray(imports)) continue;
    for (const pkg of imports) {
      const provider = typeof pkg === 'string' ? authProviderForPackage(pkg) : null;
      if (provider) {
        node.meta.authPackage = provider;
        break;
      }
    }
  }

  const byId = new Map(nodes.map((node) => [node.id, node]));
  stampSignInCalls(findings, liveEdges, byId);

  // Why each unchecked door is unchecked, written onto the door. Every screen that
  // badges an endpoint then reads one field instead of re-deriving its own answer,
  // which is how the card, the card's group and the summary line stay in agreement.
  for (const [id, verdict] of classifyOpenDoors(nodes, liveEdges)) {
    const node = byId.get(id);
    if (node) node.meta.open = verdict;
  }

  options.onProgress?.('Building the map', 1, 1);

  const atlas: Atlas = {
    meta: {
      formatVersion: FORMAT_VERSION,
      toolVersion: TOOL_VERSION,
      root: project.root,
      name: project.name,
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      languages: [...languages],
      frameworks: project.frameworks,
      archetype,
      stats: computeStats(nodes, liveEdges),
      incremental: { reused, analyzed },
      warnings,
    },
    nodes: nodes.sort((a, b) => a.id.localeCompare(b.id)),
    edges: liveEdges.sort((a, b) => a.id.localeCompare(b.id)),
  };

  return { atlas, project };
}

/**
 * Writes "this door's handler calls the auth library's own sign-in" onto the doors it
 * is true of.
 *
 * Same shape as the `authPackage` stamp above and for the same two reasons: `src/model`
 * must not import a detector, and a fact written onto the node survives into
 * `atlas.json` for anything reading it afterwards. What the fact *means* for the
 * headline is decided in `model/exposure.ts`; this only carries it across the layer.
 *
 * The detectors report where a call was seen, never which door it answers, because the
 * file being read has no idea. `exposed-by` is the edge that knows: it points from a
 * door to the code behind it, so a sign-in call and a handler match only when they are
 * literally the same function.
 *
 * Only a function counts. A call at the top of a file would otherwise excuse every door
 * that file declares, which is the file-wide guess this rule was written to avoid — one
 * sign-out button in a module of twenty actions is not a reason to stop reporting the
 * other nineteen.
 */
function stampSignInCalls(
  findings: BoundaryFinding[],
  edges: AtlasEdge[],
  byId: Map<string, AtlasNode>,
): void {
  const byHandler = new Map<string, SignInCall>();
  for (const finding of findings) {
    if (finding.type !== 'sign-in-call') continue;
    if (byId.get(finding.nodeId)?.kind !== 'function') continue;
    byHandler.set(finding.nodeId, {
      provider: finding.provider,
      what: finding.what,
      call: finding.call,
    });
  }
  if (byHandler.size === 0) return;

  for (const edge of edges) {
    if (edge.kind !== 'exposed-by') continue;
    const call = byHandler.get(edge.toId);
    if (!call) continue;
    const door = byId.get(edge.fromId);
    if (door?.kind === 'endpoint') (door.meta as unknown as EndpointMeta).signInCall = call;
  }
}

/**
 * A folder's zone is the zone of what is inside it — so `src/components` reads as UI
 * without anyone hard-coding that folder name.
 */
function assignModuleZones(nodes: AtlasNode[]): void {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const childIds = new Map<string, string[]>();
  for (const node of nodes) {
    if (!node.parentId) continue;
    const list = childIds.get(node.parentId);
    if (list) list.push(node.id);
    else childIds.set(node.parentId, [node.id]);
  }

  const resolve = (id: string, seen: Set<string>): Zone[] => {
    if (seen.has(id)) return [];
    seen.add(id);
    const node = byId.get(id);
    if (!node) return [];
    if (node.kind === 'file') return [node.zone];
    const zones: Zone[] = [];
    for (const childId of childIds.get(id) ?? []) zones.push(...resolve(childId, seen));
    if (node.kind === 'module') node.zone = dominantZone(zones);
    return zones;
  };

  for (const node of nodes) {
    if (node.kind === 'app') resolve(node.id, new Set());
  }
  // Any module not reachable from the app (shouldn't happen) still gets a zone.
  for (const node of nodes) {
    if (node.kind === 'module' && node.zone === 'unknown') {
      node.zone = dominantZone(resolve(node.id, new Set()));
    }
  }
}

/**
 * Exported because the words layer runs after analysis and changes some of these
 * numbers — descriptions get written, stale docstrings get flagged — and one
 * definition of "how many" is better than two that can disagree.
 */
export function computeStats(nodes: AtlasNode[], edges: AtlasEdge[]): AtlasStats {
  let files = 0;
  let functions = 0;
  let types = 0;
  let modules = 0;
  let linesOfCode = 0;
  let documentedFiles = 0;
  let documentedFunctions = 0;
  let aiSummaries = 0;
  let aiFiles = 0;
  let endpoints = 0;
  let routes = 0;
  let unreadFiles = 0;
  let services = 0;
  let externalServices = 0;
  let stores = 0;
  let envVars = 0;

  for (const node of nodes) {
    if (node.summarySource === 'ai') aiSummaries++;
    switch (node.kind) {
      case 'file':
        files++;
        linesOfCode += Number(node.meta.loc ?? 0);
        if (node.meta.unread) unreadFiles++;
        if (node.summarySource === 'docs') documentedFiles++;
        else if (node.summarySource === 'ai') aiFiles++;
        break;
      case 'function':
        functions++;
        if (node.summarySource === 'docs') documentedFunctions++;
        break;
      case 'type':
        types++;
        break;
      case 'module':
        modules++;
        break;
      case 'endpoint': {
        endpoints++;
        const meta = node.meta as unknown as EndpointMeta;
        if (meta.endpointKind === 'env') envVars += meta.vars?.length ?? 0;
        if (isAuthRelevant(meta)) routes++;
        break;
      }
      case 'service':
        services++;
        if (node.meta.external !== false) externalServices++;
        break;
      case 'store':
        stores++;
        break;
      default:
        break;
    }
  }

  let imports = 0;
  let references = 0;
  for (const edge of edges) {
    if (edge.kind === 'imports') imports++;
    else if (edge.kind === 'references') references++;
  }

  // "No check found" is three different statements wearing one number. Splitting them
  // here rather than at each screen is what stops the CLI, the walkthrough and the
  // security page from quoting three different totals (#24, #36).
  const open = tallyOpenDoors(classifyOpenDoors(nodes, edges).values());

  return {
    files,
    functions,
    types,
    modules,
    imports,
    references,
    linesOfCode,
    documentedFiles,
    documentedFunctions,
    staleDocs: countStaleDocs(nodes),
    aiSummaries,
    aiFiles,
    endpoints,
    routes,
    unprotectedRoutes: open.worthALook,
    publicRoutes: open.page + open.authMount,
    unreadableRoutes: open.unreadable,
    unreadFiles,
    services,
    externalServices,
    stores,
    envVars,
  };
}

// The rule itself lives beside the classification it belongs to, so the denominator and
// the numerator can never be computed from two different ideas of what a route is.
export { isAuthRelevant } from '../model/exposure.js';
