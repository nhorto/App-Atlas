/**
 * @fileoverview Column names that look like personal data (issue #48).
 *
 * The way this feature fails is by being believed. It matches names and never reads a
 * value, so both of its errors are quiet: `wallet_address` on a crypto app reads as a
 * home address, and a passport number in a column called `payload` reads as nothing at
 * all. Neither shows up as a crash, and both show up as a confident sentence in front of
 * a customer.
 *
 * So the negatives below are pinned by name alongside the positives, and the separation
 * between a direct match and an ambiguous one is asserted rather than assumed — rounding
 * `name` up to `first_name` is the single failure this issue was filed to prevent.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { classifyColumn, findPersonalData } from '../dist/node/model/personal.js';
import { analyzeProject, AtlasGraph, buildTypeView } from '../dist/node/index.js';
import { renderAtlasMarkdown } from '../dist/node/export/markdown.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** A table node carrying the columns the classifier reads. */
const table = (name, columns, id = `type:${name}`) => ({
  id,
  kind: 'type',
  name,
  path: `schema/${name}.sql`,
  zone: 'data',
  meta: { typeKind: 'table', fields: columns.map((column) => ({ name: column, type: 'text' })), isExported: true, extends: [] },
});

const edge = (kind, fromId, toId) => ({ id: `${fromId}-${kind}->${toId}`, kind, fromId, toId, weight: 1 });

// ---------------------------------------------------------------------------
// classifyColumn
// ---------------------------------------------------------------------------

test('a column that states what it holds is a direct match', () => {
  for (const name of ['email', 'ssn', 'date_of_birth', 'passport_number', 'iban', 'cvv', 'password', 'first_name']) {
    const hit = classifyColumn(name);
    assert.ok(hit, `${name} matched nothing`);
    assert.equal(hit.strength, 'direct', `${name} should be direct`);
  }
});

test('a column that might mean something else is ambiguous, never direct', () => {
  // Each of these is personal data on most apps and something else entirely on some.
  // Reported so a reader who knows the app can settle it; never counted as a fact.
  for (const name of ['name', 'address', 'city', 'country', 'username', 'age']) {
    const hit = classifyColumn(name);
    assert.ok(hit, `${name} matched nothing`);
    assert.equal(hit.strength, 'ambiguous', `${name} must not be reported as direct`);
  }
});

test('a technical qualifier means it is not a person', () => {
  // The false positives that would bury the real ones: every repo has dozens of these.
  for (const name of ['file_name', 'fileName', 'host_name', 'table_name', 'template_name', 'product_name', 'brand_name']) {
    assert.equal(classifyColumn(name), null, `${name} is not a person`);
  }
});

test('an address that belongs to a machine or a chain is not a home address', () => {
  for (const name of ['wallet_address', 'contract_address', 'server_address', 'network_address']) {
    assert.equal(classifyColumn(name), null, `${name} is not where somebody lives`);
  }
  // …while the ones that say which kind of address they are keep their meaning.
  assert.equal(classifyColumn('ip_address').category, 'device');
  assert.equal(classifyColumn('billing_address').strength, 'direct');
});

test('a made-up compound keeps a direct tail and drops an ambiguous one', () => {
  // `customer_email` is still an email address.
  assert.equal(classifyColumn('customer_email').strength, 'direct');
  assert.equal(classifyColumn('applicant_dob').category, 'date-of-birth');
  // `applicant_name` is not, because promoting an ambiguous tail turns every `x_name`
  // column in the repo into a person — which is how a list stops being read at all.
  assert.equal(classifyColumn('applicant_name'), null);
});

test('the schema house style does not decide whether a column is seen', () => {
  for (const spelling of ['first_name', 'firstName', 'FIRST_NAME', 'first-name']) {
    assert.equal(classifyColumn(spelling)?.category, 'person-name', `${spelling} was missed`);
  }
});

test('ordinary columns match nothing at all', () => {
  // A matcher that fires on these is one nobody will read twice.
  for (const name of ['id', 'user_id', 'order_id', 'created_at', 'status', 'state', 'title', 'amount', 'slug', 'url']) {
    assert.equal(classifyColumn(name), null, `${name} should not have matched`);
  }
});

test('the blind spot this cannot see is genuinely invisible', () => {
  // Named in the docs and in the exported prose as the reason absence is not clearance.
  // If this ever starts matching, the wording in the exporter has to change with it.
  assert.equal(classifyColumn('user_reference'), null);
  assert.equal(classifyColumn('payload'), null);
  assert.equal(classifyColumn('field_7'), null);
});

// ---------------------------------------------------------------------------
// findPersonalData
// ---------------------------------------------------------------------------

test('a table with no declared columns is reported as unlooked-at, not as clean', () => {
  // The most misleading thing this module could do is stay silent about a table whose
  // columns it never saw, because silence here reads as "nothing personal in it".
  const report = findPersonalData([table('page_views', [])], []);
  assert.deepEqual(report.tables, []);
  assert.equal(report.unknownColumns.length, 1);
  assert.equal(report.unknownColumns[0].name, 'page_views');
  assert.equal(report.tablesConsidered, 1);
});

test('the table with the strongest evidence is listed first', () => {
  const report = findPersonalData(
    [table('staff', ['email', 'city']), table('people', ['email', 'ssn', 'name'])],
    [],
  );
  assert.equal(report.tables[0].name, 'people', 'more direct matches outrank fewer');
  assert.equal(report.tables[0].columns.filter((c) => c.strength === 'direct').length, 2);
  assert.equal(report.tables[1].name, 'staff');
});

test('a table whose only evidence is a `name` column is counted, not listed', () => {
  // Measured on documenso: listing these put `ApiToken`, `BackgroundJob` and `Folder` in
  // a personal-data section for having a column called `name` — eleven rows of noise
  // around fourteen real ones, which is how a section stops being read.
  const report = findPersonalData(
    [table('api_tokens', ['name']), table('folders', ['name', 'city']), table('people', ['email'])],
    [],
  );
  assert.deepEqual(report.tables.map((t) => t.name), ['people']);
  assert.deepEqual(report.ambiguousOnly.map((t) => t.name).sort(), ['api_tokens', 'folders']);
});

test('a relation is not a column, however personal its name sounds', () => {
  // documenso's `EmailDomain.emails` is `OrganisationEmail[]` — a list of related rows,
  // not a column of email addresses. Only the type says so; the name never will.
  const nodes = [
    table('EmailDomain', [], 'type:EmailDomain'),
    table('OrganisationEmail', ['email'], 'type:OrganisationEmail'),
  ];
  nodes[0].meta.fields = [{ name: 'emails', type: 'OrganisationEmail[]' }, { name: 'domain', type: 'String' }];

  const report = findPersonalData(nodes, []);
  assert.deepEqual(report.tables.map((t) => t.name), ['OrganisationEmail']);
  assert.ok(!report.tables.some((t) => t.name === 'EmailDomain'), 'a relation was read as a column');
});

test('an exported function is not a way in, so it never counts as reaching a table', () => {
  // Same measurement: every documenso table came back "reached by" six seed scripts.
  // True, useless, and it crowds out the doors somebody outside can actually knock on.
  const nodes = [
    table('users', ['email']),
    { id: 'func:seed', kind: 'function', name: 'seedUser', path: 'seed/users.ts', zone: 'logic', meta: {} },
    { id: 'ep:export', kind: 'endpoint', name: 'IMPORT seed/users.ts#seedUser', zone: 'logic', meta: { endpointKind: 'export' } },
    { id: 'ep:route', kind: 'endpoint', name: 'GET /api/users', zone: 'api', meta: { endpointKind: 'http-route', route: '/api/users', method: 'GET' } },
  ];
  const edges = [
    edge('references', 'func:seed', 'type:users'),
    edge('exposed-by', 'ep:export', 'func:seed'),
    edge('exposed-by', 'ep:route', 'func:seed'),
  ];

  const report = findPersonalData(nodes, edges);
  assert.deepEqual(report.tables[0].doors.map((d) => d.name), ['GET /api/users']);
});

test('the doors that reach a table are traced through the query site', () => {
  const nodes = [
    table('users', ['email']),
    { id: 'func:handler', kind: 'function', name: 'GET', path: 'api/users.ts', zone: 'api', meta: {} },
    { id: 'ep:get-users', kind: 'endpoint', name: 'GET /api/users', path: 'api/users.ts', zone: 'api', meta: { route: '/api/users', method: 'GET' } },
  ];
  const edges = [
    // The handler queries the table…
    edge('references', 'func:handler', 'type:users'),
    // …and the door exposes the handler.
    edge('exposed-by', 'ep:get-users', 'func:handler'),
  ];

  const report = findPersonalData(nodes, edges);
  assert.equal(report.tables.length, 1);
  assert.deepEqual(report.tables[0].doors.map((d) => d.name), ['GET /api/users']);
});

test('a table nothing exposes reports no doors rather than guessing at one', () => {
  const nodes = [table('users', ['email']), { id: 'func:helper', kind: 'function', name: 'count', path: 'lib/db.ts', zone: 'logic', meta: {} }];
  const report = findPersonalData(nodes, [edge('references', 'func:helper', 'type:users')]);
  assert.deepEqual(report.tables[0].doors, []);
});

test('a project with no tables at all returns nothing to say', () => {
  const report = findPersonalData([{ id: 'file:a.ts', kind: 'file', name: 'a.ts', zone: 'logic', meta: {} }], []);
  assert.deepEqual(report.tables, []);
  assert.deepEqual(report.unknownColumns, []);
  assert.equal(report.tablesConsidered, 0);
});

// ---------------------------------------------------------------------------
// through the product
// ---------------------------------------------------------------------------

test('on a real fixture the section names the table, the column and the doors', async () => {
  const { atlas } = await analyzeProject(path.join(here, 'fixtures', 'boundary'), {
    cache: 'off',
    followReferences: true,
  });
  const markdown = renderAtlasMarkdown(new AtlasGraph(atlas), { toolVersion: 'test' });

  assert.match(markdown, /## Columns whose names suggest personal data/);
  assert.match(markdown, /\*\*User\*\* — `email`/);
  // Hand-checked against the fixture: `prisma.user` is touched at exactly three
  // door-reachable sites, and `src/lib/db.ts` is the fourth, behind no door.
  assert.match(markdown, /reached by .*GET \/api\/users/);
  assert.match(markdown, /reached by .*POST \/api\/users/);

  // The claim about the method has to travel with the finding, in the same section.
  assert.match(markdown, /has not read a single value/);
  assert.match(markdown, /has not been cleared/);
});

test('a SQLAlchemy table is given the columns its model declares (#80)', async () => {
  // The columns were always in the atlas — on the model *class*, while the table node
  // the queries produced sat empty beside it. On mealie that was 34 tables reporting
  // "columns unknown" with `email` and `password` a few nodes away.
  const { atlas } = await analyzeProject(path.join(here, 'fixtures', 'pymodels'), {
    cache: 'off',
    followReferences: true,
  });
  const tables = atlas.nodes.filter((node) => node.kind === 'type' && node.meta.typeKind === 'table');
  const byName = new Map(tables.map((node) => [node.name, node]));

  const invoices = byName.get('invoices');
  assert.ok(invoices, `no invoices table: ${[...byName.keys()].join(', ')}`);
  assert.deepEqual(invoices.meta.fields.map((f) => f.name), ['id', 'customer_id', 'total_cents', 'status']);
  // Where the columns came from, so nobody has to wonder why a database table is
  // carrying Python type annotations.
  assert.equal(invoices.meta.declaredBy, 'models.py');
  assert.equal(invoices.meta.observed, false, 'the columns were found, so it is no longer declared nowhere');
});

test('the fullest declaration of a table wins over a migration stub', async () => {
  // Two classes declare `customers`: the model with five columns and a migration stub
  // with two. Refusing on the collision is what left mealie with 16 empty tables; they
  // are not rival claims, they are partial views of one table.
  const { atlas } = await analyzeProject(path.join(here, 'fixtures', 'pymodels'), {
    cache: 'off',
    followReferences: true,
  });
  const customers = atlas.nodes.find(
    (node) => node.kind === 'type' && node.meta.typeKind === 'table' && node.name === 'customers',
  );
  assert.ok(customers, 'no customers table');
  assert.deepEqual(
    customers.meta.fields.map((f) => f.name),
    ['id', 'email', 'full_name', 'phone_number', 'is_active'],
    'took the stub instead of the model',
  );

  // …and the whole point of the join: the classification now has something to read.
  const report = findPersonalData(atlas.nodes, atlas.edges);
  const row = report.tables.find((t) => t.name === 'customers');
  assert.ok(row, 'the joined table produced no finding');
  assert.deepEqual(row.columns.filter((c) => c.strength === 'direct').map((c) => c.column), ['email', 'phone_number']);
});

test('a model class and the table it declares are one card, not two (item 41)', async () => {
  // Django's `class Profile(models.Model)` is not a table plus a class; it is a table,
  // written as a class. The atlas holds two nodes for it — the queries produce the
  // table, the file produces the class — and drawing both put all thirteen of
  // healthchecks' models on the canvas twice with identical field lists, each pair's
  // table half pointing at whichever file happened to query it first.
  const { atlas } = await analyzeProject(path.join(here, 'fixtures', 'pymodels'), {
    cache: 'off',
    followReferences: true,
  });
  const view = buildTypeView(new AtlasGraph(atlas));

  const names = view.cards.map((card) => card.name);
  assert.equal(new Set(names).size, names.length, `duplicated cards: ${names.join(', ')}`);

  // The card keeps the *table's* name and the *class's* location — `invoices` is what a
  // reader will look for in a database, and `models.py` is where it is written down.
  const invoices = view.cards.find((card) => card.name === 'invoices');
  assert.ok(invoices, `no invoices card: ${names.join(', ')}`);
  assert.equal(invoices.typeKind, 'table');
  assert.equal(invoices.path, 'models.py');
  assert.equal(invoices.observed ?? false, false);
  assert.ok(!names.includes('Invoice'), 'the class half should have been absorbed');
});

test('one table reached under two names is one row, not two', () => {
  // A SQLAlchemy app names its table twice — `select(User)` records the class name and
  // a raw query records `users`. Two rows would say personal data lives in two tables
  // when it lives in one, which is the number somebody repeats in a meeting.
  const a = table('User', ['email', 'password'], 'type:store#User');
  const b = table('users', ['email', 'password'], 'type:store#users');
  a.meta.declaredBy = 'db/models/users.py';
  b.meta.declaredBy = 'db/models/users.py';

  const report = findPersonalData([a, b], []);
  assert.equal(report.tables.length, 1, `collapsed to ${report.tables.map((t) => t.name).join(', ')}`);
  assert.deepEqual(report.tables[0].alsoKnownAs.length, 1);
});

test('two tables with no declaring model are left as two', () => {
  // Nothing here says they are the same table, so nothing here may merge them.
  const report = findPersonalData(
    [table('staff', ['email'], 'type:a'), table('members', ['email'], 'type:b')],
    [],
  );
  assert.equal(report.tables.length, 2);
});

test('a project where nothing matches gets no section rather than an empty scare', async () => {
  // A heading that promises personal data over a list of caveats reads either as an
  // alarm or as a clean bill of health, and a name match is not strong enough for either.
  const { atlas } = await analyzeProject(path.join(here, 'fixtures', 'pyorm'), {
    cache: 'off',
    followReferences: true,
  });
  const markdown = renderAtlasMarkdown(new AtlasGraph(atlas), { toolVersion: 'test' });
  assert.ok(!markdown.includes('Columns whose names suggest personal data'), markdown.slice(0, 400));
});
