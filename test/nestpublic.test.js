/**
 * @fileoverview A NestJS guard that permits everything is not a lock (#152).
 *
 * Nest has no `[AllowAnonymous]`. Excusing a route from a globally applied guard is
 * conventionally written *as a guard that returns true*, so the opt-out and the lock are
 * spelled identically — `@UseGuards(X)` either way — and only the class body tells them
 * apart. twentyhq/twenty writes one 27 times, with a docstring saying it "serves as
 * documentation that the endpoint is intentionally accessible without authentication",
 * and its two OAuth callbacks were reported as protected at `certain` confidence.
 *
 * `csharp/boundaries.ts` already calls this "the one direction this tool must never be
 * wrong in", which is why that tier has `ALLOW_ANONYMOUS`. This is the same rule for the
 * framework where the opt-out has no name of its own.
 *
 * The verdict is `declared-public` rather than silence, because the two are different
 * facts. Dropping the guard and stopping there would move twenty-seven deliberate
 * decisions onto the worry list — trading a false green for a false alarm. Somebody
 * wrote this down, and the map should say what they wrote.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyzeProject } from '../dist/node/index.js';
import { authHeadline } from '../dist/node/model/exposure.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const { atlas } = await analyzeProject(path.join(here, 'fixtures', 'nestpublic'), {
  followReferences: true,
  cache: 'off',
});

// Every door, not only the `http-route` ones: `POST /billing/webhook` is reclassified
// to `webhook` in the merge, on its address, which is correct and would otherwise hide
// the case this fixture exists to test.
const routes = atlas.nodes.filter(
  (n) => n.kind === 'endpoint' && (n.meta.endpointKind === 'http-route' || n.meta.endpointKind === 'webhook'),
);
const named = (name) => routes.find((n) => n.name === name);
const guardsOn = (name) => (named(name)?.meta.guards ?? []).map((g) => g.name);

test('the fixture parsed, so a silent failure cannot pass as a pass', () => {
  assert.deepEqual(atlas.meta.warnings, []);
  assert.equal(routes.length, 4);
});

test('a guard whose body is `return true` is not counted as a check', () => {
  assert.deepEqual(guardsOn('GET /billing/health'), []);
});

test('and the route is open on purpose, not merely unlocked', () => {
  // The distinction the whole issue turns on. Silence would put a deliberate decision
  // on the worry list; a lock would hide it. Neither is what the author wrote.
  assert.equal(named('GET /billing/health').meta.open.kind, 'declared-public');
});

test('a guard that can say no is still a check', () => {
  assert.deepEqual(guardsOn('GET /billing/invoices'), ['RealAuthGuard']);
});

test('the rule reads the body, never the name', () => {
  // `PublicApiKeyGuard` has "Public" in it and is a genuine check. A name match would
  // have unlocked a webhook.
  assert.deepEqual(guardsOn('POST /billing/webhook'), ['PublicApiKeyGuard']);
  assert.notEqual(named('POST /billing/webhook').meta.open?.kind, 'declared-public');
});

test('a route with no guard at all is still worth a look', () => {
  // Nothing here says this door is open on purpose. It is just open.
  assert.equal(named('POST /billing/charge').meta.open.kind, 'worth-a-look');
});

test('the headline counts a declared-public route as open on purpose', () => {
  assert.equal(atlas.meta.stats.unprotectedRoutes, 1);
  assert.equal(atlas.meta.stats.publicRoutes, 1);
  const line = authHeadline(atlas.meta.stats);
  assert.match(line.headline, /1 of 4 routes have no auth check/);
  assert.ok(
    line.caveats.some((c) => /1 more (is|are) pages or the door people sign in through/.test(c)),
    `expected the public route to be stated, got ${JSON.stringify(line.caveats)}`,
  );
});
