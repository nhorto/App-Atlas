/**
 * @fileoverview What an arrow on the Map means, and what the Map is currently showing.
 *
 * Both halves live here for the same reason: the legend and the canvas must never be
 * able to disagree. Issue #90 was one arrow standing for four different relationships
 * with nothing on screen saying which — the kinds were computed, carried to the browser
 * and thrown away at the last step. So the drawing reads its colour, its arrowhead and
 * its label from this file, and the key beside the drawing reads the same words out of
 * the same list.
 *
 * The filtering half is issue #91: the legend looked like a filter in every mapping tool
 * anyone has used, and was not one. It is one now, which means something on screen has
 * to say what is being held back — hiding is fine, hiding silently is not.
 */
import type { EdgeKind, LevelEdge, LevelNode, LevelView, OutsideNeighbor, Zone } from './types';

/**
 * The four relationships an arrow can stand for, collapsed to the three a reader has to
 * tell apart. `imports` and `references` are both "this code needs that code" and are
 * drawn alike; reading a database and writing one are not alike at all, and used to be.
 */
export type ArrowKind = 'uses' | 'reads' | 'writes' | 'both';

export interface ArrowStyle {
  kind: ArrowKind;
  /** The word for it, used on the key. */
  word: string;
  /** What it means, in the reader's terms rather than the graph's. */
  means: string;
  stroke: string;
  /** Darker, for the arrows touching whatever is selected. */
  strokeLit: string;
  /** Which end of the line carries the arrowhead — the end the data arrives at. */
  head: 'start' | 'end' | 'both';
}

/**
 * Data edges are drawn in the data zone's own green, so an arrow that means "your
 * information moves along here" is the same colour as the boxes that hold it.
 */
const INK = '#a89f8b';
const INK_LIT = '#4a4436';
const FLOW = '#7fa98f';
const FLOW_LIT = '#2f7a53';

/**
 * A read points at the code, not at the database.
 *
 * `reads-from` is stored with the file as `fromId` and the store as `toId` — correct as
 * a sentence ("this file reads from Postgres") and backwards as a picture, because an
 * arrow means "this goes there". Every read edge was telling the reader that their data
 * flows into the database it is being loaded out of. The stored direction is left alone
 * — the boundary view, the security screen and the MCP tools all read it as a sentence
 * — and only the arrowhead moves to the end the data actually arrives at.
 */
export const ARROWS: ArrowStyle[] = [
  {
    kind: 'uses',
    word: 'uses',
    means: 'imports or calls the thing it points at',
    stroke: INK,
    strokeLit: INK_LIT,
    head: 'end',
  },
  {
    kind: 'reads',
    word: 'reads',
    means: 'data comes out of the thing at the blunt end',
    stroke: FLOW,
    strokeLit: FLOW_LIT,
    head: 'start',
  },
  {
    kind: 'writes',
    word: 'writes',
    means: 'data goes into the thing it points at',
    stroke: FLOW,
    strokeLit: FLOW_LIT,
    head: 'end',
  },
  {
    kind: 'both',
    word: 'reads and writes',
    means: 'data moves both ways',
    stroke: FLOW,
    strokeLit: FLOW_LIT,
    head: 'both',
  },
];

const BY_KIND = new Map(ARROWS.map((arrow) => [arrow.kind, arrow]));

export function arrowKindOf(kinds: EdgeKind[] | undefined): ArrowKind {
  const reads = kinds?.includes('reads-from') ?? false;
  const writes = kinds?.includes('writes-to') ?? false;
  if (reads && writes) return 'both';
  if (reads) return 'reads';
  if (writes) return 'writes';
  return 'uses';
}

export function arrowStyle(kinds: EdgeKind[] | undefined): ArrowStyle {
  return BY_KIND.get(arrowKindOf(kinds)) ?? ARROWS[0];
}

/**
 * The number on an arrow, with the thing it counts attached.
 *
 * A bare `15` was two different quantities sharing a glyph: on an import edge it is how
 * many file-to-file connections were rolled up into the one line, and on a database edge
 * it is how many call sites do the querying. Fifteen connections and fifteen call sites
 * are not the same fact, so neither is written as fifteen.
 */
export function edgeLabel(kinds: EdgeKind[] | undefined, weight: number): string {
  const plural = weight === 1 ? '' : 's';
  switch (arrowKindOf(kinds)) {
    case 'reads':
      return `${weight} read${plural}`;
    case 'writes':
      return `${weight} write${plural}`;
    case 'both':
      return `${weight} quer${weight === 1 ? 'y' : 'ies'}`;
    default:
      return kinds?.length === 1 && kinds[0] === 'imports'
        ? `${weight} import${plural}`
        : `${weight} use${plural}`;
  }
}

/** A zone the Map is holding back, and how many boxes at this level it costs. */
export interface HiddenZone {
  zone: Zone;
  count: number;
}

/** One level, after the zone filter — exactly what the canvas is drawing. */
export interface ShownLevel {
  levelId: string;
  nodes: LevelNode[];
  edges: LevelEdge[];
  outside: OutsideNeighbor[];
  /** What the filter is holding back here, so the screen can say it out loud. */
  hidden: HiddenZone[];
  hiddenTotal: number;
}

/**
 * Applies the zone filter to one level.
 *
 * Hiding a box hides every arrow that ended in it, which is the part that has to be said
 * rather than assumed: the counts the screen prints alongside are then describing
 * something other than the picture. `hidden` is what makes saying it possible.
 */
export function filterLevel(level: LevelView, hiddenZones: Set<Zone>): ShownLevel {
  const counts = new Map<Zone, number>();
  const nodes = level.nodes.filter((node) => {
    if (!hiddenZones.has(node.zone)) return true;
    counts.set(node.zone, (counts.get(node.zone) ?? 0) + 1);
    return false;
  });

  const visible = new Set(nodes.map((node) => node.id));
  const edges = level.edges.filter((edge) => visible.has(edge.fromId) && visible.has(edge.toId));

  // A store the app still talks to stays on the far side of the membrane; it just loses
  // the flows that came from a box no longer on screen. One with none left goes with them.
  const outside: OutsideNeighbor[] = [];
  for (const neighbor of level.outside) {
    const flows = neighbor.flows.filter((flow) => visible.has(flow.insideId));
    if (flows.length === 0) continue;
    outside.push({ ...neighbor, flows, total: flows.reduce((sum, flow) => sum + flow.weight, 0) });
  }

  const hidden = [...counts.entries()].map(([zone, count]) => ({ zone, count }));
  return {
    levelId: level.levelId,
    nodes,
    edges,
    outside,
    hidden,
    hiddenTotal: hidden.reduce((sum, entry) => sum + entry.count, 0),
  };
}

/**
 * How many arrows are drawn before the rest go behind a control.
 *
 * A file level of a 238-file repo has thousands of connections in it, and an unfiltered
 * canvas of them is spaghetti whatever the arrows look like. The heaviest are kept
 * because a rolled-up edge standing for forty imports is a fact about the architecture,
 * while a single reference is a fact about one line.
 *
 * The layout never sees this cap — elk is given every edge, so turning the rest back on
 * moves nothing on screen. Spatial memory is a feature (SPEC.md principle 4), and a
 * picture that rearranged itself when you asked to see more of it would spend it.
 */
export const ARROW_BUDGET = 40;

/**
 * The arrows to draw: the heaviest, plus every one touching the selection.
 *
 * The exception matters more than the rule. "What is this connected to" is the question a
 * click asks, and answering it with the subset that happened to be heavy would be a worse
 * lie than the spaghetti.
 */
export function budgetEdges(edges: LevelEdge[], selectedId: string | null, showAll: boolean): LevelEdge[] {
  if (showAll || edges.length <= ARROW_BUDGET) return edges;
  const heaviest = [...edges].sort((a, b) => b.weight - a.weight).slice(0, ARROW_BUDGET);
  const kept = new Set(heaviest.map((edge) => edge.id));
  return edges.filter(
    (edge) => kept.has(edge.id) || edge.fromId === selectedId || edge.toId === selectedId,
  );
}

/**
 * Below this many arrows every one carries its label without being asked.
 *
 * The label used to appear only on arrows touching the selection, which made a property
 * of the edge look like a property of the click. On a level small enough to read, they
 * are simply all on.
 */
export const LABEL_EVERYTHING_BELOW = 14;
