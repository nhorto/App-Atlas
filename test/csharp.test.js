/**
 * @fileoverview C# through the generic tier.
 *
 * The seam's second language, and the point of it. Go proved a tree-sitter grammar could
 * carry a language; C# is the one that had to arrive without the shared code learning
 * anything about it — a query file, a dialect, a detector, and `boundaries/build.ts`
 * still not knowing what language a finding came from.
 *
 * C# stressed the seam in three places Go never did, and each is pinned below: its
 * visibility is a keyword rather than the case of a letter, it says most of what matters
 * in attributes rather than calls, and it spells "this is a call" as
 * `invocation_expression` with no letters in common with the word the extractor was
 * matching on.
 *
 * The negative assertions carry the same weight as the positive ones. `Where` and
 * `Select` are LINQ before they are Entity Framework, `_skus.Add(sku)` is a list, and a
 * class called `PaymentController` with no attributes on it is somebody's naming
 * convention — a map that reports any of those has invented something.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyzeProject, AtlasGraph, grammarTier } from '../dist/node/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const result = await analyzeProject(path.join(here, 'fixtures', 'csharpapi'), {
  cache: 'off',
  followReferences: true,
});

const nodes = result.atlas.nodes;
const doors = nodes
  .filter((node) => node.kind === 'endpoint' && node.meta.endpointKind === 'http-route')
  .sort((a, b) => a.name.localeCompare(b.name));
const stores = nodes.filter((node) => node.kind === 'store');
const services = nodes.filter((node) => node.kind === 'service');
const guardsOf = (name) => (doors.find((d) => d.name === name)?.meta.guards ?? []).map((g) => g.name);

// ---------------------------------------------------------------------------
// It reads as C#
// ---------------------------------------------------------------------------

test('the language is claimed, and the project file says what it is', () => {
  assert.deepEqual(result.atlas.meta.languages, ['csharp']);
  // `Microsoft.NET.Sdk.Web` and nothing else declares ASP.NET Core here: the runtime
  // ships it, so a web service's project file can list no web dependency at all.
  assert.ok(result.atlas.meta.frameworks.includes('ASP.NET Core'), result.atlas.meta.frameworks.join(', '));
  assert.ok(result.atlas.meta.frameworks.includes('Entity Framework Core'));
  assert.ok(result.atlas.meta.frameworks.includes('Dapper'));
});

test('the reader is told this came from a grammar, not a compiler', () => {
  const tier = grammarTier(nodes);
  assert.ok(tier.languages.includes('csharp'));
  assert.match(tier.display, /C#/, 'and it is spelled C#, not Csharp');
});

test('nothing failed to parse', () => {
  assert.deepEqual(result.atlas.meta.warnings, []);
});

// ---------------------------------------------------------------------------
// Doors: controllers
// ---------------------------------------------------------------------------

test('an address split across two attributes is put back together', () => {
  // `[Route("api/v1/[controller]")]` on the class, `[HttpGet("{id:int}")]` on the method,
  // and `[controller]` is ASP.NET's own token for the class name minus its suffix.
  assert.ok(
    doors.some((door) => door.name === 'GET /api/v1/orders/{id:int}'),
    doors.map((d) => d.name).join(', '),
  );
  assert.ok(doors.some((door) => door.name === 'POST /api/v1/orders'));
});

test('a class-level [Authorize] locks every action under it', () => {
  assert.deepEqual(guardsOf('GET /api/v1/orders/{id:int}'), ['[Authorize] on OrdersController']);
  assert.deepEqual(guardsOf('POST /api/v1/orders'), ['[Authorize] on OrdersController']);
});

test('[AllowAnonymous] on the action beats [Authorize] on the class', () => {
  // This is how nearly every ASP.NET app writes its sign-in route, and reading the class
  // attribute alone would badge the one deliberately-open door as locked. Being wrong in
  // that direction is the worst thing this tool can do.
  assert.deepEqual(guardsOf('GET /api/v1/orders/public-status'), []);
});

test('a class named like a controller is not a door', () => {
  // `PaymentController` has no [ApiController], no [Route] and no verb attributes. The
  // suffix is a convention; a door invented from one is a door nobody can knock on.
  for (const door of doors) {
    assert.ok(!/payment/i.test(door.name), `invented from a name: ${door.name}`);
  }
});

// ---------------------------------------------------------------------------
// Doors: minimal APIs
// ---------------------------------------------------------------------------

test('a minimal-API route is a door, with no lock on it', () => {
  assert.ok(doors.some((door) => door.name === 'GET /health'));
  assert.deepEqual(guardsOf('GET /health'), []);
});

test('a group prefix composes, and a chained RequireAuthorization locks', () => {
  // `var admin = app.MapGroup("/admin");` three lines above the route that uses it. The
  // binding is the only record that `admin` carries a prefix at all.
  assert.ok(doors.some((door) => door.name === 'POST /admin/reindex'), doors.map((d) => d.name).join(', '));
  assert.deepEqual(guardsOf('POST /admin/reindex'), ['.RequireAuthorization()']);
});

test('the door count is the whole list and nothing else', () => {
  assert.deepEqual(doors.map((door) => door.name), [
    'GET /api/kiosk/ping',
    'GET /api/kiosk/today',
    'GET /api/v1/orders/{id:int}',
    'GET /api/v1/orders/public-status',
    'GET /health',
    'POST /admin/reindex',
    'POST /api/kiosk/shift/end',
    'POST /api/kiosk/shift/start',
    'POST /api/v1/orders',
  ]);
});

// ---------------------------------------------------------------------------
// A lock this app wrote itself
// ---------------------------------------------------------------------------

test('a filter is a check because of the 401 it writes, not its name', () => {
  // Found on a real .NET connector, which reported **48 of 48 routes unprotected**
  // because every one of its locks is an in-house endpoint filter rather than
  // `[Authorize]` or `.RequireAuthorization()`. The Go tier has judged middleware this
  // way from the start; this is the same rule in C#.
  assert.deepEqual(guardsOf('GET /api/kiosk/today'), ['.RequireDevice()']);
});

test('a filter that writes no 401 is not a check, whatever it is called', () => {
  // `.RequireTelemetry()` is chained onto its route exactly as `.RequireDevice()` is,
  // and shares the word the name-based rule would have matched on. It writes a timing
  // line and nothing else, so the route stays open — which is the true answer.
  assert.deepEqual(guardsOf('GET /api/kiosk/ping'), []);
});

test('a filter on the group covers every route registered on it', () => {
  // `var kiosk = app.MapGroup("/api/kiosk/shift").RequireDevice();` — one line, and
  // neither route below it mentions a lock anywhere near itself. The chained call also
  // binds the name to the *outermost* call, which is what used to lose the prefix too.
  assert.deepEqual(guardsOf('POST /api/kiosk/shift/start'), ['.RequireDevice()']);
  assert.deepEqual(guardsOf('POST /api/kiosk/shift/end'), ['.RequireDevice()']);
});

test('a hop-found lock is likely, never certain', () => {
  // The route names the filter and the filter answers 401; both halves are written
  // down. What is not proven is that every path through it rejects.
  const guard = doors.find((d) => d.name === 'GET /api/kiosk/today').meta.guards[0];
  assert.equal(guard.confidence, 'likely');
  assert.equal(guard.provider, 'custom');
});

// ---------------------------------------------------------------------------
// SQL, wherever it was written
// ---------------------------------------------------------------------------

test('raw ADO.NET is read, including through a helper this repo wrote', () => {
  // `cmd.CommandText = "SELECT … FROM punches"` is assigned, not passed, and
  // `connection.Sql("…")` is a four-line extension method with a name no table could
  // list. The statement is the evidence in both cases.
  const sqlite = stores.find((store) => store.name === 'SQLite');
  assert.ok(sqlite, stores.map((s) => `${s.name} (${s.meta.client})`).join(', '));
  assert.ok(sqlite.meta.tables.includes('punches'), sqlite.meta.tables.join(', '));
});

test('a comment inside a statement does not name a table', () => {
  // The upsert explains itself: "-- Kept rather than cleared when absent: these come
  // from the shop's own database". `from` is looked for before `into`, so this used to
  // put a table called `the` in the data model — in every language, not just this one.
  const tables = stores.flatMap((store) => store.meta.tables);
  assert.ok(!tables.includes('the'), tables.join(', '));
  assert.ok(tables.includes('employees'), 'and the real table is still found');
});

test('an interpolated column list does not cost the table', () => {
  // `$"SELECT {columns} FROM job_stations WHERE …"` — the hole is in the column list and
  // the table is written down plainly. Dropping it whenever a string is interpolated
  // would lose most of the queries in a real repo.
  const sqlite = stores.find((store) => store.name === 'SQLite');
  assert.ok(sqlite.meta.tables.includes('job_stations'), sqlite.meta.tables.join(', '));
});

test('prose that opens with a SQL keyword is not a query', () => {
  // "Update the settings for this shop before syncing again." Scanning every string for
  // SQL is what makes the helper above readable, and it is also how a table called
  // `the` gets into somebody's data model.
  const tables = stores.flatMap((store) => store.meta.tables);
  for (const invented of ['the', 'settings']) {
    assert.ok(!tables.includes(invented), `${invented} came out of an English sentence`);
  }
});

// ---------------------------------------------------------------------------
// Where data goes
// ---------------------------------------------------------------------------

test('a DbContext declares the tables, whether or not code has touched them', () => {
  const ef = stores.find((store) => store.meta.client === 'Entity Framework Core');
  assert.deepEqual(ef.meta.tables, ['Customers', 'Orders']);
});

test('Dapper names its table out of the SQL', () => {
  const dapper = stores.find((store) => store.meta.client === 'Dapper');
  assert.ok(dapper, stores.map((s) => s.meta.client).join(', '));
  assert.deepEqual(dapper.meta.tables, ['ledger_entries']);
  assert.equal(dapper.meta.reads, 1);
});

test('LINQ over a list is not a database', () => {
  // `_skus.Where(…).Select(…)`, `_skus.Count()`, `_skus.Add(sku)` in Reporting.cs. Every
  // one of those method names is also Entity Framework's, which is why they only count
  // when written on a DbSet the file declared. A table called `_skus` would be a lie
  // about somebody's schema.
  const tables = stores.flatMap((store) => store.meta.tables);
  for (const invented of ['_skus', 'skus']) {
    assert.ok(!tables.includes(invented), `${invented} is a list: ${tables.join(', ')}`);
  }
});

// ---------------------------------------------------------------------------
// Outbound
// ---------------------------------------------------------------------------

test('an HttpClient call names the host it reaches', () => {
  const hosts = services.map((service) => service.name).sort();
  assert.deepEqual(hosts, ['rates.example-vendor.com', 'telemetry.example-vendor.com']);
});

test('a URL held in a const is the same fact as the literal', () => {
  // `private const string FeedUrl = "https://…"` at the top of the class, used in a
  // method below it — the shape #89 was filed about, in a third language.
  assert.ok(services.some((service) => service.name === 'rates.example-vendor.com'));
});

test('an unrecognised host is named, never guessed into a brand', () => {
  for (const service of services) assert.equal(service.meta.category, 'other');
});

// ---------------------------------------------------------------------------
// What links two C# files (#96)
// ---------------------------------------------------------------------------

test('a using plus a name this file actually mentions is a link', () => {
  // Nothing in a C# file names a file. A `using` names a namespace, so the link is the
  // pair of facts: the namespace was imported, and a type it declares is used here.
  // Without this a 203-file app had zero import edges and no answer at all to "where do
  // I start reading".
  const links = result.atlas.edges
    .filter((edge) => edge.kind === 'imports')
    .map((edge) => `${edge.fromId.replace('file:', '')} -> ${edge.toId.replace('file:', '')}`)
    .sort();
  assert.deepEqual(links, [
    'src/Shop.Api/Controllers/OrdersController.cs -> src/Shop.Api/Data/ShopContext.cs',
    'src/Shop.Api/Program.cs -> src/Shop.Api/Auth.cs',
    'src/Shop.Api/Program.cs -> src/Shop.Api/Data/ShopContext.cs',
  ]);
});

test('a using does not link to everything in the namespace', () => {
  // `Shop.Api.Services` holds `PricingClient` and `Reporting`, and no file that imports
  // that namespace names either of them. Linking to a namespace's whole contents would
  // turn one line into an arrow per file and call every one a dependency.
  const targets = result.atlas.edges.filter((edge) => edge.kind === 'imports').map((edge) => edge.toId);
  for (const unused of ['PricingClient.cs', 'Reporting.cs']) {
    assert.ok(!targets.some((id) => id.endsWith(unused)), `${unused} is imported by nothing that names it`);
  }
});

test('a namespace link is likely, because a name matched a name', () => {
  // A Go import path resolves to a folder and is `certain`. This is a namespace and a
  // name, which is the same grade of evidence as everything else in this tier.
  for (const edge of result.atlas.edges.filter((e) => e.kind === 'imports')) {
    assert.equal(edge.confidence, 'likely');
  }
});

test('where to look first has something to say', () => {
  const start = new AtlasGraph(result.atlas).getOverview().whereToLookFirst;
  assert.ok(start.length > 0, 'a C# project with links in it can be ranked');
});

// ---------------------------------------------------------------------------
// Visibility, which C# writes as a keyword
// ---------------------------------------------------------------------------

test('public is read from the word public, not from the capital letter', () => {
  const file = nodes.find((node) => node.path?.endsWith('Data/ShopContext.cs'));
  // `Orders` and `Customers` are public properties; `_connectionString` is private and
  // `InternalNote` is `internal` — visible across the assembly and no further, which is
  // exactly where the line is drawn. All four are PascalCase or underscore by
  // convention, and the convention is not what was read.
  assert.ok(file.meta.exportedNames.includes('ShopContext'));
  assert.ok(!file.meta.exportedNames.includes('_connectionString'));
  assert.ok(!file.meta.exportedNames.includes('InternalNote'));
});

test('a docstring is read verbatim, XML tags and all', () => {
  const context = nodes.find((node) => node.kind === 'type' && node.name === 'ShopContext');
  assert.equal(context.summarySource, 'docs');
  assert.match(context.summary, /Every table this app knows about/);
});

test('the map has the shape of the code', () => {
  const graph = new AtlasGraph(result.atlas);
  const types = nodes.filter((node) => node.kind === 'type' && node.meta.typeKind !== 'table');
  for (const expected of ['OrdersController', 'ShopContext', 'Order', 'Customer', 'OrderRequest', 'PricingClient']) {
    assert.ok(types.some((type) => type.name === expected), `${expected} is missing`);
  }
  assert.ok(graph.getOverview().app, 'and the app node exists');
});
