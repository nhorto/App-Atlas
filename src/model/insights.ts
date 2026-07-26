/**
 * @fileoverview Security insight badges (SPEC.md 6.6).
 *
 * Three questions, all answered from static facts rather than judgement:
 *   - which of my doors is anything checking, and which is nothing checking?
 *   - which companies does my app send data to?
 *   - which environment variables do I read, and did I write them down anywhere?
 *
 * The provenance rule matters here more than anywhere else in the product: nothing on
 * this page is generated or inferred by a model. Where certainty runs out — an
 * approximated middleware matcher, a guard found in the file but not in the handler —
 * the answer is `likely`, and the UI says so rather than rounding up to "safe".
 */
import type {
  AtlasNode,
  CodeSite,
  EndpointKind,
  EndpointMeta,
  EnvVarInfo,
  GuardInfo,
  ServiceMeta,
  StoreMeta,
  TypeMeta,
} from './types.js';
import type { AtlasGraph } from './graph.js';

/** How sure we are that something is checking who is calling. */
export type Protection = 'protected' | 'likely' | 'open';

export interface RouteInsight {
  id: string;
  name: string;
  method: string | null;
  route: string | null;
  endpointKind: EndpointKind;
  framework: string;
  /** The handler writes data — an open door here is worth more attention. */
  writes: boolean;
  protection: Protection;
  guards: GuardInfo[];
  sites: CodeSite[];
}

export interface ServiceInsight {
  id: string;
  name: string;
  category: string;
  /** Package names and hostnames — the evidence, not a guess. */
  evidence: string[];
  callSites: number;
  /** True when the app sends data out rather than only reading. */
  sends: boolean;
  sites: CodeSite[];
}

export interface StoreInsight {
  id: string;
  name: string;
  client: string;
  storeKind: string;
  tables: string[];
  reads: number;
  writes: number;
}

export interface EnvInsight extends EnvVarInfo {}

/**
 * One table, and what the migrations say protects its rows.
 *
 * `rls: null` is *unknown*, not "off" — a table created in a dashboard may be fully
 * protected by policies no migration ever recorded. Claiming it was open would be
 * the badge equivalent of rounding up.
 */
export interface TableProtectionInsight {
  /** The type node, so the panel can reveal it. */
  id: string;
  name: string;
  /** Whether a schema source declared it, or the code's queries merely named it. */
  declared: boolean;
  rls: {
    enabled: boolean;
    policyCount: number;
    /** Distinct commands the policies cover: `select`, `insert`… */
    commands: string[];
  } | null;
  path: string | null;
  line: number | null;
}

export interface InsightsView {
  auth: {
    total: number;
    protectedCount: number;
    likelyCount: number;
    openCount: number;
    /** Open doors that write data, first. */
    routes: RouteInsight[];
  };
  services: ServiceInsight[];
  stores: StoreInsight[];
  /** Row-level security per table, when SQL migrations are there to read. */
  tables: {
    total: number;
    /** Declared with row security off — the row that deserves the reader's eye. */
    unprotected: number;
    /** RLS enabled but not one policy: every request is denied. Usually a mistake. */
    locked: number;
    unknown: number;
    list: TableProtectionInsight[];
  };
  env: {
    exampleFile: string | null;
    total: number;
    undocumented: EnvInsight[];
    vars: EnvInsight[];
  };
}

/** Doors a stranger on the internet can knock on. Crons and queues are not. */
const AUTH_RELEVANT: EndpointKind[] = ['http-route', 'server-action', 'realtime'];

export function buildInsights(graph: AtlasGraph): InsightsView {
  const endpoints = graph.nodesOfKind('endpoint');

  const routes: RouteInsight[] = [];
  let envMeta: EndpointMeta | null = null;

  for (const node of endpoints) {
    const meta = node.meta as unknown as EndpointMeta;
    if (meta.endpointKind === 'env') {
      envMeta = meta;
      continue;
    }
    if (!AUTH_RELEVANT.includes(meta.endpointKind)) continue;

    routes.push({
      id: node.id,
      name: node.name,
      method: meta.method,
      route: meta.route,
      endpointKind: meta.endpointKind,
      framework: meta.framework,
      writes: meta.writes,
      protection: protectionOf(meta.guards),
      guards: meta.guards,
      sites: meta.sites,
    });
  }

  routes.sort(byUrgency);

  return {
    auth: {
      total: routes.length,
      protectedCount: routes.filter((route) => route.protection === 'protected').length,
      likelyCount: routes.filter((route) => route.protection === 'likely').length,
      openCount: routes.filter((route) => route.protection === 'open').length,
      routes,
    },
    services: buildServices(graph),
    stores: buildStores(graph),
    tables: buildTableProtection(graph),
    env: buildEnv(envMeta),
  };
}

/**
 * Row-level security, table by table. On a Supabase-style app the browser talks to
 * Postgres directly with a published key, so RLS is not a database detail — it is
 * the auth model, and a table without it is an open route by another name.
 */
function buildTableProtection(graph: AtlasGraph): InsightsView['tables'] {
  const list: TableProtectionInsight[] = [];
  for (const node of graph.nodesOfKind('type')) {
    const meta = node.meta as unknown as TypeMeta;
    if (meta.typeKind !== 'table') continue;
    const rls = meta.rls
      ? {
          enabled: meta.rls.enabled,
          policyCount: meta.rls.policies.length,
          commands: [...new Set(meta.rls.policies.map((policy) => policy.command))],
        }
      : null;
    list.push({
      id: node.id,
      name: node.name,
      declared: meta.observed !== true,
      rls,
      path: node.path,
      line: node.startLine,
    });
  }

  // Problems first: no row security, then locked-out tables, then the unknowns.
  const rank = (table: TableProtectionInsight) =>
    table.rls === null ? 2 : !table.rls.enabled ? 0 : table.rls.policyCount === 0 ? 1 : 3;
  list.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));

  return {
    total: list.length,
    unprotected: list.filter((table) => rank(table) === 0).length,
    locked: list.filter((table) => rank(table) === 1).length,
    unknown: list.filter((table) => table.rls === null).length,
    list,
  };
}

function protectionOf(guards: GuardInfo[]): Protection {
  if (guards.length === 0) return 'open';
  return guards.some((guard) => guard.confidence === 'certain') ? 'protected' : 'likely';
}

/**
 * An open door that writes data comes first, then open doors, then the rest. This is
 * the order someone should read the list in, so it is the order we return it in.
 */
function byUrgency(a: RouteInsight, b: RouteInsight): number {
  const rank = (route: RouteInsight): number => {
    if (route.protection === 'open' && route.writes) return 0;
    if (route.protection === 'open') return 1;
    if (route.protection === 'likely') return 2;
    return 3;
  };
  return rank(a) - rank(b) || (a.route ?? a.name).localeCompare(b.route ?? b.name);
}

function buildServices(graph: AtlasGraph): ServiceInsight[] {
  return graph
    .nodesOfKind('service')
    .map((node) => {
      const meta = node.meta as unknown as ServiceMeta;
      const sends = graph.edgesTo(node.id).some((edge) => edge.kind === 'writes-to');
      return {
        id: node.id,
        name: node.name,
        category: meta.category,
        evidence: [...meta.packages, ...meta.hosts],
        callSites: meta.sites.length,
        sends,
        sites: meta.sites,
      };
    })
    .sort((a, b) => b.callSites - a.callSites || a.name.localeCompare(b.name));
}

function buildStores(graph: AtlasGraph): StoreInsight[] {
  return graph
    .nodesOfKind('store')
    .map((node) => {
      const meta = node.meta as unknown as StoreMeta;
      return {
        id: node.id,
        name: node.name,
        client: meta.client,
        storeKind: meta.storeKind,
        tables: meta.tables,
        reads: meta.reads,
        writes: meta.writes,
      };
    })
    .sort((a, b) => b.reads + b.writes - (a.reads + a.writes));
}

function buildEnv(meta: EndpointMeta | null): InsightsView['env'] {
  const vars = meta?.vars ?? [];
  return {
    exampleFile: meta?.envExample ?? null,
    total: vars.length,
    // Secrets first: a missing `.env.example` entry for an API key is a different
    // problem from a missing entry for a feature flag.
    undocumented: vars
      .filter((entry) => !entry.documented)
      .sort((a, b) => Number(b.secret) - Number(a.secret) || a.name.localeCompare(b.name)),
    vars,
  };
}

export type { AtlasNode };
