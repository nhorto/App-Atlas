/**
 * @fileoverview A DRF router's register() table is the whole API (#170).
 *
 * paperless-ngx registers twenty viewsets in `urls.py` — documents, tags, saved
 * views, tasks: the application's entire REST surface — and produced zero doors,
 * while the map counted "83 ways in" from allauth pages and the admin. The
 * registration call is as readable as the `path()` beside it: a route prefix
 * literal and a named handler class.
 *
 * What is claimed per registration is the under-claiming floor: ONE door, method
 * unknown, because DRF derives list/detail/extra-action URLs from the class body
 * and claiming them without reading it would invent doors — the fixture's
 * `StatusViewSet` is read-only and has no POST for anybody to claim. The mount
 * prefix (`api/` in paperless) lives wherever `*router.urls` was spliced, so the
 * address wears #153's ellipsis rather than a guess, and `route: null` keeps every
 * downstream matcher honest. The class name rides along as the way back to the
 * code, and as `handlerOwner`, so the owner chain can carry a class-level check
 * when one is readable.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyzeProject } from '../dist/node/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const { atlas } = await analyzeProject(path.join(here, 'fixtures', 'pydrf'), {
  followReferences: true,
  cache: 'off',
});

const routes = atlas.nodes.filter((n) => n.kind === 'endpoint' && n.meta.endpointKind === 'http-route');
const named = (name) => routes.find((n) => n.name === name);

test('every registration is a door, and the path() beside them still is too', () => {
  assert.equal(routes.length, 4, routes.map((n) => n.name).join(', '));
  assert.ok(named('…/documents (DocumentViewSet)'));
  assert.ok(named('…/tags (TagViewSet)'));
  assert.ok(named('…/status (StatusViewSet)'));
  assert.ok(named('/about/'));
});

test('one door per registration, no invented verbs', () => {
  const door = named('…/status (StatusViewSet)');
  assert.equal(door.meta.method, null);
  assert.equal(door.meta.route, null);
});

test('the handler is named but not claimed followed', () => {
  const door = named('…/documents (DocumentViewSet)');
  assert.equal(door.meta.handlerUnlinked, true);
  assert.equal(door.meta.open?.kind, 'unlinked');
});

test('set aside, never counted as unprotected', () => {
  // The three registrations, still. A door whose handler was never followed is not a
  // door known to be open, and this is the assertion that says so.
  const viewsets = routes.filter((n) => n.name.startsWith('…/'));
  assert.equal(viewsets.length, 3);
  for (const door of viewsets) assert.equal(door.meta.handlerUnlinked, true);
  assert.equal(atlas.meta.stats.unlinkedRoutes, 3);
});

test('a view imported by name is followed, and an open page says so', () => {
  // `from .views import landing` binds a *symbol*, not a module, and the Django handler
  // resolver only read the module spelling — so `/about/` used to be set aside with the
  // viewsets, and `unlinkedRoutes` was 4. It is an ordinary function view with no check
  // on it, and now that it is actually read, "no auth check" is the true answer rather
  // than the absence of one.
  const about = named('/about/');
  assert.equal(about.meta.handlerUnlinked ?? false, false);
  assert.deepEqual(about.meta.guards, []);
  assert.equal(atlas.meta.stats.unprotectedRoutes, 1);
});
