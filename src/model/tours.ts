/**
 * @fileoverview Guided tours, derived rather than written (SPEC.md 6.4).
 *
 * A walkthrough is the delivery mechanism for everything else this tool knows: a
 * sequence of steps, each one a place on the map, a set of things to light up, a
 * paragraph, and the code underneath it. What makes it worth building is that the
 * steps come out of the graph — "what happens when someone posts to /api/checkout" is
 * a traversal, not an essay, so it is right on a codebase nobody has ever seen and it
 * stays right after the next commit.
 *
 * Every `body` here is a statement of compiler-derived fact, phrased in plain English
 * and assembled from counts and names. Where a node has a description of its own it
 * rides along as a `quote`, labelled with where it came from — so a tour never blurs
 * the line between what the code says and what a model said about it.
 *
 * Nothing in this file calls a model. Tours are free, work offline, and are the same
 * on every run.
 */
import { authHeadline } from './exposure.js';
import type { AtlasGraph } from './graph.js';
import type { AtlasNode, EndpointMeta, ServiceMeta, StoreMeta, SummarySource } from './types.js';

export interface TourStep {
  id: string;
  title: string;
  /** Compiler facts in plain English. Always true, never generated. */
  body: string;
  /** The node's own description, when it has one. */
  quote: string | null;
  quoteSource: SummarySource;
  /** What to light up on the map. */
  focusIds: string[];
  /** Which level the map should be showing for this step. */
  levelId: string | null;
  /** Whose code belongs in the drawer. */
  codeId: string | null;
  /** Set when the step is telling the reader something is wrong. */
  tone?: 'warn';
}

export interface Tour {
  id: string;
  title: string;
  subtitle: string;
  kind: 'welcome' | 'flow';
  steps: TourStep[];
}

/** How many flows to offer up front. More than a handful stops being a suggestion. */
const MAX_FLOW_TOURS = 5;
const MAX_TRACE_DEPTH = 3;
const MAX_TRACED_NODES = 40;

export function buildTours(graph: AtlasGraph): Tour[] {
  const tours: Tour[] = [welcomeTour(graph)];
  for (const endpoint of majorEntryPoints(graph)) {
    const tour = flowTour(graph, endpoint);
    // A door with nothing behind it makes a one-step tour, which is not a tour.
    if (tour && tour.steps.length >= 2) tours.push(tour);
  }
  return tours;
}

/**
 * The walkthrough for whatever the reader just opened, built when they open it.
 *
 * The offered list is short on purpose — five suggestions is a suggestion and twenty-four
 * is a directory — but "we only suggested five" was silently becoming "only five exist".
 * A reader who searched their way to the twelfth route found no button and no reason
 * given, which reads as *this door is not worth explaining*.
 *
 * Given a door, this is its own flow. Given a file or a function, it is the flow of the
 * door that leads there — the question somebody looking at `checkout.ts` is actually
 * asking is what reaches it. Exactly one door or nothing: two doors is two answers, and
 * picking one of them would be inventing the reader's question for them.
 */
export function tourFor(graph: AtlasGraph, nodeId: string): Tour | null {
  const node = graph.getNodeById(nodeId);
  if (!node) return null;

  const door = node.kind === 'endpoint' ? node : theDoorThatLeadsHere(graph, node);
  if (!door) return null;

  const tour = flowTour(graph, door);
  return tour && tour.steps.length >= 2 ? tour : null;
}

function theDoorThatLeadsHere(graph: AtlasGraph, node: AtlasNode): AtlasNode | null {
  const doors = graph
    .edgesTo(node.id)
    .filter((edge) => edge.kind === 'exposed-by')
    .map((edge) => graph.getNodeById(edge.fromId))
    .filter((found): found is AtlasNode => found?.kind === 'endpoint');
  const distinct = new Map(doors.map((found) => [found.id, found]));
  return distinct.size === 1 ? [...distinct.values()][0] : null;
}

// ---------------------------------------------------------------------------
// Welcome to your codebase
// ---------------------------------------------------------------------------

function welcomeTour(graph: AtlasGraph): Tour {
  const stats = graph.meta.stats;
  const auth = authHeadline(stats);
  const app = graph.getNodeById(graph.rootId) ?? null;
  const overview = graph.getOverview();
  // Sorted by size, because the welcome step introduces them as "the biggest" —
  // and the level's own order is layout order, which made that claim a lie.
  const modules = overview.topLevel
    .filter((node) => node.kind === 'module')
    .sort(
      (a, b) =>
        Number(b.meta.descendantFileCount ?? b.childCount ?? 0) - Number(a.meta.descendantFileCount ?? a.childCount ?? 0),
    )
    .slice(0, 6);
  const endpoints = graph.nodesOfKind('endpoint');
  const stores = graph.nodesOfKind('store');
  const services = graph.nodesOfKind('service');

  const steps: TourStep[] = [];

  steps.push({
    id: 'welcome:what',
    title: 'What this is',
    body: [
      `${graph.meta.name} is ${countOf(stats.files, 'file')} of ${graph.meta.languages.includes('typescript') ? 'TypeScript and JavaScript' : 'source code'}`,
      graph.meta.frameworks.length > 0 ? `built with ${list(graph.meta.frameworks)}` : null,
      `— ${countOf(stats.linesOfCode, 'line')} across ${countOf(stats.modules, 'folder')}.`,
    ]
      .filter(Boolean)
      .join(' '),
    quote: app?.summary ?? null,
    quoteSource: app?.summarySource ?? null,
    focusIds: [graph.rootId],
    levelId: graph.rootId,
    codeId: null,
  });

  steps.push({
    id: 'welcome:in',
    title: 'How the outside gets in',
    body:
      endpoints.length === 0
        ? 'App Atlas found no routes, webhooks or scheduled jobs — nothing here answers the outside world directly.'
        : [
            `${sentenceCase(countOf(stats.endpoints, 'way'))} in: ${describeDoors(endpoints)}.`,
            auth ? `${sentenceCase(auth.headline)}.` : null,
            // Only the first caveat: a walkthrough card is three lines, and the
            // security screen is where the full accounting belongs.
            auth?.caveats[0] ? `${sentenceCase(auth.caveats[0])}.` : null,
          ]
            .filter(Boolean)
            .join(' '),
    quote: null,
    quoteSource: null,
    focusIds: endpoints.slice(0, 12).map((node) => node.id),
    levelId: graph.rootId,
    codeId: null,
    tone: auth?.tone === 'warn' ? 'warn' : undefined,
  });

  if (modules.length > 0) {
    // The two boundary containers are not parts of the code, so they are not counted
    // as such — "5 parts" when two of them are the inbound and outbound groups is the
    // kind of small wrongness that costs a reader their trust in every other number.
    const parts = overview.topLevel.filter((node) => node.kind === 'module' || node.kind === 'file').length;
    steps.push({
      id: 'welcome:parts',
      title: 'The parts it is made of',
      // Real folder names, not the generated ones. The count beside each is its whole
      // subtree, while a generated name may have been written about a cut across it
      // (#94) — and a step's body carries no provenance mark to say which is which, so
      // the only honest string here is the one the reader can find on disk.
      body: `The code divides into ${countOf(parts, 'part')} at the top level. The biggest: ${list(
        modules.map(
          (node) => `${node.name} (${countOf(Number(node.meta.descendantFileCount ?? node.childCount), 'file')})`,
        ),
      )}.`,
      quote: null,
      quoteSource: null,
      focusIds: modules.map((node) => node.id),
      levelId: graph.rootId,
      codeId: null,
    });
  }

  if (stores.length + services.length > 0) {
    steps.push({
      id: 'welcome:out',
      title: 'Where your data ends up',
      body: [
        stores.length > 0 ? `Data is kept in ${list(stores.map(describeStore))}.` : null,
        services.length > 0
          ? `It is also sent to ${countOf(services.length, 'outside company', 'outside companies')}: ${list(
              services.slice(0, 6).map((node) => node.name),
            )}.`
          : null,
      ]
        .filter(Boolean)
        .join(' '),
      quote: null,
      quoteSource: null,
      focusIds: [...stores, ...services].slice(0, 12).map((node) => node.id),
      levelId: graph.rootId,
      codeId: null,
    });
  }

  const busiest = overview.whereToLookFirst.slice(0, 5);
  if (busiest.length > 0) {
    const names = labelsFor(busiest.map((entry) => entry.node));
    const by = busiest[0].imports;
    steps.push({
      id: 'welcome:start',
      title: 'Where to start reading',
      body: `${names[0]} pulls more of this codebase together than anything else — it imports ${by} ${
        by === 1 ? 'file' : 'files'
      } directly, and reaches most of the rest through them. That is usually either the way in or the place the app is assembled. After that: ${list(
        names.slice(1),
      )}.`,
      quote: busiest[0].node.summary,
      quoteSource: busiest[0].node.summarySource,
      focusIds: busiest.map((entry) => entry.node.id),
      levelId: parentOf(graph, busiest[0].node.id),
      codeId: busiest[0].node.id,
    });
  }

  return {
    id: 'tour:welcome',
    title: 'Welcome to your codebase',
    subtitle: `${steps.length} steps · start here`,
    kind: 'welcome',
    steps,
  };
}

// ---------------------------------------------------------------------------
// What happens when…
// ---------------------------------------------------------------------------

/**
 * The doors worth a tour. A route that writes data matters more than one that reads
 * it, and a door with code behind it matters more than one declared in a config file
 * and never wired up.
 */
function majorEntryPoints(graph: AtlasGraph): AtlasNode[] {
  const scored = graph
    .nodesOfKind('endpoint')
    .filter((node) => {
      const meta = node.meta as unknown as EndpointMeta;
      // The env "door" is an inventory, not a path anyone travels.
      return meta.endpointKind !== 'env' && meta.endpointKind !== 'file-read';
    })
    .map((node) => {
      const meta = node.meta as unknown as EndpointMeta;
      const handlers = graph.edgesFrom(node.id).filter((edge) => edge.kind === 'exposed-by').length;
      let score = handlers * 3;
      if (meta.writes) score += 6;
      if (meta.endpointKind === 'webhook') score += 4;
      if (meta.endpointKind === 'server-action') score += 2;
      if (meta.method === 'PAGE') score -= 3;
      score += Math.min(meta.sites.length, 4);
      return { node, score };
    })
    .filter((entry) => entry.score > 0);

  // A screen is a door a person walks through; a route is a door a stranger can reach
  // over the network. Both deserve a tour, but a file-routed app has two dozen screens
  // and perhaps one edge function, and ranking them together buries the single thing a
  // reader most needs to see. Network doors go first; screens fill whatever is left.
  return scored
    .sort(
      (a, b) =>
        doorRank(a.node) - doorRank(b.node) || b.score - a.score || a.node.name.localeCompare(b.node.name),
    )
    .slice(0, MAX_FLOW_TOURS)
    .map((entry) => entry.node);
}

function doorRank(node: AtlasNode): number {
  return (node.meta as unknown as EndpointMeta).endpointKind === 'screen' ? 1 : 0;
}

function flowTour(graph: AtlasGraph, endpoint: AtlasNode): Tour | null {
  const meta = endpoint.meta as unknown as EndpointMeta;
  const handlers = graph
    .edgesFrom(endpoint.id)
    .filter((edge) => edge.kind === 'exposed-by')
    .map((edge) => graph.getNodeById(edge.toId))
    .filter((node): node is AtlasNode => Boolean(node));

  const traced = trace(graph, handlers);
  const outputs = outputsOf(graph, [...handlers, ...traced]);
  const steps: TourStep[] = [];

  // 1. the door
  steps.push({
    id: `${endpoint.id}:door`,
    title: 'Something knocks',
    body: `${sentenceCase(trigger(endpoint))}. ${doorDetail(meta)}`,
    quote: endpoint.summary,
    quoteSource: endpoint.summarySource,
    focusIds: [endpoint.id],
    levelId: parentOf(graph, endpoint.id),
    codeId: handlers[0]?.id ?? null,
  });

  // 2. what answers
  if (handlers.length > 0) {
    const first = handlers[0];
    steps.push({
      id: `${endpoint.id}:handler`,
      title: 'Your code answers',
      body:
        handlers.length === 1
          ? `${nameAndPlace(first)} runs.`
          : `${countOf(handlers.length, 'piece')} of code answer it, starting with ${nameAndPlace(first)}.`,
      quote: first.summary,
      quoteSource: first.summarySource,
      focusIds: handlers.map((node) => node.id),
      levelId: parentOf(graph, first.id),
      codeId: first.id,
    });
  }

  // 3. what it reaches
  if (traced.length > 0) {
    const named = traced.slice(0, 6);
    steps.push({
      id: `${endpoint.id}:calls`,
      title: 'And calls on',
      body: `From there it reaches ${countOf(traced.length, 'other piece')} of your code${
        traced.length > named.length ? ', including' : ':'
      } ${list(named.map((node) => node.name))}.`,
      quote: named.find((node) => node.summary)?.summary ?? null,
      quoteSource: named.find((node) => node.summary)?.summarySource ?? null,
      focusIds: named.map((node) => node.id),
      levelId: parentOf(graph, named[0].id),
      codeId: named[0].id,
    });
  }

  // 4. where it lands
  if (outputs.length > 0) {
    steps.push({
      id: `${endpoint.id}:out`,
      title: 'And ends up here',
      body: `Along the way it touches ${list(outputs.map((node) => (node.kind === 'store' ? describeStore(node) : describeService(node))))}.`,
      quote: null,
      quoteSource: null,
      focusIds: outputs.map((node) => node.id),
      levelId: parentOf(graph, outputs[0].id),
      codeId: null,
    });
  }

  // 5. the warning, if it is one
  if (meta.guards.length === 0 && meta.writes && isReachableByStrangers(meta)) {
    steps.push({
      id: `${endpoint.id}:auth`,
      title: 'Nobody is checking who called',
      body: `App Atlas found no auth check on this door, and the code behind it writes data. Anyone who knows the address can reach it. If that is deliberate — a public sign-up, a webhook verified by signature — nothing is wrong; if it is not, this is the kind of thing worth fixing today.`,
      quote: null,
      quoteSource: null,
      focusIds: [endpoint.id],
      levelId: parentOf(graph, endpoint.id),
      codeId: null,
      tone: 'warn',
    });
  } else if (meta.guards.length > 0) {
    const guard = meta.guards[0];
    steps.push({
      id: `${endpoint.id}:auth`,
      title: 'What is guarding it',
      body: `${guard.provider === 'custom' ? guard.name : guard.provider} checks the caller${
        guard.path ? ` in ${guard.path}` : ''
      }${guard.confidence === 'certain' ? '' : ' — App Atlas is fairly, not entirely, sure this covers it'}.`,
      quote: null,
      quoteSource: null,
      focusIds: [endpoint.id],
      levelId: parentOf(graph, endpoint.id),
      codeId: null,
    });
  }

  return {
    id: `tour:${endpoint.id}`,
    title: `What happens when ${trigger(endpoint)}`,
    subtitle: `${steps.length} steps · traced from the code`,
    kind: 'flow',
    steps,
  };
}

/** Breadth-first through `references`, staying inside the app's own code. */
function trace(graph: AtlasGraph, from: AtlasNode[]): AtlasNode[] {
  const seen = new Set(from.map((node) => node.id));
  const out: AtlasNode[] = [];
  let frontier = from;

  for (let depth = 0; depth < MAX_TRACE_DEPTH && out.length < MAX_TRACED_NODES; depth++) {
    const next: AtlasNode[] = [];
    for (const node of frontier) {
      for (const edge of graph.edgesFrom(node.id)) {
        if (edge.kind !== 'references' || seen.has(edge.toId)) continue;
        const target = graph.getNodeById(edge.toId);
        if (!target || (target.kind !== 'function' && target.kind !== 'file')) continue;
        seen.add(target.id);
        next.push(target);
        out.push(target);
        if (out.length >= MAX_TRACED_NODES) break;
      }
    }
    if (next.length === 0) break;
    frontier = next;
  }

  return out;
}

function outputsOf(graph: AtlasGraph, nodes: AtlasNode[]): AtlasNode[] {
  const found = new Map<string, AtlasNode>();
  for (const node of nodes) {
    for (const edge of graph.edgesFrom(node.id)) {
      const target = graph.getNodeById(edge.toId);
      if (!target || (target.kind !== 'store' && target.kind !== 'service')) continue;
      found.set(target.id, target);
    }
  }
  return [...found.values()].slice(0, 8);
}

// ---------------------------------------------------------------------------
// Phrasing
// ---------------------------------------------------------------------------

/**
 * "index.ts in supabase/functions/chat/index.ts" says the file name twice.
 * When the thing that runs *is* the file, its path is the whole story.
 */
function nameAndPlace(node: AtlasNode): string {
  if (!node.path) return node.name;
  const base = node.path.split('/').pop() ?? '';
  return base === node.name || base === `${node.name}.ts` || base === `${node.name}.js`
    ? node.path
    : `${node.name} in ${node.path}`;
}

/** The clause that finishes "What happens when …". */
function trigger(endpoint: AtlasNode): string {
  const meta = endpoint.meta as unknown as EndpointMeta;
  const route = meta.route ?? endpoint.name;
  switch (meta.endpointKind) {
    case 'http-route':
      // "sends ANY to" is analyzer jargon leaking out — a route that accepts any
      // method is simply called.
      if (meta.method === 'PAGE') return `someone opens ${route}`;
      if (!meta.method || meta.method === 'ANY') return `something calls ${route}`;
      return `something sends ${meta.method} to ${route}`;
    case 'server-action':
      return `the page calls ${route}`;
    // Deliberately not named: `framework` is the convention that *found* the webhook,
    // not whoever calls it, and "Next.js calls your webhook" is simply false.
    case 'webhook':
      return `an outside service calls your webhook at ${route}`;
    case 'cron':
      return `the schedule fires${meta.schedule ? ` (${meta.schedule})` : ''}`;
    case 'queue':
      return `a background job runs`;
    case 'worker':
      // The schedule is only ever one the code declared; without one, "with the app"
      // is the whole truth — it starts when the app does and runs on its own.
      return `${endpoint.name} runs${meta.schedule ? ` (${meta.schedule})` : ' with the app'}`;
    case 'realtime':
      return `a client subscribes to ${route}`;
    case 'cli':
      return `the command line runs it`;
    case 'screen':
      return `someone opens ${route}`;
    default:
      return `${route} is reached`;
  }
}

function doorDetail(meta: EndpointMeta): string {
  const where = meta.sites[0];
  const parts = [`Found by the ${meta.framework} convention`];
  if (where) parts.push(`at ${where.path}:${where.line}`);
  return `${parts.join(' ')}.${meta.writes ? ' The code behind it writes data.' : ''}`;
}

function describeDoors(endpoints: AtlasNode[]): string {
  const counts = new Map<string, number>();
  for (const node of endpoints) {
    const meta = node.meta as unknown as EndpointMeta;
    const noun = DOOR_NOUNS[meta.endpointKind] ?? 'entry point';
    counts.set(noun, (counts.get(noun) ?? 0) + 1);
  }
  return list(
    [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([noun, count]) => countOf(count, noun)),
  );
}

const DOOR_NOUNS: Record<string, string> = {
  'http-route': 'route',
  'server-action': 'server action',
  webhook: 'webhook',
  cron: 'scheduled job',
  queue: 'background worker',
  worker: 'background service',
  realtime: 'realtime channel',
  cli: 'command',
  env: 'config source',
  'file-read': 'file read',
};

function describeStore(node: AtlasNode): string {
  const meta = node.meta as unknown as StoreMeta;
  const tables = meta.tables.length > 0 ? ` (${countOf(meta.tables.length, 'table')})` : '';
  return `${node.name}${tables}`;
}

function describeService(node: AtlasNode): string {
  const meta = node.meta as unknown as ServiceMeta;
  return `${node.name}${meta.category !== 'other' ? ` for ${meta.category}` : ''}`;
}

function isReachableByStrangers(meta: EndpointMeta): boolean {
  return meta.endpointKind === 'http-route' || meta.endpointKind === 'server-action' || meta.endpointKind === 'realtime';
}

/**
 * `route.ts` four times in a row tells the reader nothing. Framework conventions name
 * files by position rather than by content, so those get their folder back.
 */
const POSITIONAL_NAMES = new Set([
  'route.ts',
  'route.tsx',
  'page.ts',
  'page.tsx',
  'index.ts',
  'index.tsx',
  'layout.tsx',
  'handler.ts',
  'mod.ts',
]);

function withFolder(node: AtlasNode): string {
  return node.path ? node.path.split('/').slice(-2).join('/') : node.name;
}

/**
 * Names for a set of files, disambiguated within that set. Listing `types.ts` twice
 * looks like a mistake even when both are real; `model/types.ts` and `web/types.ts`
 * are two answers rather than one repeated.
 */
function labelsFor(nodes: AtlasNode[]): string[] {
  const seen = new Map<string, number>();
  for (const node of nodes) seen.set(node.name, (seen.get(node.name) ?? 0) + 1);
  return nodes.map((node) =>
    (seen.get(node.name) ?? 0) > 1 || POSITIONAL_NAMES.has(node.name) ? withFolder(node) : node.name,
  );
}

function parentOf(graph: AtlasGraph, id: string): string | null {
  const chain = graph.breadcrumb(id);
  return chain[chain.length - 2]?.id ?? graph.rootId;
}

function countOf(value: number, one: string, many?: string): string {
  return `${value} ${value === 1 ? one : (many ?? `${one}s`)}`;
}

function list(items: string[]): string {
  const clean = items.filter(Boolean);
  if (clean.length === 0) return '';
  if (clean.length === 1) return clean[0];
  return `${clean.slice(0, -1).join(', ')} and ${clean[clean.length - 1]}`;
}

function sentenceCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
