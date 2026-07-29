/**
 * @fileoverview Cloudflare Workers, read out of `wrangler.toml`.
 *
 * A Worker is a door that no amount of AST walking would find, because nothing in the
 * repo calls it: the platform does. The config file is the only place that says "this
 * script answers requests on the internet", and until we read it App Atlas would state,
 * in writing, that an app deployed to the edge had no network surface at all.
 *
 * Two deploy shapes share the one file name and are not the same thing:
 *
 *   main = "index.ts"              a Worker — a fetch handler, and code that runs
 *   pages_build_output_dir = "…"   Pages — a static site, no handler of its own
 *
 * Both answer URLs, so both matter, but only the first is code in this repo that runs
 * on a request. Conflating them would put a door on a folder of HTML.
 *
 * The TOML here is deliberately a small hand-rolled reader rather than a dependency:
 * we need six keys out of a config file, the grammar those keys use is flat, and a
 * parser we control fails softly on the parts we do not understand. Anything it cannot
 * make sense of is skipped, never guessed at.
 */
import fs from 'node:fs';
import path from 'node:path';
import { toPosix } from '../util/paths.js';

export interface WorkerBinding {
  /** The name the code sees on `env` — `LIVE`, `MY_KV`. */
  name: string;
  /** `durable-object` | `kv` | `r2` | `d1` | `queue` | `ai` | `vectorize`. */
  kind: string;
  /** The class, namespace or bucket on the other end, when the config names one. */
  target: string | null;
}

export interface WorkerSignal {
  /** The Worker's name in the config — what it is called in the dashboard. */
  name: string | null;
  /** Repo-relative path of the config file. */
  configPath: string;
  /**
   * Repo-relative path of the entry script, resolved against the config's own folder
   * and only when the file is really there. A `main` pointing at a build artifact that
   * does not exist yet must not put a phantom file on the map.
   */
  entry: string | null;
  /** Cron expressions from `[triggers] crons`. */
  crons: string[];
  bindings: WorkerBinding[];
  /** Pages, not a Worker: a static site with no fetch handler of its own. */
  isPages: boolean;
}

const CONFIG_NAMES = ['wrangler.toml', 'wrangler.json', 'wrangler.jsonc'];

/** Directories that never hold a config worth reading. */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.app-atlas',
  'dist',
  'build',
  'out',
  '.next',
  '.wrangler',
  '.venv',
  'venv',
  'coverage',
  'vendor',
]);

/**
 * Finds every wrangler config in the tree, not just the one at the root: a repo that
 * keeps its Worker in `worker/` — beside a Pages config at the top — is the normal
 * shape, and reading only the root would find the static site and miss the code.
 */
export function readWorkers(root: string, maxDepth = 3): WorkerSignal[] {
  const out: WorkerSignal[] = [];

  const walk = (dir: string, depth: number): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth >= maxDepth || SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        walk(full, depth + 1);
      } else if (CONFIG_NAMES.includes(entry.name)) {
        const signal = readOne(root, full);
        if (signal) out.push(signal);
      }
    }
  };

  walk(root, 0);
  return out.sort((a, b) => a.configPath.localeCompare(b.configPath));
}

function readOne(root: string, absPath: string): WorkerSignal | null {
  let text: string;
  try {
    text = fs.readFileSync(absPath, 'utf8');
  } catch {
    return null;
  }

  const configPath = toPosix(path.relative(root, absPath));
  const parsed = absPath.endsWith('.toml') ? readToml(text) : readJsonish(text);
  if (!parsed) return null;

  const main = typeof parsed.main === 'string' ? parsed.main : null;
  const isPages = typeof parsed.pages_build_output_dir === 'string';
  // A config that names neither a script nor a site is not a deploy target — a
  // fragment, or something else that happens to be called wrangler.toml.
  if (!main && !isPages) return null;

  return {
    name: typeof parsed.name === 'string' ? parsed.name : null,
    configPath,
    entry: main ? resolveEntry(root, absPath, main) : null,
    crons: parsed.crons ?? [],
    bindings: parsed.bindings ?? [],
    isPages,
  };
}

/**
 * `main` is relative to the config file, not to the repo root. Returns null unless the
 * file is actually on disk: a Worker built from TypeScript may name a `dist/` artifact
 * that only exists after a build, and a door hung on a file nobody can open is worse
 * than no door at all.
 */
function resolveEntry(root: string, configAbs: string, main: string): string | null {
  const base = path.dirname(configAbs);
  const candidates = [main, `${main}.ts`, `${main}.js`, path.join(main, 'index.ts'), path.join(main, 'index.js')];
  for (const candidate of candidates) {
    const abs = path.resolve(base, candidate);
    try {
      if (fs.statSync(abs).isFile()) return toPosix(path.relative(root, abs));
    } catch {
      /* try the next shape */
    }
  }
  return null;
}

interface ParsedConfig {
  main?: string;
  name?: string;
  pages_build_output_dir?: string;
  crons?: string[];
  bindings?: WorkerBinding[];
}

/** Which `[[...]]` table array means which kind of store. */
const BINDING_TABLES: Record<string, string> = {
  'durable_objects.bindings': 'durable-object',
  kv_namespaces: 'kv',
  r2_buckets: 'r2',
  d1_databases: 'd1',
  'queues.producers': 'queue',
  vectorize: 'vectorize',
  hyperdrive: 'hyperdrive',
};

/**
 * Enough TOML for a wrangler config: top-level `key = "value"`, `[section]` headers,
 * `[[section]]` table arrays, and single-line string arrays. Multi-line arrays and
 * inline tables are skipped rather than half-read.
 */
function readToml(text: string): ParsedConfig {
  const out: ParsedConfig = { crons: [], bindings: [] };
  let section = '';
  let current: Record<string, string> | null = null;
  let currentTable = '';

  const flush = () => {
    if (!current || !currentTable) return;
    const kind = BINDING_TABLES[currentTable];
    if (kind && current.binding !== undefined) {
      out.bindings!.push({ name: current.binding, kind, target: bindingTarget(current) });
    } else if (kind && current.name !== undefined) {
      // `durable_objects.bindings` spells the env name `name`, everything else spells
      // it `binding`. Same idea, two conventions, both in the same file.
      out.bindings!.push({ name: current.name, kind, target: bindingTarget(current) });
    }
    current = null;
  };

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, '').trim();
    if (!line) continue;

    const tableArray = /^\[\[([^\]]+)\]\]$/.exec(line);
    if (tableArray) {
      flush();
      currentTable = tableArray[1].trim();
      section = currentTable;
      current = {};
      continue;
    }

    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      flush();
      section = header[1].trim();
      currentTable = '';
      continue;
    }

    const pair = /^([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*(.+)$/.exec(line);
    if (!pair) continue;
    const key = pair[1];
    const value = pair[2].trim();

    if (current) {
      const str = readTomlString(value);
      if (str !== null) current[key] = str;
      continue;
    }

    if (section === 'triggers' && key === 'crons') {
      out.crons!.push(...readTomlStringArray(value));
      continue;
    }

    if (section !== '') continue; // top-level keys only
    const str = readTomlString(value);
    if (str === null) continue;
    if (key === 'main') out.main = str;
    else if (key === 'name') out.name = str;
    else if (key === 'pages_build_output_dir') out.pages_build_output_dir = str;
  }
  flush();
  return out;
}

function bindingTarget(entry: Record<string, string>): string | null {
  return entry.class_name ?? entry.database_name ?? entry.bucket_name ?? entry.queue ?? entry.id ?? null;
}

function readTomlString(value: string): string | null {
  const match = /^["']([^"']*)["']$/.exec(value);
  return match ? match[1] : null;
}

function readTomlStringArray(value: string): string[] {
  if (!value.startsWith('[') || !value.endsWith(']')) return [];
  const out: string[] = [];
  for (const part of value.slice(1, -1).split(',')) {
    const str = readTomlString(part.trim());
    if (str) out.push(str);
  }
  return out;
}

/** `wrangler.json` / `.jsonc` — the same keys, in a format we can hand to JSON.parse. */
function readJsonish(text: string): ParsedConfig | null {
  const stripped = text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/,(\s*[}\]])/g, '$1');
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(stripped) as Record<string, unknown>;
  } catch {
    return null;
  }

  const out: ParsedConfig = { crons: [], bindings: [] };
  if (typeof json.main === 'string') out.main = json.main;
  if (typeof json.name === 'string') out.name = json.name;
  if (typeof json.pages_build_output_dir === 'string') {
    out.pages_build_output_dir = json.pages_build_output_dir;
  }

  const triggers = json.triggers as { crons?: unknown } | undefined;
  if (triggers && Array.isArray(triggers.crons)) {
    out.crons!.push(...triggers.crons.filter((c): c is string => typeof c === 'string'));
  }

  const durable = json.durable_objects as { bindings?: unknown } | undefined;
  collectJsonBindings(durable?.bindings, 'durable-object', out);
  collectJsonBindings(json.kv_namespaces, 'kv', out);
  collectJsonBindings(json.r2_buckets, 'r2', out);
  collectJsonBindings(json.d1_databases, 'd1', out);
  const queues = json.queues as { producers?: unknown } | undefined;
  collectJsonBindings(queues?.producers, 'queue', out);

  return out;
}

function collectJsonBindings(value: unknown, kind: string, out: ParsedConfig): void {
  if (!Array.isArray(value)) return;
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as Record<string, unknown>;
    const name = typeof entry.binding === 'string' ? entry.binding : typeof entry.name === 'string' ? entry.name : null;
    if (!name) continue;
    const target = ['class_name', 'database_name', 'bucket_name', 'queue', 'id'].find(
      (key) => typeof entry[key] === 'string',
    );
    out.bindings!.push({ name, kind, target: target ? (entry[target] as string) : null });
  }
}
