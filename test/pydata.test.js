/**
 * @fileoverview Where a Python project's data lives (#26, #16).
 *
 * Two fixtures, because the interesting cases pull in opposite directions. `pydata` is
 * a repo of scripts: pandas, files on disk, and a MySQL connection opened in one file
 * and queried from another. `pyorm` is an application: SQLAlchemy, routes and queries
 * in the same file, and the three query shapes that used to produce a confident wrong
 * answer.
 *
 * Most of these assertions are negative. Finding a `read_csv` is easy; the job is to
 * not call `os.environ.get` a database read, not call `@router.get` one either, and not
 * name a table `limit` because an f-string left a hole where the table should be.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyzeProject, AtlasGraph, buildBoundaryView, catalogSchema } from '../dist/node/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));

const scripts = await analyzeProject(path.join(here, 'fixtures', 'pydata'), { cache: 'off' });
const app = await analyzeProject(path.join(here, 'fixtures', 'pyorm'), { cache: 'off' });

const readable = scripts.atlas.meta.languages.includes('python') && scripts.atlas.nodes.some((n) => n.kind === 'function');
const skip = readable ? false : 'no Python 3.9+ on this machine';

const storesOf = (result) => result.atlas.nodes.filter((n) => n.kind === 'store');
const store = (result, name) => storesOf(result).find((n) => n.name === name);
const sites = (result, name) => (store(result, name)?.meta.sites ?? []).map((s) => `${s.path}:${s.line} ${s.snippet}`);

// ---------------------------------------------------------------------------
// Data files
// ---------------------------------------------------------------------------

test('a format the call names out loud becomes a box of its own', { skip }, () => {
  const found = storesOf(scripts)
    .filter((n) => n.meta.storeKind === 'filesystem')
    .map((n) => `${n.name} · ${n.meta.client} · ${n.meta.reads}r ${n.meta.writes}w`)
    .sort();

  assert.deepEqual(found, [
    'CSV files · pandas · 2r 1w',
    'Files on disk · Python · 3r 2w',
    'NumPy array files · NumPy · 0r 1w',
    'Parquet files · pandas · 0r 1w',
    'Saved Python objects · joblib · 0r 1w',
  ]);
});

test('the format comes from the call, never from the path', { skip }, () => {
  // `open("out/report.html", "w")` names a format in its string, and stays "Files on
  // disk" all the same. Splitting on the path would let an inlined literal decide what
  // the reader sees, so the same code written with a variable would land in a different
  // box from the code written with a string.
  assert.ok(sites(scripts, 'Files on disk').some((s) => s.includes('report.html')));
  assert.equal(store(scripts, 'HTML files'), undefined);
});

test('the call that opens the file is the site, not the one that parses it', { skip }, () => {
  // `with open(…) as f: json.load(f)` is one file being read. Counting the parse as
  // well would report every settings file in the repo twice.
  const lines = sites(scripts, 'Files on disk');
  assert.equal(lines.filter((s) => s.includes('settings.json')).length, 1);
  assert.ok(!lines.some((s) => s.includes('json.load')));
});

test('pathlib counts, whether the Path is built here or handed in', { skip }, () => {
  const lines = sites(scripts, 'Files on disk');
  assert.ok(lines.some((s) => s.includes('Path(…).read_text')), 'Path(x).read_text()');
  assert.ok(lines.some((s) => s.includes('path.open("r"')), 'a Path passed in as an argument');
});

test('a mode string is what makes something.open a file being opened', { skip }, () => {
  // The receiver's name is no help — a Path, a ZipFile and a webbrowser all spell it
  // `open`. `path.open("r", encoding=…)` has the shape of a file; `webbrowser.open(url)`
  // does not, and nothing in this fixture should have taught us otherwise.
  const opens = sites(scripts, 'Files on disk').filter((s) => s.includes('.open('));
  assert.equal(opens.length, 1);
});

// ---------------------------------------------------------------------------
// Databases: the evidence has to be database code
// ---------------------------------------------------------------------------

test('a store cites the code that touches it, not the code that configures it', { skip }, () => {
  const mysql = store(scripts, 'MySQL');
  assert.ok(mysql, 'the MySQL box exists');
  const lines = sites(scripts, 'MySQL');
  assert.ok(!lines.some((s) => s.includes('environ')), `environment lines are not database evidence:\n${lines.join('\n')}`);
  assert.ok(lines.some((s) => s.includes('pymysql.connect')), 'the connection is');
  assert.ok(lines.some((s) => s.includes('SELECT VERSION')), 'and so is the query');
});

test('a connection with nothing else is still a database', { skip }, () => {
  // `pymysql.connect("localhost")` may be the only line in a repo that says which
  // database this is. A box with no read and no write is a truer answer than no box,
  // and it is the same reading a Worker binding gets from `wrangler.toml`.
  assert.ok(sites(scripts, 'MySQL').some((s) => s.includes('pymysql.connect')));
});

test('queries reach the box even from a file that imports no client', { skip }, () => {
  // The scripts get their connection from a helper module, so requiring the import
  // would lose every query in the repo. Two boxes for one database reads as an app with
  // two databases, so the unnamed queries fold into the named client.
  const lines = sites(scripts, 'MySQL');
  assert.ok(lines.some((s) => s.includes('queries.py') && s.includes('FROM orders')));
  assert.ok(lines.some((s) => s.includes('queries.py') && s.includes('UPDATE orders')));
  assert.equal(store(scripts, 'Database'), undefined, 'and no second box called "Database"');
});

test('the direction comes from the statement', { skip }, () => {
  const mysql = store(scripts, 'MySQL');
  assert.equal(mysql.meta.writes, 1, 'the UPDATE');
  assert.ok(mysql.meta.reads >= 2, 'the SELECTs');
});

// ---------------------------------------------------------------------------
// The database's own bookkeeping (#86)
// ---------------------------------------------------------------------------

test('the schema probe leaves the data model exactly as it found it', { skip }, () => {
  // The bar the issue set: diff the list, not its length. `schema_probe.py` adds three
  // catalog queries and one ordinary one, so the app's tables are `orders` plus the
  // `shipments` that script names — and nothing whatsoever from information_schema.
  assert.deepEqual(store(scripts, 'MySQL').meta.tables, ['orders', 'shipments']);
});

test('the catalog rows are kept, apart, so the page can say what happened', { skip }, () => {
  assert.deepEqual(store(scripts, 'MySQL').meta.catalogTables, [
    'information_schema.columns',
    'information_schema.tables',
    'information_schema.triggers',
  ]);
});

test('a catalog read is still a read', { skip }, () => {
  // The queries are real, they run, and they hit the database. Only the *table* is
  // disqualified — dropping the read too would understate what the app does.
  const lines = sites(scripts, 'MySQL');
  assert.ok(lines.some((s) => s.includes('schema_probe.py') && s.includes('information_schema')));
});

test('every vendor catalog is recognised, and no ordinary table is', () => {
  for (const name of [
    'information_schema.columns',
    'INFORMATION_SCHEMA.TABLES',
    'pg_catalog.pg_class',
    'pg_stat_activity',
    'sqlite_master',
    'sqlite_sequence',
    'mysql.user',
    'performance_schema.events_statements_summary_by_digest',
    'sys.tables',
    'user_tab_columns',
  ]) {
    assert.ok(catalogSchema(name), `${name} is the database describing itself`);
  }

  // The rule earns its keep by what it refuses. `user_sessions` and `user_accounts` are
  // why Oracle is a list of view names rather than a `USER_` prefix: a prefix rule would
  // take real tables out of the data model of most apps that have users.
  for (const name of [
    'orders',
    'users',
    'user_sessions',
    'user_accounts',
    'all_hands_meetings',
    'system_settings',
    'schema_migrations',
    'public.information',
    'postgres_config',
    'sqlitedb',
  ]) {
    assert.equal(catalogSchema(name), null, `${name} is somebody's table`);
  }
});

// ---------------------------------------------------------------------------
// Databases: an ORM, and the shapes that used to lie
// ---------------------------------------------------------------------------

test('the engine is read out of the connection URL', { skip }, () => {
  assert.ok(store(app, 'PostgreSQL'), `expected PostgreSQL, got ${storesOf(app).map((n) => n.name).join(', ')}`);
});

test('the connection URL never reaches the atlas', { skip }, () => {
  // A path names the database file and is worth showing. A URL carries the password,
  // and the atlas is a file people share.
  const text = JSON.stringify(app.atlas);
  assert.ok(!text.includes('hunter2'), 'the password is not in the atlas');
});

test('a route decorator is not a database read', { skip }, () => {
  // `@router.get("/items")` is a call whose method is `get`. So is `payload.get("name")`
  // and `form_data.get("name")`. Counting method names alone made one FastAPI app report
  // forty of its own routes as queries.
  const lines = sites(app, 'PostgreSQL');
  for (const wrong of ['router.get', 'router.post', 'router.put', 'payload.get', 'form_data.get']) {
    assert.ok(!lines.some((s) => s.includes(wrong)), `${wrong} is not a query:\n${lines.join('\n')}`);
  }
});

test('a session held under any name is still a session', { skip }, () => {
  // `db_session` is what the app calls it. Matching the whole name only would drop
  // every query in the repo; matching any name at all picks up `form_data`.
  const lines = sites(app, 'PostgreSQL');
  assert.ok(lines.some((s) => s.includes('db_session.add')));
  assert.ok(lines.some((s) => s.includes('db_session.commit')));
});

test('a statement built before it is run still says which way it went', { skip }, () => {
  // Modern SQLAlchemy writes `select(Item)` rather than `"SELECT …"`, inline or bound
  // to a name one line up. Without reading the builder, every query in the app is a
  // call whose direction is unknown.
  const postgres = store(app, 'PostgreSQL');
  assert.ok(postgres.meta.reads >= 2, `reads: ${postgres.meta.reads}`);
  assert.ok(postgres.meta.writes >= 3, `writes: ${postgres.meta.writes}`);
});

test('an f-string gives up its verb but not its table', { skip }, () => {
  // `f"SELECT * FROM {table} LIMIT {n}"` arrives as `SELECT * FROM  LIMIT`, and the
  // first word after FROM is LIMIT. A table called `limit` is a name the reader can go
  // looking for and never find.
  assert.ok(!store(app, 'PostgreSQL').meta.tables.includes('limit'));
});

test('a catalog view is not part of the data model, and says so (#86)', { skip }, () => {
  // Superseding the older rule that kept the schema qualifier on the name. Keeping
  // `information_schema.columns` out of `columns` was right and not enough: it still
  // sat in the table list beside `orders`, so the page still claimed the app owns it.
  const postgres = store(app, 'PostgreSQL');
  assert.ok(!postgres.meta.tables.includes('information_schema.columns'), `got ${postgres.meta.tables.join(', ')}`);
  assert.ok(!postgres.meta.tables.includes('columns'), 'and it is not mistaken for one of the app’s own either');
  assert.ok(postgres.meta.tables.includes('orders'), 'public.orders is just orders, and it stays');

  // Kept, not dropped — the read happened, and a repo that queries its own schema is
  // telling you something true about itself.
  assert.deepEqual(postgres.meta.catalogTables, ['information_schema.columns']);
});

test('one table spelled two ways is one table', { skip }, () => {
  // `session.get(Item, id)` names the model; the SQL beside it names the table. SQL
  // does not distinguish them either, and counting both turns two tables into four.
  const tables = store(app, 'PostgreSQL').meta.tables;
  assert.equal(tables.filter((t) => t.toLowerCase() === 'item').length, 1, `got ${tables.join(', ')}`);
});

// ---------------------------------------------------------------------------
// What the reader sees
// ---------------------------------------------------------------------------

test('a store nothing writes to still says what it is', { skip }, () => {
  const view = buildBoundaryView(new AtlasGraph(scripts.atlas));
  const csv = view.outputs.find((card) => card.name === 'CSV files');
  assert.ok(csv, `expected a CSV card, got ${view.outputs.map((c) => c.name).join(', ')}`);
  const parquet = view.outputs.find((card) => card.name === 'Parquet files');
  assert.match(parquet.detail, /1 write/);
});
