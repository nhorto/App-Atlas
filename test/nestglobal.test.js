/**
 * @fileoverview A guard the whole application stands behind is wired in one line no
 * controller imports (#172).
 *
 * `{ provide: APP_GUARD, useClass: AuthGuard }` is NestJS's "every route, unless it
 * opts out" — immich locks all 270 of its routes this way, with per-route decorators
 * that only set metadata for the global guard to read, and the map said `269 of 270
 * routes unprotected`. The largest false alarm this project has produced.
 *
 * Pinned here: both spellings of the wiring (directly in the module decorator, and
 * through an array variable, which is immich's); two real global guards staying two;
 * the #152 sentinel (`return true`) wired globally and counting for nothing; and the
 * unresolved-address door (#153) being exactly as behind the catch-all as its readable
 * neighbours — a global guard's reach is not an address pattern.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyzeProject } from '../dist/node/index.js';
import { authHeadline } from '../dist/node/model/exposure.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const { atlas } = await analyzeProject(path.join(here, 'fixtures', 'nestglobal'), {
  followReferences: true,
  cache: 'off',
});

const routes = atlas.nodes.filter((n) => n.kind === 'endpoint' && n.meta.endpointKind === 'http-route');
const guardsOn = (name) => (routes.find((n) => n.name === name)?.meta.guards ?? []).map((g) => g.name).sort();

test('every route is behind both global guards', () => {
  assert.equal(routes.length, 3, routes.map((n) => n.name).join(', '));
  assert.deepEqual(guardsOn('GET /status/health'), ['AuthGuard', 'MaintenanceGuard']);
  assert.deepEqual(guardsOn('POST /status/report'), ['AuthGuard', 'MaintenanceGuard']);
});

test('a door with no address is exactly as behind the catch-all', () => {
  const unresolved = routes.find((n) => n.meta.route === null);
  assert.ok(unresolved, 'the unread-prefix door exists');
  assert.deepEqual(
    unresolved.meta.guards.map((g) => g.name).sort(),
    ['AuthGuard', 'MaintenanceGuard'],
  );
});

test('the always-true sentinel wired globally counts for nothing', () => {
  for (const route of routes) {
    assert.ok(!route.meta.guards.some((g) => g.name === 'EveryoneGuard'), route.name);
  }
});

test('matched rather than proven: likely, never certain', () => {
  for (const route of routes) {
    for (const guard of route.meta.guards) assert.equal(guard.confidence, 'likely', `${route.name} ${guard.name}`);
  }
});

test('the headline says checked-with-a-hedge, not unprotected', () => {
  const stats = atlas.meta.stats;
  assert.equal(stats.unprotectedRoutes, 0);
  // "all matched, none proven" — the all-likely phrasing, which is this fixture's truth.
  assert.match(authHeadline(stats).headline, /has an auth check — all matched, none proven/);
});
