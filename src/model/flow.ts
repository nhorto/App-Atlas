/**
 * @fileoverview Where one way in leads, followed as far as the code can be followed.
 *
 * A walkthrough answers "what happens here" in five paragraphs and then stops. This
 * answers the question people ask next — *where can this get to, and where does it
 * leave* — by handing back the whole reachable set at once instead of a narration of
 * it, so the reader can look down a branch nobody wrote a sentence about.
 *
 * Two honesty rules run through everything below. The first is what a link means. The
 * edges being followed say one piece of code *names* another — resolved by the
 * compiler where the language has one, matched by name where it does not, which is
 * what each edge's confidence records. Naming is not calling: a branch may be behind
 * an `if` nobody has ever satisfied. So a flow is where control can go, never a
 * recording of where it went, and the view says "can reach" rather than "does". The
 * second is that the walk is bounded, and every bound it hits is stated — a reader
 * told "41 pieces of code" and shown 30 has been told the wrong thing about their own
 * app, which is worse than being told nothing.
 *
 * Nothing here calls a model.
 */
import type { AtlasGraph } from './graph.js';
import type {
  AtlasNode,
  Confidence,
  EndpointKind,
  EndpointMeta,
  GuardInfo,
  ServiceMeta,
  StoreMeta,
  SummarySource,
  Zone,
} from './types.js';

/**
 * How far to follow the code away from a door.
 *
 * Deeper than a walkthrough's three, because this is the surface someone opens *to*
 * wander, and a walk that stops before the database it writes to has answered the
 * wrong question. Not unbounded, because a reference graph fans out fast and a screen
 * that lists every function in the app is a screen that says nothing.
 */
const MAX_HOPS = 4;

/** Ceiling on the reachable set. Hitting it is reported, never silently absorbed. */
const MAX_STOPS = 150;

/** Ceiling on where a flow leaves. Hitting it is reported too. */
const MAX_EXITS = 24;

/** One way into the app, as the door list shows it. */
export interface DoorSummary {
  id: string;
  name: string;
  endpointKind: EndpointKind;
  method: string | null;
  route: string | null;
  framework: string;
  /** The code behind this door writes data somewhere. */
  writes: boolean;
  guards: GuardInfo[];
  /**
   * Whether any code in this repo was found to answer this door. False for routes a
   * framework publishes from a schema or a routing table — real doors that this atlas
   * cannot follow inward, which is a different thing from a door with nothing behind
   * it and is worth saying rather than hiding.
   */
  answered: boolean;
  path: string | null;
  line: number | null;
  summary: string | null;
  summarySource: SummarySource;
}

/** Doors of one kind, kept together because that is how people look for them. */
export interface DoorGroup {
  kind: EndpointKind;
  /** "Screens", "Routes over the network" — the archetype-neutral plural. */
  label: string;
  doors: DoorSummary[];
}

export interface DoorList {
  groups: DoorGroup[];
  total: number;
  /** How many of them no code in this repo answers. */
  unanswered: number;
}

/** A piece of code a flow can get to. */
export interface FlowStop {
  id: string;
  name: string;
  kind: 'function' | 'file';
  path: string | null;
  line: number | null;
  zone: Zone;
  summary: string | null;
  summarySource: SummarySource;
  /** 1 answers the door; 2 is what that names; and so on. */
  hop: number;
  /**
   * How sure the atlas is that this link exists at all, carried through from the edge
   * that reached here: `certain` where a compiler resolved the name, `likely` where it
   * was matched across files by name alone. It is not a claim about how sure the atlas
   * is that this code *runs* — no static reading can say that, and this field must
   * never be read as if it did.
   */
  confidence: Confidence;
}

/** One followed link, kept so the reader can see what reached what. */
export interface FlowLink {
  fromId: string;
  toId: string;
  confidence: Confidence;
}

/** Somewhere a flow leaves the app: a database, a bucket, another company's API. */
export interface FlowExit {
  id: string;
  name: string;
  kind: 'store' | 'service';
  /** "Supabase Postgres · 14 tables", "api.anthropic.com" — what it is, in short. */
  detail: string;
  /** True when the code reaching it writes rather than only reads. */
  writes: boolean;
  external: boolean;
  /** Which stops touch it, so a reader can see the last step before the door out. */
  reachedBy: string[];
}

/** What the reader was not shown, said out loud. */
export interface FlowLimits {
  /** The walk stopped at MAX_HOPS with code still unvisited beyond it. */
  hitDepth: boolean;
  /** The walk stopped at MAX_STOPS. */
  hitStops: boolean;
  /** Exits found beyond MAX_EXITS. */
  exitsHidden: number;
}

export interface FlowView {
  door: DoorSummary;
  /** "someone opens /cellar/add" — the same clause the walkthrough titles use. */
  trigger: string;
  stops: FlowStop[];
  links: FlowLink[];
  exits: FlowExit[];
  limits: FlowLimits;
  /** Deepest hop actually reached, so the view can lay out that many columns. */
  maxHop: number;
}

/**
 * Every way into the app, grouped by kind, for the list a reader chooses from.
 *
 * All of them, deliberately. The walkthrough list offers five because a suggestion
 * stops being a suggestion at twenty; this is the opposite surface — somebody came
 * here to find a particular door, and one that is missing reads as one that does not
 * exist. The `env` inventory is the single exception: it is a list of variables, not
 * a path anybody travels.
 */
export function listDoors(graph: AtlasGraph): DoorList {
  const groups = new Map<EndpointKind, DoorSummary[]>();
  let total = 0;
  let unanswered = 0;

  for (const node of graph.nodesOfKind('endpoint')) {
    const meta = node.meta as unknown as EndpointMeta;
    if (meta.endpointKind === 'env') continue;
    const door = summarize(graph, node);
    total += 1;
    if (!door.answered) unanswered += 1;
    const bucket = groups.get(door.endpointKind);
    if (bucket) bucket.push(door);
    else groups.set(door.endpointKind, [door]);
  }

  const ordered = [...groups.entries()]
    .map(([kind, doors]) => ({
      kind,
      label: labelFor(kind),
      doors: doors.sort((a, b) => (a.route ?? a.name).localeCompare(b.route ?? b.name)),
    }))
    .sort((a, b) => kindRank(a.kind) - kindRank(b.kind) || a.label.localeCompare(b.label));

  return { groups: ordered, total, unanswered };
}

/**
 * Follow one door as far as the references go, and report where the walk stopped.
 *
 * Returns null when the id is not a door, so a caller can tell "no such door" from
 * "a door that reaches nothing" — the second is a real and interesting answer.
 */
export function buildFlow(graph: AtlasGraph, doorId: string): FlowView | null {
  const node = graph.getNodeById(doorId);
  if (!node || node.kind !== 'endpoint') return null;

  const door = summarize(graph, node);
  const stops: FlowStop[] = [];
  const links: FlowLink[] = [];
  const seen = new Set<string>([node.id]);
  const limits: FlowLimits = { hitDepth: false, hitStops: false, exitsHidden: 0 };

  // Hop 1 is what the framework runs, which the analyzer states outright.
  let frontier: AtlasNode[] = [];
  for (const edge of graph.edgesFrom(node.id)) {
    if (edge.kind !== 'exposed-by' || seen.has(edge.toId)) continue;
    const answering = graph.getNodeById(edge.toId);
    if (!answering || !isCode(answering)) continue;
    seen.add(answering.id);
    frontier.push(answering);
    stops.push(asStop(answering, 1, edge.confidence));
    links.push({ fromId: node.id, toId: answering.id, confidence: edge.confidence });
  }

  // Everything after it is a name resolved to a declaration.
  for (let hop = 2; hop <= MAX_HOPS; hop++) {
    const next: AtlasNode[] = [];
    for (const from of frontier) {
      for (const edge of graph.edgesFrom(from.id)) {
        if (edge.kind !== 'references') continue;
        const target = graph.getNodeById(edge.toId);
        if (!target || !isCode(target)) continue;
        // A link to somewhere already reached is still worth drawing — it is how a
        // reader sees that two branches meet at the same helper.
        links.push({ fromId: from.id, toId: target.id, confidence: edge.confidence });
        if (seen.has(target.id)) continue;
        if (stops.length >= MAX_STOPS) {
          limits.hitStops = true;
          continue;
        }
        seen.add(target.id);
        next.push(target);
        stops.push(asStop(target, hop, edge.confidence));
      }
    }
    if (next.length === 0) break;
    if (hop === MAX_HOPS && reachesFurther(graph, next, seen)) limits.hitDepth = true;
    frontier = next;
  }

  const exits = exitsFrom(graph, stops, limits);
  const maxHop = stops.reduce((deepest, stop) => Math.max(deepest, stop.hop), 0);

  return {
    door,
    trigger: triggerFor(node),
    stops,
    links: dedupeLinks(links),
    exits,
    limits,
    maxHop,
  };
}

// ---------------------------------------------------------------------------
// The pieces
// ---------------------------------------------------------------------------

function summarize(graph: AtlasGraph, node: AtlasNode): DoorSummary {
  const meta = node.meta as unknown as EndpointMeta;
  const site = meta.sites[0] ?? null;
  const answered = graph.edgesFrom(node.id).some((edge) => edge.kind === 'exposed-by');
  return {
    id: node.id,
    name: node.name,
    endpointKind: meta.endpointKind,
    method: meta.method,
    route: meta.route,
    framework: meta.framework,
    writes: meta.writes,
    guards: meta.guards,
    answered,
    path: site?.path ?? node.path ?? null,
    line: site?.line ?? node.startLine ?? null,
    summary: node.summary,
    summarySource: node.summarySource,
  };
}

function asStop(node: AtlasNode, hop: number, confidence: Confidence): FlowStop {
  return {
    id: node.id,
    name: node.name,
    kind: node.kind === 'function' ? 'function' : 'file',
    path: node.path ?? null,
    line: node.startLine ?? null,
    zone: node.zone,
    summary: node.summary,
    summarySource: node.summarySource,
    hop,
    confidence,
  };
}

function isCode(node: AtlasNode): boolean {
  return node.kind === 'function' || node.kind === 'file';
}

/**
 * Whether the walk is being cut off rather than finishing on its own.
 *
 * Only asked at the last hop, and only so the view can say "there is more past here".
 * Saying nothing would let a bounded walk pass for a complete one.
 */
function reachesFurther(graph: AtlasGraph, frontier: AtlasNode[], seen: Set<string>): boolean {
  for (const node of frontier) {
    for (const edge of graph.edgesFrom(node.id)) {
      if (edge.kind !== 'references' || seen.has(edge.toId)) continue;
      const target = graph.getNodeById(edge.toId);
      if (target && isCode(target)) return true;
    }
  }
  return false;
}

/**
 * The stores and services anything on the flow touches — the points where data leaves
 * the app, which is the half of the question a call graph alone never answers.
 */
function exitsFrom(graph: AtlasGraph, stops: FlowStop[], limits: FlowLimits): FlowExit[] {
  const found = new Map<string, FlowExit>();

  for (const stop of stops) {
    for (const edge of graph.edgesFrom(stop.id)) {
      const target = graph.getNodeById(edge.toId);
      if (!target || (target.kind !== 'store' && target.kind !== 'service')) continue;
      const already = found.get(target.id);
      if (already) {
        if (!already.reachedBy.includes(stop.id)) already.reachedBy.push(stop.id);
        already.writes = already.writes || edge.kind === 'writes-to';
        continue;
      }
      if (found.size >= MAX_EXITS) {
        limits.exitsHidden += 1;
        continue;
      }
      found.set(target.id, {
        id: target.id,
        name: target.name,
        kind: target.kind,
        detail: detailOf(target),
        writes: edge.kind === 'writes-to',
        external: target.kind === 'service' ? ((target.meta as unknown as ServiceMeta).external ?? true) : true,
        reachedBy: [stop.id],
      });
    }
  }

  // Somewhere data is written outranks somewhere it is only read.
  return [...found.values()].sort(
    (a, b) => Number(b.writes) - Number(a.writes) || a.name.localeCompare(b.name),
  );
}

function detailOf(node: AtlasNode): string {
  if (node.kind === 'store') {
    const meta = node.meta as unknown as StoreMeta;
    const tables = meta.tables.length;
    const bits = [meta.client];
    if (tables > 0) bits.push(`${tables} ${tables === 1 ? 'table' : 'tables'}`);
    return bits.filter(Boolean).join(' · ');
  }
  const meta = node.meta as unknown as ServiceMeta;
  const bits: string[] = [];
  if (meta.category && meta.category !== 'other') bits.push(meta.category);
  if (meta.hosts.length > 0) bits.push(meta.hosts[0]);
  return bits.join(' · ');
}

/** Two files naming each other twice is one link, drawn once, at the higher weight. */
function dedupeLinks(links: FlowLink[]): FlowLink[] {
  const best = new Map<string, FlowLink>();
  for (const link of links) {
    const key = `${link.fromId} ${link.toId}`;
    const already = best.get(key);
    if (!already || rankConfidence(link.confidence) > rankConfidence(already.confidence)) {
      best.set(key, link);
    }
  }
  return [...best.values()];
}

function rankConfidence(value: Confidence): number {
  return value === 'certain' ? 2 : value === 'likely' ? 1 : 0;
}

/**
 * The plural a reader would use for this kind of door. Deliberately archetype-neutral:
 * the boundary screen rewords itself per archetype and this list does not, because
 * somebody hunting for a door wants the word the code uses.
 */
function labelFor(kind: EndpointKind): string {
  switch (kind) {
    case 'http-route':
      return 'Routes over the network';
    case 'screen':
      return 'Screens';
    case 'server-action':
      return 'Server actions';
    case 'webhook':
      return 'Webhooks';
    case 'cron':
      return 'Scheduled jobs';
    case 'queue':
      return 'Queue consumers';
    case 'realtime':
      return 'Realtime channels';
    case 'cli':
      return 'Commands';
    case 'ipc':
      return 'Calls from the front end';
    case 'worker':
      return 'Workers';
    case 'port':
      return 'Ports';
    case 'export':
      return 'Exported for other code';
    case 'file-read':
      return 'Files read at startup';
    case 'env':
      return 'Environment';
    default:
      return 'Other ways in';
  }
}

/** Network doors first, then the ones a person walks through, then the rest. */
function kindRank(kind: EndpointKind): number {
  switch (kind) {
    case 'http-route':
      return 0;
    case 'webhook':
      return 1;
    case 'server-action':
      return 2;
    case 'ipc':
      return 3;
    case 'realtime':
      return 4;
    case 'queue':
      return 5;
    case 'cron':
      return 6;
    case 'worker':
      return 7;
    case 'cli':
      return 8;
    case 'screen':
      return 9;
    default:
      return 10;
  }
}

/**
 * The clause that finishes "What happens when …", matching the walkthrough's wording
 * so the two surfaces name the same door the same way.
 */
function triggerFor(endpoint: AtlasNode): string {
  const meta = endpoint.meta as unknown as EndpointMeta;
  const route = meta.route ?? endpoint.name;
  switch (meta.endpointKind) {
    case 'http-route':
      if (meta.method === 'PAGE') return `someone opens ${route}`;
      return meta.method && meta.method !== 'ANY'
        ? `something sends ${meta.method} to ${route}`
        : `something calls ${route}`;
    case 'screen':
      return `someone opens ${route}`;
    case 'server-action':
      return `the page calls ${endpoint.name}`;
    case 'webhook':
      return `an outside service calls your webhook at ${route}`;
    case 'cron':
      return `the schedule fires (${meta.schedule ?? route})`;
    case 'queue':
      return `a job arrives on ${route}`;
    case 'realtime':
      return `something connects to ${route}`;
    case 'cli':
      return `somebody runs ${route}`;
    case 'ipc':
      return `the front end calls ${endpoint.name}`;
    case 'worker':
      return `the worker ${endpoint.name} starts`;
    default:
      return `something reaches ${route}`;
  }
}
