/**
 * @fileoverview A gate on a bare-mounted router does not cover the parent app (#260).
 *
 * `routerMiddleware` emits a gate whose pattern is the prefix of the `.use` that
 * registered it. With no prefix — `app.use(api)` — that pattern is the catch-all
 * `/:path*`, and a catch-all covers every address in the program by design (#172, which
 * is right for a NestJS `APP_GUARD` and wrong here).
 *
 * So a check written on a sub-router was reported in front of the parent app's own
 * routes, including two registered *above* the mount, which Express answers before it
 * ever reaches the gate. The count of unprotected doors read zero on an app with two
 * open ones — a false green, which is the direction this project treats as expensive.
 *
 * The ordering rule could not catch it: `registeredAboveTheGate` compares a door and a
 * gate that belong to the same router, and here the door's is `app` while the gate's is
 * `api`, so it answered false and suppressed nothing.
 *
 * mastodon has this exact shape in `streaming/index.js` and stays quiet today only
 * because `authenticationMiddleware` matches no name in the guard vocabulary. Fixing
 * the vocabulary (#261) would have turned it on.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyzeProject } from '../dist/node/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const { atlas } = await analyzeProject(path.join(here, 'fixtures', 'tsbaremount'), {
  followReferences: true,
  cache: 'off',
});

const doors = new Map(
  atlas.nodes
    .filter((n) => n.kind === 'endpoint' && n.meta.endpointKind === 'http-route')
    .map((n) => [`${n.meta.method} ${n.meta.route}`, (n.meta.guards ?? []).map((g) => g.name)]),
);

test('the fixture parsed, so a silent failure cannot pass as a pass', () => {
  assert.deepEqual(atlas.meta.warnings, []);
  assert.deepEqual([...doors.keys()].sort(), [
    'GET /favicon.ico',
    'GET /items',
    'GET /metrics',
    'GET /reports/daily',
  ]);
});

test('a route on the parent app is not covered by the mounted router\'s gate', () => {
  // The regression. Both were reported `requireSession:likely`, and Express never runs
  // it for either — they are registered above the mount and answer before it.
  assert.deepEqual(doors.get('GET /favicon.ico'), []);
  assert.deepEqual(doors.get('GET /metrics'), []);
});

test('the gated router keeps its own check', () => {
  assert.deepEqual(doors.get('GET /items'), ['requireSession']);
});

test('a router mounted beneath the gated one still inherits the gate', () => {
  // The half a fix must not break, and the reason the rule walks the mount graph rather
  // than comparing one router to one gate. `adminRouter` names no check of its own.
  assert.deepEqual(doors.get('GET /reports/daily'), ['requireSession']);
});

test('the two open doors are counted as open', () => {
  // The number is the point: it read zero, on an app with two unchecked routes.
  assert.equal(atlas.meta.stats.routes, 4);
  assert.equal(atlas.meta.stats.unprotectedRoutes, 2);
});
