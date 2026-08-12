/**
 * @fileoverview Reading a frame that landed in build output back to the file it was written in.
 *
 * A trace from a running app almost never names a file anybody typed. It names
 * `index.android.bundle:1:483920`, or a hashed chunk under `.next/`, and every path in
 * this atlas is a path in the source tree — so the frame misses, and the feature that
 * was supposed to answer "where did this come from" says "no file here matches". That
 * is exactly the paste somebody most needs help with: the one from production.
 *
 * The build already wrote down the answer. A source map is the compiler's own record of
 * which original line each generated column came from, so using it keeps the promise the
 * rest of this feature makes — the path is computed, never guessed:
 *
 *   - The mapping is read from the map the build emitted. Nothing here infers a location
 *     from a name, and a position the map does not cover comes back as nothing rather
 *     than as the nearest thing.
 *   - Maps are found on disk, not asked for. They live in the build directories a repo
 *     usually ignores, which is why this walk deliberately ignores `.gitignore`.
 *   - When two maps could be the one — every chunk directory has an `index.js.map` — the
 *     frame is only placed if they agree. Picking one is how this sends somebody to a
 *     file that had nothing to do with the crash, which is the failure this whole
 *     feature exists to avoid.
 */
import fs from 'node:fs';
import path from 'node:path';
import fg from 'fast-glob';

/** A position in a file somebody actually wrote. */
export interface OriginalPosition {
  /** The source as the map records it, resolved against the map's own location. */
  source: string;
  /** 1-based, to match how every stack trace and editor counts. */
  line: number;
  /** 0-based, as source maps record it. */
  column: number;
  /** The original identifier, when the map kept one. Minifiers usually do. */
  name: string | null;
}

/** An original position, plus which map said so. */
export interface MappedPosition extends OriginalPosition {
  /** Repo-relative path of the map that answered. */
  mapPath: string;
}

/** Whatever can turn a generated position back into a written one. */
export interface SourceMapIndex {
  /**
   * @param bundlePath The frame's path, cleaned but otherwise as the trace wrote it.
   * @param line 1-based, as the trace wrote it.
   * @param column 1-based, as the trace wrote it. Null for runtimes that omit it.
   */
  lookup(bundlePath: string, line: number, column: number | null): MappedPosition | null;
}

/** Big enough for a React Native bundle's map, small enough not to be a memory bug. */
const MAX_MAP_BYTES = 64 * 1024 * 1024;

/** Maps to open for one frame before giving up. Only ever more than one on a tie. */
const MAX_MAPS_TRIED = 4;

/** Ceiling on the walk for map files, so a giant monorepo cannot stall a paste. */
const MAX_MAPS_FOUND = 2000;

/** Parsed maps, kept between pastes because re-reading 30MB per frame is not free. */
const PARSED = new Map<string, Lookup | null>();

/** How many parsed maps to hold. They are large; a couple is all one trace needs. */
const PARSED_KEPT = 4;

// ---------------------------------------------------------------------------
// Finding the map
// ---------------------------------------------------------------------------

/**
 * The source maps a project has on disk, looked for only when something needs one.
 *
 * Built fresh per paste on purpose: somebody tracing a bug rebuilds constantly, and a
 * map list cached at server start would be answering about a bundle that no longer
 * exists. The expensive half — parsing — is cached across pastes by path and mtime, so
 * the repeated cost is a directory walk rather than a 30MB JSON parse.
 */
export function bundleMaps(root: string): SourceMapIndex {
  return new BundleMaps(root);
}

class BundleMaps implements SourceMapIndex {
  private found: string[] | null = null;

  constructor(private readonly root: string) {}

  lookup(bundlePath: string, line: number, column: number | null): MappedPosition | null {
    const wanted = `${basename(bundlePath)}.map`;
    if (wanted === '.map') return null;

    const matches = this.all().filter((rel) => basename(rel) === wanted);
    if (matches.length === 0) return null;

    // Source maps sit next to what they describe, so the map whose path agrees with more
    // of the frame's path is the more likely one. Groups are tried best-first.
    const grouped = new Map<number, string[]>();
    for (const rel of matches) {
      const score = tailAgreement(rel, `${bundlePath}.map`);
      const group = grouped.get(score);
      if (group) group.push(rel);
      else grouped.set(score, [rel]);
    }

    let opened = 0;
    for (const score of [...grouped.keys()].sort((a, b) => b - a)) {
      const group = (grouped.get(score) ?? []).sort();
      const answers: MappedPosition[] = [];
      for (const rel of group) {
        if (opened >= MAX_MAPS_TRIED) return null;
        opened++;
        // Parsed against its repo-relative path: a map's sources are usually relative to
        // it, and resolving them against the absolute path would put every answer
        // outside the repo, where nothing can match it.
        const map = load(path.join(this.root, rel), rel);
        // Traces count lines from 1 and columns from 1; source maps count both from 0.
        const at = map?.originalFor(line - 1, (column ?? 1) - 1);
        if (at) answers.push({ ...at, mapPath: rel });
      }
      if (answers.length === 0) continue;
      // A tie only counts if the maps say the same thing. Where they disagree the honest
      // answer is that this atlas cannot tell which bundle the trace came from.
      if (answers.every((answer) => answer.source === answers[0].source && answer.line === answers[0].line)) {
        return answers[0];
      }
      return null;
    }
    return null;
  }

  private all(): string[] {
    if (this.found) return this.found;
    try {
      this.found = fg
        .sync('**/*.map', {
          cwd: this.root,
          absolute: false,
          // Build output lives in ignored, often dotted directories — `.next`, `.expo`,
          // `.output`. Skipping those is skipping every map worth having.
          dot: true,
          onlyFiles: true,
          followSymbolicLinks: false,
          suppressErrors: true,
          ignore: ['**/node_modules/**', '**/.git/**', '**/.app-atlas/**'],
        })
        .slice(0, MAX_MAPS_FOUND)
        .map((found) => found.replace(/\\/g, '/'));
    } catch {
      this.found = [];
    }
    return this.found;
  }
}

/** How many trailing path segments two paths share. */
function tailAgreement(a: string, b: string): number {
  const left = a.split('/').filter(Boolean).reverse();
  const right = b.split('/').filter(Boolean).reverse();
  let shared = 0;
  while (shared < left.length && shared < right.length && left[shared] === right[shared]) shared++;
  return shared;
}

function basename(value: string): string {
  return value.split('/').pop() ?? value;
}

function load(absolute: string, relative: string): Lookup | null {
  let key: string;
  try {
    const stat = fs.statSync(absolute);
    if (stat.size > MAX_MAP_BYTES) return null;
    key = `${absolute}:${stat.mtimeMs}:${stat.size}`;
  } catch {
    return null;
  }

  if (PARSED.has(key)) return PARSED.get(key) ?? null;

  let parsed: Lookup | null = null;
  try {
    parsed = parseSourceMap(fs.readFileSync(absolute, 'utf8'), relative);
  } catch {
    parsed = null;
  }

  if (PARSED.size >= PARSED_KEPT) {
    const oldest = PARSED.keys().next().value;
    if (oldest !== undefined) PARSED.delete(oldest);
  }
  PARSED.set(key, parsed);
  return parsed;
}

// ---------------------------------------------------------------------------
// Reading the map
// ---------------------------------------------------------------------------

/** Anything that can answer where a generated position came from. Both indices 0-based. */
export interface Lookup {
  originalFor(line: number, column: number): OriginalPosition | null;
}

interface RawMap {
  version?: number;
  sources?: (string | null)[];
  names?: string[];
  mappings?: string;
  sourceRoot?: string;
  sections?: { offset?: { line?: number; column?: number }; map?: RawMap }[];
}

/**
 * Turn the text of a source map into something that can be asked questions.
 *
 * @param mapPath Where the map was read from. Sources are usually written relative to
 *   it — tsc emits `../src/app.ts` — so without it half the answers point nowhere.
 */
export function parseSourceMap(text: string, mapPath = ''): Lookup | null {
  let raw: RawMap;
  try {
    raw = JSON.parse(text) as RawMap;
  } catch {
    return null;
  }
  return build(raw, mapPath);
}

function build(raw: RawMap, mapPath: string): Lookup | null {
  if (Array.isArray(raw.sections)) {
    const sections: { line: number; column: number; map: Lookup }[] = [];
    for (const section of raw.sections) {
      const inner = section.map ? build(section.map, mapPath) : null;
      if (!inner) continue;
      sections.push({
        line: section.offset?.line ?? 0,
        column: section.offset?.column ?? 0,
        map: inner,
      });
    }
    return sections.length > 0 ? new SectionedMap(sections) : null;
  }

  if (typeof raw.mappings !== 'string' || !Array.isArray(raw.sources)) return null;
  const dir = mapPath ? path.posix.dirname(mapPath.replace(/\\/g, '/')) : '';
  const sources = raw.sources.map((source) => locate(dir, raw.sourceRoot ?? '', source ?? ''));
  return new PlainMap(raw.mappings, sources, raw.names ?? []);
}

/**
 * Where a map's `sources` entry actually points.
 *
 * A relative source is relative to the map, which is how tsc, esbuild and Vite write
 * them, and resolving it gives the repo-relative path straight out. Anything already
 * absolute — or carrying a `webpack://` scheme — is left exactly as written for the
 * caller to make sense of; rewriting it against the map's directory would turn a path
 * that merely needs a prefix stripped into one that points somewhere real and wrong.
 */
function locate(dir: string, sourceRoot: string, source: string): string {
  let text = source.replace(/\\/g, '/');
  if (sourceRoot) {
    const root = sourceRoot.replace(/\\/g, '/').replace(/\/+$/, '');
    text = /^[a-zA-Z][\w+.-]*:\/\/|^\//.test(text) ? text : `${root}/${text}`;
  }
  if (/^[a-zA-Z][\w+.-]*:\/\//.test(text) || text.startsWith('/')) return text;
  return dir && dir !== '.' ? path.posix.normalize(`${dir}/${text}`) : path.posix.normalize(text);
}

/** An index map: several maps side by side, each covering a stretch of the output. */
class SectionedMap implements Lookup {
  constructor(private readonly sections: { line: number; column: number; map: Lookup }[]) {}

  originalFor(line: number, column: number): OriginalPosition | null {
    for (let index = this.sections.length - 1; index >= 0; index--) {
      const section = this.sections[index];
      if (line < section.line || (line === section.line && column < section.column)) continue;
      return section.map.originalFor(
        line - section.line,
        line === section.line ? column - section.column : column,
      );
    }
    return null;
  }
}

/** Five numbers per segment: generated column, source, line, column, name. */
const STRIDE = 5;
const EMPTY = new Int32Array(0);

/**
 * One ordinary source map, decoded a generated line at a time.
 *
 * Every field but the generated column is a delta against the previous segment *anywhere
 * in the file*, so a line cannot be decoded without the ones before it — which is why
 * this walks forward from wherever it left off rather than jumping. Minified output is
 * one enormous line, so in the case this exists for, "the ones before it" is none of them.
 */
class PlainMap implements Lookup {
  private readonly rows: string[];
  private readonly decoded: Int32Array[] = [];
  private cursor = 0;
  private carried = [0, 0, 0, 0];
  /** The first generated line that would not decode, after which nothing can be read. */
  private brokenFrom: number | null = null;

  constructor(
    mappings: string,
    private readonly sources: string[],
    private readonly names: string[],
  ) {
    this.rows = mappings.split(';');
  }

  originalFor(line: number, column: number): OriginalPosition | null {
    const row = this.rowAt(line);
    if (!row || row.length === 0 || column < 0) return null;

    let low = 0;
    let high = row.length / STRIDE - 1;
    let found = -1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (row[middle * STRIDE] <= column) {
        found = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    if (found < 0) return null;

    const at = found * STRIDE;
    // A one-field segment marks generated code that came from nothing — a runtime helper
    // the bundler injected. Saying so beats attaching it to whatever is nearby.
    if (row[at + 1] < 0) return null;
    const source = this.sources[row[at + 1]];
    if (source === undefined) return null;

    return {
      source,
      line: row[at + 2] + 1,
      column: row[at + 3],
      name: row[at + 4] >= 0 ? (this.names[row[at + 4]] ?? null) : null,
    };
  }

  private rowAt(line: number): Int32Array | null {
    if (line < 0 || line >= this.rows.length) return null;
    if (this.brokenFrom !== null && line >= this.brokenFrom) return null;

    while (this.cursor <= line) {
      const row = this.decodeRow(this.rows[this.cursor]);
      if (row === null) {
        // Everything past here is unreadable too, not just this line: the deltas this
        // row would have carried are gone, so every row after it would decode to
        // somewhere confident and wrong. The lines already decoded are still good.
        this.brokenFrom = this.cursor;
        return null;
      }
      this.decoded[this.cursor] = row;
      this.cursor++;
    }
    return this.decoded[line];
  }

  /** The decoded row, or null when it cannot be read and neither can anything after it. */
  private decodeRow(row: string): Int32Array | null {
    if (!row) return EMPTY;
    const out: number[] = [];
    let generated = 0;

    for (const piece of row.split(',')) {
      if (!piece) continue;
      const fields = decodeVlq(piece);
      // A segment that will not decode takes the whole line with it. Skipping just the
      // bad one looks tidier and is worse: every column on the line is a delta from the
      // one before, so dropping a delta silently shifts everything after it and the map
      // goes on answering — with a real file and a plausible line that is not the one.
      // A line nobody can read has to read as nothing.
      if (fields === null || fields.length === 0) return null;

      generated += fields[0];
      if (fields.length < 4) {
        out.push(generated, -1, -1, -1, -1);
        continue;
      }
      this.carried[0] += fields[1];
      this.carried[1] += fields[2];
      this.carried[2] += fields[3];
      let name = -1;
      if (fields.length >= 5) {
        this.carried[3] += fields[4];
        name = this.carried[3];
      }
      out.push(generated, this.carried[0], this.carried[1], this.carried[2], name);
    }
    return out.length > 0 ? Int32Array.from(out) : EMPTY;
  }
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const DIGITS = new Map<string, number>([...BASE64].map((char, value) => [char, value]));

/**
 * Read one comma-free segment of a `mappings` string into its numbers.
 *
 * Base64 VLQ: five bits of payload per character, low bit of the assembled value is the
 * sign, and the sixth bit says another character follows. Returns null rather than a
 * half-read segment when the text is not that, because a mapping decoded wrongly is a
 * confident answer pointing at the wrong line.
 *
 * Values are assembled with arithmetic instead of shifts: a generated column in a
 * megabyte-wide minified line runs past what `<<` handles once a delta needs six digits.
 */
export function decodeVlq(text: string): number[] | null {
  const out: number[] = [];
  let value = 0;
  let scale = 1;

  for (const char of text) {
    const digit = DIGITS.get(char);
    if (digit === undefined) return null;
    value += (digit & 31) * scale;
    if ((digit & 32) !== 0) {
      scale *= 32;
      continue;
    }
    const negative = value % 2 === 1;
    const magnitude = (value - (negative ? 1 : 0)) / 2;
    out.push(negative ? -magnitude : magnitude);
    value = 0;
    scale = 1;
  }

  // A trailing continuation bit means the segment was cut off mid-number.
  return scale === 1 ? out : null;
}

// ---------------------------------------------------------------------------
// Knowing when to bother
// ---------------------------------------------------------------------------

/** Directories a build writes into. None of them hold anything anybody typed. */
const BUILD_DIRS = [
  'dist/',
  'build/',
  'out/',
  '.next/',
  '_next/',
  '.output/',
  '.expo/',
  '.nuxt/',
  '.svelte-kit/',
  '.vercel/',
  'static/js/',
  'public/static/',
];

/**
 * Names a bundler gives its output.
 *
 * The last two are the content-hashed shapes Vite, Rollup and webpack emit — eight or
 * more characters of hash is not something anybody types into a filename.
 */
const BUILT_NAMES = [
  /\.bundle$/,
  /\.jsbundle$/,
  /\.min\.js$/,
  /\.chunk\.js$/,
  /^bundle[\w.-]*\.js$/,
  /^[\w-]+\.[0-9a-z]{8,}\.js$/,
  /^[\w.]+-[a-z0-9_-]{8,}\.js$/i,
];

/**
 * Whether a frame is pointing at build output rather than at a file somebody wrote.
 *
 * Worth asking twice over: once before looking anything up, because a repo that commits
 * its `dist/` would otherwise place the frame on the bundle and call that an answer;
 * and once after failing, to say "this is minified" rather than the misleading "no file
 * here matches that path".
 *
 * The last clause is the honest heuristic. It was once "a wide column on the first line
 * or two", which sounds right and misses: minifiers break output every few thousand
 * characters, so a real bundle frame arrives at line 41 as readily as line 1. The width
 * is the signal on its own — nobody writes past column 200 — and a false positive here
 * costs a map lookup that returns nothing, after which the frame is placed the ordinary
 * way regardless.
 *
 * @param line 1-based, and unused: kept because reading a signature that ignores where
 *   in the file the frame was is how somebody re-adds the line test that fails.
 */
export function looksBuilt(cleanedPath: string, line: number, column: number | null): boolean {
  void line;
  const lower = cleanedPath.toLowerCase();
  if (BUILD_DIRS.some((dir) => lower.includes(`/${dir}`) || lower.startsWith(dir))) return true;
  if (BUILT_NAMES.some((pattern) => pattern.test(basename(lower)))) return true;
  return (column ?? 0) >= 200;
}
