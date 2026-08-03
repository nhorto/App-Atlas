/**
 * @fileoverview Analysis orchestrator.
 *
 * Discovers the project, works out which files still need reading, hands those to the
 * language plugins, wraps the results in the containment tree (app → modules → files →
 * functions/types), and produces a complete Atlas. This is the only place that knows
 * the whole pipeline.
 */
import path from 'node:path';
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
import { declaredEntryFor, frameworkOwnerOf } from './owned.js';
import { buildSchemaNodes, buildSqlSchemaNodes } from './schema.js';
import type { FileSlice, LanguagePlugin } from './plugin.js';
import { discoverProject } from './project.js';
import { markRetiredFiles } from './retired.js';
import { buildMarkupNodes, readMarkupFiles } from './markup.js';
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
 *
 * It is also the provenance line in every generated `ATLAS.md`, which is a file people
 * commit — so it is kept level with `package.json` even when a release changes nothing
 * the analyzer sees, as 0.10.0 did. A build that stamps somebody else's version number
 * into a checked-in file is making a false claim about where that file came from, and
 * that costs more than the one stated absence in "what changed" that the bump buys.
 *
 * 0.11.0 is the ordinary case: a table that reported "columns unknown" now carries the
 * columns its ORM model declares, so a cache written by 0.10.0 answers a different
 * question about the same file.
 *
 * 0.12.0 is the other case, like 0.10.0 before it. The analyzer sees exactly what it saw
 * — the change is in how the words layer groups those findings before describing them, and
 * that layer has its own `PROMPT_VERSION` to invalidate what it cached. This number moves
 * anyway, to stay level with `package.json` for the sake of the line stamped into ATLAS.md.
 *
 * 0.12.1 is the same case once more, and the smallest one yet: the run report stopped
 * calling a detected store and a detected framework unfounded. Not one atlas fact differs,
 * and `PROMPT_VERSION` does not move either, because the question asked of the model is
 * unchanged — only what we do with the answer afterwards.
 *
 * 0.18.0 is the ordinary case: Rust joins the grammar tier (#85), so a repo with `.rs`
 * files in it now answers with files, functions, types, imports, Tauri command doors and
 * sqlx tables where it used to answer with nothing. A Rust-free repo's atlas is
 * unchanged; its cache is discarded anyway, because the version is part of the
 * fingerprint and a fingerprint that special-cased "probably unaffected" would be a
 * cache that can lie.
 */
export const TOOL_VERSION = '0.18.0';

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

  // --- code that says it is retired ---
  // Before the boundary is built and before anything is ranked or described, because
  // every one of those answers is about the live app and a file that opens with
  // "DEPRECATED — do not run as part of the pipeline" is not part of it (#87). Marked
  // in place: dropping it would hide a backstop somebody still runs by hand.
  const retiredCount = markRetiredFiles(nodes);

  // --- the database schema ---
  // Read before the containment tree is built, because the schema file has to be in
  // the folder tree like any other file for its tables to have somewhere to live.
  const schema = buildSchemaNodes(project.signals.prisma);
  appendAll(nodes, schema.nodes);
  appendAll(edges, schema.edges);
  const sqlSchema = buildSqlSchemaNodes(project.signals.sqlSchema, project.signals.prisma);
  appendAll(nodes, sqlSchema.nodes);
  appendAll(edges, sqlSchema.edges);

  // --- the markup a desktop app is made of ---
  // After the language plugins, because every edge it draws points at something they
  // declared — the `partial class` half of a window, and the methods its buttons call
  // (#103). Before the boundary is built, because a screen is a door.
  const markup = buildMarkupNodes(readMarkupFiles(project.root, project.markupFiles), nodes);
  appendAll(nodes, markup.nodes);
  appendAll(edges, markup.edges);
  appendAll(findings, markup.findings);

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
  for (const relPath of markup.filePaths) treeFiles.push({ relPath, zone: 'ui' });
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

  // Why a file nobody imports is nevertheless in use: a framework runs it, or a manifest
  // names it. Stamped here for the same two reasons the auth package above is — the model
  // layer must not import a detector, and the fact has to survive into `atlas.json`.
  for (const node of nodes) {
    if (node.kind !== 'file' || !node.path) continue;
    const owner = frameworkOwnerOf(node.path, project.signals);
    if (owner) node.meta.frameworkOwned = owner;
    const entry = declaredEntryFor(node.path, project.signals.entryPoints);
    if (entry) node.meta.declaredEntry = entry;
  }

  joinOrmModelsToTables(nodes);

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
      // Written down rather than inferred later, because every one of these facts is
      // gone by the time a second process reads the atlas — and a question answered by
      // *not finding* something needs to know whether anybody looked.
      coverage: {
        references: followReferences,
        wholeRepo: (options.repoRoot ? path.resolve(options.repoRoot) : project.root) === project.root,
        unreadFormats: project.unreadFormats,
      },
      // Counted here so every screen quotes the same number, and stated even when it
      // is zero-by-absence: a map that quietly leaves code out is the failure this
      // project exists to avoid (#87).
      retiredFiles: retiredCount,
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
/**
 * Give a table the columns its ORM model already declares (issue #80).
 *
 * A SQLAlchemy app arrives as two nodes for the same thing. The queries name a table, so
 * there is a table node with `observed: true` and no columns at all; the model class is a
 * separate `class` node that has every column on it. On mealie that meant 34 tables
 * reporting "columns unknown" while `email`, `password` and `full_name` sat in the atlas
 * a few nodes away — the type explorer drew a card with a name and no rows, and the
 * personal-data pass had nothing to look at.
 *
 * So this is a join, not a new reader. Nothing here parses anything; it matches a table
 * to a model and copies across what was already extracted.
 *
 * Matched on `__tablename__` first, because that is the class stating outright which
 * table it maps to, and on the class name second, because SQLAlchemy queries are written
 * `select(User)` and the table is recorded under the *class* name in that case. Both are
 * facts the code states. A model whose name matches nothing is left alone rather than
 * guessed at, and a table matching two models is left alone as well — the point of the
 * join is that it is unambiguous, and two candidates means it is not.
 */
function joinOrmModelsToTables(nodes: AtlasNode[]): void {
  // Two passes, and the order is the whole trick. A class that declares `__tablename__`
  // is an ORM model and says so; a class that merely shares its name is usually the
  // Pydantic schema sitting beside it. On mealie every model has such a twin, and
  // treating the two as equal candidates made almost every table ambiguous and left 16
  // of them with no columns at all. So the declaring class is preferred outright, and
  // only a collision *between two declaring classes* is treated as unresolvable.
  const models = new Map<string, AtlasNode | null>();
  const claim = (key: string, node: AtlasNode, declares: boolean) => {
    const lower = key.toLowerCase();
    if (!models.has(lower)) {
      models.set(lower, node);
      return;
    }
    // `null` marks a name two models answer to. Left unresolved on purpose: picking one
    // would put another model's columns on this table, which is worse than no columns.
    if (declares) models.set(lower, null);
  };

  const candidates: AtlasNode[] = [];
  for (const node of nodes) {
    if (node.kind !== 'type') continue;
    const meta = node.meta as { typeKind?: string; tableName?: string; fields?: unknown[] };
    if (meta.typeKind !== 'class' || !(meta.fields?.length)) continue;
    candidates.push(node);
  }

  // Classes that name the same table are not rival claims about different things — they
  // are partial views of one table, and the fullest one is the real model. A migration
  // declares a stub of the model it is about to alter: mealie's `RecipeModel` appears
  // five times, four of them Alembic stubs of three to five columns beside the actual
  // 49-column model. Refusing on the collision cost 15 tables their columns; taking the
  // most complete description of a table everyone agrees is the same table does not.
  const byTable = new Map<string, AtlasNode>();
  for (const node of candidates) {
    const tableName = (node.meta as { tableName?: string }).tableName;
    if (!tableName) continue;
    const key = tableName.toLowerCase();
    const held = byTable.get(key);
    if (!held || fieldCount(node) > fieldCount(held)) byTable.set(key, node);
  }

  for (const [tableName, node] of byTable) {
    claim(tableName, node, true);
    // The class name too, because a SQLAlchemy query is written `select(User)` and the
    // table gets recorded under the class name rather than the table's own.
    claim(node.name, node, true);
  }
  for (const node of candidates) {
    if ((node.meta as { tableName?: string }).tableName) continue;
    // Fills only the names no declaring model answered to, and never overwrites one.
    if (!models.has(node.name.toLowerCase())) models.set(node.name.toLowerCase(), node);
  }
  if (models.size === 0) return;

  for (const node of nodes) {
    const meta = node.meta as {
      typeKind?: string;
      observed?: boolean;
      fields?: unknown[];
      declaredBy?: string;
    };
    // Only a table nobody has declared. A table read out of a migration or a
    // `schema.prisma` already has the real thing, and the schema outranks the model.
    if (meta.typeKind !== 'table' || !meta.observed || (meta.fields?.length ?? 0) > 0) continue;

    const model = models.get(node.name.toLowerCase());
    if (!model) continue;

    const modelMeta = model.meta as { fields?: unknown[] };
    meta.fields = modelMeta.fields;
    // No longer named-in-queries-and-nowhere-else: the declaration was found, and the
    // card should stop saying the columns are unknowable.
    meta.observed = false;
    // Where the columns came from, so a reader can go and check rather than wonder why
    // a table in a database has Python type annotations on it.
    meta.declaredBy = model.path ?? model.name;
  }
}

/** How many columns a model declares — the measure of how complete a description it is. */
function fieldCount(node: AtlasNode): number {
  return ((node.meta as { fields?: unknown[] }).fields ?? []).length;
}

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
