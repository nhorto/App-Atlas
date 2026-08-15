/**
 * @fileoverview Project-level signals: the facts that live in config files, not code.
 *
 * A surprising amount of an app's boundary is declared outside the source: cron
 * schedules in `vercel.json`, the database engine in `schema.prisma`, the intended
 * configuration in `.env.example`. Reading them costs milliseconds and tells us
 * things no amount of AST walking would.
 *
 * Everything here is best-effort and non-fatal — a malformed config file must never
 * stop the analysis.
 */
import fs from 'node:fs';
import path from 'node:path';
import { readComposePorts } from './boundaries/compose.js';
import { buildIgnoreMatcher } from './ignores.js';
import { parseSqlMigrations } from './sql.js';
import { readWorkers } from './wrangler.js';
/**
 * Everything the config files say, for one app.
 *
 * `repoRoot` is the directory the user asked about and defaults to `root`, the app being
 * mapped. The two differ only when this run has narrowed to one app inside a bigger repo,
 * and exactly one signal cares: a deployment file describes the whole stack and lives at
 * the top of the repo, while everything else here — the `.env.example`, the Prisma
 * schema, the wrangler config — belongs to the app that owns it and is read from `root`
 * as it always was.
 *
 * `ignores` is the caller's `--ignore` list, compiled. Every reader below consults it,
 * including the ones that open a single file at a known path: a signal is a *fact about
 * this app*, and a path the caller said is not this app cannot supply one. Nothing here
 * enforced that for a long time — every reader walks the tree itself, so a fixture tree
 * no source scan would touch was still naming the frameworks in the summary.
 */
export function readSignals(root, packageJson, repoRoot = root, ignores = buildIgnoreMatcher(root)) {
    const packages = readPackages(packageJson);
    const prisma = readPrismaSchema(root, ignores);
    return {
        packages,
        nextAppDir: packages.has('next') ? firstExistingDir(root, ['app', 'src/app'], ignores) : null,
        nextPagesDir: packages.has('next') ? firstExistingDir(root, ['pages', 'src/pages'], ignores) : null,
        // Expo Router owns `app/` the same way Next's App Router does, but declares itself
        // through the dependency rather than a config file. Same candidate dirs.
        expoRouterDir: packages.has('expo-router') ? firstExistingDir(root, ['app', 'src/app'], ignores) : null,
        // SvelteKit's route tree can be moved in `svelte.config.js`, which is a JavaScript
        // module this layer will not execute. The default is what all but a handful of
        // projects use, and a directory that is not there produces no signal at all.
        svelteKitRoutesDir: packages.has('@sveltejs/kit')
            ? firstExistingDir(root, ['src/routes', 'routes'], ignores)
            : null,
        remixRoutesDir: hasRemix(packages) ? firstExistingDir(root, ['app/routes'], ignores) : null,
        crons: readVercelCrons(root, ignores),
        workers: readWorkers(root, ignores),
        publishedPorts: readComposePorts(repoRoot, root, ignores),
        prisma,
        // When Prisma is present its migrations are generated from schema.prisma, so
        // reading both would declare every table twice.
        sqlSchema: readSqlSchema(root, prisma !== null, ignores),
        ...readPythonPackages(root, ignores),
        ...readGoModule(root, ignores),
        ...readDotnetProjects(root, ignores),
        ...(() => {
            const cargo = readCargoManifests(root, ignores);
            return { cargoPackages: cargo.packages, cargoBinaries: cargo.binaries };
        })(),
        ...readEnvExample(root, ignores),
        declaresAPackage: readsAsAPackage(root, packageJson, ignores),
        entryPoints: readEntryPoints(root, packageJson, ignores),
    };
}
/** The manifest fields that name one file each, in the order a reader would look. */
const ENTRY_FIELDS = ['main', 'module', 'browser', 'types', 'typings', 'source'];
/**
 * Every file a manifest says is a way in.
 *
 * Four kinds of declaration, all of them saying the same thing in different words: this
 * file is started by something that is not in the source tree. `main` and the `exports`
 * map are for whoever installs the package; `bin` is for whoever runs it; a script is
 * for whoever develops it; and Python's console scripts are all three at once.
 *
 * Paths inside script commands are picked out by their extension rather than by parsing
 * a shell line, because a shell line has no grammar worth the name and the cost of
 * missing one is a file mentioned that should not have been.
 */
function readEntryPoints(root, pkg, ignores) {
    const out = [];
    const add = (value, field, command) => {
        if (typeof value !== 'string' || value === '')
            return;
        const normalized = value.replace(/^\.\//, '');
        const existing = out.find((entry) => entry.path === normalized && entry.field === field);
        if (existing) {
            existing.command ??= command;
            return;
        }
        out.push(command ? { path: normalized, field, command } : { path: normalized, field });
    };
    if (pkg) {
        for (const field of ENTRY_FIELDS)
            add(pkg[field], field);
        // `bin` is the one npm field whose *key* is a word somebody types.
        const bin = pkg.bin;
        if (typeof bin === 'string')
            add(bin, 'bin', typeof pkg.name === 'string' ? pkg.name : undefined);
        else if (bin && typeof bin === 'object') {
            for (const [name, value] of Object.entries(bin))
                add(value, 'bin', name);
        }
        // An `exports` map nests conditions arbitrarily deep — `{".": {"import": {"types":
        // "./x.d.ts"}}}` — and every string at the bottom of it is a real entry point.
        const walk = (value, depth) => {
            if (depth > 6)
                return;
            if (typeof value === 'string')
                return add(value, 'exports');
            if (Array.isArray(value))
                return value.forEach((item) => walk(item, depth + 1));
            if (value && typeof value === 'object') {
                for (const item of Object.values(value))
                    walk(item, depth + 1);
            }
        };
        walk(pkg.exports, 0);
        const scripts = pkg.scripts;
        if (scripts && typeof scripts === 'object') {
            for (const [name, command] of Object.entries(scripts)) {
                if (typeof command !== 'string')
                    continue;
                for (const match of command.matchAll(/(?:^|[\s'"=([])([\w./@-]+\.(?:[cm]?[jt]sx?|py))(?=$|[\s'")\];])/g)) {
                    add(match[1], `scripts.${name}`);
                }
            }
        }
    }
    // `mytool = "mypkg.cli:main"` — the module before the colon is a real file, and it is
    // the one thing in a Python project that is started from outside the source tree and
    // says so in writing.
    const pyproject = readableFile(root, 'pyproject.toml', ignores);
    if (pyproject) {
        let inScripts = false;
        for (const line of splitLines(readText(pyproject))) {
            const section = /^\s*\[([^\]]+)\]/.exec(line);
            if (section) {
                inScripts = /(^|\.)scripts$/.test(section[1]) || /gui-scripts$/.test(section[1]);
                continue;
            }
            if (!inScripts)
                continue;
            const target = /=\s*["']([A-Za-z0-9_.]+)\s*:/.exec(line);
            const named = /^\s*([A-Za-z0-9_.-]+)\s*=/.exec(line);
            if (target)
                add(`${target[1].split('.').join('/')}.py`, 'project.scripts', named?.[1]);
        }
    }
    return out;
}
/**
 * The packages that mean "this repo lets a framework own its route files".
 *
 * `react-router` on its own is deliberately not one of them. Half the single-page apps
 * ever written depend on it and route inside the browser, where no file is a door — so
 * the declaration that matters is the framework-mode package (`@react-router/dev` and
 * friends), which is what turns `app/routes/` into a server.
 */
const REMIX_PACKAGES = [
    '@remix-run/node',
    '@remix-run/react',
    '@remix-run/serve',
    '@remix-run/server-runtime',
    '@remix-run/cloudflare',
    '@remix-run/deno',
    '@react-router/dev',
    '@react-router/node',
    '@react-router/serve',
];
/** Whether the project depends on Remix, or on React Router running as a framework. */
function hasRemix(packages) {
    return REMIX_PACKAGES.some((name) => packages.has(name));
}
/**
 * Whether this repo says, in a manifest, that it is meant to be installed and imported.
 *
 * `psf/requests` has two files with `if __name__ == "__main__":` in them, left over from
 * debugging, and that was enough to classify the most-imported library in Python as
 * "Something you run". Counting entry points cannot separate those two files from the
 * thirty-five around them; the `setup.py` sitting beside them says it outright.
 *
 * `requirements.txt` is deliberately not a signal. It lists what this code needs, which
 * every script also has, and says nothing about what anybody does with this code.
 */
function readsAsAPackage(root, packageJson, ignores) {
    if (readableFile(root, 'setup.py', ignores) || readableFile(root, 'setup.cfg', ignores))
        return true;
    const pyproject = readableFile(root, 'pyproject.toml', ignores);
    if (pyproject) {
        const text = readText(pyproject);
        if (/^\s*\[project\]/m.test(text) || /^\s*\[tool\.poetry\]/m.test(text))
            return true;
    }
    // `private: true` is not consulted. It means "do not publish to the registry", which
    // every internal package in a monorepo says, and `cal.com/packages/ui` is a component
    // library whether or not npm has heard of it. An `exports` field is the declaration
    // that matters: it says where to import this from.
    if (!packageJson)
        return false;
    return ['main', 'module', 'exports', 'types'].some((field) => packageJson[field] !== undefined);
}
/** The migration folders projects actually use. Checked, not globbed — a glob over an
 * unknown repo can wander into gigabytes of vendored code for three .sql files. */
const MIGRATION_DIRS = [
    'supabase/migrations',
    'migrations',
    'db/migrations',
    'database/migrations',
    'sql/migrations',
    'drizzle',
    'drizzle/migrations',
    'prisma/migrations',
];
const MAX_MIGRATION_FILES = 400;
/**
 * Reads the schema out of SQL migrations, replayed in filename order — which is
 * application order, because every migration tool timestamps its filenames precisely
 * so that lexical order is run order.
 */
export function readSqlSchema(root, hasPrisma, ignores = buildIgnoreMatcher(root)) {
    const files = [];
    for (const dir of MIGRATION_DIRS) {
        if (hasPrisma && dir === 'prisma/migrations')
            continue;
        const abs = path.join(root, dir);
        if (ignores.ignores(abs))
            continue;
        let entries;
        try {
            entries = fs.readdirSync(abs, { withFileTypes: true, recursive: true });
        }
        catch {
            continue;
        }
        const sqlFiles = entries
            .filter((e) => e.isFile() && e.name.endsWith('.sql'))
            .map((e) => path.join(e.parentPath, e.name))
            .filter((file) => !ignores.ignores(file))
            .sort()
            .slice(0, MAX_MIGRATION_FILES);
        for (const absFile of sqlFiles) {
            try {
                files.push({
                    path: path.relative(root, absFile).split(path.sep).join('/'),
                    text: fs.readFileSync(absFile, 'utf8'),
                });
            }
            catch {
                // A single unreadable migration must not cost the rest of the schema.
            }
        }
    }
    if (files.length === 0)
        return null;
    const parsed = parseSqlMigrations(files);
    if (parsed.tables.length === 0 && parsed.orphanPolicies.length === 0)
        return null;
    return { tables: parsed.tables, orphanPolicies: parsed.orphanPolicies, files: files.map((f) => f.path) };
}
/**
 * Python dependencies, from whichever manifest the project uses.
 *
 * Deliberately a lexer rather than a parser: `requirements.txt` has no grammar worth
 * the name, and pyproject.toml would cost a TOML dependency to read three lines out of.
 * All that is needed is the set of distribution names, and a line-by-line read of
 * either file gets that right.
 */
function readPythonPackages(root, ignores) {
    const packages = new Set();
    let manifest = null;
    for (const name of ['requirements.txt', 'requirements-dev.txt', 'requirements/base.txt']) {
        const file = readableFile(root, name, ignores);
        if (!file)
            continue;
        manifest ??= name;
        for (const line of splitLines(readText(file))) {
            const stripped = line.split('#')[0].trim();
            if (!stripped || stripped.startsWith('-'))
                continue;
            const match = /^([A-Za-z0-9._-]+)/.exec(stripped);
            if (match)
                packages.add(normalizeDistribution(match[1]));
        }
    }
    const pyproject = readableFile(root, 'pyproject.toml', ignores);
    if (pyproject) {
        manifest ??= 'pyproject.toml';
        // Covers both spellings: PEP 621 `dependencies = ["fastapi>=0.1"]` and Poetry's
        // `[tool.poetry.dependencies]` table of `fastapi = "^0.1"`.
        for (const line of splitLines(readText(pyproject))) {
            const quoted = /^\s*["']([A-Za-z0-9._-]+)\s*[<>=!~\[;]/.exec(line);
            if (quoted)
                packages.add(normalizeDistribution(quoted[1]));
            const bare = /^\s*["']?([A-Za-z0-9._-]+)["']?\s*=\s*["{]/.exec(line);
            if (bare && bare[1].toLowerCase() !== 'python')
                packages.add(normalizeDistribution(bare[1]));
            const plain = /^\s*["']([A-Za-z0-9._-]+)["']\s*,?\s*$/.exec(line);
            if (plain)
                packages.add(normalizeDistribution(plain[1]));
        }
    }
    const pipfile = readableFile(root, 'Pipfile', ignores);
    if (pipfile) {
        manifest ??= 'Pipfile';
        for (const line of splitLines(readText(pipfile))) {
            const match = /^\s*["']?([A-Za-z0-9._-]+)["']?\s*=\s*/.exec(line);
            if (match && match[1].toLowerCase() !== 'python_version')
                packages.add(normalizeDistribution(match[1]));
        }
    }
    return { pythonPackages: packages, pythonManifest: manifest };
}
/**
 * The module this repo declares itself to be, and what it depends on, from `go.mod`.
 *
 * The module path matters as much as the dependency list: every import a Go file writes
 * of its own code is absolute and starts with it, so `github.com/me/app/internal/store`
 * cannot be turned back into the `internal/store` directory without reading this line.
 *
 * Indirect requirements are left out. They are the dependencies of dependencies, listed
 * by the toolchain rather than by anybody, and treating them as declarations would put a
 * framework label on a repo that has never imported it.
 */
function readGoModule(root, ignores) {
    const file = readableFile(root, 'go.mod', ignores);
    if (!file)
        return { goModules: new Set(), goModule: null };
    const modules = new Set();
    let module = null;
    let inBlock = false;
    for (const raw of splitLines(readText(file))) {
        const line = raw.replace(/\/\/.*$/, '').trim();
        if (!line)
            continue;
        const declared = /^module\s+(\S+)/.exec(line);
        if (declared) {
            module = declared[1];
            continue;
        }
        // `// indirect` lives in the comment this loop just stripped, so the test is made
        // against the raw line.
        const indirect = /\/\/\s*indirect\b/.test(raw);
        if (inBlock) {
            if (line === ')') {
                inBlock = false;
                continue;
            }
            const entry = /^(\S+)\s+v\S+/.exec(line);
            if (entry && !indirect)
                modules.add(entry[1]);
            continue;
        }
        if (/^require\s*\($/.test(line)) {
            inBlock = true;
            continue;
        }
        const single = /^require\s+(\S+)\s+v\S+/.exec(line);
        if (single && !indirect)
            modules.add(single[1]);
    }
    return { goModules: modules, goModule: module };
}
/**
 * What every `.csproj` in the repo references, and what kind of project each one is.
 *
 * Read with regular expressions rather than an XML parser, which is the same bargain
 * `go.mod` and `pyproject.toml` are read on: two attributes out of a file whose full
 * grammar would cost a dependency, and a missed reference costs a label rather than a
 * wrong answer.
 *
 * Searched a few levels deep because a .NET solution puts each project in its own folder
 * — `src/Api/Api.csproj`, `src/Worker/Worker.csproj` — and a repo root with nothing but a
 * `.sln` in it is the normal shape rather than the exception. `Directory.Packages.props`
 * is read too: central package management moves every version, and often every id, out
 * of the project files entirely.
 */
function readDotnetProjects(root, ignores) {
    const packages = new Set();
    const sdks = new Set();
    const outputTypes = new Set();
    const appsettingsKeys = new Set();
    const appsettingsPaths = [];
    const files = [];
    const scan = (dir, depth) => {
        if (depth > 3 || files.length > 200)
            return;
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
                if (/^(node_modules|\.git|bin|obj|packages)$/i.test(entry.name))
                    continue;
                scan(full, depth + 1);
            }
            else if (/\.(cs|fs|vb)proj$/i.test(entry.name) ||
                /^Directory\.(Packages|Build)\.props$/i.test(entry.name) ||
                /^appsettings(\..+)?\.json$/i.test(entry.name)) {
                files.push(full);
            }
        }
    };
    scan(root, 0);
    for (const file of files) {
        const text = readText(file);
        if (/appsettings(\..+)?\.json$/i.test(file)) {
            // Flattened with the `:` .NET itself uses, and every ancestor kept: the code
            // reads `GetSection("PowerFab")` and `Configuration["PowerFab:BaseUrl"]` alike,
            // and both are documented by the same JSON object.
            try {
                const flatten = (value, prefix) => {
                    if (value === null || typeof value !== 'object' || Array.isArray(value))
                        return;
                    for (const [key, child] of Object.entries(value)) {
                        const full = prefix ? `${prefix}:${key}` : key;
                        appsettingsKeys.add(full);
                        flatten(child, full);
                    }
                };
                flatten(JSON.parse(text), '');
                appsettingsPaths.push(path.relative(root, file).split(path.sep).join('/'));
            }
            catch {
                // A settings file that is not JSON documents nothing.
            }
            continue;
        }
        for (const match of text.matchAll(/<(?:PackageReference|PackageVersion|FrameworkReference)\s[^>]*Include\s*=\s*"([^"]+)"/gi)) {
            packages.add(match[1]);
        }
        for (const match of text.matchAll(/<Project\s[^>]*Sdk\s*=\s*"([^"]+)"/gi)) {
            // `Sdk="Microsoft.NET.Sdk.Web"`, and occasionally a version after a slash.
            for (const sdk of match[1].split(';'))
                sdks.add(sdk.split('/')[0].trim());
        }
        for (const match of text.matchAll(/<OutputType>\s*([^<\s]+)\s*<\/OutputType>/gi)) {
            outputTypes.add(match[1].trim());
        }
    }
    return {
        dotnetPackages: packages,
        dotnetSdks: sdks,
        dotnetOutputTypes: outputTypes,
        appsettingsKeys,
        appsettingsPaths: appsettingsPaths.sort(),
    };
}
/**
 * Every crate the repo's `Cargo.toml` files depend on.
 *
 * Read with the same bargain go.mod and the .csproj files are read on: a line parser
 * over the handful of shapes real manifests use, not a TOML grammar. A dependency is a
 * key under `[dependencies]` (dev and build included — a detector gated on a crate the
 * repo only tests with still describes code that is really there), a
 * `[dependencies.foo]` section header, or a key under `[workspace.dependencies]`,
 * which is where a workspace keeps the versions its members inherit.
 *
 * Searched a few levels deep because a workspace puts each crate in its own folder —
 * `engine/Cargo.toml`, `app/src-tauri/Cargo.toml` — and the root manifest often
 * declares nothing but the member list.
 */
function readCargoManifests(root, ignores) {
    const packages = new Set();
    const binaries = new Set();
    const files = [];
    const scan = (dir, depth) => {
        if (depth > 3 || files.length > 100)
            return;
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
                if (/^(node_modules|\.git|target|vendor|dist|build)$/i.test(entry.name))
                    continue;
                scan(full, depth + 1);
            }
            else if (entry.name === 'Cargo.toml') {
                files.push(full);
            }
        }
    };
    scan(root, 0);
    const DEPENDENCY_SECTION = /^\[(?:workspace\.|target\.[^\]]+\.)?(?:dependencies|dev-dependencies|build-dependencies)\]$/;
    const INLINE_DEPENDENCY = /^\[(?:workspace\.|target\.[^\]]+\.)?(?:dependencies|dev-dependencies|build-dependencies)\.([A-Za-z0-9_-]+)\]$/;
    for (const file of files) {
        const crateDir = path.dirname(file);
        // Cargo's convention, and it needs no manifest entry: a crate with `src/main.rs`
        // builds a binary. Lemmy's server is exactly this — three `main.rs` files and a
        // single `[[bin]]` between them.
        if (fs.existsSync(path.join(crateDir, 'src', 'main.rs')))
            binaries.add(path.relative(root, crateDir) || '.');
        let inDependencies = false;
        for (const raw of splitLines(readText(file))) {
            const line = raw.replace(/#.*$/, '').trim();
            if (!line)
                continue;
            if (line.startsWith('[')) {
                const inline = INLINE_DEPENDENCY.exec(line);
                if (inline)
                    packages.add(inline[1]);
                if (/^\[\[bin\]\]$/.test(line))
                    binaries.add(path.relative(root, crateDir) || '.');
                inDependencies = DEPENDENCY_SECTION.test(line);
                continue;
            }
            if (!inDependencies)
                continue;
            const key = /^([A-Za-z0-9_-]+)\s*=/.exec(line);
            if (key)
                packages.add(key[1]);
        }
    }
    return { packages, binaries };
}
/** PyPI treats `-`, `_` and `.` as the same character, and so does everyone else. */
function normalizeDistribution(name) {
    return name.toLowerCase().replace(/[-_.]+/g, '-');
}
function readPackages(pkg) {
    const names = new Set();
    if (!pkg)
        return names;
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
        const deps = pkg[field];
        if (deps && typeof deps === 'object') {
            for (const name of Object.keys(deps))
                names.add(name);
        }
    }
    return names;
}
function firstExistingDir(root, candidates, ignores) {
    for (const candidate of candidates) {
        const full = path.join(root, candidate);
        if (ignores.ignores(full))
            continue;
        try {
            if (fs.statSync(full).isDirectory())
                return candidate;
        }
        catch {
            /* not there */
        }
    }
    return null;
}
/** `vercel.json` is where Vercel apps declare their scheduled work. */
function readVercelCrons(root, ignores) {
    const out = [];
    for (const name of ['vercel.json', 'now.json']) {
        const file = readableFile(root, name, ignores);
        if (!file)
            continue;
        try {
            const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (!Array.isArray(parsed.crons))
                continue;
            for (const entry of parsed.crons) {
                if (!entry || typeof entry !== 'object')
                    continue;
                const { path: route, schedule } = entry;
                if (typeof route === 'string' && typeof schedule === 'string') {
                    out.push({ route, schedule, source: name });
                }
            }
        }
        catch {
            /* a broken vercel.json is not our problem to report */
        }
    }
    return out;
}
/**
 * Pulls the engine, the models and their columns out of `schema.prisma`. Prisma users
 * get the name of their actual database for free instead of a generic "Database" box —
 * and, since M4, the tables themselves as shapes the type explorer can draw.
 *
 * A hand-rolled line reader rather than a real Prisma parser: the block syntax is
 * simple, the dependency is not worth it, and anything unrecognised is skipped rather
 * than allowed to fail the analysis.
 */
function readPrismaSchema(root, ignores) {
    const candidates = ['prisma/schema.prisma', 'schema.prisma', 'src/prisma/schema.prisma'];
    for (const candidate of candidates) {
        const file = readableFile(root, candidate, ignores);
        if (!file)
            continue;
        try {
            const text = fs.readFileSync(file, 'utf8');
            const provider = /datasource\s+\w+\s*\{[^}]*?provider\s*=\s*"([^"]+)"/s.exec(text)?.[1] ?? 'sql';
            const tables = readPrismaModels(text);
            return {
                provider,
                models: tables.map((table) => table.name).sort(),
                tables,
                path: candidate,
                lineCount: splitLines(text).length,
            };
        }
        catch {
            return null;
        }
    }
    return null;
}
/** Scalars Prisma defines itself. Anything else naming a model is a relation. */
const PRISMA_SCALARS = new Set([
    'String',
    'Boolean',
    'Int',
    'BigInt',
    'Float',
    'Decimal',
    'DateTime',
    'Json',
    'Bytes',
    'Unsupported',
]);
/**
 * Splits on either line ending. A checkout on Windows leaves `\r` at the end of every
 * line, and a `$`-anchored pattern silently matches nothing against it — which reads
 * as "this schema has no documentation" rather than as the bug it is.
 */
function splitLines(text) {
    return text.split(/\r?\n/);
}
/**
 * A file this app declares at a known place, or null when it is not there — or when the
 * caller left its path out.
 *
 * The second half is the point. Most readers here open a fixed path rather than search
 * for one, so they look immune to a search-time filter, and the rule `--ignore` states
 * has nothing to do with searching: a path the caller took out of view supplies no
 * facts. `--ignore 'prisma/**'` has to mean the schema is gone, not that it is gone from
 * one of the two places that read it.
 */
function readableFile(root, relPath, ignores) {
    const file = path.join(root, relPath);
    if (ignores.ignores(file) || !fs.existsSync(file))
        return null;
    return file;
}
/** A config file that will not open tells us nothing, which is not an error. */
function readText(file) {
    try {
        return fs.readFileSync(file, 'utf8');
    }
    catch {
        return '';
    }
}
function readPrismaModels(text) {
    const lines = splitLines(text);
    const models = [];
    let current = null;
    let pendingDoc = [];
    for (let i = 0; i < lines.length; i++) {
        // `///` is Prisma's docstring. It is read verbatim, exactly like a JSDoc comment,
        // so a documented schema never needs a generated description.
        const docLine = /^\s*\/\/\/\s?(.*)$/.exec(lines[i]);
        if (docLine) {
            pendingDoc.push(docLine[1].trim());
            continue;
        }
        const line = lines[i].replace(/\/\/.*$/, '').trim();
        if (!current) {
            const open = /^model\s+(\w+)\s*\{/.exec(line);
            if (open) {
                const doc = pendingDoc.join(' ').trim();
                current = { name: open[1], fields: [], doc: doc || null, line: i + 1, endLine: i + 1 };
            }
            pendingDoc = [];
            continue;
        }
        if (line === '}') {
            current.endLine = i + 1;
            models.push(current);
            current = null;
            continue;
        }
        // `@@index([userId])` and friends describe the table, not a column.
        if (line.startsWith('@@') || line === '')
            continue;
        const field = /^(\w+)\s+([\w.]+)(\[\])?(\?)?(.*)$/.exec(line);
        if (!field)
            continue;
        const [, name, baseType, list, optional, attributes] = field;
        current.fields.push({
            name,
            type: `${baseType}${list ?? ''}${optional ?? ''}`,
            optional: Boolean(optional),
            list: Boolean(list),
            relationTo: PRISMA_SCALARS.has(baseType) ? null : baseType,
            isId: /@id\b/.test(attributes),
            isUnique: /@unique\b/.test(attributes),
        });
    }
    // An enum-typed column is not a relation. Only a type that names another table is,
    // and that can only be known once every model has been read.
    const known = new Set(models.map((model) => model.name));
    for (const model of models) {
        for (const field of model.fields) {
            if (field.relationTo && !known.has(field.relationTo))
                field.relationTo = null;
        }
    }
    return models;
}
/**
 * Any file whose name says "this is the template, not the secrets". Deliberately a
 * pattern rather than a list: `.env.local.example` and `.env.example.local` are both
 * common, and so is a leading `env.` with no dot. What must never match is a real
 * `.env` — that one holds the values, and we do not read it.
 */
const ENV_EXAMPLE = /^\.?env\b.*\.?(example|sample|template|defaults|dist)\b.*$/i;
/**
 * The variables the author meant you to set — the yardstick for the secrets badge.
 *
 * Every matching file is read and the names unioned, because a project that splits its
 * template across `.env.example` and `.env.local.example` has documented the variables
 * in both. Stopping at the first one made the badge report documented variables as
 * missing, which is the direction this tool is least allowed to be wrong in.
 */
function readEnvExample(root, ignores) {
    const names = new Set();
    const found = [];
    let entries;
    try {
        entries = fs.readdirSync(root);
    }
    catch {
        return { envExample: names, envExamplePath: null };
    }
    for (const entry of entries.sort()) {
        if (!ENV_EXAMPLE.test(entry))
            continue;
        try {
            const file = path.join(root, entry);
            if (ignores.ignores(file))
                continue;
            if (!fs.statSync(file).isFile())
                continue;
            for (const line of splitLines(fs.readFileSync(file, 'utf8'))) {
                const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
                if (match)
                    names.add(match[1]);
            }
            found.push(entry);
        }
        catch {
            /* keep looking: one unreadable template should not hide the others */
        }
    }
    return { envExample: names, envExamplePath: found.length > 0 ? listOf(found) : null };
}
/** "a", "a and b", "a, b and c" — this ends up in a sentence on screen. */
function listOf(items) {
    if (items.length === 1)
        return items[0];
    return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}
//# sourceMappingURL=signals.js.map