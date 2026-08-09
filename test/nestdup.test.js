/**
 * @fileoverview A class name is not an address either (#159).
 *
 * #153 stopped NestJS controllers with unreadable prefixes from collapsing onto one
 * door by keying them on the controller — the class name. But class names are not
 * unique across files: a v1/v2 split writes `UsersController` twice, and keying on the
 * name merged the two back into one entry wearing one of their guards. v2's unguarded
 * `GET ${API_PREFIX}/v2/users/list` read as protected by v1's SessionGuard at
 * `certain` — the same false green, through a smaller hole.
 *
 * The key now carries the file, which is the identity the class name only
 * approximates: a TS file holds one class of a given name, so file-plus-tail can never
 * merge strangers and never splits a door that is genuinely one.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyzeProject } from '../dist/node/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const { atlas } = await analyzeProject(path.join(here, 'fixtures', 'nestdup'), {
  followReferences: true,
  cache: 'off',
});

const routes = atlas.nodes.filter((n) => n.kind === 'endpoint' && n.meta.endpointKind === 'http-route');

test('two same-named controllers with unread prefixes stay two doors', () => {
  assert.equal(routes.length, 2, `expected 2 doors, got: ${routes.map((n) => n.name).join(', ')}`);
});

test('each door keeps a single site — no pooling of files', () => {
  for (const route of routes) {
    assert.equal(route.meta.sites.length, 1, `${route.name} has sites in ${route.meta.sites.map((s) => s.path).join(', ')}`);
  }
});

test("v1's guard stays on v1's door", () => {
  const v1 = routes.find((n) => n.meta.sites[0].path.includes('v1/'));
  assert.ok(v1, 'v1 door found');
  assert.deepEqual(
    v1.meta.guards.map((g) => g.name),
    ['SessionGuard'],
  );
});

test("v2's door carries no guard at all", () => {
  const v2 = routes.find((n) => n.meta.sites[0].path.includes('v2/'));
  assert.ok(v2, 'v2 door found');
  assert.equal(v2.meta.guards.length, 0, `v2 wears ${v2.meta.guards.map((g) => g.name).join(', ')}`);
});

test('both doors still refuse to claim an address', () => {
  for (const route of routes) {
    assert.equal(route.meta.route, null, `${route.name} claims route ${route.meta.route}`);
  }
});
