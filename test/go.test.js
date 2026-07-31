/**
 * @fileoverview End-to-end tests for the generic tier, proved on Go.
 *
 * Four fixtures, because Go services come in shapes that break different rules.
 * `gohttp` uses chi, which is where sub-routers, closures and middleware live; `gostd`
 * uses nothing at all but `net/http`, which is a large fraction of real Go and would be a
 * blank page for anything that only knows frameworks; `gomount` splits its routes across
 * packages, which is what every Go service does once it outgrows one file; and `goecho`
 * writes its route calls back to front from every other router in the language.
 *
 * Nothing here needs Go installed. The grammar is a WebAssembly file this repo ships, so
 * these run identically on a machine that has never had a Go toolchain on it — which is
 * the whole argument for the tier.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyzeProject, AtlasGraph, grammarTier, renderAtlasMarkdown } from '../dist/node/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CHI = path.join(here, 'fixtures', 'gohttp');
const STDLIB = path.join(here, 'fixtures', 'gostd');
const PACKAGES = path.join(here, 'fixtures', 'gomount');
const ECHO = path.join(here, 'fixtures', 'goecho');

const { atlas } = await analyzeProject(CHI, { followReferences: true, cache: 'off' });
const std = (await analyzeProject(STDLIB, { followReferences: true, cache: 'off' })).atlas;
const split = (await analyzeProject(PACKAGES, { followReferences: true, cache: 'off' })).atlas;
const echo = (await analyzeProject(ECHO, { followReferences: true, cache: 'off' })).atlas;

const find = (kind, name) => atlas.nodes.find((n) => n.kind === kind && n.name === name);
const file = (relPath) => atlas.nodes.find((n) => n.kind === 'file' && n.path === relPath);
const door = (source, name) => source.nodes.find((n) => n.kind === 'endpoint' && n.name === name);
const doors = (source) => source.nodes.filter((n) => n.meta.endpointKind === 'http-route').map((n) => n.name).sort();
const guardNames = (node) => (node.meta.guards ?? []).map((g) => g.name).sort();
/** What a door says answers it — the thing the reader is sent to go and look at. */
const answeredBy = (source, name) => {
  const endpoint = door(source, name);
  return source.edges
    .filter((e) => e.kind === 'exposed-by' && e.fromId === endpoint.id)
    .map((e) => source.nodes.find((n) => n.id === e.toId)?.name)
    .sort();
};

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

test('reads Go without a Go toolchain anywhere on the machine', () => {
  assert.deepEqual(atlas.meta.languages, ['go']);
  assert.deepEqual(atlas.meta.warnings, [], 'a clean fixture should produce no warnings');
  assert.ok(file('internal/api/router.go'), 'the router file is on the map');
  assert.equal(file('internal/api/router.go').summary, 'Package api wires every HTTP door this service opens.');
});

test('a method hangs off the type it is written on', () => {
  const server = find('type', 'Server');
  const listOrders = find('function', 'ListOrders');
  assert.ok(server && listOrders);
  assert.equal(listOrders.parentId, server.id, 'ListOrders is a method of Server, not a loose function');
  assert.equal(listOrders.meta.ownerName, 'Server');
  assert.equal(listOrders.summary, 'ListOrders returns every order the shop has taken.');
});

test('a struct field is a field, with the type as written', () => {
  const orders = find('type', 'Orders');
  assert.deepEqual(
    orders.meta.fields.map((f) => `${f.name}: ${f.type}`),
    ['db: *sql.DB'],
  );
});

test('the case of the first letter is the whole of Go visibility', () => {
  assert.equal(find('function', 'NewRouter').meta.isExported, true);
  assert.equal(find('function', 'health') ?? null, null, 'gohttp has no lowercase `health`');
  assert.equal(std.nodes.find((n) => n.kind === 'function' && n.name === 'health').meta.isExported, false);
});

test('an import brings in the whole package directory, not one file', () => {
  // Go compiles a directory as a unit, so `import ".../internal/api"` really does depend
  // on every file in it. Pointing the edge at one of them would be picking a favourite.
  const from = 'file:cmd/api/main.go';
  const targets = atlas.edges
    .filter((e) => e.kind === 'imports' && e.fromId === from)
    .map((e) => e.toId.slice('file:'.length))
    .sort();
  assert.deepEqual(targets, [
    'internal/api/middleware.go',
    'internal/api/router.go',
    'internal/config/config.go',
    'internal/store/orders.go',
  ]);
});

test('a name is followed across packages, and never claimed as certain', () => {
  const main = atlas.nodes.find((n) => n.kind === 'function' && n.name === 'main');
  const newRouter = find('function', 'NewRouter');
  const edge = atlas.edges.find((e) => e.kind === 'references' && e.fromId === main.id && e.toId === newRouter.id);
  assert.ok(edge, 'main() reaches NewRouter through the package it imports');
  assert.equal(edge.confidence, 'likely', 'no compiler resolved this, and the map has to say so');
});

test('machine-written Go is left out rather than counted', () => {
  // Forty thousand lines of protobuf would swamp every number on the screen, and nobody
  // wrote them.
  assert.equal(file('internal/store/schema.pb.go') ?? null, null);
  assert.equal(find('type', 'OrderProto') ?? null, null);
});

// ---------------------------------------------------------------------------
// Doors
// ---------------------------------------------------------------------------

test('a chi service lists its doors at the addresses they answer at', () => {
  // `/orders/` and not `/`: the address is written across two lines and one closure, and
  // the short version is an address that does not answer.
  assert.deepEqual(doors(atlas), ['DELETE /admin/orders/{id}', 'GET /health', 'GET /orders/', 'POST /orders/']);
  assert.equal(door(atlas, 'GET /orders/').meta.framework, 'chi');
});

test('the standard library alone is enough to find doors', () => {
  assert.deepEqual(doors(std), ['ANY /debug/vars', 'GET /health', 'POST /widgets']);
});

test('a method written inside the pattern is read out of it', () => {
  // Go 1.22 put the verb in the string: `mux.HandleFunc("GET /health", …)`. A reader who
  // ignores it reports every route as answering to every verb.
  assert.equal(door(std, 'GET /health').meta.method, 'GET');
  // `ANY` is what the rest of the pipeline calls a route with no verb of its own, and
  // it is what every screen prints in the column where the others show a verb.
  assert.equal(door(std, 'ANY /debug/vars').meta.method, 'ANY', 'a bare pattern really does answer everything');
});

test('a client call going out is not a door coming in', () => {
  // `http.Post(url, …)` is the standard library's client. Reading it as a route once put
  // a Slack webhook URL on the list of addresses a stranger can reach.
  assert.ok(!doors(atlas).some((name) => name.includes('hooks.slack.com')));
  const slack = find('service', 'Slack');
  assert.ok(slack, 'and it is still recorded — as somewhere data goes');
  assert.deepEqual(slack.meta.hosts, ['hooks.slack.com']);
});

// ---------------------------------------------------------------------------
// Addresses written in one package and finished in another
// ---------------------------------------------------------------------------

test('a router mounted from another package wears the prefix the mount put in front of it', () => {
  // `r.Mount("/api/v1", api.Routes())` is in `cmd/gateway/main.go`; `r.Get("/orders", …)`
  // is in `internal/api/routes.go`. Neither file holds the address, and `/orders` on its
  // own is a short address that looks complete — the exact failure the mount graph was
  // written to prevent.
  assert.deepEqual(split.meta.warnings, [], 'a silent parse failure must not pass as a pass');
  assert.deepEqual(doors(split), ['GET /admin/status', 'GET /api/v1/orders', 'POST /api/v1/orders']);
});

test('a Go import names a folder, so no single file in the package answers to it', () => {
  // The mount asks for `internal/api`. The router is built in `internal/api/routes.go`
  // and the handlers sit beside it in `internal/api/handlers.go` — same package, and the
  // import can name neither file, because what it names is the folder holding both.
  assert.ok(
    split.nodes.some((n) => n.kind === 'file' && n.path === 'internal/api/handlers.go'),
    'the package really is more than one file',
  );
  assert.ok(!doors(split).includes('GET /orders'), 'so the routes are not left at the address their own file holds');
});

test('a router handed in as a parameter is already at its full address', () => {
  // `admin.RegisterRoutes(r)` is not a mount: the parent is passed in, and
  // `r.Get("/admin/status", …)` inside it is written against that parent. There is no
  // prefix to add, and adding one would be inventing an address nobody serves.
  assert.ok(doors(split).includes('GET /admin/status'));
  assert.ok(!doors(split).some((name) => name.includes('/api/v1/admin')));
});

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

test('a middleware counts as a check because of what it writes, not what it is called', () => {
  // `r.Use(Logger)` and `r.Use(RequireAuth)` are the same line. Only one of them ever
  // puts a 401 on the wire.
  assert.deepEqual(guardNames(door(atlas, 'DELETE /admin/orders/{id}')), ['RequireAuth']);
  assert.deepEqual(guardNames(door(atlas, 'GET /health')), [], 'Logger guards nothing, and is applied to everything');
  assert.equal(door(atlas, 'GET /health').meta.open.kind, 'worth-a-look');
});

test('a check written inside a group reaches that group and no further', () => {
  // `r.Group(func(r chi.Router) { r.Use(RequireAuth); … })` shadows the outer router, so
  // the routes inside say `r` and mean something else entirely.
  assert.deepEqual(guardNames(door(atlas, 'DELETE /admin/orders/{id}')), ['RequireAuth']);
  assert.deepEqual(guardNames(door(atlas, 'GET /orders/')), []);
});

test('a check written on one route reaches only that route', () => {
  assert.deepEqual(guardNames(door(atlas, 'POST /orders/')), ['RequireAuth'], 'r.With(RequireAuth).Post(…)');
  assert.deepEqual(guardNames(door(atlas, 'GET /orders/')), [], 'and the GET beside it is open');
});

test('a handler wrapped in a check is checked', () => {
  const guarded = door(std, 'POST /widgets');
  assert.deepEqual(guardNames(guarded), ['requireToken']);
  assert.equal(guarded.meta.guards[0].confidence, 'certain', 'the wrapper is named on the same line as the route');
});

test('a door whose handler we could not find inherits nothing', () => {
  // `mux.Handle("/debug/vars", expvar.Handler())` answers with something declared in
  // another module. Letting an unknown handler fall back to "the whole file" attached
  // every check in that file to it — a route reported as protected by a middleware it
  // has never been near.
  const unknown = door(std, 'ANY /debug/vars');
  assert.deepEqual(guardNames(unknown), []);
  assert.equal(unknown.meta.open.kind, 'worth-a-look');
});

// ---------------------------------------------------------------------------
// Which argument is the handler
// ---------------------------------------------------------------------------

test('Echo writes the handler before its middleware, and the door points at the handler', () => {
  // `e.GET("/reports/:id", showReport, RequireToken)`. Read gin's way round, the last
  // name wins and the door is sent to the lock instead of to what is behind it.
  assert.deepEqual(echo.meta.warnings, [], 'a silent parse failure must not pass as a pass');
  assert.deepEqual(doors(echo), ['GET /health', 'GET /reports/:id', 'POST /reports']);
  assert.deepEqual(answeredBy(echo, 'GET /reports/:id'), ['showReport']);
  assert.deepEqual(answeredBy(echo, 'POST /reports'), ['createReport'], 'not the last of two middlewares');
});

test('the names after an Echo handler are the checks, and only the rejecting ones count', () => {
  // `AuditLog` and `RequireToken` are attached by the same call on the same line, and
  // only one of them ever puts a 401 on the wire.
  assert.deepEqual(guardNames(door(echo, 'GET /reports/:id')), ['RequireToken']);
  assert.deepEqual(guardNames(door(echo, 'POST /reports')), ['RequireToken']);
  assert.deepEqual(guardNames(door(echo, 'GET /health')), [], 'and a route written with no middleware has none');
});

test('a check read off an argument list is likely, and never certain', () => {
  // Read gin's way round, Echo's middleware *is* the handler — and a guard sitting on
  // the handler's own node comes back `certain`, the badge that means a compiler said
  // so. The lock was real; the reason given for it was not.
  assert.equal(door(echo, 'GET /reports/:id').meta.guards[0].confidence, 'likely');
});

test('a router handed in as a parameter still belongs to the framework that built it', () => {
  // `registerRoutes(e *echo.Echo)` never says `echo.New()`. The type is the evidence,
  // and it is what tells this file which end of the argument list to read.
  assert.deepEqual(echo.meta.frameworks, ['Echo']);
  assert.equal(door(echo, 'GET /health').meta.framework, 'Echo');
});

// ---------------------------------------------------------------------------
// Data, configuration and dependencies
// ---------------------------------------------------------------------------

test('a query names its table and says which way the data moved', () => {
  const db = find('store', 'Database');
  assert.equal(db.meta.client, 'database/sql');
  assert.deepEqual(db.meta.tables, ['orders']);
  assert.equal(db.meta.reads, 1);
  assert.equal(db.meta.writes, 2, 'the verb of an Exec is inside the string it was handed');
});

test('every environment variable the code reads', () => {
  const env = atlas.nodes.find((n) => n.meta.endpointKind === 'env');
  assert.deepEqual(env.meta.vars.map((v) => v.name).sort(), ['DATABASE_URL', 'PORT']);
  assert.equal(env.meta.vars.find((v) => v.name === 'DATABASE_URL').documented, true);
});

test('the framework comes from go.mod, and indirect requirements are not declarations', () => {
  assert.deepEqual(atlas.meta.frameworks, ['chi']);
  assert.deepEqual(std.meta.frameworks, [], 'a repo with no dependencies is built with nothing');
});

test('a major version in the import path is not the name of the package', () => {
  // `github.com/go-chi/chi/v5` is typed `chi`. Taking the last segment gives a package
  // called `v5`, after which `chi.NewRouter()` matches nothing and a chi service reports
  // no routes at all.
  assert.ok(file('internal/api/router.go').meta.externalImports.includes('github.com/go-chi/chi/v5'));
  assert.ok(doors(atlas).length > 0, 'which is how we know the name resolved');
});

// ---------------------------------------------------------------------------
// Saying how much this is worth
// ---------------------------------------------------------------------------

test('every node read by a grammar says so', () => {
  const read = atlas.nodes.filter((n) => n.language === 'go');
  assert.ok(read.length > 10);
  assert.ok(read.every((n) => n.meta.tier === 'tree-sitter'));
});

test('the map does not claim a type checker it never ran', () => {
  const note = grammarTier(atlas.nodes);
  assert.equal(note.display, 'Go');
  assert.match(note.sentence, /tree-sitter grammar rather than a compiler/);

  const markdown = renderAtlasMarkdown(new AtlasGraph(atlas));
  assert.ok(!markdown.includes("own parser and type checker"), 'no type checker ran over this repo');
  assert.ok(markdown.includes(note.sentence));
});

test('a repo with no generic-tier code says nothing about tiers', () => {
  const typescript = { ...atlas, nodes: atlas.nodes.map((n) => ({ ...n, meta: { ...n.meta, tier: undefined } })) };
  assert.equal(grammarTier(typescript.nodes), null);
});

// ---------------------------------------------------------------------------
// Incremental
// ---------------------------------------------------------------------------

test('an unedited Go file is not parsed twice', async () => {
  await analyzeProject(CHI, { cache: 'refresh' });
  const second = await analyzeProject(CHI, { cache: 'use' });
  assert.equal(second.atlas.meta.incremental.analyzed, 0);
  assert.ok(second.atlas.meta.incremental.reused > 0);
  assert.deepEqual(doors(second.atlas), doors(atlas), 'and the answer is the same one');
});
