import { baseNameOf, extOf } from '../util/paths.js';
const TEST_HINTS = [/(^|\/)__tests__\//, /(^|\/)tests?\//, /\.(test|spec)\.[cm]?[jt]sx?$/];
const CONFIG_NAMES = new Set([
    'next.config.js', 'next.config.mjs', 'next.config.ts',
    'vite.config.ts', 'vite.config.js', 'tailwind.config.ts', 'tailwind.config.js',
    'jest.config.ts', 'jest.config.js', 'vitest.config.ts', 'playwright.config.ts',
    'eslint.config.js', 'eslint.config.mjs', 'postcss.config.js', 'drizzle.config.ts',
    'svelte.config.js', 'astro.config.mjs', 'nuxt.config.ts', 'webpack.config.js',
]);
const DATA_HINTS = [
    /(^|\/)prisma\//, /(^|\/)drizzle\//, /(^|\/)migrations?\//, /(^|\/)db\//,
    /(^|\/)database\//, /(^|\/)models?\//, /(^|\/)entities\//, /(^|\/)repositor(y|ies)\//,
    /(^|\/)schemas?\//, /(^|\/)seed(s)?\//,
];
const API_HINTS = [
    /(^|\/)api\//, /(^|\/)routes?\//, /(^|\/)server\//, /(^|\/)trpc\//,
    /(^|\/)controllers?\//, /(^|\/)handlers?\//, /(^|\/)endpoints?\//,
    /(^|\/)functions\//, /(^|\/)actions\//,
];
const API_FILES = new Set(['route.ts', 'route.js', 'middleware.ts', 'middleware.js', 'server.ts', 'server.js']);
const UI_HINTS = [
    /(^|\/)components?\//, /(^|\/)ui\//, /(^|\/)views?\//, /(^|\/)screens?\//,
    /(^|\/)pages?\//, /(^|\/)layouts?\//, /(^|\/)styles?\//, /(^|\/)app\//,
];
const LOGIC_HINTS = [
    /(^|\/)lib\//, /(^|\/)utils?\//, /(^|\/)services?\//, /(^|\/)hooks?\//,
    /(^|\/)domain\//, /(^|\/)core\//, /(^|\/)helpers?\//, /(^|\/)store\//,
];
/**
 * Python says the same things with different words, so it gets its own table.
 *
 * Sharing the JavaScript one would be actively wrong: `app/` is a Next.js router in one
 * ecosystem and simply the name of the package in the other, and colouring a Django
 * project's entire backend as "UI" is the kind of mistake that makes a reader stop
 * trusting every other colour on the map.
 */
const PY_TEST = [/(^|\/)tests?\//, /(^|\/)test_[^/]+\.py$/, /_test\.py$/, /(^|\/)conftest\.py$/];
const PY_CONFIG = new Set(['settings.py', 'conf.py', 'config.py', 'setup.py', 'asgi.py', 'wsgi.py', 'manage.py', '__init__.py']);
const PY_DATA = new Set(['models.py', 'model.py', 'schema.py', 'schemas.py', 'database.py', 'db.py', 'crud.py', 'repository.py', 'entities.py']);
const PY_DATA_DIRS = [/(^|\/)migrations?\//, /(^|\/)alembic\//, /(^|\/)models?\//, /(^|\/)schemas?\//, /(^|\/)db\//];
const PY_API = new Set(['views.py', 'urls.py', 'routes.py', 'router.py', 'routers.py', 'api.py', 'main.py', 'app.py', 'server.py', 'serializers.py', 'endpoints.py', 'handlers.py']);
const PY_API_DIRS = [/(^|\/)api\//, /(^|\/)routers?\//, /(^|\/)views?\//, /(^|\/)endpoints?\//];
const PY_UI_DIRS = [/(^|\/)templates?\//, /(^|\/)static\//];
function classifyPythonZone(lower, base) {
    if (PY_TEST.some((r) => r.test(lower)))
        return 'test';
    if (PY_DATA.has(base) || PY_DATA_DIRS.some((r) => r.test(lower)))
        return 'data';
    if (PY_API.has(base) || PY_API_DIRS.some((r) => r.test(lower)))
        return 'api';
    if (PY_UI_DIRS.some((r) => r.test(lower)))
        return 'ui';
    // `__init__.py` is usually empty plumbing, and `settings.py` is configuration —
    // both are checked after the roles above so a real `models/__init__.py` still reads
    // as data rather than as config.
    //
    // `jupyter_notebook_config.py`, `gunicorn_config.py`: the tool is told to look for a
    // file with that suffix and reads it by name. Exactly what `*.config.ts` means on the
    // JavaScript side, and it was the one spelling this table did not know.
    if (PY_CONFIG.has(base) || /(^|_)config\.py$/.test(base))
        return 'config';
    return 'logic';
}
/**
 * Go's own words for the same roles.
 *
 * It gets its own table for the reason Python does. `cmd/` is where a Go repo keeps the
 * programs it builds, `internal/` is the half of a repo other modules cannot import, and
 * neither means anything at all in the JavaScript table — while `app/` and `pages/`,
 * which that table treats as a router, are just ordinary directory names here.
 */
// `test/` and `tests/` are what the other two tables already call a suite, and Go was
// the one language here that did not say so — leaving a fixture tree under `test/` filed
// as ordinary application code.
const GO_TEST = [/_test\.go$/, /(^|\/)testdata\//, /(^|\/)tests?\//];
const GO_CONFIG = new Set(['config.go', 'settings.go', 'options.go', 'env.go', 'doc.go']);
const GO_DATA_DIRS = [/(^|\/)migrations?\//, /(^|\/)models?\//, /(^|\/)store\//, /(^|\/)storage\//, /(^|\/)repositor(y|ies)\//, /(^|\/)db\//, /(^|\/)database\//, /(^|\/)ent\//];
const GO_DATA = new Set(['models.go', 'model.go', 'schema.go', 'store.go', 'db.go', 'database.go', 'repository.go', 'queries.go']);
const GO_API_DIRS = [/(^|\/)api\//, /(^|\/)handlers?\//, /(^|\/)routes?\//, /(^|\/)controllers?\//, /(^|\/)server\//, /(^|\/)transport\//, /(^|\/)rpc\//];
const GO_API = new Set(['handler.go', 'handlers.go', 'router.go', 'routes.go', 'server.go', 'api.go', 'middleware.go']);
const GO_UI_DIRS = [/(^|\/)templates?\//, /(^|\/)static\//, /(^|\/)web\//, /(^|\/)views?\//];
function classifyGoZone(lower, base) {
    if (GO_TEST.some((r) => r.test(lower)))
        return 'test';
    if (GO_DATA.has(base) || GO_DATA_DIRS.some((r) => r.test(lower)))
        return 'data';
    if (GO_API.has(base) || GO_API_DIRS.some((r) => r.test(lower)))
        return 'api';
    if (GO_UI_DIRS.some((r) => r.test(lower)))
        return 'ui';
    if (GO_CONFIG.has(base))
        return 'config';
    // `cmd/` is where the programs live: a `main.go` that wires everything together and
    // then gets out of the way. Logic, not API — the routes it mounts are declared
    // elsewhere, and colouring the entry point as API would put the wiring in with them.
    return 'logic';
}
/**
 * Rust's own words for the same roles.
 *
 * Its own table for the reason the others have one. `tests/` and `benches/` are
 * Cargo's, `schema.rs` is Diesel's generated schema and `migrations/` is where both
 * ORMs keep theirs, and `commands.rs` is where a Tauri app keeps the doors its webview
 * calls — none of which the JavaScript table could know without being wrong about
 * JavaScript.
 */
const RUST_TEST = [/(^|\/)tests?\//, /(^|\/)benches\//, /_test\.rs$/];
const RUST_CONFIG = new Set(['build.rs', 'config.rs', 'settings.rs', 'options.rs']);
const RUST_DATA = new Set(['schema.rs', 'models.rs', 'model.rs', 'db.rs', 'database.rs', 'store.rs', 'repository.rs', 'queries.rs', 'entities.rs']);
const RUST_DATA_DIRS = [/(^|\/)migrations?\//, /(^|\/)models?\//, /(^|\/)entities\//, /(^|\/)db\//, /(^|\/)database\//, /(^|\/)store\//, /(^|\/)repositor(y|ies)\//];
const RUST_API = new Set(['routes.rs', 'router.rs', 'handlers.rs', 'handler.rs', 'server.rs', 'api.rs', 'commands.rs', 'middleware.rs']);
const RUST_API_DIRS = [/(^|\/)api\//, /(^|\/)routes?\//, /(^|\/)handlers?\//, /(^|\/)controllers?\//, /(^|\/)server\//, /(^|\/)commands?\//, /(^|\/)rpc\//];
const RUST_UI_DIRS = [/(^|\/)templates?\//, /(^|\/)static\//, /(^|\/)views?\//, /(^|\/)ui\//];
function classifyRustZone(lower, base) {
    if (RUST_TEST.some((r) => r.test(lower)))
        return 'test';
    if (RUST_DATA.has(base) || RUST_DATA_DIRS.some((r) => r.test(lower)))
        return 'data';
    if (RUST_API.has(base) || RUST_API_DIRS.some((r) => r.test(lower)))
        return 'api';
    if (RUST_UI_DIRS.some((r) => r.test(lower)))
        return 'ui';
    if (RUST_CONFIG.has(base))
        return 'config';
    // `main.rs` is the wiring, the way a Go `cmd/` is: the doors it mounts are declared
    // elsewhere, and colouring the entry point as API would put the plumbing in with them.
    return 'logic';
}
/**
 * Classifies a repo-relative file path into a zone. Order matters: the most specific
 * signals (tests, config, data) win over the broadest ones (a file under `app/`).
 */
export function classifyZone(relPath) {
    const lower = relPath.toLowerCase();
    const base = baseNameOf(lower);
    const ext = extOf(lower);
    if (ext === '.py' || ext === '.pyi')
        return classifyPythonZone(lower, base);
    if (ext === '.go')
        return classifyGoZone(lower, base);
    if (ext === '.rs')
        return classifyRustZone(lower, base);
    // A notebook is where the analysis itself lives, whatever it is named. The Python
    // filename conventions do not apply — nobody calls a notebook `models.py`.
    //
    // Nor do the test conventions: `test.ipynb` in a data repo is a scratchpad, not a
    // suite, and `test_model.ipynb` is usually someone testing a model rather than
    // testing code. Reading either as `test` would dim the very work the reader came
    // for, so notebooks are never classified that way on their name alone.
    if (ext === '.ipynb') {
        if (DATA_HINTS.some((r) => r.test(lower)))
            return 'data';
        return 'logic';
    }
    if (TEST_HINTS.some((r) => r.test(lower)))
        return 'test';
    if (CONFIG_NAMES.has(base) || /\.config\.[cm]?[jt]s$/.test(base))
        return 'config';
    if (DATA_HINTS.some((r) => r.test(lower)))
        return 'data';
    if (API_FILES.has(base) || API_HINTS.some((r) => r.test(lower)))
        return 'api';
    if (ext === '.tsx' || ext === '.jsx' || ext === '.css' || ext === '.scss')
        return 'ui';
    if (UI_HINTS.some((r) => r.test(lower)))
        return 'ui';
    if (LOGIC_HINTS.some((r) => r.test(lower)))
        return 'logic';
    return 'logic';
}
/** The zone a container should take, given the zones of everything inside it. */
export function dominantZone(zones) {
    if (zones.length === 0)
        return 'unknown';
    const counts = new Map();
    for (const z of zones)
        counts.set(z, (counts.get(z) ?? 0) + 1);
    // Tests and config never define a container's identity unless that is all it holds.
    const ranked = [...counts.entries()].sort((a, b) => {
        const aWeak = a[0] === 'test' || a[0] === 'config' ? 1 : 0;
        const bWeak = b[0] === 'test' || b[0] === 'config' ? 1 : 0;
        if (aWeak !== bWeak)
            return aWeak - bWeak;
        if (b[1] !== a[1])
            return b[1] - a[1];
        return a[0].localeCompare(b[0]);
    });
    return ranked[0][0];
}
//# sourceMappingURL=zones.js.map