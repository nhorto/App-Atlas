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
 *
 * One view, parameterized by archetype (SPEC.md 5.9) — never three. The geometry is
 * fixed, because left→right is the whole argument for this picture over a ring; what
 * changes is the vocabulary, since a library's left column is what consumers may call
 * and a script's is what it reads when you run it. Calling either of those "ways in"
 * would be false.
 */
import type {
  Archetype,
  AtlasNode,
  EndpointKind,
  EndpointMeta,
  ServiceMeta,
  StoreMeta,
  Zone,
} from './types.js';
import { classifyOpenDoors } from './exposure.js';
import type { OpenVerdict } from './exposure.js';
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
  /**
   * Those same nodes with their names, so a card standing for fourteen pages can list
   * the fourteen instead of silently opening one of them (#30). Only carried when the
   * card is a group; a card that *is* a node has nothing to expand into.
   */
  members?: { id: string; name: string }[];
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

/**
 * What the three columns are called for this kind of project.
 *
 * The geometry never changes — something arrives on the left, your code is in the
 * middle, something leaves on the right — because that reading order is the whole
 * reason the view beats a ring. What changes is the words, and only the words: a
 * library's left column is what consumers may call, a script's is what it reads when
 * you run it, and calling either of those "ways in over the network" would be false.
 */
export interface BoundaryCaptions {
  inputs: string;
  app: string;
  outputs: string;
}

export interface BoundaryView {
  appName: string;
  /** Absent on an atlas analyzed before archetypes existed. */
  archetype?: Archetype;
  captions: BoundaryCaptions;
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

const CAPTIONS: Record<Archetype, BoundaryCaptions> = {
  'web-app': { inputs: 'What gets in', app: 'Your app', outputs: 'Where data goes' },
  service: { inputs: 'What calls it', app: 'Your service', outputs: 'Where data goes' },
  library: { inputs: 'What consumers can call', app: 'Your library', outputs: 'What it reaches for' },
  pipeline: { inputs: 'What it reads', app: 'Your code', outputs: 'What it writes' },
  unknown: { inputs: 'What gets in', app: 'Your code', outputs: 'Where data goes' },
};

interface InputFamily {
  family: string;
  label: string;
  kinds: EndpointKind[];
  /** Narrows a kind that covers two different kinds of door. */
  match?: (meta: EndpointMeta) => boolean;
}

/** Kept in this order on screen: how a request arrives, roughly. */
const INPUT_FAMILIES: InputFamily[] = [
  { family: 'screens', label: 'Screens', kinds: ['screen'] },
  { family: 'pages', label: 'Pages', kinds: ['http-route'], match: (meta) => meta.method === 'PAGE' },
  { family: 'routes', label: 'API routes', kinds: ['http-route'], match: (meta) => meta.method !== 'PAGE' },
  { family: 'actions', label: 'Server actions', kinds: ['server-action'] },
  { family: 'webhooks', label: 'Webhooks', kinds: ['webhook'] },
  { family: 'cron', label: 'Scheduled jobs', kinds: ['cron'] },
  { family: 'queue', label: 'Background jobs', kinds: ['queue'] },
  { family: 'realtime', label: 'Realtime', kinds: ['realtime'] },
  // A library's whole boundary. Split in two because the commitments are different:
  // changing a function's behaviour breaks callers at runtime, changing a type's
  // shape breaks them at compile time.
  {
    family: 'exports',
    label: 'Functions you can call',
    kinds: ['export'],
    match: (meta) => meta.framework === 'function',
  },
  {
    family: 'export-types',
    label: 'Types you can import',
    kinds: ['export'],
    match: (meta) => meta.framework !== 'function',
  },
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

  // Card badges and the summary line under them have to be counting the same thing,
  // or the screen argues with itself: "8 open" on the Pages card above "1 route has
  // no auth check" is a reader's first reason to distrust both (#24).
  const openDoors = classifyOpenDoors(graph.allNodes(), graph.allEdges());
  const inputs = buildInputs(graph, endpoints, flows, zoneWeights, openDoors);
  const outputs = buildOutputs(graph, services, stores, flows, zoneWeights);

  const archetype = graph.meta.archetype?.archetype;

  return {
    appName: graph.meta.name,
    archetype,
    captions: CAPTIONS[archetype ?? 'unknown'],
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
  openDoors: Map<string, OpenVerdict>,
): BoundaryCard[] {
  const cards: BoundaryCard[] = [];

  for (const { family, label, kinds, match } of INPUT_FAMILIES) {
    const members = endpoints.filter((node) => {
      const meta = node.meta as unknown as EndpointMeta;
      if (!kinds.includes(meta.endpointKind)) return false;
      return match ? match(meta) : true;
    });
    if (members.length === 0) continue;

    let paths = 0;
    let open = 0;
    for (const node of members) {
      const meta = node.meta as unknown as EndpointMeta;
      paths += Math.max(1, meta.sites.length);
      if (openDoors.get(node.id)?.kind === 'worth-a-look') open++;

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
      members: members.length > 1 ? members.map((node) => ({ id: node.id, name: node.name })) : undefined,
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
  screens: 'screen',
  pages: 'page',
  routes: 'route',
  actions: 'action',
  webhooks: 'webhook',
  cron: 'scheduled job',
  queue: 'worker',
  realtime: 'subscription',
  exports: 'function',
  'export-types': 'type',
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
      members: rest.map((entry) => ({ id: entry.node.id, name: entry.card.name })),
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
  // A store nothing writes to is still a store something reads, and a card that says
  // only "pandas" looks like a box we could not finish.
  else if (meta.reads > 0) parts.push(`${meta.reads} ${meta.reads === 1 ? 'read' : 'reads'}`);
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
