/**
 * @fileoverview The check that wraps the router instead of being attached to it (#298).
 *
 * `return mw.validateBasicAuth(mux)` says exactly what `mux.Use(mw.validateBasicAuth)`
 * says, and the three passes that read Go routers saw none of it: nothing is attached to
 * the router, the router is the argument. miniflux writes its whole API this way, and its
 * fifty-two `/v1` routes — somebody's entire reading history — came out as fifty-two open
 * doors, with the one lock on the map hung on `POST /accounts/ClientLogin`, which is the
 * single route in that application that cannot require a caller to be signed in.
 *
 * Two things are being proved here and the second one is the harder one.
 *
 * The first is that the wrap is read: three names in front of one mux, and the one of
 * them that writes a 401 is the one that lands.
 *
 * The second is that it is read *precisely*. A Go method's name is not unique inside its
 * package — this fixture has three functions called `handle`, which is one fewer than
 * miniflux has — and the first cut of this rule matched them the way every other name in
 * the Go tier is matched, on the last segment. That hung `authProxy.handle`, a
 * reverse-proxy check standing in front of one login page, in front of ninety-eight
 * routes it has never been near. The doors behind `session.handle(csrf.handle(uiMux))`
 * are blank below and they must stay blank: neither of those turns a caller away, and a
 * number that improved because the evidence got weaker is worse than the gap it filled.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyzeProject } from '../dist/node/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const { atlas } = await analyzeProject(path.join(here, 'fixtures', 'gobehind'), {
  followReferences: true,
  cache: 'off',
});

const door = (name) => atlas.nodes.find((n) => n.kind === 'endpoint' && n.name === name);
const guards = (name) => (door(name).meta.guards ?? []).map((g) => g.name).sort();

test('the fixture reads clean', () => {
  assert.deepEqual(atlas.meta.warnings, []);
  assert.deepEqual(
    atlas.nodes.filter((n) => n.meta?.endpointKind === 'http-route').map((n) => n.name).sort(),
    [
      'ANY /v1/',
      'DELETE /v1/entries/{id}',
      'GET /feed.xml',
      'GET /feeds',
      'GET /ops/queue',
      'GET /status',
      'GET /v1/entries',
      'POST /feeds',
      'POST /v1/entries',
    ],
  );
});

// ---------------------------------------------------------------------------
// The wrap
// ---------------------------------------------------------------------------

test('a router handed to a check is behind it, on every route registered on it', () => {
  assert.deepEqual(guards('GET /v1/entries'), ['validateBasicAuth']);
  assert.deepEqual(guards('POST /v1/entries'), ['validateBasicAuth']);
  assert.deepEqual(guards('DELETE /v1/entries/{id}'), ['validateBasicAuth']);
});

test('the wrap is read even though it is written below every route it covers', () => {
  // `NewAPIHandler` registers three routes and only then returns the wrapped mux. A
  // check attached with `Use` runs from the line it was written on, which is why the
  // merge dates those; a wrapper is not attached to anything and covers the whole mux
  // however the file is ordered.
  const guard = door('GET /v1/entries').meta.guards[0];
  assert.equal(guard.path, 'middleware.go');
  assert.equal(guard.how, 'middleware');
  assert.equal(guard.confidence, 'likely');
});

test('the wrapper that only sets headers is not mistaken for the one that refuses', () => {
  // `withCORSHeaders` and `validateBasicAuth` are handed the same router by the same
  // call on the same line. What tells them apart is that one of them writes a 401.
  assert.ok(!guards('GET /v1/entries').includes('withCORSHeaders'));
});

test('a plain function wrapping the mux works the same as a method', () => {
  assert.deepEqual(guards('GET /ops/queue'), ['requireOperator']);
});

// ---------------------------------------------------------------------------
// What must not happen
// ---------------------------------------------------------------------------

test('a `handle` that redirects does not borrow the `handle` that refuses', () => {
  // Three methods named `handle` in one package: `authProxy`'s writes a 403, and the two
  // in front of these doors write a redirect and a 400. Matched on the last segment, the
  // 403 lands on both of these — a lock a reader would click through to and find in a
  // file that is not on this path.
  assert.deepEqual(guards('GET /feeds'), []);
  assert.deepEqual(guards('POST /feeds'), []);
});

test('a receiver this file cannot follow to a constructor claims nothing', () => {
  // `s.guard.handle(srvMux)` — `s.guard` is a struct field, so which `handle` it is
  // cannot be told from the file the wrap is written in. The honest answer is the blank.
  assert.deepEqual(guards('GET /status'), []);
});

test('a function handed the router to register on is not standing in front of it', () => {
  // `RegisterSSERoutes(feedMux, "hub", "s3cret")` takes the router and three other
  // things: it goes *behind* the routes, not in front of them. The 401 its own handler
  // writes still makes it read as a function that turns callers away, which is why the
  // shape of the call has to answer instead — Go's middleware takes the handler and
  // nothing else. memos had this registrar guarding `ANY /api/v1/*` and `ANY /file/*`.
  assert.deepEqual(guards('GET /feed.xml'), []);
});

test('mounting a wrapped handler does not make the mount line a guarded door', () => {
  // `mux.Handle("/v1/", http.StripPrefix("/v1", NewAPIHandler()))` hands a handler over;
  // the check is inside `NewAPIHandler`, and this line is a mount rather than a route.
  assert.deepEqual(guards('ANY /v1/'), []);
});
