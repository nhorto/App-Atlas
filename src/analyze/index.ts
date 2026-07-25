/**
 * @fileoverview Analysis orchestrator.
 *
 * Discovers the project, works out which files still need reading, hands those to the
 * language plugins, wraps the results in the containment tree (app → modules → files →
 * functions/types), and produces a complete Atlas. This is the only place that knows
 * the whole pipeline.
 */
import type { Atlas, AtlasEdge, AtlasNode, AtlasStats, EndpointMeta, Zone } from '../model/types.js';
import { countStaleDocs } from '../model/staleness.js';
import { FORMAT_VERSION, makeAppId, makeEdgeId } from '../model/types.js';
import { hashParts } from '../util/hash.js';
import { buildBoundaryGraph } from './boundaries/build.js';
import type { BoundaryFinding } from './boundaries/types.js';
import { AnalysisCache, fingerprintProject } from './cache.js';
import { buildModuleTree } from './modules.js';
import { buildSchemaNodes } from './schema.js';
import type { FileSlice, LanguagePlugin } from './plugin.js';
import { discoverProject } from './project.js';
import type { ProjectInfo } from './project.js';
import { pythonPlugin } from './py/index.js';
import { typescriptPlugin } from './ts/index.js';
import { dominantZone } from './zones.js';

export const TOOL_VERSION = '0.5.0';

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
  onProgress?: (stage: string, done: number, total: number) => void;
}

export interface AnalyzeResult {
  atlas: Atlas;
  project: ProjectInfo;
}

const PLUGINS: LanguagePlugin[] = [typescriptPlugin, pythonPlugin];

export async function analyzeProject(rootDir: string, options: AnalyzeOptions = {}): Promise<AnalyzeResult> {
  const started = Date.now();
  const maxFiles = options.maxFiles ?? 5000;
  const followReferences = options.followReferences ?? true;
  const detectBoundaries = options.detectBoundaries ?? true;
  const pluginOptions = { followReferences, detectBoundaries };

  options.onProgress?.('Finding source files', 0, 1);
  const project = await discoverProject(rootDir, { maxFiles, extraIgnores: options.ignore });
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
    nodes.push(...result.nodes);
    edges.push(...result.edges);
    findings.push(...result.boundaries);
    warnings.push(...result.warnings);
    slices.push(...(result.slices ?? []));
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
  nodes.push(...schema.nodes);
  edges.push(...schema.edges);

  // --- boundaries ---
  // Merged once across every language, so a Python route and a TypeScript route land
  // in the same list rather than two parallel ones.
  if (detectBoundaries) {
    const boundary = buildBoundaryGraph({
      findings,
      appId,
      signals: project.signals,
      knownNodeIds: new Set(nodes.map((n) => n.id)),
    });
    nodes.push(...boundary.nodes);
    edges.push(...boundary.edges);
  }

  // --- containment tree ---
  options.onProgress?.('Building the map', 0, 1);
  const treeFiles = project.files.map((f) => ({ relPath: f.relPath, zone: f.zone as Zone }));
  if (schema.filePath) treeFiles.push({ relPath: schema.filePath, zone: 'data' });
  const { modules, parentForFile } = buildModuleTree(treeFiles, appId);
  nodes.push(...modules);

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
  let unprotectedRoutes = 0;
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
        if (isAuthRelevant(meta)) {
          routes++;
          if (meta.guards.length === 0) unprotectedRoutes++;
        }
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
    unprotectedRoutes,
    services,
    externalServices,
    stores,
    envVars,
  };
}

/**
 * Auth coverage is measured over the doors a stranger can knock on. A cron job or a
 * queue worker is not reachable from the internet, so counting it as "unprotected"
 * would inflate the number that matters and teach people to ignore it.
 */
export function isAuthRelevant(meta: EndpointMeta): boolean {
  return (
    meta.endpointKind === 'http-route' ||
    meta.endpointKind === 'server-action' ||
    meta.endpointKind === 'realtime'
  );
}
