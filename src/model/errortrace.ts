/**
 * @fileoverview Put a pasted error onto the map, and walk back from it to the doors.
 *
 * Somebody has a stack trace and a question — *where did this come from* — and the
 * atlas already holds the only two things needed to answer it: every file's path, and
 * the line range of everything declared in it. A frame is a path and a number, so
 * turning one into "the function this happened in" is a lookup, not a guess. From
 * there the reference edges run backwards to whatever ways in can reach it.
 *
 * This is the one place the atlas is handed evidence from a run rather than reading it
 * from source, and the seam is worth being careful about:
 *
 *   - Nothing here calls a model. The frames are parsed with per-language patterns,
 *     the files are matched by path, and the doors come from the graph. The whole
 *     path is compiler facts joined to text the user pasted.
 *   - A trace says where the program *was*; the edges say where control *can* go. So a
 *     door reported here is a door that can reach the failing code, not one that
 *     provably did — the phrasing everywhere is "can reach", and when several doors
 *     can, all of them are returned rather than the tool picking a favourite.
 *   - Every frame it could not place says why: a dependency, a file this atlas has
 *     never read, or a name that matched more than one file. Dropping them silently
 *     would turn "I could not follow this" into "this did not happen".
 */
import type { DoorSummary } from './flow.js';
import { listDoors } from './flow.js';
import type { AtlasGraph } from './graph.js';
import type { AtlasNode, Confidence } from './types.js';

/** How far back through the references to look for a way in. */
const MAX_BACK_HOPS = 6;

/** Ceiling on the backward walk, so a hub file cannot make this run away. */
const MAX_BACK_VISITED = 600;

/** Languages whose stack traces this can read. */
export type TraceLanguage = 'javascript' | 'python' | 'go' | 'dotnet' | 'java';

/** One line of a pasted trace that named a file and a line number. */
export interface ErrorFrame {
  /** The line as pasted, kept so the reader can see what was read. */
  raw: string;
  /** The path exactly as the trace wrote it. */
  rawPath: string;
  line: number;
  column: number | null;
  /** The function the runtime named, where it named one. */
  functionName: string | null;
  language: TraceLanguage;
  /** Position in the pasted trace, innermost first as most runtimes print it. */
  order: number;
}

/** Why a frame could not be put on the map. */
export type UnplacedReason = 'dependency' | 'runtime' | 'unknown-file' | 'ambiguous';

export interface PlacedFrame {
  frame: ErrorFrame;
  /** Set when the frame landed on something in the atlas. */
  nodeId: string | null;
  nodeName: string | null;
  nodeKind: 'function' | 'file' | null;
  /** The repo-relative path the raw path was resolved to. */
  path: string | null;
  reason: UnplacedReason | null;
  /** When more than one file in the repo could be what the trace meant. */
  candidates: string[];
  /**
   * The runtime named one function and that line holds a different one.
   *
   * In a trace taken from the code as it stands now these always agree, so a
   * disagreement means the two have drifted apart — a paste from before the last
   * edit, or a build whose line numbers are not the source's. The frame is still
   * placed, because the file is right and the neighbourhood is usually right, but a
   * reader following it to the exact function deserves to know it may have moved.
   */
  nameDrifted: boolean;
}

/** A way in that can reach the code the error happened in. */
export interface DoorReach {
  door: DoorSummary;
  /** Door → … → failing code, as node ids. The evidence for the claim. */
  via: string[];
  /** Readable version of the same chain. */
  viaNames: string[];
  hops: number;
  /** The weakest link in the chain — never stronger than the edge it rests on. */
  confidence: Confidence;
}

export interface ErrorTraceResult {
  /** Every frame parsed out of the paste, in the order it was written. */
  frames: PlacedFrame[];
  /** Just the ones that landed on this project's own code. */
  yours: PlacedFrame[];
  /** The languages the parser recognised. More than one means a mixed paste. */
  languages: TraceLanguage[];
  /**
   * The frame the walk started from: the innermost frame that is your code, because
   * that is where the failure actually is rather than where the runtime noticed it.
   */
  origin: PlacedFrame | null;
  /** Every door that can reach the origin, nearest first. */
  doors: DoorReach[];
  /** True when the backward walk stopped before it ran out of code to look at. */
  searchTruncated: boolean;
  /**
   * Nothing in the paste looked like a stack frame. Separated from "no frames matched"
   * because the two need completely different things said to the reader.
   */
  parsedNothing: boolean;
}

/**
 * Read a pasted error and place it on the map.
 *
 * Takes the paste exactly as it arrives — a stack trace, a log excerpt with timestamps
 * around it, a screenshot's text — and ignores whatever is not a frame rather than
 * demanding a format.
 */
export function traceError(graph: AtlasGraph, pasted: string): ErrorTraceResult {
  const frames = parseFrames(pasted);
  const placed = frames.map((frame) => place(graph, frame));
  const yours = placed.filter((found) => found.nodeId !== null);
  const origin = yours[0] ?? null;
  const back = origin?.nodeId ? doorsReaching(graph, origin.nodeId) : { doors: [], truncated: false };

  return {
    frames: placed,
    yours,
    languages: [...new Set(frames.map((frame) => frame.language))],
    origin,
    doors: back.doors,
    searchTruncated: back.truncated,
    parsedNothing: frames.length === 0,
  };
}

// ---------------------------------------------------------------------------
// Reading the paste
// ---------------------------------------------------------------------------

/**
 * V8 and every JavaScript runtime that copies it:
 *   `at handler (/app/routes/users.ts:12:5)` · `at /app/x.js:3:1` · `at async f (…)`
 * The path group is lazy and the two numbers are anchored to the end, because paths on
 * Windows contain the same colon the line number is separated by.
 */
const JS_FRAME = /^\s*at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?\s*$/;

/** CPython: `  File "/app/api.py", line 42, in create_user` */
const PY_FRAME = /^\s*File\s+"(.+?)",\s+line\s+(\d+)(?:,\s+in\s+(.+?))?\s*$/;

/**
 * .NET: `at Shop.Api.Orders.Delete(Int32 id) in /src/Orders.cs:line 42`
 * Tried before the JavaScript pattern, which would otherwise claim the same line and
 * read `:line 42` as a path ending in `line`.
 */
const NET_FRAME = /^\s*at\s+(.+?)\s+in\s+(.+?):line\s+(\d+)\s*$/;

/** JVM: `at com.example.Shop.checkout(Shop.java:42)` — a file name, never a path. */
const JAVA_FRAME = /^\s*at\s+([\w$.]+)\(([\w$]+\.(?:java|kt)):(\d+)\)\s*$/;

/** Go's panic dump puts the location on its own tab-indented line under the call. */
const GO_LOCATION = /^\s*(\S*\.go):(\d+)(?:\s+\+0x[0-9a-f]+)?\s*$/;
const GO_CALL = /^(?:\s*)([\w./\-*()]+\.[\w*()]+)\((?:.*)\)\s*$/;

/**
 * Pull every frame out of a paste, whatever else is in it.
 *
 * Order matters: the .NET and Java shapes both begin `at ` and would be swallowed by
 * the JavaScript pattern, so they are tried first. Anything that matches nothing is
 * skipped without comment — a paste is usually mostly prose.
 */
export function parseFrames(pasted: string): ErrorFrame[] {
  const frames: ErrorFrame[] = [];
  const lines = pasted.split(/\r?\n/);

  lines.forEach((raw, index) => {
    const net = NET_FRAME.exec(raw);
    if (net) {
      frames.push(frame(raw, net[2], net[3], null, net[1], 'dotnet', frames.length));
      return;
    }

    const java = JAVA_FRAME.exec(raw);
    if (java) {
      frames.push(frame(raw, java[2], java[3], null, java[1], 'java', frames.length));
      return;
    }

    const js = JS_FRAME.exec(raw);
    if (js) {
      frames.push(frame(raw, js[2], js[3], js[4], js[1] ?? null, 'javascript', frames.length));
      return;
    }

    const py = PY_FRAME.exec(raw);
    if (py) {
      frames.push(frame(raw, py[1], py[2], null, py[3] ?? null, 'python', frames.length));
      return;
    }

    const go = GO_LOCATION.exec(raw);
    if (go) {
      // Go prints the function on the line above the file it is in.
      const caller = GO_CALL.exec(lines[index - 1] ?? '');
      frames.push(frame(raw, go[1], go[2], null, caller?.[1] ?? null, 'go', frames.length));
    }
  });

  return frames;
}

function frame(
  raw: string,
  rawPath: string,
  line: string,
  column: string | null,
  functionName: string | null,
  language: TraceLanguage,
  order: number,
): ErrorFrame {
  return {
    raw: raw.trim(),
    rawPath: rawPath.trim(),
    line: Number(line),
    column: column === null ? null : Number(column),
    functionName: functionName?.trim() || null,
    language,
    order,
  };
}

// ---------------------------------------------------------------------------
// Putting a frame on the map
// ---------------------------------------------------------------------------

/** Directories whose contents are somebody else's code, whatever the language. */
const VENDORED = [
  'node_modules/',
  'site-packages/',
  'dist-packages/',
  '/vendor/',
  'go/pkg/mod/',
  '.nuget/',
  '.cargo/registry/',
  '.pub-cache/',
  'Pods/',
];

/** Frames the runtime made up: not files anybody can open. */
const RUNTIME_ONLY = ['node:', '<anonymous>', 'native', 'internal/', 'unknown location', '[native code]'];

function place(graph: AtlasGraph, frame: ErrorFrame): PlacedFrame {
  const blank: PlacedFrame = {
    frame,
    nodeId: null,
    nodeName: null,
    nodeKind: null,
    path: null,
    reason: null,
    candidates: [],
    nameDrifted: false,
  };

  const cleaned = cleanPath(frame.rawPath);
  if (RUNTIME_ONLY.some((mark) => cleaned.startsWith(mark) || cleaned === mark)) {
    return { ...blank, reason: 'runtime' };
  }
  if (VENDORED.some((mark) => cleaned.includes(mark))) return { ...blank, reason: 'dependency' };

  const matched = resolvePath(graph, cleaned);
  if (matched.length === 0) return { ...blank, reason: 'unknown-file' };
  if (matched.length > 1) return { ...blank, reason: 'ambiguous', candidates: matched };

  const node = graph.nodeAt(matched[0], frame.line);
  if (!node) return { ...blank, path: matched[0], reason: 'unknown-file' };

  return {
    frame,
    nodeId: node.id,
    nodeName: node.name,
    nodeKind: node.kind === 'function' ? 'function' : 'file',
    path: matched[0],
    reason: null,
    candidates: [],
    nameDrifted: node.kind === 'function' && namesDisagree(frame.functionName, node.name),
  };
}

/**
 * Whether the name the runtime printed and the name at that line are different things.
 *
 * Runtimes decorate the name with everything they know — `async`, the receiver, the
 * whole namespace — so only the last identifier is compared. Anonymous frames say
 * nothing to disagree with.
 */
function namesDisagree(printed: string | null, declared: string): boolean {
  if (!printed) return false;
  const bare = printed
    .replace(/^(?:async|new|get|set)\s+/, '')
    .replace(/\(.*\)$/, '')
    .split(/[.#]/)
    .filter(Boolean)
    .pop();
  if (!bare || bare === '<anonymous>' || bare.startsWith('<')) return false;
  return bare !== declared;
}

/**
 * A frame's path, reduced to something comparable with the atlas.
 *
 * Traces carry the same file a dozen ways — `file:///`, a Windows drive, a webpack
 * prefix, a percent-encoded space — and none of that changes which file it is.
 */
export function cleanPath(raw: string): string {
  let path = raw.trim();
  path = path.replace(/^\(+/, '').replace(/\)+$/, '');
  path = path.replace(/^(?:webpack-internal:\/\/\/|webpack:\/\/[^/]*\/?|rsc:\/\/[^/]*\/?)/, '');
  path = path.replace(/^file:\/\//, '');
  try {
    if (/%[0-9a-f]{2}/i.test(path)) path = decodeURIComponent(path);
  } catch {
    // A malformed escape is not worth failing the whole paste over.
  }
  path = path.replace(/\\/g, '/');
  path = path.replace(/^[a-zA-Z]:\//, '/');
  path = path.replace(/[?#].*$/, '');
  return path;
}

/**
 * Which file in this repo a frame's path means — none, one, or several.
 *
 * An exact repo-relative hit is the easy case. Everything else is matched by the tail
 * of the path, because a trace from a container, a CI box or a colleague's laptop has
 * an absolute prefix that never existed here. Matching on the tail is also how a
 * single ambiguous answer happens — a JVM frame gives `Shop.java` and nothing else —
 * and that case returns every candidate rather than picking, because picking is how
 * this feature would send somebody to the wrong file.
 */
export function resolvePath(graph: AtlasGraph, cleaned: string): string[] {
  const known = graph.filePaths();
  if (known.length === 0) return [];

  const withoutRoot = stripRoot(cleaned, graph.meta.root);
  const direct = new Set(known);
  if (direct.has(withoutRoot)) return [withoutRoot];

  const tail = withoutRoot.replace(/^\/+/, '');
  if (direct.has(tail)) return [tail];

  const hits = known.filter((path) => path === tail || path.endsWith(`/${tail}`));
  if (hits.length > 0) return dedupe(hits);

  // A bundled or aliased frame may only agree with the repo on the last segment or
  // two. Walk in from the left until something matches, so the longest agreement wins.
  const parts = tail.split('/').filter(Boolean);
  for (let start = 1; start < parts.length; start++) {
    const suffix = parts.slice(start).join('/');
    const found = known.filter((path) => path === suffix || path.endsWith(`/${suffix}`));
    if (found.length > 0) return dedupe(found);
  }
  return [];
}

function stripRoot(path: string, root: string): string {
  const normalRoot = root.replace(/\\/g, '/').replace(/\/+$/, '');
  if (normalRoot && path.startsWith(`${normalRoot}/`)) return path.slice(normalRoot.length + 1);
  return path;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)].sort();
}

// ---------------------------------------------------------------------------
// Walking back to the doors
// ---------------------------------------------------------------------------

/**
 * Every way in that can reach one piece of code, with the chain that proves it.
 *
 * Backwards along the same `references` edges the forward view follows, collecting a
 * door wherever one is attached to something on the way. All of them are returned,
 * nearest first: when four screens can reach the failing function, saying so is the
 * answer, and choosing one of them would be inventing a fact the code does not have.
 */
export function doorsReaching(
  graph: AtlasGraph,
  targetId: string,
): { doors: DoorReach[]; truncated: boolean } {
  const doorsById = new Map<string, DoorSummary>();
  for (const group of listDoors(graph).groups) {
    for (const door of group.doors) doorsById.set(door.id, door);
  }

  const cameFrom = new Map<string, string>();
  const weakest = new Map<string, Confidence>([[targetId, 'certain']]);
  const seen = new Set<string>([targetId]);
  const found = new Map<string, DoorReach>();
  let frontier = [targetId];
  let truncated = false;

  for (let hop = 0; hop <= MAX_BACK_HOPS && frontier.length > 0; hop++) {
    for (const id of frontier) collectDoors(graph, id, doorsById, found, cameFrom, weakest, targetId);

    const next: string[] = [];
    for (const id of frontier) {
      for (const edge of graph.edgesTo(id)) {
        if (edge.kind !== 'references' || seen.has(edge.fromId)) continue;
        const source = graph.getNodeById(edge.fromId);
        if (!source || (source.kind !== 'function' && source.kind !== 'file')) continue;
        if (seen.size >= MAX_BACK_VISITED) {
          truncated = true;
          break;
        }
        seen.add(edge.fromId);
        cameFrom.set(edge.fromId, id);
        weakest.set(edge.fromId, weaker(weakest.get(id) ?? 'certain', edge.confidence));
        next.push(edge.fromId);
      }
    }
    frontier = next;
  }

  const doors = [...found.values()].sort(
    (a, b) => a.hops - b.hops || rank(b.confidence) - rank(a.confidence) || a.door.name.localeCompare(b.door.name),
  );
  return { doors, truncated };
}

function collectDoors(
  graph: AtlasGraph,
  id: string,
  doorsById: Map<string, DoorSummary>,
  found: Map<string, DoorReach>,
  cameFrom: Map<string, string>,
  weakest: Map<string, Confidence>,
  targetId: string,
): void {
  for (const edge of graph.edgesTo(id)) {
    if (edge.kind !== 'exposed-by') continue;
    const door = doorsById.get(edge.fromId);
    if (!door || found.has(door.id)) continue;

    const chain = [door.id, ...pathBack(cameFrom, id, targetId)];
    found.set(door.id, {
      door,
      via: chain,
      viaNames: chain.map((step) => graph.getNodeById(step)?.name ?? step),
      hops: chain.length - 1,
      confidence: weaker(weakest.get(id) ?? 'certain', edge.confidence),
    });
  }
}

/** The route the walk took to get here, read back the way a reader would follow it. */
function pathBack(cameFrom: Map<string, string>, from: string, target: string): string[] {
  const chain = [from];
  let at = from;
  while (at !== target) {
    const next = cameFrom.get(at);
    if (!next || chain.includes(next)) break;
    chain.push(next);
    at = next;
  }
  return chain;
}

function weaker(a: Confidence, b: Confidence): Confidence {
  return rank(a) <= rank(b) ? a : b;
}

function rank(value: Confidence): number {
  return value === 'certain' ? 2 : value === 'likely' ? 1 : 0;
}
