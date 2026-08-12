/**
 * @fileoverview The example trace shown in an empty paste box, built from this project.
 *
 * The box used to be prompted with a hardcoded stack from a wine-cellar app — `at
 * addBottle (lib/cellar.js:203:18)` — shown to every project that ever opened the Trace
 * tab (#214). It is only a placeholder, and it is greyed, and it is still the one place
 * in a tool built on "a path on screen is a path you can open" that showed a path nobody
 * could. On this repo it invited the reader to picture a file that does not exist here.
 *
 * So it is built out of the graph instead: a function this project declares and one that
 * names it, printed in the stack-trace dialect of the language they are written in. Every
 * path and every line number is read off the atlas, which means the example is a trace
 * this tool would actually place — that is what {@link exampleTrace} is tested against.
 *
 * **Real paths raise the stakes rather than lowering them.** A made-up path is confusing;
 * a real one, sitting in a box on a screen about errors, can read as a finding — as
 * though App Atlas had caught something. Nothing here is evidence of anything: the two
 * frames are the most-referenced function and one of its callers, and the error at the
 * top is a stock message for the language. So the screen says that in words next to the
 * box, and this file returns the pieces separately so it can.
 *
 * The column numbers are the one invented part. The atlas stores line ranges, not
 * columns, and every dialect that prints a column requires one to parse — so it is the
 * least-significant digit of a frame and it is labelled with the rest.
 */
import { isParked } from '../analyze/retired.js';
import type { TraceLanguage } from './errortrace.js';
import type { AtlasGraph } from './graph.js';
import type { AtlasNode } from './types.js';

/** A stack trace made of this project's own code, for an empty paste box. */
export interface ExampleTrace {
  /** The trace, ready to drop in the box. Innermost frame first, as a runtime prints it. */
  text: string;
  /** Which dialect it is written in, taken from the files it names. */
  language: TraceLanguage;
  /**
   * The `path:line` of each frame, innermost first. What the caller needs to say "these
   * came from your code" without parsing the text back apart.
   */
  frames: string[];
}

/**
 * What every dialect this can write needs: how to name a frame, and an error to head it.
 *
 * The error lines are the stock null-ish failure for each runtime, chosen because they
 * are the ones a reader recognises without reading — the sentence is scenery, and
 * anything more specific would be a claim about code this has not looked at.
 */
const DIALECTS: Record<
  TraceLanguage,
  { extensions: string[]; header: string; frame: (name: string, path: string, line: number) => string }
> = {
  javascript: {
    extensions: ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts'],
    header: 'TypeError: Cannot read properties of undefined',
    frame: (name, path, line) => `    at ${name} (${path}:${line}:1)`,
  },
  python: {
    extensions: ['.py'],
    header: 'TypeError: argument of type \'NoneType\' is not iterable',
    frame: (name, path, line) => `  File "${path}", line ${line}, in ${name}`,
  },
  go: {
    extensions: ['.go'],
    header: 'panic: runtime error: invalid memory address or nil pointer dereference',
    // Go prints the call on one line and the file it is in on the next, indented.
    frame: (name, path, line) => `${name}(0x0)\n\t${path}:${line} +0x1c`,
  },
  java: {
    extensions: ['.java', '.kt'],
    header: 'java.lang.NullPointerException',
    // The JVM prints a file name, never a path, so this one frame cannot carry the
    // folders — which is a fact about the dialect and not something lost here.
    frame: (name, path, line) => `\tat ${name}(${basename(path)}:${line})`,
  },
  dotnet: {
    extensions: ['.cs'],
    header: 'System.NullReferenceException: Object reference not set to an instance of an object.',
    frame: (name, path, line) => `   at ${name}() in ${path}:line ${line}`,
  },
};

/**
 * A stack trace built from this project, or `null` when there is nothing honest to build
 * one from.
 *
 * Null rather than a fallback on purpose: an atlas with no placeable functions in it —
 * a single config repo, a language tier that resolves no declarations — has nothing to
 * illustrate with, and the screen has a shape to show that does not name any file at all.
 */
export function exampleTrace(graph: AtlasGraph): ExampleTrace | null {
  const chosen = pickFrames(graph);
  if (!chosen) return null;

  const { language, nodes } = chosen;
  const dialect = DIALECTS[language];
  const lines = nodes.map((node) => dialect.frame(node.name, node.path as string, node.startLine as number));

  return {
    text: [dialect.header, ...lines].join('\n'),
    language,
    frames: nodes.map((node) => `${node.path}:${node.startLine}`),
  };
}

/**
 * The function to show, and whatever names it.
 *
 * Ranked by how many other functions reference it, which is the cheapest available answer
 * to "what would a reader recognise" — the code most of the project touches is the code
 * most likely to turn up in a real stack. It also tends to be reachable from a way in, so
 * the example is a trace that traces to something rather than one that dead-ends.
 *
 * Ties break on id so the same repo produces the same example every time. A placeholder
 * that shuffles between reloads reads as live output.
 */
function pickFrames(graph: AtlasGraph): { language: TraceLanguage; nodes: AtlasNode[] } | null {
  const candidates: { language: TraceLanguage; nodes: AtlasNode[] }[] = [];

  for (const node of graph.nodesOfKind('function')) {
    const language = usable(node);
    if (!language) continue;

    const callers = graph
      .edgesTo(node.id)
      .filter((edge) => edge.kind === 'references')
      .map((edge) => graph.getNodeById(edge.fromId))
      .filter((from): from is AtlasNode => Boolean(from))
      .filter((from) => from.id !== node.id && usable(from) === language)
      .sort((a, b) => a.id.localeCompare(b.id));

    candidates.push({ language, nodes: callers.length === 0 ? [node] : [node, callers[0]] });
  }

  if (candidates.length === 0) return null;

  // A pair beats a lone frame however popular the lone one is: two frames are what makes
  // the thing in the box read as a stack rather than as a line of log. Among pairs, and
  // among singles, the most-referenced wins, and identical scores break on id so the same
  // repo produces the same example on every reload.
  const score = (node: AtlasNode) => graph.edgesTo(node.id).filter((edge) => edge.kind === 'references').length;
  candidates.sort(
    (a, b) =>
      b.nodes.length - a.nodes.length ||
      score(b.nodes[0]) - score(a.nodes[0]) ||
      a.nodes[0].id.localeCompare(b.nodes[0].id),
  );
  return candidates[0];
}

/**
 * Whether a node can appear in the example, and in which dialect.
 *
 * Functions only, and the check is load-bearing on the caller side rather than obvious:
 * a `references` edge can arrive from a file node, which has a path and a start line of 1
 * like everything else, and printing one gives `at build.ts (src/analyze/boundaries/build.ts:1:1)`
 * — a file wearing a function's clothes, in the one box on this screen where the reader
 * is being shown what a frame looks like. Caught by running this against this repo.
 *
 * The rest is excluded for the reason "where to look first" excludes it: a test is not
 * where the app lives, and a parked file is the last place to send anybody.
 */
function usable(node: AtlasNode): TraceLanguage | null {
  if (node.kind !== 'function') return null;
  if (node.zone === 'test' || !node.path || node.startLine === null) return null;
  if (isParked(node.path)) return null;
  if (!node.name || node.name.includes(' ')) return null;
  return dialectOf(node.path);
}

function dialectOf(path: string): TraceLanguage | null {
  const dot = path.lastIndexOf('.');
  if (dot === -1) return null;
  const extension = path.slice(dot).toLowerCase();
  for (const [language, dialect] of Object.entries(DIALECTS)) {
    if (dialect.extensions.includes(extension)) return language as TraceLanguage;
  }
  return null;
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}
