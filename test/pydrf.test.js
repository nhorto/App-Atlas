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
 *
 * And the class is opened where the import resolves (#178): `permission_classes` is
 * where a DRF API writes its lock down, so `DocumentViewSet` reaches a verdict. The
 * ViewSet that declares none does not — DRF's `DEFAULT_PERMISSION_CLASSES` decides
 * that one, in a settings file this reader has not read, and "no check we can see"
 * would be reporting our blind spot as the application's.
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

test('the ViewSet is opened, and its permission_classes read', () => {
  const door = named('…/documents (DocumentViewSet)');
  assert.equal(door.meta.handlerUnlinked, undefined);
  assert.deepEqual(
    door.meta.guards.map((g) => g.name),
    ['IsAuthenticated'],
  );
});

test('a ViewSet that names no permission keeps the blank — settings decides it', () => {
  const door = named('…/status (StatusViewSet)');
  assert.equal(door.meta.handlerUnlinked, true);
  assert.equal(door.meta.open?.kind, 'unlinked');
  assert.equal(door.meta.guards.length, 0);
});

test('the registrations are never counted as unprotected', () => {
  // The one that is: `path("about/", landing)`, a plain view with no check on it,
  // followed to `views.py` through its own `from .views import landing`.
  assert.equal(atlas.meta.stats.unprotectedRoutes, 1);
  assert.equal(named('/about/').meta.guards.length, 0);
  assert.equal(atlas.meta.stats.unlinkedRoutes, 1);
});
