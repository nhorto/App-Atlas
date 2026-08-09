/**
 * @fileoverview A group handed into a function has no address here, and two of those
 * are never one door (#151).
 *
 * gin's realworld app writes `func Routes(r *gin.RouterGroup)` in every package, and
 * the routes inside compose no prefix — so `POST ""` from the articles package
 * (mounted *after* `v1.Use(AuthMiddleware)`) and `POST ""` from the users package
 * (mounted before it, because it is how you sign up) merged onto one key: creating an
 * article and registering an account were one entry, wearing each other's truth.
 * #153's failure, in Go.
 *
 * The discriminator is the parameter's *type*, not the missing prefix. A missing
 * prefix is normal — `r.GET("/api/ping")` on the engine is complete — but a
 * `*gin.RouterGroup` only ever comes from a `Group(...)` call, so when one arrives as
 * a parameter its prefix belongs to the caller, and a route it failed to compose is
 * unresolved rather than whole. `ServeMux`/`Router`/`Engine` parameters are left
 * alone: gomount passes its root mux around with complete addresses, and unresolving
 * those would be the worse bug. The six older Go fixtures pin that this change
 * touches none of them.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyzeProject } from '../dist/node/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const { atlas } = await analyzeProject(path.join(here, 'fixtures', 'gingroups'), {
  followReferences: true,
  cache: 'off',
});

const routes = atlas.nodes.filter((n) => n.kind === 'endpoint' && n.meta.endpointKind === 'http-route');
const named = (name) => routes.find((n) => n.name === name);

test('two POSTs from two packages are two doors', () => {
  assert.equal(routes.length, 3, routes.map((n) => n.name).join(', '));
  assert.ok(named('POST … (ArticlesCreate)'));
  assert.ok(named('POST … (UsersRegister)'));
});

test('each unresolved door keeps a single site — no pooling across packages', () => {
  for (const name of ['POST … (ArticlesCreate)', 'POST … (UsersRegister)']) {
    const door = named(name);
    assert.equal(door.meta.sites.length, 1, `${name}: ${door.meta.sites.map((s) => s.path).join(', ')}`);
  }
});

test('an unresolved address is no address: route is null, so nothing matches a fragment', () => {
  assert.equal(named('POST … (ArticlesCreate)').meta.route, null);
  assert.equal(named('POST … (UsersRegister)').meta.route, null);
});

test('neither door wears a guard that belongs to the other', () => {
  // The truth this fixture cannot yet state — articles sits behind AuthMiddleware —
  // needs Use() ordering and cross-file group resolution, which is its own issue.
  // What must hold NOW is that the users door never inherits whatever articles gets.
  assert.deepEqual(named('POST … (UsersRegister)').meta.guards, []);
});

test('a complete address on the engine is untouched by any of this', () => {
  const ping = named('GET /api/ping');
  assert.ok(ping, `have: ${routes.map((n) => n.name).join(', ')}`);
  assert.equal(ping.meta.route, '/api/ping');
});
