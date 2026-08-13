/**
 * @fileoverview Where a check was written, against where the routes were (#201).
 *
 * Express middleware runs for the routes registered after it and for no others.
 * Registration order is not a detail there — it is the entire mechanism — and applying
 * `app.use(requireAuth)` to every route in the application reports the routes a
 * developer deliberately put *above* the gate as the ones behind it.
 *
 * The two things that sit above the gate in a real application are a health check and a
 * webhook whose signature is its own lock, which is why this was found dogfooding
 * `directus/directus`: `/server/ping` and a source-comment-labelled public webhook, both
 * reported as protected by `authenticate`.
 *
 * The fixture is that shape and its three neighbours, because the interesting part is
 * which of the four the rule declines to answer:
 *
 *   /health           written above the gate, on the guarded router  → open
 *   /webhooks/stripe  its router mounted above the gate              → open
 *   /items            written below the gate                        → guarded
 *   /admin/settings   its router mounted below the gate             → guarded
 *   /reports          registered on the imported app, no mount       → guarded, unread
 *
 * The last one is not an oversight and is the correction this fix needed: an app that
 * registers every route from another file would go to "no auth check found" on all of
 * them, and a reader who sees every door red discounts the column entirely. Under-claiming
 * one door is recoverable; under-claiming a whole application is not. #206 is the import
 * direction that would settle it honestly.
 */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import { analyzeProject } from '../dist/node/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, 'fixtures', 'tsorder');

const { atlas } = await analyzeProject(FIXTURE, { followReferences: true, cache: 'off' });

const doors = new Map(
  atlas.nodes
    .filter((node) => node.kind === 'endpoint')
    .map((node) => [`${node.meta.method} ${node.meta.route}`, node.meta.guards.map((guard) => guard.name)]),
);

test('the fixture wires all five shapes', () => {
  assert.deepEqual([...doors.keys()].sort(), [
    'GET /admin/settings',
    'GET /health',
    'GET /items',
    'GET /reports',
    'POST /webhooks/stripe',
  ]);
});

test('a route written above the gate is not behind it', () => {
  assert.deepEqual(doors.get('GET /health'), []);
});

test('a router mounted above the gate carries its routes above it too', () => {
  // The mount is the only line that says so. `webhooks.ts` names no check, so reading
  // that file — or the route's own line number, which is smaller than the gate's for an
  // unrelated reason — answers the wrong question.
  assert.deepEqual(doors.get('POST /webhooks/stripe'), []);
});

test('a route written below the gate keeps its check', () => {
  assert.deepEqual(doors.get('GET /items'), ['requireAuth']);
});

test('a router mounted below the gate keeps its check', () => {
  assert.deepEqual(doors.get('GET /admin/settings'), ['requireAuth']);
});

test('a position that cannot be read keeps the check rather than blanking the map', () => {
  assert.deepEqual(doors.get('GET /reports'), ['requireAuth']);
});

test('the check is dropped once, not once per rule that found it', () => {
  // `requireAuth` reaches `/health` twice over — as a matcher covering every address,
  // and again through the reference walk out of the handler's own file. Suppressing the
  // first alone leaves the door reported as guarded by the second, which is the same
  // false green wearing a different `how`.
  for (const [door, guards] of doors) {
    assert.equal(new Set(guards).size, guards.length, `${door} lists a check twice`);
  }
});
