/**
 * @fileoverview Django assembles an address one `include()` at a time (item 40).
 *
 * Six mount spellings were taught to compose in issue #33 — FastAPI's `include_router`,
 * Starlette's `mount`, Flask's `register_blueprint`, Express's `use`, Hono's `route` and
 * NestJS's `setGlobalPrefix`. Django's `include()` was not among them, and it is how
 * essentially every Django app assembles its URL space.
 *
 * Driving `healthchecks/healthchecks` was what found it: of 179 real addresses, 97 were
 * displayed correctly and 43 addresses were displayed that the app does not answer at.
 * The product's whole public REST API read `/checks/` where it is really
 * `/api/v1/checks/`.
 *
 * The fixture copies the three shapes that repo uses: a list mounted twice under two
 * version prefixes, an `include()` handed a local list variable, and a root URLconf
 * whose sub-path prefix is a name with two assignments and so cannot be read.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyzeProject } from '../dist/node/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const atlas = (
  await analyzeProject(path.join(here, 'fixtures', 'djangourls'), {
    followReferences: true,
    cache: 'off',
  })
).atlas;

const routes = atlas.nodes
  .filter((n) => n.kind === 'endpoint' && n.meta.route)
  .map((n) => n.name)
  .sort();

test('the fixture parsed, so a silent failure cannot pass as a pass', () => {
  assert.deepEqual(atlas.meta.warnings, []);
});

test('an include() handed a local list puts its segments in front', () => {
  // `path("name/", views.update_name)` lives in `check_urls`, which `front/urls.py`
  // includes under `checks/<uuid:code>/`. Nothing on the route's own line says so.
  assert.ok(routes.includes('/checks/<uuid:code>/name/'));
  assert.ok(!routes.includes('/name/'), 'the fragment is not an address');
});

test('one list mounted under two versions answers at both', () => {
  // healthchecks mounts its fifteen API routes under `api/v1/`, `api/v2/` and
  // `api/v3/`. Reading them once, unprefixed, hid forty-five real addresses and
  // published fifteen that do not answer.
  assert.ok(routes.includes('/api/v1/checks/'));
  assert.ok(routes.includes('/api/v2/checks/'));
  assert.ok(routes.includes('/api/v1/checks/<uuid:code>'));
  assert.ok(routes.includes('/api/v2/checks/<uuid:code>'));
  assert.ok(!routes.includes('/checks/'), 'the unversioned fragment is not an address');
});

test('a sub-path prefix nobody can read leaves the address alone', () => {
  // `path(prefix, include("front.urls"))` with `prefix` assigned twice — the idiom for
  // "serve me at `/` unless configured otherwise". Treating the name as a segment would
  // print an ellipsis in front of every address in the app to describe a prefix that is
  // empty in the deployment the reader is looking at.
  assert.ok(routes.includes('/'));
  assert.ok(routes.includes('/healthz/'));
  assert.ok(
    routes.every((route) => !route.startsWith('…')),
    'no route collects a gap it did not earn',
  );
});

test('a check written on the view reaches the door, by whichever name it wears', () => {
  // `@login_required` is one this tool knows outright. `@authorize` is the project's
  // own, and earns its place only because `api/auth.py` defines it as something that
  // turns callers away with a 401 — the same bar a FastAPI `Depends(...)` clears.
  const guards = (name) =>
    atlas.nodes
      .find((n) => n.kind === 'endpoint' && n.name === name)
      .meta.guards.map((g) => `${g.name}/${g.confidence}`);
  assert.deepEqual(guards('/checks/<uuid:code>/name/'), ['login_required/certain']);
  assert.deepEqual(guards('/api/v1/checks/'), ['authorize/likely']);
  assert.deepEqual(guards('/api/v2/checks/'), ['authorize/likely']);
});

test('an undecorated view is open, and says so rather than staying silent', () => {
  // The point of following the link: once the handler is in hand, "no check" is a
  // reading of the code instead of a gap in the reader.
  for (const name of ['/', '/healthz/']) {
    const door = atlas.nodes.find((n) => n.kind === 'endpoint' && n.name === name);
    assert.deepEqual(door.meta.guards, []);
    assert.equal(door.meta.handlerUnlinked, undefined);
  }
});

test('templates are a front end, and email bodies are not (item 43)', () => {
  // The archetype asked whether any *parsed* file fell into the `ui` zone, and no
  // analyzer parses a template — so a server-rendered app could never answer yes,
  // however many pages it served. healthchecks has 154 behind a login and was filed as
  // "A service other things call · no interface files".
  assert.equal(atlas.meta.archetype.archetype, 'web-app');
  assert.equal(atlas.meta.archetype.label, 'An app with a front end');
  // Two pages, not three: `templates/emails/alert.html` is rendered and sent and is not
  // an interface. An app with only those is still a service.
  assert.ok(
    atlas.meta.archetype.because.includes('2 pages it renders'),
    `because: ${atlas.meta.archetype.because.join(' · ')}`,
  );
});

test('the addresses are exactly the seven this app answers at', () => {
  assert.deepEqual(routes, [
    '/',
    '/api/v1/checks/',
    '/api/v1/checks/<uuid:code>',
    '/api/v2/checks/',
    '/api/v2/checks/<uuid:code>',
    '/checks/<uuid:code>/name/',
    '/healthz/',
  ]);
});
