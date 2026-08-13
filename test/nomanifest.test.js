/**
 * @fileoverview A repo with no manifest is not a repo with no doors.
 *
 * The whole HTTP route detector was gated on finding a server package in a *manifest*,
 * so a project that does not ship one at the root came out with no routes at all — and
 * said so confidently, with no warning and nothing marked unreadable.
 *
 * `NodeBB/NodeBB` is the case: it keeps `package.json` in `install/` and copies it into
 * place during setup, so a checked-out clone has none. 927 files and 150,000 lines of
 * Express reported **two ways in**, no framework, and the archetype "a service other
 * things call — no interface files", for a forum with a full web UI.
 *
 * The fix is not a longer list of places to look for a manifest. It is that
 * `require('express')` in the file doing the routing is better evidence than a
 * dependency list: a manifest says what somebody declared, an import says what this code
 * uses. The manifest is still read; it is no longer the only thing that counts.
 */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import { analyzeProject } from '../dist/node/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, 'fixtures', 'nomanifest');

const { atlas } = await analyzeProject(FIXTURE, { followReferences: true, cache: 'off' });
const doors = atlas.nodes.filter((node) => node.kind === 'endpoint');
const byName = new Map(doors.map((node) => [node.name, node]));

test('routes are found with no manifest at the root', () => {
  assert.deepEqual(doors.map((node) => node.name).sort(), [
    'GET /admin/dashboard',
    'GET /api/config',
    'POST /api/self',
  ]);
});

test('the mount prefix still composes', () => {
  // Two route files, two routers, two prefixes. Turning the detector on per file must
  // not cost the cross-file half of the address.
  assert.equal(byName.get('GET /api/config')?.meta.route, '/api/config');
  assert.equal(byName.get('GET /admin/dashboard')?.meta.route, '/admin/dashboard');
});

test('the framework is named from the import rather than left generic', () => {
  // `HTTP` would be the honest fallback for a route on something unidentified. Here the
  // file says `require('express')`, so there is nothing to hedge about.
  for (const door of doors) assert.equal(door.meta.framework, 'Express');
});

test('checks written beside a route are still read', () => {
  assert.deepEqual(
    byName.get('POST /api/self')?.meta.guards.map((guard) => guard.name),
    ['middleware.requireAuth'],
  );
  assert.deepEqual(byName.get('GET /api/config')?.meta.guards, []);
});
