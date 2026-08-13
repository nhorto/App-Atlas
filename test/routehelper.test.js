/**
 * @fileoverview A route registered by a function the app wrote itself (#229).
 *
 * `NodeBB/NodeBB` declares almost every door through one of three helpers of its own —
 * `setupPageRoute` 69 times, `setupAdminPageRoute` 61, `setupApiRoute` 204 — against 41
 * routes written the plain way. So the helper *is* how that application declares its
 * interface, and none of it was on the map: `/login`, `/register` and `/reset/:code?`
 * among the missing.
 *
 * The rule is `MountMethodFinding` one level down, and is recognised the same way: by
 * what the body does — it hands one of its own parameters to a route method as the path
 * — never by the name. `setupPageRoute` is not a word the detector knows.
 *
 * ## The half that is deliberately not done
 *
 * The obvious next step is to forward the helper's middleware list onto the doors it
 * opens, and it is the one thing here that would make the map worse. NodeBB puts
 * `middleware.authenticateRequest` at the head of every list it builds, and that function
 * returns true for an anonymous caller — it parses a session, it refuses nobody. It also
 * stands on `/login`, which is the proof: a check guarding the door that hands out
 * sessions is not a lock.
 *
 * Surveying the shape across five more projects settles it. Strapi's `compose-endpoint`
 * injects `createAuthorizeMiddleware`, which genuinely refuses with `ctx.unauthorized()`.
 * Same slot, opposite meaning, and nothing in the shape distinguishes them. So these
 * doors arrive with no checks and read as "not examined", which is what this tool says
 * everywhere else it has not established an answer, and under-claiming is the recoverable
 * direction.
 *
 * This comment used to say the rule cost NodeBB's 61 admin pages a real lock, because
 * `setupAdminPageRoute` injects `middleware.admin.isAdminPage`. That was wrong, and wrong
 * in the exact way this rule exists to prevent — it was read off the *name*. The body is
 * `res.locals.isAdminPage = true; next();`. It sets a flag and refuses nobody. NodeBB's
 * real admin gate is `middleware.admin.checkPrivileges`, attached by a path matcher in
 * `src/routes/index.js`, which is a shape read elsewhere in this codebase.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import { analyzeProject } from '../dist/node/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, 'fixtures', 'routehelper');

const { atlas } = await analyzeProject(FIXTURE, { followReferences: true, cache: 'off' });
const doors = atlas.nodes.filter((node) => node.kind === 'endpoint');
const byName = new Map(doors.map((node) => [node.name, node]));

test('a route registered through the app’s own helper is a door', () => {
  assert.deepEqual(doors.map((node) => node.name).sort(), [
    'DELETE /api/v3/categories/:cid',
    'GET /api/login',
    'GET /api/register',
    'GET /api/reset/:code?',
    'GET /api/v3/categories/:cid',
    'GET /login',
    'GET /plain',
    'GET /register',
    'GET /reset/:code?',
    'PUT /api/v3/categories/:cid',
  ]);
});

test('one call registering two routes gives two addresses', () => {
  // `setupPageRoute` ends with `router.get(name, …)` and `` router.get(`/api${name}`, …) ``
  // — the page and the JSON the page fetches. The second address is written nowhere in
  // the calling file, so a reader grepping for it would conclude it does not exist.
  assert.ok(byName.get('GET /login'), 'the page');
  assert.ok(byName.get('GET /api/login'), 'the JSON beside it');
});

test('the verb can come from the call site rather than the helper body', () => {
  // `router[verb](name, …)` — one helper covering every method, which is 204 of NodeBB's
  // 334 calls. The verb is read from the argument the caller wrote.
  assert.equal(byName.get('GET /api/v3/categories/:cid')?.meta.method, 'GET');
  assert.equal(byName.get('PUT /api/v3/categories/:cid')?.meta.method, 'PUT');
  assert.equal(byName.get('DELETE /api/v3/categories/:cid')?.meta.method, 'DELETE');
});

test('a helper-registered route composes its mount prefix like any other', () => {
  // The fragment in `write/categories.js` is `/:cid`, and on its own it is not an address
  // — it is three different doors wearing one name. The prefix comes from
  // `mountPoint.use('/api/v3/categories', require('./categories')())` a file away.
  assert.equal(byName.get('GET /api/v3/categories/:cid')?.meta.route, '/api/v3/categories/:cid');
});

test('the mount host is recognised by evidence, not by being spelled `router`', () => {
  // #234. `write/index.js` receives its router as `params.mountPoint` — a name
  // `ROUTER_NAMES` does not match — so the address above can only compose if the rule
  // read the *argument*: you cannot mount a sub-router onto something that is not one.
  //
  // Measured on the real thing before this existed: renaming NodeBB's `router` to `rtr`
  // took its `/api/v3` addresses from 204 to 2, with nothing else changed. Every one of
  // those addresses was resting on a coincidence of spelling.
  //
  // Spelling this parameter `router` would make this test pass for the wrong reason, so
  // if somebody renames it back, this comment is the reason not to.
  const source = readFileSync(path.join(FIXTURE, 'src/routes/write/index.js'), 'utf8');
  assert.match(source, /const \{ mountPoint \} = params/, 'the fixture stopped testing the rule');
  assert.equal(byName.get('PUT /api/v3/categories/:cid')?.meta.route, '/api/v3/categories/:cid');
});

test('the router is found when it was built straight off a require', () => {
  // `const router = require('express').Router()` binds no name for the constructor to be
  // read from, and fourteen of NodeBB's route modules open exactly this way. Without it
  // the module builds no router, so nothing mounts onto it and every address under it
  // stays a fragment.
  const door = byName.get('DELETE /api/v3/categories/:cid');
  assert.ok(door, 'the door on a router built through require');
  assert.equal(door.meta.route, '/api/v3/categories/:cid');
});

test('no check is claimed from the middleware the helper injects', () => {
  // The whole point. `authenticateRequest` matches the guard-prefix rule on its name
  // alone, is injected into every list `setupPageRoute` builds, and refuses nobody.
  // Claiming it would put a lock on the login page.
  for (const route of ['/login', '/register', '/reset/:code?', '/api/login', '/api/register']) {
    assert.deepEqual(byName.get(route)?.meta.guards ?? [], [], `${route} claimed a check it cannot prove`);
  }
});

test('a check the caller passes is read, because that is ordinary evidence', () => {
  // The other list, and the distinction the rule turns on. What the helper injects is
  // uniform across every door it opens and says nothing about any of them; what the
  // *caller* writes in the argument list sits beside one door, the same as
  // `router.get('/x', requireAuth, handler)`.
  //
  // Withholding it left 21 of NodeBB's `/api/v3/admin/*` doors — token management,
  // analytics, the settings writer — reading as though nothing guarded them, while
  // `[middleware.ensureLoggedIn, middleware.admin.checkPrivileges]` sat in the call.
  const door = doors.find((node) => node.meta.method === 'DELETE' && node.meta.route === '/api/v3/categories/:cid');
  assert.deepEqual(
    door?.meta.guards.map((guard) => guard.name),
    ['middleware.ensureLoggedIn'],
  );
});

test('a check spread from a list the file built earlier is still read', () => {
  // `const middlewares = [middleware.ensureLoggedIn]` and then `[...middlewares]` — the
  // name never appears in the argument list as written, and this is how NodeBB writes
  // every one of them. Resolved through the identifier's symbol rather than by scanning
  // the file, so a list declared inside a factory is still found (#204's scope trap).
  const door = doors.find((node) => node.meta.method === 'PUT' && node.meta.route === '/api/v3/categories/:cid');
  assert.deepEqual(
    door?.meta.guards.map((guard) => guard.name),
    ['middleware.ensureLoggedIn'],
  );
});

test('a helper call with no middleware of its own stays blank', () => {
  // The same helper, the same file, one line up. If the spread resolution leaked across
  // call sites this is the door that would show it.
  const door = doors.find((node) => node.meta.method === 'GET' && node.meta.route === '/api/v3/categories/:cid');
  assert.deepEqual(door?.meta.guards, []);
});

test('a route written out longhand is untouched by any of this', () => {
  assert.equal(byName.get('GET /plain')?.meta.route, '/plain');
});

test('a shim wearing the same idiom registers nothing', () => {
  // Apostrophe monkeypatches Express to log routes, in NodeBB's exact spelling: rest
  // arguments, handler off the end, path first, a route method called with it. It
  // forwards to the method it replaced and adds no door. Reading it as a helper would
  // invent routes at whatever addresses happened to pass through it.
  assert.equal(
    doors.filter((node) => node.meta.sites.some((site) => site.path.endsWith('instrument.js'))).length,
    0,
  );
});
