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
    env: buildEnv(envMeta),
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
