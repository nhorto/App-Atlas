/**
 * @fileoverview End-to-end tests for the Python analyzer.
 *
 * These need a Python 3.9+ on the machine, which is the same thing the analyzer needs.
 * When there isn't one the tests skip rather than fail: a contributor working on the
 * TypeScript side should not have to install Python to run the suite, and the analyzer
 * itself degrades the same way — the files still appear, without their insides.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyzeProject, AtlasGraph, buildInsights, classifyZone } from '../dist/node/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, 'fixtures', 'pyapp');

const { atlas } = await analyzeProject(FIXTURE, { followReferences: true, cache: 'off' });
const readable = atlas.meta.languages.includes('python') && atlas.nodes.some((n) => n.kind === 'function');
const skip = readable ? false : 'no Python 3.9+ on this machine';

const find = (kind, name) => atlas.nodes.find((n) => n.kind === kind && n.name === name);
const endpoint = (name) => atlas.nodes.find((n) => n.kind === 'endpoint' && n.name === name);

test('finds every Python file, and reads its module docstring', { skip }, () => {
  const files = atlas.nodes.filter((n) => n.kind === 'file');
  assert.deepEqual(
    files.map((f) => f.path).sort(),
    ['app/__init__.py', 'app/db.py', 'app/main.py', 'app/services/billing.py', 'app/tasks.py'],
  );
  const db = files.find((f) => f.path === 'app/db.py');
  assert.equal(db.summary, 'Where the sample app keeps its data.');
  assert.equal(db.summarySource, 'docs');
  assert.equal(db.language, 'python');
});

test('reads functions with their annotations, and classes with their fields', { skip }, () => {
  const listUsers = find('function', 'list_users');
  assert.equal(listUsers.meta.signature, 'list_users(session: Session, limit?: int) -> Any');
  assert.equal(listUsers.summary, 'Everyone who has signed up, newest first.');

  const user = find('type', 'User');
  assert.equal(user.meta.typeKind, 'class');
  assert.deepEqual(user.meta.fields.map((f) => f.name), ['id', 'email', 'display_name']);
  assert.deepEqual(user.meta.extends, ['Base']);
});

/**
 * The one place a Python file can be misread badly. `app/` is a Next.js router in
 * JavaScript and just the package name in Python, so sharing the rules would paint a
 * whole backend as interface code.
 */
test('zones Python by what Python calls things', () => {
  assert.equal(classifyZone('app/main.py'), 'api');
  assert.equal(classifyZone('app/urls.py'), 'api');
  assert.equal(classifyZone('app/models.py'), 'data');
  assert.equal(classifyZone('app/services/billing.py'), 'logic');
  assert.equal(classifyZone('app/templates/index.py'), 'ui');
  assert.equal(classifyZone('tests/test_main.py'), 'test');
  assert.equal(classifyZone('app/settings.py'), 'config');
  // Still the JavaScript rules for JavaScript.
  assert.equal(classifyZone('src/app/page.tsx'), 'ui');
});

test('reads the dependency manifest, pins and extras included', { skip }, () => {
  assert.ok(atlas.meta.frameworks.includes('FastAPI'));
  assert.ok(atlas.meta.frameworks.includes('Celery'));
  assert.ok(atlas.meta.frameworks.includes('SQLAlchemy'));
});

test('finds the doors, and tells a webhook from a route', { skip }, () => {
  assert.ok(endpoint('GET /users'));
  assert.ok(endpoint('POST /orders'));
  assert.equal(endpoint('POST /webhooks/stripe').meta.endpointKind, 'webhook');
  assert.equal(endpoint('email_digest').meta.endpointKind, 'queue');
  assert.equal(endpoint('email_digest').meta.framework, 'Celery');
});

/**
 * The number the whole product turns on. A FastAPI dependency is named evidence, not
 * proof, so it counts as a guard but never as a certain one.
 */
test('sees a FastAPI dependency as a guard, and says only that it is likely', { skip }, () => {
  const orders = endpoint('POST /orders');
  assert.equal(orders.meta.guards.length, 1);
  assert.equal(orders.meta.guards[0].name, 'Depends(get_current_user)');
  assert.equal(orders.meta.guards[0].confidence, 'likely');

  assert.equal(endpoint('GET /users').meta.guards.length, 0);
  // Four, not three. `POST /webhooks/stripe` is called a webhook because of the word in
  // its address and nothing else — no signature is verified anywhere near it — so it is
  // a door anyone can post to. Leaving it out of the count was how an open door
  // disappeared from the one screen that exists to find open doors.
  assert.equal(atlas.meta.stats.routes, 4);
  assert.equal(atlas.meta.stats.unprotectedRoutes, 3);
});

test('names the company behind an outbound call, and keeps the ones it cannot name', { skip }, () => {
  const stripe = find('service', 'Stripe');
  assert.ok(stripe, 'Stripe should be recognised from the SDK import and the URL');
  assert.ok(stripe.meta.hosts.includes('api.stripe.com'));
  assert.ok(atlas.nodes.some((n) => n.kind === 'service' && n.name === 'ledger.acme-books.com'));
});

test('finds the database, and only lists tables it can actually name', { skip }, () => {
  const store = atlas.nodes.find((n) => n.kind === 'store');
  assert.equal(store.meta.client, 'SQLAlchemy');
  // `session.add(order)` passes a variable, not a table. Listing `order` as a table
  // would be a plain lie about the schema.
  assert.deepEqual(store.meta.tables, ['User']);
});

test('collects environment variables however they are read', { skip }, () => {
  const env = atlas.nodes.find((n) => n.kind === 'endpoint' && n.meta.endpointKind === 'env');
  const names = env.meta.vars.map((v) => v.name).sort();
  assert.deepEqual(names, ['DATABASE_URL', 'STRIPE_SECRET_KEY']);
});

/**
 * Reference edges are the difference between a file listing and a map. Python has no
 * type checker here, so the confidence on each edge is the honest part.
 */
test('links a call to the function it names, and grades how sure it is', { skip }, () => {
  const readUsers = find('function', 'read_users');
  const listUsers = find('function', 'list_users');
  const sameFile = find('function', 'get_current_user');
  const createOrder = find('function', 'create_order');

  const across = atlas.edges.find(
    (e) => e.kind === 'references' && e.fromId === readUsers.id && e.toId === listUsers.id,
  );
  assert.ok(across, 'read_users should reach list_users through the import');
  assert.equal(across.confidence, 'likely');

  const within = atlas.edges.find(
    (e) => e.kind === 'references' && e.fromId === createOrder.id && e.toId === sameFile.id,
  );
  assert.ok(within, 'a name declared in the same file is not a guess');
  assert.equal(within.confidence, 'certain');
});

test('links files that import each other', { skip }, () => {
  const imports = atlas.edges.filter((e) => e.kind === 'imports').map((e) => `${e.fromId} -> ${e.toId}`);
  assert.ok(imports.includes('file:app/main.py -> file:app/db.py'));
  assert.ok(imports.includes('file:app/main.py -> file:app/services/billing.py'));
  assert.ok(imports.includes('file:app/tasks.py -> file:app/db.py'));
});

test('the whole atlas still answers the questions the views ask of it', { skip }, () => {
  const graph = new AtlasGraph(atlas);
  const insights = buildInsights(graph);
  // The security screen and the headline count the same doors, including the webhook
  // that verifies nothing — two screens disagreeing about how many routes there are is
  // the fastest way to lose a reader's trust in both.
  assert.equal(insights.auth.total, 4);
  assert.equal(insights.auth.openCount, 3);
  assert.equal(insights.auth.likelyCount, 1);
  assert.ok(insights.services.some((s) => s.name === 'Stripe'));

  const level = graph.getLevel(graph.rootId);
  assert.ok(level.nodes.length > 0, 'the map has something to draw at the top level');
});

// ---------------------------------------------------------------------------
// A folder of scripts is not a library (found by running this on a real repo)
// ---------------------------------------------------------------------------

const SCRIPTS = path.join(here, 'fixtures', 'pyscripts');
const scripts = (await analyzeProject(SCRIPTS, { followReferences: true, cache: 'off' })).atlas;
const scriptsReadable =
  scripts.meta.languages.includes('python') && scripts.nodes.some((n) => n.kind === 'function');
const skipScripts = scriptsReadable ? false : 'no Python 3.9+ on this machine';

test('`if __name__ == "__main__"` is a command-line door', { skip: skipScripts }, () => {
  const cli = scripts.nodes.filter(
    (n) => n.kind === 'endpoint' && n.meta.endpointKind === 'cli',
  );
  assert.deepEqual(
    cli.map((n) => n.name).sort(),
    ['clean.py', 'report.py'],
    'both scripts declare themselves runnable without argparse',
  );
  assert.ok(
    cli.every((n) => n.meta.framework === '__main__'),
    'the guard is named as what made it a door',
  );
});

test('a folder of runnable scripts is a pipeline, not a library', { skip: skipScripts }, () => {
  // The bug this pins: module-level `def`s read as exports, so scripts nobody imports
  // were classified as code other code imports.
  assert.equal(scripts.meta.archetype.archetype, 'pipeline');
});

test('a byte-order mark does not make a file unreadable', { skip: skipScripts }, () => {
  const clean = scripts.nodes.find((n) => n.kind === 'file' && n.path === 'clean.py');
  assert.ok(clean, 'the BOM file is on the map');
  assert.equal(clean.summary, 'Cleans the export.', 'and its docstring was read');
  assert.ok(
    scripts.nodes.some((n) => n.kind === 'function' && n.name === 'clean'),
    'and so were its insides',
  );
});
