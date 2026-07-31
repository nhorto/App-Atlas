/**
 * @fileoverview Ports a Compose file says it publishes on the host machine.
 *
 * Every other door on this map comes from application code. This one does not: a
 * container port published by a deployment file is a listening socket with no handler
 * anywhere in the repo, so no amount of reading TypeScript or Python will ever find it.
 * A `postgres` service with `ports: - "5432:5432"` is a database reachable on the host,
 * and there is no auth check to look for because there is no code in front of it.
 *
 * The one distinction this file exists to get right:
 *
 *   ports:   - "5432:5432"   published on the host — a door
 *   expose:  - "5432"        reachable only by the other containers — not a door
 *
 * Reading the second as the first invents a door that is not there; reading the first
 * as the second hides one that is. Both are the over-claim CONTRIBUTING.md forbids, so
 * `expose:` is matched by name and dropped on purpose rather than left to fall through
 * some looser test that might one day widen.
 *
 * A Compose file is a *description of a deployment*, never evidence that anything is
 * running. Nobody may ever run it; a production deploy may publish something else
 * entirely. That is why every door built from this says which file declared it and what
 * that file says would happen — see `publishedPortDoorName` in `build.ts` — rather than
 * asserting that a port is open on anybody's server.
 *
 * The YAML reader here is deliberately small and deliberately not a dependency. It
 * understands the shape Compose actually uses — a top-level `services:` mapping, block
 * mappings, block sequences, one-line flow sequences, quoted and unquoted scalars,
 * comments, and `${VAR:-default}` interpolation — and skips anything else rather than
 * guessing at it. **It does not handle**: anchors, aliases and `<<:` merge keys, so a
 * service that inherits its `ports:` from a shared block contributes nothing; multiple
 * YAML documents in one file, of which only the first is read as it stands; flow
 * *mappings* (`ports: [{target: 80}]`); and files indented with tabs, which it refuses
 * outright because it cannot trust the nesting.
 *
 * Also deliberately not claimed:
 *   - `network_mode: host`, which puts every port a container listens on straight onto
 *     the host. It is a real exposure and the file never says which ports those are, so
 *     naming any of them would be inventing numbers.
 *   - whether the host is reachable from anywhere. A port bound to every interface is
 *     published by Docker; whether a firewall, a security group or a home router lets
 *     anyone reach it is not in this repo.
 *   - what is behind the port. The image is somebody else's build.
 *   - which of several Compose files somebody actually runs. They are read one at a
 *     time and never merged; see `readComposePorts`.
 *   - anything a Compose file under a test path declares. It stands fixtures up for a
 *     test run rather than describing a deploy; see `isTestScaffolding`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { toPosix } from '../../util/paths.js';
import { classifyZone } from '../zones.js';
import type { PublishedPort } from '../signals.js';

/** How the doors built from these files are labelled on screen. */
const DECLARED_BY = 'Docker Compose';

/**
 * The names Compose itself recognises, as a convention rather than a list of files.
 *
 * `compose.yaml` and `docker-compose.yml` are the canonical two; everything with a word
 * in the middle — `docker-compose.override.yml`, `compose.prod.yaml`,
 * `docker-compose.dev.yml` — is the variant convention every project reaches for the
 * moment it has more than one environment.
 */
const COMPOSE_FILE = /^(docker-)?compose(\.[A-Za-z0-9_.-]+)?\.ya?ml$/i;

/** Directories that never hold a deployment file worth reading. */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.app-atlas',
  'dist',
  'build',
  'out',
  '.next',
  '.venv',
  'venv',
  'coverage',
  'vendor',
]);

/**
 * Every port every Compose file in the tree says it publishes on the host.
 *
 * **`repoRoot` is the directory the user asked about; `appRoot` is the app inside it we
 * happened to focus on, and only the second is allowed to narrow anything.** App Atlas
 * lands a large repo on its main app (#34), so the analysis root for cal.com is
 * `packages/app-store/zoomvideo` and for the FastAPI template it is `backend/` — and a
 * search that started there would walk straight past the `docker-compose.yml` sitting at
 * the top of the repo, which is the only place the stack is described. So the *search*
 * starts at `repoRoot` and the *paths* are reported against `appRoot`, which keeps every
 * site in the atlas resolvable from the atlas's own root. `repoRoot` is never guessed at
 * by walking upwards: if somebody runs `app-atlas ./backend`, `./backend` is the whole
 * world and a file above it is out of bounds.
 *
 * Files are read **one at a time and never merged**, and that is the honest answer to a
 * repo with `compose.yml`, `compose.override.yml` and `compose.prod.yml` in it. Merging
 * them would mean knowing which ones somebody runs together, which nothing in the repo
 * records: `docker compose up` layers the base file with the override, `-f prod.yml`
 * replaces it, and a port that only the dev file publishes is a real door for whoever
 * runs the dev file and no door at all for whoever does not. So each declaration is
 * reported against the file that made it, and the reader is told which file that was —
 * rather than being handed one reconciled answer that no single file supports.
 *
 * Sub-directories are searched three deep: a monorepo keeps its stack in
 * `apps/api/docker-compose.yml` far more often than at the root. Hidden directories are
 * skipped, `.devcontainer/` among them — a dev container publishes ports on one
 * developer's laptop, which is the least deployment-like thing in any repo.
 */
export function readComposePorts(repoRoot: string, appRoot: string = repoRoot, maxDepth = 3): PublishedPort[] {
  const out: PublishedPort[] = [];

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
      } else if (COMPOSE_FILE.test(entry.name) && !isTestScaffolding(repoRoot, full)) {
        out.push(...readOne(appRoot, full));
      }
    }
  };

  walk(repoRoot, 0);
  return out.sort((a, b) => a.configPath.localeCompare(b.configPath) || a.line - b.line);
}

/**
 * Whether this file stands a stack up for a test run rather than describing a deploy.
 *
 * mealie's `tests/e2e/docker/docker-compose.yml` publishes an LDAP server on 10389 so
 * that a browser test has something to log in against. That is scaffolding, in the same
 * sense `.devcontainer/` is scaffolding for an editor: neither is a description of how
 * anybody ships this app, and both belong off a boundary view somebody briefs a customer
 * from. So the same rule applies to both.
 *
 * Decided with `classifyZone`, the classifier the rest of the tool already uses, rather
 * than a list of directory names invented here — which also means it is the *path* that
 * decides, not the filename. A root-level `docker-compose.test.yml` stays: `test` there
 * is the variant word in `compose.<env>.yml`, the same slot `prod` and `dev` sit in, and
 * the file is at the top of the repo where somebody runs it with `-f`.
 *
 * `build.ts` deliberately exempts *doors* from its own test filter, and this does not
 * contradict it: that rule protects a real route whose URL happens to contain the word
 * "test" (dub ships one). A Compose file's path is a location on disk, not an address
 * somebody types, so there is no equivalent case to protect.
 */
function isTestScaffolding(repoRoot: string, absPath: string): boolean {
  return classifyZone(toPosix(path.relative(repoRoot, absPath))) === 'test';
}

function readOne(appRoot: string, absPath: string): PublishedPort[] {
  let text: string;
  try {
    text = fs.readFileSync(absPath, 'utf8');
  } catch {
    return [];
  }

  const lines = readLines(text);
  if (!lines) return [];

  // Relative to the app being mapped, not to the repo, so that every path in the atlas
  // resolves from the same place. A stack described above a scoped app therefore reads
  // `../../docker-compose.yml`, which is ugly and true — and a bare `docker-compose.yml`
  // there would point at a file that is not where it says it is.
  const configPath = toPosix(path.relative(appRoot, absPath));
  const out: PublishedPort[] = [];

  // A file called `compose.yml` with no `services:` in it is a fragment, a template, or
  // something else that happens to share the name. Nothing is claimed about it.
  const servicesAt = lines.findIndex((line) => line.indent === 0 && line.text === 'services:');
  if (servicesAt === -1) return [];

  for (const serviceAt of childKeys(lines, servicesAt)) {
    const service = keyOf(lines[serviceAt]);
    if (!service) continue;

    for (const attrAt of childKeys(lines, serviceAt)) {
      const { key, value } = splitPair(lines[attrAt]) ?? { key: '', value: '' };
      // The whole point of the file. `expose` is named here so that a reader of this
      // code can see it was considered and refused, not merely forgotten.
      if (key === 'expose') continue;
      if (key !== 'ports') continue;

      for (const entry of sequenceItems(lines, attrAt, value)) {
        const port = entry.map ? longForm(entry.map) : shortForm(entry.scalar ?? '');
        if (!port) continue;
        out.push({
          ...port,
          declaredBy: DECLARED_BY,
          configPath,
          line: entry.line,
          raw: entry.raw,
          target: service,
        });
      }
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Port syntax
// ---------------------------------------------------------------------------

/** The parts of a port entry, before the file it came from is attached. */
type PortSpec = Pick<
  PublishedPort,
  'bindAddress' | 'hostPort' | 'hostPortVar' | 'containerPort' | 'protocol'
>;

/** A port number or a range of them, which is all a port field is allowed to be. */
const PORT_NUMBER = /^\d+(-\d+)?$/;

/**
 * The short form: `[[HOST_IP:]HOST_PORT:]CONTAINER_PORT[/PROTOCOL]`.
 *
 * Returns null for anything it cannot take apart with certainty. A port entry nobody
 * can read is worth less than nothing on a map whose job is to be trusted, so it is
 * dropped rather than half-understood.
 */
function shortForm(written: string): PortSpec | null {
  let rest = resolve(written).trim();
  if (!rest) return null;

  let protocol: 'tcp' | 'udp' = 'tcp';
  const proto = /\/(tcp|udp)$/i.exec(rest);
  if (proto) {
    protocol = proto[1].toLowerCase() as 'tcp' | 'udp';
    rest = rest.slice(0, proto.index);
  }

  // An IPv6 bind address is bracketed precisely because it is full of colons, so it has
  // to come off before anything is split on one.
  let bind: string | null = null;
  const bracketed = /^\[([^\]]*)\]:(.*)$/.exec(rest);
  if (bracketed) {
    bind = `[${bracketed[1]}]`;
    rest = bracketed[2];
  }

  const parts = rest.split(':');
  let host: string;
  let container: string;
  if (!bracketed && parts.length === 3) {
    bind = parts[0];
    host = parts[1];
    container = parts[2];
  } else if (parts.length === 2) {
    host = parts[0];
    container = parts[1];
  } else if (parts.length === 1) {
    host = '';
    container = parts[0];
  } else {
    return null;
  }

  return spec(bind, host, container, protocol);
}

/**
 * The long form: a mapping of `target`, `published`, `host_ip` and `protocol`.
 *
 * `published` may be missing, and when it is the platform picks a host port — the same
 * meaning as a bare `"3000"` in the short form, spelled out differently.
 */
function longForm(entry: Map<string, string>): PortSpec | null {
  const target = entry.get('target');
  if (target === undefined) return null;
  const protocol = entry.get('protocol')?.toLowerCase() === 'udp' ? 'udp' : 'tcp';
  return spec(entry.get('host_ip') ?? null, entry.get('published') ?? '', target, protocol);
}

/** The one place a bind address, a host port and a container port become a fact. */
function spec(
  bind: string | null,
  host: string,
  container: string,
  protocol: 'tcp' | 'udp',
): PortSpec | null {
  if (!PORT_NUMBER.test(container) && !container.includes('$')) return null;

  let hostPort: string | null = null;
  let hostPortVar: string | null = null;
  if (PORT_NUMBER.test(host)) {
    hostPort = host;
  } else if (host !== '') {
    // `${REDIS_PORT}` with no default: the port is published, and which number it lands
    // on is in somebody's `.env`. The door is real; the number is not ours to invent.
    const named = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(host);
    if (!named) return null;
    hostPortVar = named[1];
  }

  return {
    bindAddress: bind === null || bind === '' ? null : bind,
    hostPort,
    hostPortVar,
    containerPort: container,
    protocol,
  };
}

/**
 * Compose's `${VAR}` interpolation, resolved as far as the file itself allows.
 *
 * `${PORT:-8080}` carries its own default and resolves to `8080`. `${PORT}` and
 * `${PORT?must be set}` do not: their value lives in a `.env` file this tool does not
 * read, so they are left as a bare `$PORT` marker for the caller to describe honestly
 * instead of being filled in with a number nobody wrote.
 */
function resolve(written: string): string {
  return written.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::?([-?+])([^}]*))?\}/g,
    (_all, name: string, op: string | undefined, fallback: string | undefined) =>
      op === '-' ? (fallback ?? '') : `$${name}`,
  );
}

// ---------------------------------------------------------------------------
// Enough YAML for a Compose file
// ---------------------------------------------------------------------------

interface Line {
  /** Leading spaces. Nesting is decided by this and nothing else. */
  indent: number;
  /** The line with its indentation and any trailing comment removed. */
  text: string;
  /** 1-based line number, so a door can point at the line that declared it. */
  number: number;
}

/**
 * Splits a file into the lines that carry meaning, or returns null when the file cannot
 * be trusted to mean anything.
 *
 * Blank lines, comments and document markers go. So do the bodies of block scalars
 * (`command: |`), because their contents are free text — a `ports:` written inside a
 * shell script embedded in the file is not a port mapping, and reading it as one would
 * be a door out of thin air.
 */
function readLines(text: string): Line[] | null {
  const raw = text.split(/\r?\n/);
  const lines: Line[] = [];

  for (let i = 0; i < raw.length; i++) {
    const line = raw[i];
    const body = stripComment(line).replace(/\s+$/, '');
    if (body === '') continue;

    // A tab in the indentation is illegal YAML, and it makes every nesting decision
    // below a guess. Refusing the file says less than guessing wrong about it.
    if (/^ *\t/.test(body)) return null;

    const trimmed = body.trimStart();
    if (trimmed === '---' || trimmed === '...') continue;
    lines.push({ indent: body.length - trimmed.length, text: trimmed, number: i + 1 });
  }

  return dropBlockScalars(lines);
}

/** `key: |` and `- >` open a run of free text that is not structure. */
const BLOCK_SCALAR = /(:|^-)\s*[|>][+-]?\d*$/;

function dropBlockScalars(lines: Line[]): Line[] {
  const out: Line[] = [];
  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i]);
    if (!BLOCK_SCALAR.test(lines[i].text)) continue;
    while (i + 1 < lines.length && lines[i + 1].indent > lines[i].indent) i++;
  }
  return out;
}

/** A `#` starts a comment unless it is inside quotes or glued to the word before it. */
function stripComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quote) {
      if (char === '\\' && quote === '"') i++;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

/**
 * The indices of the keys directly inside the block that `parent` opens.
 *
 * "Directly inside" is exact equality of indentation, not "deeper than". Every key of
 * one YAML mapping starts in the same column, so a `ports:` nested under `deploy:` or
 * `develop:` sits further right and is correctly not a service's own `ports:`.
 */
function childKeys(lines: Line[], parent: number): number[] {
  const [start, end] = childRange(lines, parent);
  if (start === end) return [];
  let column = Infinity;
  for (let i = start; i < end; i++) column = Math.min(column, lines[i].indent);
  const keys: number[] = [];
  for (let i = start; i < end; i++) if (lines[i].indent === column) keys.push(i);
  return keys;
}

/** Where the block a key opens starts and stops. */
function childRange(lines: Line[], parent: number): [number, number] {
  const start = parent + 1;
  let end = start;
  while (end < lines.length && lines[end].indent > lines[parent].indent) end++;
  return [start, end];
}

/** `image: postgres:16` → `image` and `postgres:16`. The first colon wins. */
function splitPair(line: Line): { key: string; value: string } | null {
  const match = /^([^:\s][^:]*):(?:\s+(.*))?$/.exec(line.text);
  if (!match) return null;
  return { key: unquote(match[1].trim()), value: (match[2] ?? '').trim() };
}

/** A mapping key with no value on its own line — a service name, for instance. */
function keyOf(line: Line): string | null {
  const pair = splitPair(line);
  return pair && pair.value === '' ? pair.key : null;
}

/** One entry of a `ports:` list, however it was spelled. */
interface SequenceItem {
  line: number;
  /** Exactly what the file said, which is the evidence a reader is shown. */
  raw: string;
  /** Set for the short form: `"127.0.0.1:8080:80"`. */
  scalar?: string;
  /** Set for the long form: `target`, `published`, `host_ip`, `protocol`. */
  map?: Map<string, string>;
}

/**
 * The items of the list a key opens, in either of the two spellings Compose allows:
 * a block sequence of `- …` lines, or a one-line flow sequence `["8080:80"]`.
 *
 * A short-form entry is kept as **text**, never parsed as a number, and that is not an
 * implementation detail. Unquoted `22:22` is a legal YAML 1.1 sexagesimal integer, and
 * a reader that resolves it hands you the number 1342 instead of a port mapping — a
 * real and well-known way to get this exact feature wrong.
 */
function sequenceItems(lines: Line[], keyAt: number, inlineValue: string): SequenceItem[] {
  if (inlineValue.startsWith('[')) {
    return flowItems(inlineValue).map((raw) => ({
      line: lines[keyAt].number,
      raw,
      scalar: unquote(raw),
    }));
  }

  const items: SequenceItem[] = [];
  const [start, end] = childRange(lines, keyAt);
  let column = Infinity;
  for (let i = start; i < end; i++) column = Math.min(column, lines[i].indent);

  for (let i = start; i < end; i++) {
    const line = lines[i];
    if (line.indent !== column || !line.text.startsWith('-')) continue;
    const rest = line.text.slice(1).trim();

    // `- target: 5432` opens the long form. The test insists the key start with a
    // letter, which is exactly what keeps `- 5432:5432` out of it: a bare port mapping
    // is a scalar, and reading it as a `5432:` key would lose the door entirely.
    if (/^[A-Za-z_][A-Za-z0-9_-]*:(\s|$)/.test(rest)) {
      const map = new Map<string, string>();
      const first = splitPair({ ...line, text: rest });
      if (first) map.set(first.key, resolve(unquote(first.value)));
      let j = i + 1;
      for (; j < end && lines[j].indent > column; j++) {
        const pair = splitPair(lines[j]);
        if (pair) map.set(pair.key, resolve(unquote(pair.value)));
      }
      items.push({ line: line.number, raw: `- ${rest}`, map });
      i = j - 1;
      continue;
    }

    if (rest === '') continue;
    items.push({ line: line.number, raw: line.text, scalar: unquote(rest) });
  }

  return items;
}

/** `["8080:80", "443:443"]` — the only flow collection a `ports:` list ever uses. */
function flowItems(value: string): string[] {
  const close = value.lastIndexOf(']');
  return value
    .slice(1, close === -1 ? value.length : close)
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

function unquote(value: string): string {
  const match = /^(['"])([\s\S]*)\1$/.exec(value.trim());
  return match ? match[2] : value.trim();
}
