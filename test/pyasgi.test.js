/**
 * @fileoverview Auth written in the wiring, not on the route (issue #37).
 *
 * The third and fourth spellings of the same idea, after a route's own dependency and a
 * router built with one: a check handed to the *mount*, and an ASGI middleware attached
 * to the app. Both are how a large Python service normally locks its API, because they
 * are the only spellings that cannot be forgotten on a new file — and both leave no
 * trace at all in the files that declare the routes.
 *
 * `Netflix/dispatch` locks a hundred and sixty-three of its two hundred routes on one
 * line of `api.py`. Every one of them read as wide open.
 *
 * The negative cases carry the weight here. Middleware is how gzip is attached as much
 * as how strangers are turned away, and a mount with no check on it must stay open even
 * when its sibling has one.
 */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import { analyzeProject } from '../dist/node/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const { atlas } = await analyzeProject(path.join(here, 'fixtures', 'pyasgi'), {
  followReferences: true,
  cache: 'off',
});

const endpoint = (name) => atlas.nodes.find((n) => n.kind === 'endpoint' && n.name === name);
const guards = (name) => endpoint(name)?.meta.guards ?? [];
const guardNames = (name) => guards(name).map((g) => g.name);

test('the fixture parsed, so a silent failure cannot pass as a pass', () => {
  assert.deepEqual(atlas.meta.warnings, []);
  assert.equal(atlas.nodes.filter((n) => n.kind === 'endpoint').length, 5);
});

test('a check handed to the mount reaches the routes it mounted', () => {
  // `private_views.py` contains no auth vocabulary whatsoever. The one line that
  // decides it is `include_router(..., dependencies=[Depends(get_current_user)])`,
  // two files away.
  assert.deepEqual(guardNames('GET /private/items'), ['get_current_user']);
  assert.deepEqual(guardNames('DELETE /private/items/{item_id}'), ['get_current_user']);
});

test('…and stops at the sibling that was mounted without one', () => {
  // Both routers are mounted on the same parent, four lines apart. A rule that read the
  // parent instead of the mount would report a login route as requiring a login.
  assert.deepEqual(guardNames('GET /public/health'), []);
  assert.deepEqual(guardNames('POST /public/login'), []);
});

test('the check says it lives in the configuration, not in the handler', () => {
  const guard = guards('GET /private/items')[0];
  assert.equal(guard.how, 'config', 'a reader who goes looking must be sent to the right file');
  assert.equal(guard.confidence, 'likely', 'wiring is evidence, never proof');
  assert.equal(guard.path, 'auth.py', 'the evidence is the check itself');
});

test('an ASGI middleware that turns strangers away guards the app under it', () => {
  // `admin_views.py` is one router with one route and no mention of a caller. The
  // check is a class in `main.py`, and it is attached with `add_middleware`.
  assert.deepEqual(guardNames('GET /admin/settings'), ['AuthMiddleware']);
  assert.equal(guards('GET /admin/settings')[0].how, 'middleware');
});

test('middleware that is not a check guards nothing', () => {
  // `app.add_middleware(GZipMiddleware, minimum_size=1000)` is written exactly like
  // the one above it. What separates them is that one of them returns a 401, which is
  // a fact about the code rather than about the name — the same rule the dependency
  // detector already uses, applied to the other place Python hides a check.
  const everyGuard = atlas.nodes
    .filter((n) => n.kind === 'endpoint')
    .flatMap((n) => n.meta.guards ?? [])
    .map((g) => g.name);
  assert.ok(!everyGuard.includes('GZipMiddleware'), everyGuard.join(', '));
});

test('the headline counts the routes nobody guarded, and no more', () => {
  assert.equal(atlas.meta.stats.routes, 5);
  assert.equal(atlas.meta.stats.unprotectedRoutes, 2);
});
