/**
 * @fileoverview The boundary view — inputs on the left, your app in the middle,
 * outputs on the right (SPEC.md 6.1).
 *
 * This is the home screen, and it answers the question the primary audience actually
 * asks: what are all the ways into my app, and where does my data go? The atlas
 * already holds every endpoint, service and store; the work here is *reduction* —
 * turning forty routes into one readable card, and turning the edges between code and
 * boundaries into bands whose thickness means something.
 *
 * Grouping is by family rather than by size, because "12 API routes" and "3 webhooks"
 * are two different kinds of door even when one of them is small.
 */
import type { AtlasNode, EndpointKind, EndpointMeta, ServiceMeta, StoreMeta, Zone } from './types.js';
import type { AtlasGraph } from './graph.js';

export interface BoundaryCard {
  id: string;
  name: string;
  /** One line under the name, in plain English. */
  detail: string;
  /** How many code paths this card stands for. */
  count: number;
  /** The atlas nodes it represents, so clicking it can open the real thing. */
  memberIds: string[];
  /** Set when every member is one node — the card *is* that node. */
  nodeId: string | null;
  /** Endpoint family or service category, for the icon and grouping. */
  family: string;
  /** Doors only: how many of them nothing is guarding. */
  openCount?: number;
}

export interface BoundaryZone {
  zone: Zone;
  label: string;
  files: number;
}

export interface BoundaryFlow {
  fromId: string;
  toId: string;
  weight: number;
}

export interface BoundaryView {
  appName: string;
  inputs: BoundaryCard[];
  zones: BoundaryZone[];
  outputs: BoundaryCard[];
  /** Left→centre and centre→right bands. Zone ids are `zone:<name>`. */
  flows: BoundaryFlow[];
  summary: {
    endpoints: number;
    openRoutes: number;
    externalServices: number;
    stores: number;
    envVars: number;
  };
}

/** Kept in this order on screen: how a request arrives, roughly. */
const INPUT_FAMILIES: { family: string; label: string; kinds: EndpointKind[]; pagesOnly?: boolean }[] = [
  { family: 'pages', label: 'Pages', kinds: ['http-route'], pagesOnly: true },
  { family: 'routes', label: 'API routes', kinds: ['http-route'] },
  { family: 'actions', label: 'Server actions', kinds: ['server-action'] },
  { family: 'webhooks', label: 'Webhooks', kinds: ['webhook'] },
  { family: 'cron', label: 'Scheduled jobs', kinds: ['cron'] },
  { family: 'queue', label: 'Background jobs', kinds: ['queue'] },
  { family: 'realtime', label: 'Realtime', kinds: ['realtime'] },
  { family: 'cli', label: 'Command line', kinds: ['cli'] },
  { family: 'env', label: 'Environment & config', kinds: ['env'] },
  { family: 'files', label: 'Files on disk', kinds: ['file-read'] },
];

const ZONE_ORDER: Zone[] = ['ui', 'api', 'logic', 'data', 'config', 'test', 'unknown'];

const ZONE_LABELS: Record<Zone, string> = {
  ui: 'Interface',
  api: 'API',
  logic: 'Logic',
  data: 'Data',
  config: 'Config',
  test: 'Tests',
  unknown: 'Other',
};

const MAX_OUTPUT_CARDS = 9;

export function buildBoundaryView(graph: AtlasGraph): BoundaryView {
  const endpoints = graph.nodesOfKind('endpoint');
  const services = graph.nodesOfKind('service');
  const stores = graph.nodesOfKind('store');

  const flows: BoundaryFlow[] = [];
  const zoneWeights = new Map<Zone, number>();

  const inputs = buildInputs(graph, endpoints, flows, zoneWeights);
  const outputs = buildOutputs(graph, services, stores, flows, zoneWeights);

  return {
    appName: graph.meta.name,
    inputs,
    zones: buildZones(graph, zoneWeights),
    outputs,
    flows,
    summary: {
      endpoints: endpoints.length,
      openRoutes: graph.meta.stats.unprotectedRoutes,
      externalServices: services.length,
      stores: stores.length,
      envVars: graph.meta.stats.envVars,
    },
  };
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

function buildInputs(
  graph: AtlasGraph,
  endpoints: AtlasNode[],
  flows: BoundaryFlow[],
  zoneWeights: Map<Zone, number>,
): BoundaryCard[] {
  const cards: BoundaryCard[] = [];

  for (const { family, label, kinds, pagesOnly } of INPUT_FAMILIES) {
    const members = endpoints.filter((node) => {
      const meta = node.meta as unknown as EndpointMeta;
      if (!kinds.includes(meta.endpointKind)) return false;
      const isPage = meta.method === 'PAGE';
      return pagesOnly ? isPage : !isPage;
    });
    if (members.length === 0) continue;

    let paths = 0;
    let open = 0;
    for (const node of members) {
      const meta = node.meta as unknown as EndpointMeta;
      paths += Math.max(1, meta.sites.length);
      if (meta.guards.length === 0) open++;

      // A door's flow lands in the zone of whatever code answers it.
      for (const edge of graph.edgesFrom(node.id)) {
        if (edge.kind !== 'exposed-by') continue;
        const zone = graph.getNodeById(edge.toId)?.zone;
        if (zone) addFlow(flows, zoneWeights, `input:${family}`, `zone:${zone}`, edge.weight);
      }
    }

    // Endpoints nobody could attribute to code (a cron declared only in vercel.json)
    // would otherwise be a card with no band leaving it.
    if (!flows.some((flow) => flow.fromId === `input:${family}`)) {
      addFlow(flows, zoneWeights, `input:${family}`, `zone:${members[0].zone}`, members.length);
    }

    cards.push({
      id: `input:${family}`,
      name: label,
      detail: inputDetail(family, members),
      count: paths,
      memberIds: members.map((node) => node.id),
      nodeId: members.length === 1 ? members[0].id : null,
      family,
      openCount: isAuthFamily(family) ? open : undefined,
    });
  }

  return cards;
}

function isAuthFamily(family: string): boolean {
  return family === 'pages' || family === 'routes' || family === 'actions' || family === 'realtime';
}

function inputDetail(family: string, members: AtlasNode[]): string {
  const count = members.length;
  if (family === 'env') {
    const vars = (members[0].meta as unknown as EndpointMeta).vars ?? [];
    return `${vars.length} ${vars.length === 1 ? 'variable' : 'variables'}`;
  }
  if (family === 'cli' || family === 'files') {
    const sites = (members[0].meta as unknown as EndpointMeta).sites.length;
    return `${sites} ${sites === 1 ? 'place' : 'places'}`;
  }
  const noun = INPUT_NOUNS[family] ?? 'entry point';
  return `${count} ${count === 1 ? noun : `${noun}s`}`;
}

const INPUT_NOUNS: Record<string, string> = {
  pages: 'page',
  routes: 'route',
  actions: 'action',
  webhooks: 'webhook',
  cron: 'scheduled job',
  queue: 'worker',
  realtime: 'subscription',
};

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

function buildOutputs(
  graph: AtlasGraph,
  services: AtlasNode[],
  stores: AtlasNode[],
  flows: BoundaryFlow[],
  zoneWeights: Map<Zone, number>,
): BoundaryCard[] {
  const candidates: { card: BoundaryCard; node: AtlasNode }[] = [];

  for (const node of stores) {
    const meta = node.meta as unknown as StoreMeta;
    candidates.push({
      node,
      card: {
        id: node.id,
        name: node.name,
        detail: storeDetail(meta),
        count: meta.sites.length,
        memberIds: [node.id],
        nodeId: node.id,
        family: 'store',
      },
    });
  }

  for (const node of services) {
    const meta = node.meta as unknown as ServiceMeta;
    candidates.push({
      node,
      card: {
        id: node.id,
        name: node.name,
        detail: serviceDetail(meta),
        count: meta.sites.length,
        memberIds: [node.id],
        nodeId: node.id,
        family: meta.category,
      },
    });
  }

  // Stores first, then whatever is used most — the database is almost always the
  // thing a person is looking for.
  candidates.sort((a, b) => {
    const byFamily = (a.card.family === 'store' ? 0 : 1) - (b.card.family === 'store' ? 0 : 1);
    if (byFamily !== 0) return byFamily;
    return b.card.count - a.card.count || a.card.name.localeCompare(b.card.name);
  });

  const shown = candidates.slice(0, MAX_OUTPUT_CARDS);
  const rest = candidates.slice(MAX_OUTPUT_CARDS);

  for (const { node, card } of shown) {
    for (const edge of graph.edgesTo(node.id)) {
      if (edge.kind !== 'reads-from' && edge.kind !== 'writes-to') continue;
      const zone = graph.getNodeById(edge.fromId)?.zone;
      if (zone) addFlow(flows, zoneWeights, `zone:${zone}`, card.id, edge.weight);
    }
  }

  const cards = shown.map((entry) => entry.card);

  if (rest.length > 0) {
    const id = 'output:other';
    for (const { node } of rest) {
      for (const edge of graph.edgesTo(node.id)) {
        if (edge.kind !== 'reads-from' && edge.kind !== 'writes-to') continue;
        const zone = graph.getNodeById(edge.fromId)?.zone;
        if (zone) addFlow(flows, zoneWeights, `zone:${zone}`, id, edge.weight);
      }
    }
    cards.push({
      id,
      name: `${rest.length} more`,
      detail: rest
        .slice(0, 4)
        .map((entry) => entry.card.name)
        .join(', '),
      count: rest.reduce((sum, entry) => sum + entry.card.count, 0),
      memberIds: rest.map((entry) => entry.node.id),
      nodeId: null,
      family: 'other',
    });
  }

  return cards;
}

function storeDetail(meta: StoreMeta): string {
  const parts = [meta.client];
  if (meta.tables.length > 0) {
    parts.push(`${meta.tables.length} ${meta.tables.length === 1 ? 'table' : 'tables'}`);
  }
  if (meta.writes > 0) parts.push(`${meta.writes} ${meta.writes === 1 ? 'write' : 'writes'}`);
  return parts.join(' · ');
}

function serviceDetail(meta: ServiceMeta): string {
  const source = meta.packages[0] ?? meta.hosts[0] ?? '';
  return source ? `${CATEGORY_LABELS[meta.category] ?? meta.category} · ${source}` : CATEGORY_LABELS[meta.category] ?? meta.category;
}

const CATEGORY_LABELS: Record<string, string> = {
  payments: 'Payments',
  ai: 'AI',
  email: 'Email',
  sms: 'SMS',
  auth: 'Accounts',
  storage: 'File storage',
  analytics: 'Analytics',
  search: 'Search',
  monitoring: 'Monitoring',
  queue: 'Jobs',
  other: 'Service',
};

// ---------------------------------------------------------------------------
// The middle
// ---------------------------------------------------------------------------

function buildZones(graph: AtlasGraph, zoneWeights: Map<Zone, number>): BoundaryZone[] {
  const fileCounts = new Map<Zone, number>();
  for (const file of graph.nodesOfKind('file')) {
    fileCounts.set(file.zone, (fileCounts.get(file.zone) ?? 0) + 1);
  }

  const present = new Set<Zone>(zoneWeights.keys());
  // A zone with no boundary traffic is still part of the app; show the big ones so the
  // middle box is the app rather than only the parts that touch the outside world.
  for (const [zone, count] of fileCounts) {
    if (zone !== 'test' && zone !== 'unknown' && count > 0) present.add(zone);
  }

  return ZONE_ORDER.filter((zone) => present.has(zone)).map((zone) => ({
    zone,
    label: ZONE_LABELS[zone],
    files: fileCounts.get(zone) ?? 0,
  }));
}

function addFlow(
  flows: BoundaryFlow[],
  zoneWeights: Map<Zone, number>,
  fromId: string,
  toId: string,
  weight: number,
): void {
  const existing = flows.find((flow) => flow.fromId === fromId && flow.toId === toId);
  if (existing) existing.weight += weight;
  else flows.push({ fromId, toId, weight });

  const zoneId = fromId.startsWith('zone:') ? fromId : toId.startsWith('zone:') ? toId : null;
  if (zoneId) {
    const zone = zoneId.slice(5) as Zone;
    zoneWeights.set(zone, (zoneWeights.get(zone) ?? 0) + weight);
  }
}
