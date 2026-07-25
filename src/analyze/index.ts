/**
 * @fileoverview Analysis orchestrator.
 *
 * Discovers the project, hands its files to the language plugins, wraps the results
 * in the containment tree (app → modules → files → functions/types), and produces a
 * complete Atlas. This is the only place that knows the whole pipeline.
 */
import type { Atlas, AtlasEdge, AtlasNode, AtlasStats, EndpointMeta, Zone } from '../model/types.js';
import { FORMAT_VERSION, makeAppId, makeEdgeId } from '../model/types.js';
import { hashParts } from '../util/hash.js';
import { buildBoundaryGraph } from './boundaries/build.js';
import type { BoundaryFinding } from './boundaries/types.js';
import { buildModuleTree } from './modules.js';
import type { LanguagePlugin } from './plugin.js';
import { discoverProject } from './project.js';
import type { ProjectInfo } from './project.js';
import { typescriptPlugin } from './ts/index.js';
import { dominantZone } from './zones.js';

export const TOOL_VERSION = '0.2.0';

export interface AnalyzeOptions {
  maxFiles?: number;
  followReferences?: boolean;
  /** Run the boundary detectors (SPEC.md 5.3). On by default. */
  detectBoundaries?: boolean;
  onProgress?: (stage: string, done: number, total: number) => void;
}

export interface AnalyzeResult {
  atlas: Atlas;
  project: ProjectInfo;
}

const PLUGINS: LanguagePlugin[] = [typescriptPlugin];

export async function analyzeProject(rootDir: string, options: AnalyzeOptions = {}): Promise<AnalyzeResult> {
  const started = Date.now();
  const maxFiles = options.maxFiles ?? 5000;
  const followReferences = options.followReferences ?? true;
  const detectBoundaries = options.detectBoundaries ?? true;

  options.onProgress?.('Finding source files', 0, 1);
  const project = await discoverProject(rootDir, { maxFiles });
  options.onProgress?.('Finding source files', 1, 1);

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
  for (const plugin of PLUGINS) {
    const claimed = project.files.filter((file) => plugin.claims(file));
    if (claimed.length === 0) continue;
    languages.add(plugin.id);
    const result = await plugin.analyze({
      project,
      files: claimed,
      options: { followReferences, detectBoundaries },
      onProgress: options.onProgress,
    });
    nodes.push(...result.nodes);
    edges.push(...result.edges);
    findings.push(...result.boundaries);
    warnings.push(...result.warnings);
  }

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
  const { modules, parentForFile } = buildModuleTree(
    project.files.map((f) => ({ relPath: f.relPath, zone: f.zone })),
    appId,
  );
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

function computeStats(nodes: AtlasNode[], edges: AtlasEdge[]): AtlasStats {
  let files = 0;
  let functions = 0;
  let types = 0;
  let modules = 0;
  let linesOfCode = 0;
  let documentedFiles = 0;
  let documentedFunctions = 0;
  let endpoints = 0;
  let routes = 0;
  let unprotectedRoutes = 0;
  let services = 0;
  let externalServices = 0;
  let stores = 0;
  let envVars = 0;

  for (const node of nodes) {
    switch (node.kind) {
      case 'file':
        files++;
        linesOfCode += Number(node.meta.loc ?? 0);
        if (node.summarySource === 'docs') documentedFiles++;
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
