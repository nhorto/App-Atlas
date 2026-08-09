/**
 * @fileoverview A class that declares nothing must still declare itself (#162).
 *
 * The merge trusts a class name only while exactly one class declares it — but it can
 * only count the declarations it was told about, and both tiers used to stay silent
 * about a class with no guards and no bases. So a guardless `ApiController` made its
 * guarded namesake in another file look unique, and that namesake's `Depends(
 * who_is_asking)` walked onto the guardless one's route: a public status endpoint
 * reported as protected, at `likely`, by a check living in a file it never touches.
 *
 * The fix has two halves, and this fixture needs both. Every class now declares
 * itself, so the collision is visible; and the owner hop resolves *file-locally* —
 * the class that owns a route is declared in the route's own file, so that hop is
 * never ambiguous — which is what lets the guarded controller keep its true lock
 * instead of the tie silencing both.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyzeProject } from '../dist/node/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const { atlas } = await analyzeProject(path.join(here, 'fixtures', 'pyclassdup'), {
  followReferences: true,
  cache: 'off',
});

const routes = atlas.nodes.filter((n) => n.kind === 'endpoint' && n.meta.endpointKind === 'http-route');
const named = (name) => routes.find((n) => n.name === name);

test('both doors exist', () => {
  assert.equal(routes.length, 2, routes.map((n) => n.name).join(', '));
});

test('the guarded ApiController keeps its own lock', () => {
  const guards = (named('GET /internal/reports')?.meta.guards ?? []).map((g) => g.name);
  assert.deepEqual(guards, ['who_is_asking']);
});

test("the guardless namesake wears nothing — not its sibling's check", () => {
  const guards = named('GET /public/status')?.meta.guards ?? [];
  assert.equal(guards.length, 0, `public door wears ${guards.map((g) => g.name).join(', ')}`);
});

test('the chain stays evidence, not proof: likely, never certain', () => {
  for (const guard of named('GET /internal/reports')?.meta.guards ?? []) {
    assert.equal(guard.confidence, 'likely');
  }
});
