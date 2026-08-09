/**
 * @fileoverview A function that turns a caller away is a check, whatever framework
 * failed to bless it (#155).
 *
 * The TypeScript tier had the 401 vocabulary and fenced it three ways — inside a
 * class, implementing a NestJS contract, in a project depending on Nest — so
 * vercel/commerce's `/api/revalidate`, a shared-secret check that refuses on
 * mismatch, sat on the worry list of Vercel's own reference storefront. The fixture
 * is that repo's exact shape: a one-line handler whose whole body is a cross-file
 * hop to the function holding the refusal.
 *
 * Two decisions pinned here on purpose:
 * - `NextResponse.json({ status: 401 })` counts, though the wire says 200. The code
 *   refuses the caller; the response shape is the author's bug to find, and "nobody
 *   is checking who calls this" would be false.
 * - A 401 inside a `catch` does not count. "The vendor said 401" is an upstream
 *   failure, not a decision about our caller — the route calling `fetchUpstream`
 *   must stay on the worry list.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyzeProject } from '../dist/node/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const { atlas } = await analyzeProject(path.join(here, 'fixtures', 'tsrefusal'), {
  followReferences: true,
  cache: 'off',
});

const routes = atlas.nodes.filter((n) => n.kind === 'endpoint' && n.meta.endpointKind === 'http-route');
const named = (name) => routes.find((n) => n.name === name);

test('the hand-rolled secret check guards the door, one cross-file hop away', () => {
  const door = named('POST /api/revalidate');
  assert.ok(door, `have: ${routes.map((n) => n.name).join(', ')}`);
  const guards = door.meta.guards;
  assert.equal(guards.length, 1, JSON.stringify(guards));
  assert.equal(guards[0].name, 'revalidate');
  assert.equal(guards[0].path, 'lib/shopify.ts');
});

test('likely, never certain: behaviour standing in for a decision no framework confirmed', () => {
  assert.equal(named('POST /api/revalidate').meta.guards[0].confidence, 'likely');
});

test('the evidence link lands on the refusal line, not the function header', () => {
  const guard = named('POST /api/revalidate').meta.guards[0];
  assert.equal(typeof guard.line, 'number');
  assert.ok(guard.line > 1, `line ${guard.line}`);
});

test('a 401 in a catch block is an upstream failure, not a lock on our door', () => {
  const products = named('GET /api/products');
  assert.deepEqual(products.meta.guards, []);
  assert.equal(products.meta.open?.kind, 'worth-a-look');
});

test('a check inside the handler is not labelled with the framework\'s verb (#190)', () => {
  // The exported handler must be called POST, so the guard cannot be named after it
  // and stay meaningful: "protected by POST" gives a reader nothing to verify.
  const door = named('POST /api/rename');
  assert.ok(door, `have: ${routes.map((n) => n.name).join(', ')}`);
  assert.deepEqual(
    door.meta.guards.map((g) => g.name),
    ['a 401 in the handler'],
  );
  assert.equal(door.meta.guards[0].confidence, 'likely');
  // The site is what a reader follows, so it still has to point at the refusal.
  assert.match(door.meta.guards[0].path, /rename\/route\.ts$/);
});
