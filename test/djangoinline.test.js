/**
 * @fileoverview `include([…])` — a URLconf written straight into the argument.
 *
 * Item 40 taught Django's `include()` to compose, and was validated on
 * `healthchecks/healthchecks`, which spells it `include("hc.api.urls")` and
 * `include(api_urls)`. Both name something. `paperless-ngx` names nothing: it hands
 * `include()` a list literal and nests them four deep, and **64 of its 65 route
 * declarations sit inside one**.
 *
 * Read flat, none of them had a prefix at all. Not one of the 93 addresses that repo
 * reported began with `/api/`, while 64 of 65 route declarations were inside the `^api/`
 * block — so `/post_document/` was printed as an address for a door that answers at
 * `/api/documents/post_document/`. A wrong address is worse than a missing one; nothing
 * about it looks wrong.
 *
 * Two things it also fixes, both found by reading the rows rather than the totals:
 *
 * - **A collision.** paperless declares `login/` under `api/auth/` and again under
 *   `accounts/`. Flat, both are `/login/` and the two merge into one door — which pools
 *   whatever checks either had, the same failure #153 and #159 are about.
 * - **Regex anchors in a segment.** `re_path(r"^api/", include([…]))` contributes to
 *   everything beneath it, and the leaf reader stripped `^` while the mount reader did
 *   not, so the first composed addresses came out `/^api/^documents/post_document/`.
 *
 * The invented name is the same trick the Gin reader uses for a group built in an
 * argument (#194): a list with no name cannot be mounted, so it is given one.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyzeProject } from '../dist/node/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, 'fixtures', 'djangoinline');

const { atlas } = await analyzeProject(FIXTURE, { followReferences: true, cache: 'off' });
const doors = atlas.nodes.filter((node) => node.kind === 'endpoint');
const addresses = doors.map((node) => node.meta.route).sort();

test('a list written into the include() argument still composes its prefix', () => {
  assert.deepEqual(addresses, [
    '/accounts/login/',
    '/api/auth/login/',
    '/api/auth/logout/',
    '/api/documents/bulk_edit/',
    '/api/documents/post_document/',
    '/api/statistics/',
    '/legacy/old/',
  ]);
});

test('the namespaced spelling composes too', () => {
  // `include(([...], "rest_framework"), namespace=...)` puts the patterns in the first
  // element of a tuple. Django's own docs use it, and paperless uses it for its API auth.
  assert.ok(
    addresses.includes('/api/auth/login/'),
    'a tuple-wrapped pattern list lost its prefix',
  );
});

test('two doors whose last segment matches stay two doors', () => {
  // `/api/auth/login/` and `/accounts/login/`. Flat they are both `/login/`, and one
  // endpoint would carry the union of their checks.
  assert.equal(doors.filter((node) => node.meta.route?.endsWith('/login/')).length, 2);
});

test('a regex anchor is not part of an address', () => {
  for (const address of addresses) {
    assert.ok(address && !address.includes('^'), `${address} carries regex punctuation`);
    assert.ok(!address.endsWith('$'), `${address} carries regex punctuation`);
  }
});

test('the module-string spelling keeps working', () => {
  // What item 40 shipped, and what healthchecks is written in. This change is additive.
  assert.ok(addresses.includes('/legacy/old/'));
});

test('a decorator on the handler is still found through the composed address', () => {
  // The address changing must not cost the auth verdict that hangs off the handler.
  const guarded = doors.find((node) => node.meta.route === '/api/documents/post_document/');
  assert.deepEqual(
    guarded?.meta.guards.map((guard) => guard.name),
    ['login_required'],
  );
});
