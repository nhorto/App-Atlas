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
    'GET /api/users',
    'PAGE /',
    // The `(app)` route group shapes the folder tree but not the URL.
    'PAGE /dashboard',
    'POST /api/users',
  ]);
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
  assert.equal(stores.length, 1);
  const db = stores[0];
  assert.equal(db.name, 'PostgreSQL', 'schema.prisma names the engine');
  assert.equal(db.meta.client, 'Prisma');
  assert.deepEqual(db.meta.tables, ['AuditLog', 'Order', 'User']);
  assert.ok(db.meta.reads > 0 && db.meta.writes > 0);
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
  assert.deepEqual(
    insights.env.vars.map((v) => v.name),
    ['RESEND_API_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'],
  );
  assert.deepEqual(
    insights.env.undocumented.map((v) => v.name).sort(),
    ['RESEND_API_KEY', 'STRIPE_WEBHOOK_SECRET'],
  );
  assert.ok(insights.env.vars.every((v) => v.secret), 'all three look like credentials');
  const resendKey = insights.env.vars.find((v) => v.name === 'RESEND_API_KEY');
  assert.equal(resendKey.sites[0].path, 'src/lib/email.ts');
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
  assert.equal(s.stores, 1);
  assert.equal(s.externalServices, 4);
  assert.equal(s.envVars, 3);
  // Crons and config are not doors a stranger can knock on.
  assert.equal(s.routes, insights.auth.routes.length);
  assert.equal(s.unprotectedRoutes, insights.auth.openCount);
});

test('detects the frameworks from config files, not only package.json', () => {
  assert.ok(atlas.meta.frameworks.includes('Next.js App Router'));
  assert.ok(atlas.meta.frameworks.includes('Vercel Cron'));
});
