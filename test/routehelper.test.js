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
 * everywhere else it has not established an answer. The cost is accepted and is real:
 * NodeBB's 61 admin pages carry a genuine `isAdminPage` refusal and lose a true fact.
 * Under-claiming is the recoverable direction.
 */
import assert from 'node:assert/strict';
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
  // `router.use('/api/v3/categories', require('./categories')())` a file away.
  assert.equal(byName.get('GET /api/v3/categories/:cid')?.meta.route, '/api/v3/categories/:cid');
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
  for (const door of doors) {
    assert.deepEqual(door.meta.guards, [], `${door.name} claimed a check it cannot prove`);
  }
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
