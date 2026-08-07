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
import { analyzeProject, AtlasGraph, findScopes, grammarTier } from '../dist/node/index.js';

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
    'GET /api/kiosk/roster',
    'GET /api/kiosk/today',
    'GET /api/v1/orders/{id:int}',
    'GET /api/v1/orders/public-status',
    'GET /health',
    'POST /admin/reindex',
    'POST /api/auth/login',
    'POST /api/auth/logout',
    'POST /api/auth/setup',
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
// A door points at the code that answers it (#99)
// ---------------------------------------------------------------------------

const handlerOf = (doorName) => {
  const door = doors.find((d) => d.name === doorName);
  const edge = result.atlas.edges.find((e) => e.kind === 'exposed-by' && e.fromId === door.id);
  return edge ? nodes.find((n) => n.id === edge.toId) : undefined;
};

test('an inline handler gets a node named after its door', () => {
  // The lambda is a real unit of code with a real range; what it lacked was a node.
  // Before this, every minimal-API route in a file pointed at the one method that
  // registered them all — clicking a door landed on the registration, not the answer.
  const handler = handlerOf('GET /health');
  assert.equal(handler?.name, 'GET /health handler');
  assert.equal(handler.meta.synthesized, 'route-handler', 'and it says the source never named it');
});

test('two doors registered side by side get two handlers, not one', () => {
  // #23's guard walk starts at the handler, so twenty routes sharing one handler node
  // means a check reachable from any of them looks reachable from all of them.
  const start = handlerOf('POST /api/kiosk/shift/start');
  const end = handlerOf('POST /api/kiosk/shift/end');
  assert.ok(start && end);
  assert.notEqual(start.id, end.id);
});

test('a one-liner delegating to a real method points at the method', () => {
  // `app.MapGet("/api/kiosk/roster", Roster)` — the handler is a definition, so
  // nothing is synthesized and the door lands on the eight lines that answer it.
  const handler = handlerOf('GET /api/kiosk/roster');
  assert.equal(handler?.name, 'Roster');
  assert.equal(handler.meta.synthesized, undefined);
});

// ---------------------------------------------------------------------------
// The door people sign in through (#102)
// ---------------------------------------------------------------------------

test('a route whose handler issues the session is public by design, and says why', () => {
  // `HttpContext.SignInAsync(…)` inside the handler is the evidence — #40's rule, in
  // .NET. A door that hands out sessions cannot require one, and before this it sat on
  // the worry list as an unexplained open door.
  const login = doors.find((d) => d.name === 'POST /api/auth/login');
  assert.equal(login.meta.signInCall?.what, 'sign-in');
  assert.equal(login.meta.open?.kind, 'auth-mount');
  assert.match(login.meta.open?.because ?? '', /ASP\.NET Core/);
});

test('sign-out is the same fact in the other direction', () => {
  const logout = doors.find((d) => d.name === 'POST /api/auth/logout');
  assert.equal(logout.meta.signInCall?.what, 'sign-out');
});

test('nothing is excused by its address', () => {
  // `POST /api/auth/setup` lives under `/api/auth/` and hands out no session. It is a
  // deliberate first-run hole and a reader deserves to see it — the trap #71 documents
  // is a rule that silences a door because of its name.
  const setup = doors.find((d) => d.name === 'POST /api/auth/setup');
  assert.equal(setup.meta.signInCall, undefined);
  assert.equal(setup.meta.open?.kind, 'worth-a-look');
});

// ---------------------------------------------------------------------------
// Code that runs without anybody knocking (#100)
// ---------------------------------------------------------------------------

const workers = nodes.filter((node) => node.kind === 'endpoint' && node.meta.endpointKind === 'worker');

test('a hosted service is a door, named once from two declarations', () => {
  // `class SyncWorker : BackgroundService` in one file, `AddHostedService<SyncWorker>()`
  // in another. Either alone is enough to say it runs; together they are one door that
  // names the type and the place it was wired in — not two.
  assert.equal(workers.length, 1, workers.map((w) => w.name).join(', '));
  assert.equal(workers[0].name, 'SyncWorker');
  assert.equal(workers[0].meta.framework, '.NET Generic Host');
  const sites = workers[0].meta.sites.map((s) => s.path).sort();
  assert.deepEqual(sites, ['src/Shop.Api/Program.cs', 'src/Shop.Api/Services/SyncWorker.cs']);
});

test('the interval it declared is read; one it did not would not be', () => {
  // `new PeriodicTimer(TimeSpan.FromMinutes(5))` is a literal, so saying "every 5
  // minutes" is reading, not inventing. A worker whose interval is configuration gets
  // no schedule at all, because "runs continuously" is true and a number would be made up.
  assert.equal(workers[0].meta.schedule, 'every 5 minutes');
});

test('its handler is ExecuteAsync, so its database calls hang off the door', () => {
  const handler = nodes.find((node) => node.name === 'ExecuteAsync' && node.meta.ownerName === 'SyncWorker');
  assert.ok(handler, 'the override exists as a node');
  const answers = result.atlas.edges.filter((edge) => edge.fromId === workers[0].id && edge.toId === handler.id);
  assert.equal(answers.length, 1, 'the door points at the method the framework calls');
});

test('a worker never enters the auth count', () => {
  // A stranger cannot knock on it. The one number people act on must not be inflated
  // by a door that was never reachable — the same rule crons and queues already follow.
  assert.equal(workers[0].meta.open, undefined, 'no open-door verdict is ever written on it');
  const doorNames = doors.map((d) => d.name);
  assert.ok(!doorNames.includes('SyncWorker'), 'and it is not filed with the HTTP routes');
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

test('a query names its table when the DbContext is in another file (#104)', () => {
  // `_db.Orders.FirstOrDefaultAsync(…)` and `_db.Orders.Add(…)` in the controller,
  // `_db.Orders.Where(…).ToListAsync(…)` in the worker — every DbSet lives in
  // Data/ShopContext.cs, so no single file can name the table. The declaration file
  // says "these names are tables", the query file carries its receiver, and the two
  // meet once every file has been read. Before this, the reads were counted with no
  // table and the `Add` was not counted at all.
  const ef = stores.find((store) => store.meta.client === 'Entity Framework Core');
  assert.equal(ef.meta.reads, 3, 'FirstOrDefaultAsync, Where, ToListAsync');
  assert.equal(ef.meta.writes, 3, 'Orders.Add, and SaveChangesAsync twice');
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
    'src/Shop.Api/Program.cs -> src/Shop.Api/Services/SyncWorker.cs',
    'src/Shop.Api/Services/SyncWorker.cs -> src/Shop.Api/Data/ShopContext.cs',
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
// Configuration is in appsettings.json, and now the map reads it (#101)
// ---------------------------------------------------------------------------

test('the keys the app reads are reported, whatever provider answers them', () => {
  // The old rule read only `GetEnvironmentVariable`, deliberately — and showed a
  // configuration surface of three on an app with far more than three settings. The
  // question on the screen is *what does this app need configured*; where the value
  // comes from is a deployment question, and it travels on the row instead.
  const env = nodes.find((node) => node.kind === 'endpoint' && node.meta.endpointKind === 'env');
  const names = env.meta.vars.map((v) => v.name);
  for (const key of ['Stripe:Key', 'ConnectionStrings:Shop', 'PowerFab', 'Vendor:ApiToken']) {
    assert.ok(names.includes(key), `${key} missing from ${names.join(', ')}`);
  }
  // …and every one of them is marked as configuration, never as an environment
  // variable no deployment has ever set — the part of the old rule that was right.
  for (const key of ['Stripe:Key', 'ConnectionStrings:Shop', 'PowerFab', 'Vendor:ApiToken']) {
    assert.equal(env.meta.vars.find((v) => v.name === key).config, true);
  }
});

test('documented means present in appsettings.json, and the missing key is the finding', () => {
  const env = nodes.find((node) => node.kind === 'endpoint' && node.meta.endpointKind === 'env');
  const byName = (name) => env.meta.vars.find((v) => v.name === name);
  assert.equal(byName('Stripe:Key').documented, true);
  assert.equal(byName('PowerFab').documented, true);
  // Read by the code, absent from every settings file — the same distinction
  // `.env.example` draws for the JavaScript side, and the row a reader acts on.
  assert.equal(byName('Vendor:ApiToken').documented, false);
  assert.match(env.meta.envExample, /appsettings\.json/, 'the file it was checked against is named');
});

test('a connection string is a credential by construction', () => {
  const env = nodes.find((node) => node.kind === 'endpoint' && node.meta.endpointKind === 'env');
  const conn = env.meta.vars.find((v) => v.name === 'ConnectionStrings:Shop');
  assert.equal(conn.secret, true, 'no word in the name matches the secret pattern, and it must not need to');
});

// ---------------------------------------------------------------------------
// A solution is a monorepo (#98)
// ---------------------------------------------------------------------------

const slnScopes = await findScopes(path.join(here, 'fixtures', 'csharpsln'));

test('every project in a .sln is a scope, and the service leads', () => {
  // The split *is* the architecture — Api → Core, arrows one way, enforced by the
  // compiler — and flattened into one map that is the one thing you cannot see. It
  // also mixes archetypes: one merged map had to pick a single verdict for a service,
  // a CLI and a library, and whichever it picked was wrong for the other two.
  assert.deepEqual(
    slnScopes.map((s) => `${s.name} (${s.kind})`),
    ['Fab.Api (app)', 'Fab.Cli (app)', 'Fab.Core (library)'],
  );
  assert.equal(slnScopes[0].dir, 'src/Fab.Api', 'the web service is what somebody calls the project');
});

test('a single-project repo does not gain a switcher it has no use for', async () => {
  // Shop.sln declares one project; the console fixture has one .csproj at the root.
  // "No scopes" and "one scope" mean the same thing everywhere: analyze the root.
  assert.deepEqual(await findScopes(path.join(here, 'fixtures', 'csharpapi')), []);
  assert.deepEqual(await findScopes(path.join(here, 'fixtures', 'csharpconsole')), []);
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
