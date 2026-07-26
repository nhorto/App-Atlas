/**
 * @fileoverview Findings in, atlas nodes and edges out.
 *
 * Detectors report what they saw, file by file, with no idea what any other file
 * contains. This is where those reports become the app's boundary: forty Stripe call
 * sites collapse into one Stripe box, a middleware matcher in `middleware.ts` reaches
 * across the project to lock a route declared somewhere else, and everything hangs
 * off two containers so the architecture map stays walkable.
 *
 * The rule this file exists to enforce: a route is only reported as protected when
 * something actually protects it, and how sure we are travels with the claim.
 */
import type {
  AtlasEdge,
  AtlasNode,
  CodeSite,
  Confidence,
  EndpointKind,
  EndpointMeta,
  EnvVarInfo,
  GuardInfo,
  ServiceCategory,
  ServiceMeta,
  StoreKind,
  StoreMeta,
  Zone,
} from '../../model/types.js';
import {
  INBOUND_ID,
  OUTBOUND_ID,
  makeEdgeId,
  makeEndpointId,
  makeFileId,
  makeServiceId,
  makeStoreId,
  makeTypeId,
} from '../../model/types.js';
import { hashParts } from '../../util/hash.js';
import { isCatchAllMatcher, matcherMatches } from './auth.js';
import type { BoundaryFinding, EndpointFinding, GuardFinding } from './types.js';
import type { ProjectSignals } from '../signals.js';

export interface BoundaryGraph {
  nodes: AtlasNode[];
  edges: AtlasEdge[];
}

export interface BuildInput {
  findings: BoundaryFinding[];
  appId: string;
  signals: ProjectSignals;
  /** Every file node id that exists, so we never point an edge at a ghost. */
  knownNodeIds: Set<string>;
}

/** Names that look like a credential rather than a setting. */
const SECRET_PATTERN = /(secret|token|key|password|passwd|credential|private|dsn|auth|salt|signature|webhook)/i;

/**
 * Prefixes a build tool inlines into the client bundle on purpose. A variable named
 * this way is shipped to every browser that loads the app, so whatever else it is, it
 * is not a secret — `NEXT_PUBLIC_SUPABASE_ANON_KEY` matches SECRET_PATTERN on "key"
 * but is published by design.
 *
 * Badging those as secrets is not a harmless over-warning: a list where most rows are
 * false teaches the reader to skim past the one row that is real.
 */
const PUBLIC_ENV_PREFIX =
  /^(NEXT_PUBLIC_|EXPO_PUBLIC_|VITE_|REACT_APP_|GATSBY_|NUXT_PUBLIC_|VUE_APP_|STORYBOOK_|PUBLIC_)/;

/** Whether a variable name should be treated as holding a credential. */
function isSecretName(name: string): boolean {
  if (PUBLIC_ENV_PREFIX.test(name)) return false;
  return SECRET_PATTERN.test(name);
}

export function buildBoundaryGraph(input: BuildInput): BoundaryGraph {
  const nodes: AtlasNode[] = [];
  const edges: AtlasEdge[] = [];

  const endpoints = collectEndpoints(input);
  const guards = input.findings.filter((f): f is GuardFinding => f.type === 'guard');
  applyWebhookPromotion(endpoints, input.findings);
  applyGuards(endpoints, guards);

  const envEndpoint = collectEnv(input);
  if (envEndpoint) endpoints.set(envEndpoint.id, envEndpoint);

  const services = collectServices(input);
  const stores = collectStores(input);

  if (endpoints.size > 0) nodes.push(container(INBOUND_ID, 'Ways in', 'in', endpoints.size, input.appId));
  if (services.size + stores.size > 0) {
    nodes.push(container(OUTBOUND_ID, 'Where data goes', 'out', services.size + stores.size, input.appId));
  }

  for (const endpoint of endpoints.values()) {
    nodes.push(endpointNode(endpoint));
    addEdges(edges, endpointEdges(endpoint, input.knownNodeIds));
  }
  for (const service of services.values()) {
    nodes.push(serviceNode(service));
    addEdges(edges, flowEdges(service.id, service.meta.sites, service.writes, input.knownNodeIds));
  }
  // Every table a schema file declares already has a proper card, columns and all.
  // Queries naming a declared table still count: their edges are pointed at the
  // declared card, so "used in N places" stays true instead of resetting to zero the
  // day a migration finally writes the table down.
  const declaredTableIds = new Map<string, string>();
  const prisma = input.signals.prisma;
  if (prisma) for (const model of prisma.models) declaredTableIds.set(model.toLowerCase(), makeTypeId(prisma.path, model));
  for (const table of input.signals.sqlSchema?.tables ?? []) {
    if (!declaredTableIds.has(table.name.toLowerCase())) {
      declaredTableIds.set(table.name.toLowerCase(), makeTypeId(table.path, table.name));
    }
  }

  for (const store of stores.values()) {
    nodes.push(storeNode(store));
    addEdges(edges, storeEdges(store, input.knownNodeIds));

    // Tables the code names in its queries — `.from('cellar_bottles')`, an INSERT —
    // are the user's actual data even when no schema file is in the repo, which for
    // a Supabase app is the normal case. Each becomes a shape the data view can
    // draw. Columns are unknowable from here, so the card says so instead of lying.
    if (store.meta.storeKind !== 'sql' && store.meta.storeKind !== 'nosql') continue;
    for (const [table, sites] of store.tableSites) {
      const declaredId = declaredTableIds.get(table.toLowerCase());
      const tableId = declaredId ?? makeTypeId(store.id, table);
      if (!declaredId) nodes.push(observedTableNode(store, table, sites));
      addEdges(
        edges,
        flowEdges(tableId, sites, false, input.knownNodeIds).map((edge) => ({
          ...edge,
          kind: 'references' as const,
        })),
      );
    }
  }

  return { nodes, edges };
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

interface MergedEndpoint {
  id: string;
  kind: EndpointKind;
  name: string;
  meta: EndpointMeta;
  /** Atlas nodes that answer this door. */
  handlerIds: Set<string>;
}

function collectEndpoints(input: BuildInput): Map<string, MergedEndpoint> {
  const merged = new Map<string, MergedEndpoint>();

  const add = (finding: EndpointFinding) => {
    const id = makeEndpointId(finding.endpointKind, finding.key);
    const existing = merged.get(id);
    if (existing) {
      existing.meta.sites.push(finding.site);
      existing.meta.writes = existing.meta.writes || finding.writes;
      for (const guard of finding.guards) existing.meta.guards.push(guard);
      if (finding.handlerId) existing.handlerIds.add(finding.handlerId);
      return;
    }
    merged.set(id, {
      id,
      kind: finding.endpointKind,
      name: finding.name,
      meta: {
        endpointKind: finding.endpointKind,
        method: finding.method,
        route: finding.route,
        framework: finding.framework,
        guards: [...finding.guards],
        writes: finding.writes,
        sites: [finding.site],
      },
      handlerIds: new Set(finding.handlerId ? [finding.handlerId] : []),
    });
  };

  for (const finding of input.findings) {
    if (finding.type === 'endpoint') add(finding);
  }

  // Crons declared in `vercel.json` never appear in the source at all. When one points
  // at a route we already found, the two are the same door — the schedule is simply
  // the reason it gets knocked on, so fold it in rather than listing it twice.
  for (const cron of input.signals.crons) {
    const site: CodeSite = {
      path: cron.source,
      line: 1,
      nodeId: null,
      snippet: `${cron.schedule} → ${cron.route}`,
    };
    const target = [...merged.values()].find(
      (endpoint) => endpoint.kind === 'http-route' && endpoint.meta.route === cron.route,
    );
    if (target) {
      target.kind = 'cron';
      target.meta.endpointKind = 'cron';
      target.meta.method = 'CRON';
      target.meta.framework = 'Vercel Cron';
      target.meta.schedule = cron.schedule;
      target.meta.writes = true;
      target.name = `${cron.route}`;
      target.meta.sites.push(site);
      continue;
    }
    add({
      type: 'endpoint',
      endpointKind: 'cron',
      key: `cron ${cron.schedule} ${cron.route}`,
      name: `${cron.route}`,
      method: 'CRON',
      route: cron.route,
      framework: 'Vercel Cron',
      writes: true,
      guards: [],
      site,
      handlerId: null,
    });
  }

  return merged;
}

/**
 * A file that verifies a signature is handling a webhook, whatever its route is
 * called. Promoting it matters because a webhook is never "unprotected" in the same
 * sense as a public route — the signature *is* the lock.
 */
function applyWebhookPromotion(endpoints: Map<string, MergedEndpoint>, findings: BoundaryFinding[]): void {
  const verifiedFiles = new Map<string, string>();
  for (const finding of findings) {
    if (finding.type === 'webhook') verifiedFiles.set(finding.site.path, finding.provider);
  }

  for (const endpoint of endpoints.values()) {
    if (endpoint.kind !== 'http-route') continue;
    const route = endpoint.meta.route ?? '';
    const byPath = /webhook|\/hooks?(\/|$)/i.test(route);
    const provider = endpoint.meta.sites
      .map((site) => verifiedFiles.get(site.path))
      .find((value): value is string => Boolean(value));

    if (!provider && !byPath) continue;
    endpoint.kind = 'webhook';
    endpoint.meta.endpointKind = 'webhook';
    if (provider) {
      endpoint.meta.guards.push({
        name: `${provider} signature check`,
        how: 'call',
        provider,
        path: endpoint.meta.sites[0]?.path ?? null,
        line: null,
        confidence: 'certain',
      });
    }
  }
}

/**
 * Attaches guards found elsewhere in the project.
 *
 * The precision rule: a check inside one handler says nothing about the handler next
 * to it, so a function-scoped guard only counts when it is *that* handler's. When we
 * never resolved a precise handler (a page component, say), a guard anywhere in the
 * file counts — but only as `likely`.
 */
function applyGuards(endpoints: Map<string, MergedEndpoint>, guards: GuardFinding[]): void {
  const byFile = new Map<string, GuardFinding[]>();
  const matchers: GuardFinding[] = [];

  for (const guard of guards) {
    if (guard.scope === 'matcher') {
      matchers.push(guard);
      continue;
    }
    const file = guard.guard.path;
    if (!file) continue;
    const list = byFile.get(file);
    if (list) list.push(guard);
    else byFile.set(file, [guard]);
  }

  for (const endpoint of endpoints.values()) {
    for (const site of endpoint.meta.sites) {
      for (const guard of byFile.get(site.path) ?? []) {
        const confidence = guardConfidence(endpoint, guard);
        if (!confidence) continue;
        pushGuard(endpoint, { ...guard.guard, confidence });
      }
    }

    const route = endpoint.meta.route;
    if (!route || !route.startsWith('/')) continue;
    for (const guard of matchers) {
      const hit = guard.matchers.some(
        (matcher) => matcherMatches(matcher, route) || isCatchAllMatcher(matcher),
      );
      if (hit) pushGuard(endpoint, { ...guard.guard, confidence: 'likely' });
    }
  }
}

function guardConfidence(endpoint: MergedEndpoint, guard: GuardFinding): Confidence | null {
  if (guard.nodeId && endpoint.handlerIds.has(guard.nodeId)) return 'certain';
  // A module-scope check runs for everything the file declares.
  if (guard.nodeId?.startsWith('file:')) return 'likely';
  // We never pinned down a specific handler, so anything in the file may well guard it.
  if ([...endpoint.handlerIds].every((id) => id.startsWith('file:'))) return 'likely';
  return null;
}

function pushGuard(endpoint: MergedEndpoint, guard: GuardInfo): void {
  const already = endpoint.meta.guards.find((g) => g.name === guard.name && g.path === guard.path);
  if (already) {
    if (already.confidence === 'likely' && guard.confidence === 'certain') already.confidence = 'certain';
    return;
  }
  endpoint.meta.guards.push(guard);
}

// ---------------------------------------------------------------------------
// Environment variables
// ---------------------------------------------------------------------------

/**
 * Every env read in the project becomes one door, not one per variable — otherwise a
 * normal app buries its twelve real entry points under forty config boxes. The
 * variables themselves live in the node's metadata and drive the secrets badge.
 */
function collectEnv(input: BuildInput): MergedEndpoint | null {
  const byName = new Map<string, CodeSite[]>();
  for (const finding of input.findings) {
    if (finding.type !== 'env') continue;
    const list = byName.get(finding.name);
    if (list) list.push(finding.site);
    else byName.set(finding.name, [finding.site]);
  }
  if (byName.size === 0) return null;

  const vars: EnvVarInfo[] = [...byName.entries()]
    .map(([name, sites]) => ({
      name,
      sites: sites.sort(compareSites),
      documented: input.signals.envExample.has(name),
      secret: isSecretName(name),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const sites = vars.flatMap((v) => v.sites);
  return {
    id: makeEndpointId('env', 'config'),
    kind: 'env',
    name: 'Environment & config',
    meta: {
      endpointKind: 'env',
      method: 'ENV',
      route: null,
      framework: 'Node',
      guards: [],
      writes: false,
      sites,
      vars,
      envExample: input.signals.envExamplePath,
    },
    handlerIds: new Set(sites.map((site) => makeFileId(site.path))),
  };
}

// ---------------------------------------------------------------------------
// Services and stores
// ---------------------------------------------------------------------------

interface MergedService {
  id: string;
  name: string;
  meta: ServiceMeta;
  writes: boolean;
}

function collectServices(input: BuildInput): Map<string, MergedService> {
  const merged = new Map<string, MergedService>();

  for (const finding of input.findings) {
    if (finding.type !== 'service') continue;
    const id = makeServiceId(finding.name);
    const existing = merged.get(id);
    if (existing) {
      existing.meta.sites.push(finding.site);
      existing.writes = existing.writes || finding.writes;
      if (finding.package && !existing.meta.packages.includes(finding.package)) {
        existing.meta.packages.push(finding.package);
      }
      if (finding.host && !existing.meta.hosts.includes(finding.host)) existing.meta.hosts.push(finding.host);
      // A catalogued category beats the `other` a bare hostname gets.
      if (existing.meta.category === 'other' && finding.category !== 'other') {
        existing.meta.category = finding.category;
      }
      continue;
    }
    merged.set(id, {
      id,
      name: finding.name,
      writes: finding.writes,
      meta: {
        category: finding.category,
        packages: finding.package ? [finding.package] : [],
        hosts: finding.host ? [finding.host] : [],
        sites: [finding.site],
        external: finding.external,
      },
    });
  }

  return merged;
}

interface MergedStore {
  id: string;
  name: string;
  meta: StoreMeta;
  /** Kept apart so a function that only reads never gets a "writes to" arrow. */
  readSites: CodeSite[];
  writeSites: CodeSite[];
  /** Which call sites named which table, so each table can become a shape of its own. */
  tableSites: Map<string, CodeSite[]>;
}

function collectStores(input: BuildInput): Map<string, MergedStore> {
  const merged = new Map<string, MergedStore>();

  const noteTable = (store: MergedStore, table: string | null, site: CodeSite) => {
    if (!table) return;
    const sites = store.tableSites.get(table);
    if (sites) sites.push(site);
    else store.tableSites.set(table, [site]);
  };

  for (const finding of input.findings) {
    if (finding.type !== 'store') continue;
    const id = makeStoreId(finding.key);
    const existing = merged.get(id);
    if (existing) {
      existing.meta.sites.push(finding.site);
      if (finding.operation === 'read') {
        existing.meta.reads++;
        existing.readSites.push(finding.site);
      } else {
        existing.meta.writes++;
        existing.writeSites.push(finding.site);
      }
      if (finding.table && !existing.meta.tables.includes(finding.table)) existing.meta.tables.push(finding.table);
      noteTable(existing, finding.table, finding.site);
      continue;
    }
    const store: MergedStore = {
      id,
      name: finding.name,
      readSites: finding.operation === 'read' ? [finding.site] : [],
      writeSites: finding.operation === 'write' ? [finding.site] : [],
      tableSites: new Map(),
      meta: {
        storeKind: finding.storeKind,
        client: finding.client,
        tables: finding.table ? [finding.table] : [],
        reads: finding.operation === 'read' ? 1 : 0,
        writes: finding.operation === 'write' ? 1 : 0,
        sites: [finding.site],
      },
    };
    noteTable(store, finding.table, finding.site);
    merged.set(id, store);
  }

  // A Prisma schema lists every table, including ones no code has touched yet.
  const prisma = merged.get(makeStoreId('prisma'));
  if (prisma && input.signals.prisma) {
    for (const model of input.signals.prisma.models) {
      if (!prisma.meta.tables.includes(model)) prisma.meta.tables.push(model);
    }
  }

  for (const store of merged.values()) store.meta.tables.sort();
  return merged;
}

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

function container(id: string, name: string, direction: 'in' | 'out', count: number, appId: string): AtlasNode {
  return {
    id,
    kind: 'zone',
    name,
    label: null,
    parentId: appId,
    language: null,
    path: null,
    startLine: null,
    endLine: null,
    zone: direction === 'in' ? 'api' : 'data',
    summary: null,
    summarySource: null,
    docHash: null,
    bodyHash: null,
    hash: hashParts('boundary', id, String(count)),
    provenance: 'static',
    meta: { direction, endpointCount: count },
  };
}

const ENDPOINT_ZONES: Record<EndpointKind, Zone> = {
  'http-route': 'api',
  'server-action': 'api',
  webhook: 'api',
  cron: 'api',
  queue: 'api',
  realtime: 'api',
  cli: 'config',
  env: 'config',
  'file-read': 'data',
};

function endpointNode(endpoint: MergedEndpoint): AtlasNode {
  const first = endpoint.meta.sites[0];
  return {
    id: endpoint.id,
    kind: 'endpoint',
    name: endpoint.name,
    label: null,
    parentId: INBOUND_ID,
    language: null,
    path: first?.path ?? null,
    startLine: first?.line ?? null,
    endLine: null,
    zone: ENDPOINT_ZONES[endpoint.kind] ?? 'api',
    summary: null,
    summarySource: null,
    docHash: null,
    bodyHash: null,
    hash: hashParts('endpoint', endpoint.id, String(endpoint.meta.sites.length)),
    provenance: 'static',
    meta: { ...endpoint.meta } as unknown as Record<string, unknown>,
  };
}

function serviceNode(service: MergedService): AtlasNode {
  return {
    id: service.id,
    kind: 'service',
    name: service.name,
    label: null,
    parentId: OUTBOUND_ID,
    language: null,
    path: null,
    startLine: null,
    endLine: null,
    zone: 'api',
    summary: null,
    summarySource: null,
    docHash: null,
    bodyHash: null,
    hash: hashParts('service', service.id, String(service.meta.sites.length)),
    provenance: 'static',
    meta: { ...service.meta } as unknown as Record<string, unknown>,
  };
}

const STORE_ZONES: Record<StoreKind, Zone> = {
  sql: 'data',
  nosql: 'data',
  kv: 'data',
  blob: 'data',
  filesystem: 'data',
  unknown: 'data',
};

/**
 * A table the code queries by name, with no schema file to read columns from. It
 * hangs under its store, so drilling into the database shows what lives there.
 */
function observedTableNode(store: MergedStore, table: string, sites: CodeSite[]): AtlasNode {
  const first = sites[0];
  return {
    id: makeTypeId(store.id, table),
    kind: 'type',
    name: table,
    label: null,
    parentId: store.id,
    language: null,
    path: first?.path ?? null,
    startLine: first?.line ?? null,
    endLine: null,
    zone: 'data',
    summary: null,
    summarySource: null,
    docHash: null,
    bodyHash: null,
    hash: hashParts('observed-table', store.id, table, String(sites.length)),
    provenance: 'static',
    meta: {
      typeKind: 'table',
      fields: [],
      isExported: true,
      extends: [],
      provider: store.meta.client,
      /** Named in queries, never declared — the card explains its missing columns. */
      observed: true,
    },
  };
}

function storeNode(store: MergedStore): AtlasNode {
  return {
    id: store.id,
    kind: 'store',
    name: store.name,
    label: null,
    parentId: OUTBOUND_ID,
    language: null,
    path: null,
    startLine: null,
    endLine: null,
    zone: STORE_ZONES[store.meta.storeKind],
    summary: null,
    summarySource: null,
    docHash: null,
    bodyHash: null,
    hash: hashParts('store', store.id, String(store.meta.sites.length)),
    provenance: 'static',
    meta: { ...store.meta } as unknown as Record<string, unknown>,
  };
}

// ---------------------------------------------------------------------------
// Edges
// ---------------------------------------------------------------------------

interface EdgeInput {
  kind: AtlasEdge['kind'];
  fromId: string;
  toId: string;
  weight: number;
  confidence: Confidence;
  meta?: Record<string, unknown>;
}

function endpointEdges(endpoint: MergedEndpoint, known: Set<string>): EdgeInput[] {
  const out: EdgeInput[] = [];

  for (const handlerId of endpoint.handlerIds) {
    if (!known.has(handlerId)) continue;
    out.push({
      kind: 'exposed-by',
      fromId: endpoint.id,
      toId: handlerId,
      weight: 1,
      confidence: 'certain',
    });
  }

  // Two guards can live in the same file — a platform default plus an auth call
  // inside the handler — and an edge id is (kind, from, to), so they must merge
  // into one edge rather than crash the unique index.
  const byGuardFile = new Map<string, EdgeInput>();
  for (const guard of endpoint.meta.guards) {
    if (!guard.path) continue;
    const guardId = makeFileId(guard.path);
    if (!known.has(guardId) || guardId === endpoint.id) continue;
    const existing = byGuardFile.get(guardId);
    if (existing) {
      existing.weight++;
      if (guard.confidence === 'certain') existing.confidence = 'certain';
      continue;
    }
    byGuardFile.set(guardId, {
      kind: 'protected-by',
      fromId: endpoint.id,
      toId: guardId,
      weight: 1,
      confidence: guard.confidence,
      meta: { guard: guard.name, provider: guard.provider },
    });
  }
  out.push(...byGuardFile.values());

  return out;
}

function flowEdges(targetId: string, sites: CodeSite[], writes: boolean, known: Set<string>): EdgeInput[] {
  const counts = new Map<string, number>();
  for (const site of sites) {
    const from = site.nodeId ?? makeFileId(site.path);
    if (!known.has(from)) continue;
    counts.set(from, (counts.get(from) ?? 0) + 1);
  }
  return [...counts.entries()].map(([fromId, weight]) => ({
    kind: writes ? ('writes-to' as const) : ('reads-from' as const),
    fromId,
    toId: targetId,
    weight,
    confidence: 'likely' as Confidence,
  }));
}

/**
 * A store gets both kinds of edge, because the difference is the interesting part —
 * but each call site only produces the one it actually performed.
 */
function storeEdges(store: MergedStore, known: Set<string>): EdgeInput[] {
  return [
    ...flowEdges(store.id, store.readSites, false, known),
    ...flowEdges(store.id, store.writeSites, true, known),
  ];
}

function addEdges(edges: AtlasEdge[], inputs: EdgeInput[]): void {
  for (const input of inputs) {
    edges.push({
      id: makeEdgeId(input.kind, input.fromId, input.toId),
      kind: input.kind,
      fromId: input.fromId,
      toId: input.toId,
      weight: input.weight,
      confidence: input.confidence,
      provenance: 'static',
      meta: input.meta ?? {},
    });
  }
}

function compareSites(a: CodeSite, b: CodeSite): number {
  return a.path.localeCompare(b.path) || a.line - b.line;
}

export { SECRET_PATTERN };
