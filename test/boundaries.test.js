/**
 * @fileoverview End-to-end tests for the boundary layer (SPEC.md 5.3, 6.1, 6.6).
 *
 * The fixture is a small but realistic Next.js app: App Router routes, a page behind
 * Clerk middleware, a server action with no auth at all, a Stripe webhook, a Vercel
 * cron, Prisma, Resend and a literal-URL analytics call.
 *
 * The assertions that matter most are the negative ones. Anything can find a route;
 * the job here is to not claim a route is protected when it is not, and to not invent
 * a service that the code never calls.
 */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import { analyzeProject, AtlasGraph, buildBoundaryView, buildInsights } from '../dist/node/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, 'fixtures', 'boundary');

const { atlas } = await analyzeProject(FIXTURE, { followReferences: true, cache: 'off' });
const graph = new AtlasGraph(atlas);
const boundaries = buildBoundaryView(graph);
const insights = buildInsights(graph);

const byId = new Map(atlas.nodes.map((n) => [n.id, n]));
const endpoints = atlas.nodes.filter((n) => n.kind === 'endpoint');
const endpoint = (name) => endpoints.find((n) => n.name === name);
const route = (path) => insights.auth.routes.find((r) => r.route === path || r.name === path);

test('reads Next.js App Router routes off the file system', () => {
  const paths = endpoints
    .filter((n) => n.meta.endpointKind === 'http-route')
    .map((n) => `${n.meta.method} ${n.meta.route}`)
    .sort();

  assert.deepEqual(paths, [
    // The Supabase edge function: deployed HTTP that package.json never mentions.
    'ANY /functions/v1/greet',
    'GET /api/users',
    'PAGE /',
    // The `(app)` route group shapes the folder tree but not the URL.
    'PAGE /dashboard',
    'POST /api/users',
  ]);
});

test('a Deno.serve file under supabase/functions is a door', () => {
  const fn = endpoint('ANY /functions/v1/greet');
  assert.ok(fn, 'the directory convention is the deployment contract');
  assert.equal(fn.meta.framework, 'Supabase Edge Function');
  // The platform checks the JWT by default, but a config file we may not see can
  // turn that off — so the claim must stay "likely", never "certain".
  const guard = fn.meta.guards.find((g) => g.provider === 'Supabase');
  assert.ok(guard);
  assert.equal(guard.confidence, 'likely');
});

test('finds server actions, which look nothing like an endpoint', () => {
  const action = endpoint('createOrder');
  assert.ok(action, 'the exported async function in a "use server" file is a door');
  assert.equal(action.meta.endpointKind, 'server-action');
  assert.equal(action.meta.writes, true);
});

test('promotes a route to a webhook when it verifies a signature', () => {
  const hook = endpoint('POST /api/webhooks/stripe');
  assert.ok(hook);
  assert.equal(hook.meta.endpointKind, 'webhook');
  const guard = hook.meta.guards.find((g) => g.provider === 'Stripe');
  assert.ok(guard, 'the signature check is what protects a webhook');
  assert.equal(guard.confidence, 'certain');
});

test('folds a vercel.json cron into the route it actually calls', () => {
  const cron = endpoints.filter((n) => n.meta.endpointKind === 'cron');
  assert.equal(cron.length, 1, 'one schedule, one door — not a duplicate pair');
  assert.equal(cron[0].meta.route, '/api/cron/digest');
  assert.equal(cron[0].meta.schedule, '0 8 * * *');
  // It still knows which code answers it.
  const exposed = atlas.edges.filter((e) => e.kind === 'exposed-by' && e.fromId === cron[0].id);
  assert.ok(exposed.some((e) => e.toId.includes('cron/digest')));
});

test('an auth check inside a handler protects that handler and no other', () => {
  const post = route('/api/users');
  const all = insights.auth.routes.filter((r) => r.route === '/api/users');
  const get = all.find((r) => r.method === 'GET');
  const write = all.find((r) => r.method === 'POST');

  assert.ok(post && get && write);
  // POST calls auth() in its own body.
  assert.equal(write.protection, 'protected');
  assert.ok(write.guards.some((g) => g.provider === 'Clerk' && g.confidence === 'certain'));

  // GET sits in the same file and calls nothing. It is only covered by middleware,
  // which we can only approximate — so it must not be reported as certain.
  assert.equal(get.protection, 'likely');
  assert.ok(!get.guards.some((g) => g.confidence === 'certain'));
});

test('a middleware matcher reaches routes declared in other files', () => {
  const dashboard = route('/dashboard');
  assert.ok(dashboard);
  assert.ok(
    dashboard.guards.some((g) => g.name === 'clerkMiddleware' || g.provider === 'Clerk'),
    'matcher /dashboard/:path* covers /dashboard itself',
  );

  // …and does not reach ones it does not match.
  const home = route('/');
  assert.equal(home.protection, 'open');
});

test('names the doors nothing is guarding, worst first', () => {
  const open = insights.auth.routes.filter((r) => r.protection === 'open');
  assert.deepEqual(open.map((r) => r.name).sort(), ['/', 'createOrder']);
  // A writing endpoint with no check is the first thing anyone should see.
  assert.equal(insights.auth.routes[0].name, 'createOrder');
  assert.equal(insights.auth.routes[0].writes, true);
});

test('reads the database out of the client and the schema', () => {
  const stores = atlas.nodes.filter((n) => n.kind === 'store');
  assert.equal(stores.length, 2, 'Prisma and Supabase are different databases');

  const db = stores.find((n) => n.meta.client === 'Prisma');
  assert.equal(db.name, 'PostgreSQL', 'schema.prisma names the engine');
  assert.deepEqual(db.meta.tables, ['AuditLog', 'Order', 'User']);
  assert.ok(db.meta.reads > 0 && db.meta.writes > 0);

  const supabase = stores.find((n) => n.meta.client === 'Supabase');
  assert.ok(supabase);
  assert.deepEqual(supabase.meta.tables, ['client_errors', 'page_views'], 'table names read out of the queries');
});

test('a table named only in queries still becomes a shape', () => {
  const observed = atlas.nodes.find((n) => n.kind === 'type' && n.name === 'client_errors');
  assert.ok(observed, 'no schema declares client_errors; the .from() call is the evidence');
  assert.equal(observed.meta.typeKind, 'table');
  assert.equal(observed.meta.observed, true);
  assert.deepEqual(observed.meta.fields, [], 'columns are unknowable, and the card must not invent them');

  // The file that queries it references it, so "used in N places" is a fact.
  const refs = atlas.edges.filter((e) => e.kind === 'references' && e.toId === observed.id);
  assert.ok(refs.length > 0);

  // Tables a schema already declares must not appear twice.
  const orders = atlas.nodes.filter((n) => n.kind === 'type' && n.name === 'Order');
  assert.equal(orders.length, 1);
});

test('a function that only reads never gets a "writes to" arrow', () => {
  const reader = atlas.nodes.find((n) => n.kind === 'function' && n.name === 'countUsers');
  assert.ok(reader);
  const outgoing = atlas.edges.filter((e) => e.fromId === reader.id);
  assert.ok(outgoing.some((e) => e.kind === 'reads-from'));
  assert.ok(!outgoing.some((e) => e.kind === 'writes-to'));
});

test('names the companies data goes to, from SDKs and from literal URLs', () => {
  const names = insights.services.map((s) => s.name).sort();
  assert.deepEqual(names, ['Clerk', 'PostHog', 'Resend', 'Stripe']);

  const posthog = insights.services.find((s) => s.name === 'PostHog');
  assert.deepEqual(posthog.evidence, ['api.us.posthog.com'], 'resolved from the URL, not guessed');

  const resend = insights.services.find((s) => s.name === 'Resend');
  assert.equal(resend.category, 'email');
  assert.equal(resend.sends, true, 'sending mail is data leaving the app');
});

test('inventories every environment variable and checks it against .env.example', () => {
  assert.equal(insights.env.exampleFile, '.env.example');
  assert.deepEqual(insights.env.vars.map((v) => v.name).sort(), [
    'NEXT_PUBLIC_APP_URL',
    'NEXT_PUBLIC_SUPABASE_ANON_KEY',
    'RESEND_API_KEY',
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET',
    'SUPABASE_ANON_KEY',
    'SUPABASE_URL',
  ]);
  assert.deepEqual(insights.env.undocumented.map((v) => v.name).sort(), [
    'NEXT_PUBLIC_SUPABASE_ANON_KEY',
    'RESEND_API_KEY',
    'STRIPE_WEBHOOK_SECRET',
    'SUPABASE_ANON_KEY',
    'SUPABASE_URL',
  ]);
  const url = insights.env.vars.find((v) => v.name === 'SUPABASE_URL');
  assert.equal(url.secret, false, 'a URL is a setting, not a credential');
  const anonKey = insights.env.vars.find((v) => v.name === 'SUPABASE_ANON_KEY');
  assert.equal(anonKey.secret, true);
  const resendKey = insights.env.vars.find((v) => v.name === 'RESEND_API_KEY');
  assert.equal(resendKey.sites[0].path, 'src/lib/email.ts');
});

test('a variable the build tool publishes on purpose is not a secret', () => {
  // Every one of these trips the credential word-list on "key", and every one is
  // compiled into the client bundle by design. A secrets list that cries wolf on the
  // normal case teaches people to skim past the row that is real.
  const publicKey = insights.env.vars.find((v) => v.name === 'NEXT_PUBLIC_SUPABASE_ANON_KEY');
  assert.equal(publicKey.secret, false, 'NEXT_PUBLIC_* is inlined into the browser bundle');

  // Still inventoried, and still flagged as missing from .env.example — not a secret
  // is not the same as not worth writing down.
  assert.ok(insights.env.undocumented.some((v) => v.name === 'NEXT_PUBLIC_SUPABASE_ANON_KEY'));

  // The unprefixed twin, read on the server, keeps its badge.
  assert.equal(insights.env.vars.find((v) => v.name === 'SUPABASE_ANON_KEY').secret, true);
});

test('hangs every boundary off the two containers, with edges that land somewhere real', () => {
  for (const node of atlas.nodes) {
    if (node.kind === 'endpoint') assert.equal(node.parentId, 'zone:inbound');
    if (node.kind === 'service' || node.kind === 'store') assert.equal(node.parentId, 'zone:outbound');
  }
  const inbound = byId.get('zone:inbound');
  assert.ok(inbound);
  assert.equal(inbound.kind, 'zone');
  assert.equal(inbound.parentId, atlas.nodes.find((n) => n.kind === 'app').id);

  for (const edge of atlas.edges) {
    assert.ok(byId.has(edge.fromId), `${edge.id} starts somewhere real`);
    assert.ok(byId.has(edge.toId), `${edge.id} ends somewhere real`);
  }
});

test('groups the boundary view by family and connects it through the zones', () => {
  assert.deepEqual(
    boundaries.inputs.map((c) => c.name),
    ['Pages', 'API routes', 'Server actions', 'Webhooks', 'Scheduled jobs', 'Environment & config'],
  );
  assert.equal(boundaries.inputs.find((c) => c.name === 'Server actions').openCount, 1);

  // Stores come before services: the database is what people look for first.
  assert.equal(boundaries.outputs[0].name, 'PostgreSQL');

  // Every band must start and end on something that is actually on screen.
  const ids = new Set([
    ...boundaries.inputs.map((c) => c.id),
    ...boundaries.outputs.map((c) => c.id),
    ...boundaries.zones.map((z) => `zone:${z.zone}`),
  ]);
  assert.ok(boundaries.flows.length > 0);
  for (const flow of boundaries.flows) {
    assert.ok(ids.has(flow.fromId), `${flow.fromId} is on screen`);
    assert.ok(ids.has(flow.toId), `${flow.toId} is on screen`);
    assert.ok(flow.weight > 0);
  }
});

test('counts the boundary in the headline stats', () => {
  const s = atlas.meta.stats;
  assert.equal(s.endpoints, endpoints.length);
  assert.equal(s.stores, 2);
  assert.equal(s.externalServices, 4);
  assert.equal(s.envVars, 7);
  // Crons and config are not doors a stranger can knock on.
  assert.equal(s.routes, insights.auth.routes.length);
  assert.equal(s.unprotectedRoutes, insights.auth.openCount);
});

test('detects the frameworks from config files, not only package.json', () => {
  assert.ok(atlas.meta.frameworks.includes('Next.js App Router'));
  assert.ok(atlas.meta.frameworks.includes('Vercel Cron'));
});

// --- the schema read out of SQL migrations (no Prisma required) ---

test('reads tables out of SQL migrations, replayed in order', () => {
  const tables = atlas.nodes.filter((n) => n.kind === 'type' && n.meta.typeKind === 'table');
  const sessions = tables.find((n) => n.name === 'sessions');
  const pageViews = tables.find((n) => n.name === 'page_views');

  assert.ok(sessions, 'sessions is declared');
  assert.ok(pageViews, 'page_views is declared');
  assert.notEqual(sessions.meta.observed, true);
  assert.notEqual(pageViews.meta.observed, true);

  // Columns come from CREATE TABLE plus every later ALTER, in order.
  assert.deepEqual(
    pageViews.meta.fields.map((f) => f.name),
    ['id', 'path', 'session_id', 'at', 'referrer'],
  );
  const id = pageViews.meta.fields.find((f) => f.name === 'id');
  assert.equal(id.isId, true, 'the table-level PRIMARY KEY constraint lands on the column');
  const path = pageViews.meta.fields.find((f) => f.name === 'path');
  assert.equal(path.type, 'varchar(2048)', 'ALTER COLUMN TYPE is replayed too');

  const email = sessions.meta.fields.find((f) => f.name === 'user_email');
  assert.equal(email.isUnique, true, 'a table-level UNIQUE constraint lands on the column');
  assert.equal(sessions.summary, 'One row per visitor session.', 'COMMENT ON TABLE is the docstring');
});

test('a foreign key becomes a relation line from the exact column', () => {
  const fk = atlas.edges.find(
    (e) => e.kind === 'references' && e.fromId.endsWith('#page_views') && e.toId.endsWith('#sessions'),
  );
  assert.ok(fk, 'page_views.session_id → sessions exists');
  assert.deepEqual(fk.meta.fields, ['session_id']);
  assert.equal(fk.confidence, 'certain');
});

test('a table upgraded from observed to declared keeps its usage', () => {
  // metrics.ts queries page_views; before the migrations existed that produced an
  // observed card. Now the declared card must absorb those edges, not orphan them.
  const observed = atlas.nodes.filter(
    (n) => n.kind === 'type' && n.meta.observed === true && n.name === 'page_views',
  );
  assert.equal(observed.length, 0, 'no duplicate observed card');

  const declared = atlas.nodes.find((n) => n.name === 'page_views' && n.meta.typeKind === 'table');
  const usage = atlas.edges.filter((e) => e.kind === 'references' && e.toId === declared.id);
  assert.ok(usage.length >= 2, `query sites still point at the table (got ${usage.length})`);
});

test('row-level security is reported, and unknown is not rounded up to open', () => {
  const t = insights.tables;
  // 3 Prisma tables + 1 observed (protection unknowable for all four) + 2 SQL tables.
  assert.equal(t.total, 6);
  assert.equal(t.unknown, 4);
  assert.equal(t.unprotected, 0);
  // page_views: RLS enabled, zero policies — locked, and listed first.
  assert.equal(t.locked, 1);
  assert.equal(t.list[0].name, 'page_views');
  assert.equal(t.list[0].rls.enabled, true);
  assert.equal(t.list[0].rls.policyCount, 0);

  const sessions = t.list.find((x) => x.name === 'sessions');
  assert.deepEqual(sessions.rls, { enabled: true, policyCount: 1, commands: ['select'] });

  // The storage.objects policy belongs to Supabase's table, not ours — it must not
  // invent a table, and it must not crash the read.
  assert.ok(!t.list.some((x) => x.name === 'objects'));
});
