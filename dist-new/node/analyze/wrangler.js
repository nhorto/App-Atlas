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
import { buildIgnoreMatcher } from './ignores.js';
const CONFIG_NAMES = ['wrangler.toml', 'wrangler.json', 'wrangler.jsonc'];
/**
 * A config that deploys code, as opposed to a Pages config that deploys files.
 *
 * The one place to ask the question, so no caller re-decides it as "has an entry file
 * on disk" and quietly stops finding Workers whose entry is built.
 */
export function isWorker(signal) {
    return !signal.isPages && signal.declaredEntry !== null;
}
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
 *
 * `SKIP_DIRS` is about where a config is worth looking for; `ignores` is about what the
 * caller said is not this app, and both have to hold. A wrangler config under an ignored
 * path is the sharpest version of the leak `ignores.ts` describes — it puts a route that
 * answers every URL on the map, and every store the config binds beside it.
 */
export function readWorkers(root, ignores = buildIgnoreMatcher(root), maxDepth = 3) {
    const out = [];
    const walk = (dir, depth) => {
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (ignores.ignores(full))
                continue;
            if (entry.isDirectory()) {
                if (depth >= maxDepth || SKIP_DIRS.has(entry.name) || entry.name.startsWith('.'))
                    continue;
                walk(full, depth + 1);
            }
            else if (CONFIG_NAMES.includes(entry.name)) {
                const signal = readOne(root, full);
                if (signal)
                    out.push(signal);
            }
        }
    };
    walk(root, 0);
    return out.sort((a, b) => a.configPath.localeCompare(b.configPath));
}
function readOne(root, absPath) {
    let text;
    try {
        text = fs.readFileSync(absPath, 'utf8');
    }
    catch {
        return null;
    }
    const configPath = toPosix(path.relative(root, absPath));
    const parsed = absPath.endsWith('.toml') ? readToml(text) : readJsonish(text);
    if (!parsed)
        return null;
    const main = typeof parsed.main === 'string' ? parsed.main : null;
    const isPages = typeof parsed.pages_build_output_dir === 'string';
    // A config that names neither a script nor a site is not a deploy target — a
    // fragment, or something else that happens to be called wrangler.toml.
    if (!main && !isPages)
        return null;
    return {
        name: typeof parsed.name === 'string' ? parsed.name : null,
        configPath,
        declaredEntry: main,
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
function resolveEntry(root, configAbs, main) {
    const base = path.dirname(configAbs);
    const candidates = [main, `${main}.ts`, `${main}.js`, path.join(main, 'index.ts'), path.join(main, 'index.js')];
    for (const candidate of candidates) {
        const abs = path.resolve(base, candidate);
        try {
            if (fs.statSync(abs).isFile())
                return toPosix(path.relative(root, abs));
        }
        catch {
            /* try the next shape */
        }
    }
    return null;
}
/** Which `[[...]]` table array means which kind of store. */
const BINDING_TABLES = {
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
function readToml(text) {
    const out = { crons: [], bindings: [] };
    let section = '';
    let current = null;
    let currentTable = '';
    const flush = () => {
        if (!current || !currentTable)
            return;
        const kind = BINDING_TABLES[currentTable];
        // `durable_objects.bindings` spells the env name `name`, everything else spells
        // it `binding`. Same idea, two conventions, both in the same file.
        const envName = current.binding ?? current.name;
        if (kind && envName !== undefined) {
            out.bindings.push({ name: envName, kind, target: bindingTarget(current), id: current.id ?? null });
        }
        current = null;
    };
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.replace(/(^|\s)#.*$/, '').trim();
        if (!line)
            continue;
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
        if (!pair)
            continue;
        const key = pair[1];
        const value = pair[2].trim();
        if (current) {
            const str = readTomlString(value);
            if (str !== null)
                current[key] = str;
            continue;
        }
        if (section === 'triggers' && key === 'crons') {
            out.crons.push(...readTomlStringArray(value));
            continue;
        }
        if (section !== '')
            continue; // top-level keys only
        const str = readTomlString(value);
        if (str === null)
            continue;
        if (key === 'main')
            out.main = str;
        else if (key === 'name')
            out.name = str;
        else if (key === 'pages_build_output_dir')
            out.pages_build_output_dir = str;
    }
    flush();
    return out;
}
function bindingTarget(entry) {
    return entry.class_name ?? entry.database_name ?? entry.bucket_name ?? entry.queue ?? null;
}
function readTomlString(value) {
    const match = /^["']([^"']*)["']$/.exec(value);
    return match ? match[1] : null;
}
function readTomlStringArray(value) {
    if (!value.startsWith('[') || !value.endsWith(']'))
        return [];
    const out = [];
    for (const part of value.slice(1, -1).split(',')) {
        const str = readTomlString(part.trim());
        if (str)
            out.push(str);
    }
    return out;
}
/** `wrangler.json` / `.jsonc` — the same keys, in a format we can hand to JSON.parse. */
function readJsonish(text) {
    const stripped = text
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1')
        .replace(/,(\s*[}\]])/g, '$1');
    let json;
    try {
        json = JSON.parse(stripped);
    }
    catch {
        return null;
    }
    const out = { crons: [], bindings: [] };
    if (typeof json.main === 'string')
        out.main = json.main;
    if (typeof json.name === 'string')
        out.name = json.name;
    if (typeof json.pages_build_output_dir === 'string') {
        out.pages_build_output_dir = json.pages_build_output_dir;
    }
    const triggers = json.triggers;
    if (triggers && Array.isArray(triggers.crons)) {
        out.crons.push(...triggers.crons.filter((c) => typeof c === 'string'));
    }
    const durable = json.durable_objects;
    collectJsonBindings(durable?.bindings, 'durable-object', out);
    collectJsonBindings(json.kv_namespaces, 'kv', out);
    collectJsonBindings(json.r2_buckets, 'r2', out);
    collectJsonBindings(json.d1_databases, 'd1', out);
    const queues = json.queues;
    collectJsonBindings(queues?.producers, 'queue', out);
    return out;
}
function collectJsonBindings(value, kind, out) {
    if (!Array.isArray(value))
        return;
    for (const raw of value) {
        if (!raw || typeof raw !== 'object')
            continue;
        const entry = raw;
        const name = typeof entry.binding === 'string' ? entry.binding : typeof entry.name === 'string' ? entry.name : null;
        if (!name)
            continue;
        const target = ['class_name', 'database_name', 'bucket_name', 'queue'].find((key) => typeof entry[key] === 'string');
        out.bindings.push({
            name,
            kind,
            target: target ? entry[target] : null,
            id: typeof entry.id === 'string' ? entry.id : null,
        });
    }
}
//# sourceMappingURL=wrangler.js.map