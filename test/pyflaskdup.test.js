/**
 * @fileoverview Two blueprints writing the same computed route are two doors (#160).
 *
 * #142 keeps a route whose address the source computes — `@bp.route(make_rule("/list"))`
 * — on the map, labelled with the expression as written. But the expression text was
 * also the merge key, and identical text is not an identical address: `admin_bp` mounts
 * under `/admin` and `public_bp` under `/public`, so the same `make_rule("/list")` in
 * two files is two URLs. Merged, the public one wore the admin one's `login_required`
 * at `certain` — a false green through the same seam as #159, one tier over.
 *
 * A literal keeps the old behaviour on purpose: `GET /health` in two files IS one door,
 * because for a literal the key is the address. Only the computed key carries the file
 * and the callee.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyzeProject } from '../dist/node/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const { atlas } = await analyzeProject(path.join(here, 'fixtures', 'pyflaskdup'), {
  followReferences: true,
  cache: 'off',
});

const routes = atlas.nodes.filter((n) => n.kind === 'endpoint' && n.meta.endpointKind === 'http-route');
const inFile = (file) => routes.find((n) => n.meta.sites.some((s) => s.path === file));

test('two computed routes with identical text stay two doors', () => {
  assert.equal(routes.length, 2, routes.map((n) => n.name).join(', '));
});

test('each door keeps a single site', () => {
  for (const route of routes) {
    assert.equal(route.meta.sites.length, 1, `${route.name}: ${route.meta.sites.map((s) => s.path).join(', ')}`);
  }
});

test("admin keeps its login_required; public wears nothing", () => {
  assert.deepEqual(
    (inFile('admin.py')?.meta.guards ?? []).map((g) => g.name),
    ['login_required'],
  );
  assert.equal((inFile('public.py')?.meta.guards ?? []).length, 0);
});

test('both doors still show the expression the author wrote', () => {
  for (const route of routes) {
    assert.equal(route.name, "GET make_rule('/list')");
    assert.equal(route.meta.route, null);
  }
});
