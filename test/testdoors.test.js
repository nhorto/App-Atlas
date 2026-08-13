/**
 * @fileoverview A door the test suite declared, and the one door that proves it must be
 * marked rather than dropped (#247).
 *
 * `build.ts` has filtered test files out of the map since #25, and it has always exempted
 * *doors* from that filter, for a reason that is still correct: dub serves
 * `POST /api/stripe/integration/webhook/test` — Stripe delivers test *mode* events to a
 * separate endpoint — out of a directory called `test`, and no path is worth losing a
 * live webhook over.
 *
 * What the exemption left behind is a door reported on half its evidence. The guards and
 * the router wiring around it are filtered; the door is not. Measured on the corpus at
 * the time this landed:
 *
 *   sails         30 doors, 29 of them `.test.js`, and all 29 the whole of its open list
 *   parse-server  20 routes, 15 from `spec/`, all 15 unchecked and all 15 on that screen
 *   apostrophe     8 routes, 5 from `packages/express-cache-on-demand/test/test.js`
 *   ghost         22 routes, 4 from `.test.js` files that build an app to test middleware
 *   directus     258 routes, 5 from a Fastify mock license server in `tests/`
 *   nodebb, paperless, gin — none
 *
 * Sails' security screen was twenty-nine rows of `GET /res_sending_back_a_boolean/1`.
 *
 * ## The rule
 *
 * The path says test, unless the address says the same word — because a segment cannot be
 * both a location on disk and part of a URL somebody types. Asked of `classifyZone` in
 * both directions, so there is one definition of "test file" and a reader can guess it.
 *
 * ## What is not covered here
 *
 * The verdict sits *above* the unreadable rule in `classifyOpenDoors`, and nothing below
 * exercises that ordering — building a test-declared door whose import is unparseable
 * takes a fixture whose only purpose is the tie. The claim it rests on is written where
 * the branch is.
 */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import { analyzeProject, authHeadline, classifyOpenDoors } from '../dist/node/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));

const open = await analyzeProject(path.join(here, 'fixtures', 'testdoors'), {
  followReferences: true,
  cache: 'off',
});
const doors = open.atlas.nodes.filter((node) => node.kind === 'endpoint');
const byName = new Map(doors.map((node) => [node.name, node]));
const marked = doors.filter((node) => node.meta.declaredInTest).map((node) => node.name).sort();

test('the doors the suite declared are the ones marked, and no others', () => {
  assert.deepEqual(marked, [
    'GET /:license_key',
    'GET /res_sending_back_a_number/1',
    'GET /res_sending_back_a_string/1',
    'GET /sessionTest',
    'POST /mcp/tools/call',
  ]);
});

test('a live door in a directory called test keeps its place', () => {
  // The whole reason this is a fact written on a door and not a filter that deletes one.
  // dub still serves this; `test` in it is Stripe's test mode, and a stranger can post to
  // it. Losing it would be a wrong answer that does not look wrong, which is the failure
  // this project is built to avoid — so it is asserted on both counts: still a door, and
  // carrying no claim that it belongs to a test.
  const stripe = byName.get('POST /api/stripe/integration/webhook/test');
  assert.ok(stripe, 'a live webhook was dropped for the name of its directory');
  assert.equal(stripe.meta.declaredInTest ?? false, false);
});

test('the word in an address is a URL, and the word in a path is a location', () => {
  // The symmetry the rule turns on, stated as the pair that separates. Both files sit in
  // a test zone; only one of them answers at an address that reads as one. `sessionTest`
  // is deliberately the near miss — it contains the word and is not the segment, which is
  // what stops a substring from doing this job. It is also Sails': `test/unit/
  // req.session.test.js` serves exactly this.
  assert.equal(byName.get('POST /api/stripe/integration/webhook/test')?.meta.declaredInTest ?? false, false);
  assert.equal(byName.get('GET /sessionTest')?.meta.declaredInTest, true);
});

test('one declaration outside the suite is the whole answer, in either order', () => {
  // parse-server's `connection` door has four sites, two in `spec/ParseWebSocketServer.
  // spec.js` and two in `src/Adapters/WebSocketServer/WSAdapter.js`. An address the app
  // serves and a test also stands up is served, and marking it would take a real door out
  // of the count on the strength of the file that mentioned it second.
  //
  // Both orders, because one of them is not a test of anything. `src/` is read before
  // `test/`, so the `/events` pair never sets the flag and never needs it taken off — with
  // the merge rule deleted it passes unchanged. `/telemetry` is the pair that fails,
  // `spec/` being read before `src/`. Found by deleting the rule, not by reading it.
  for (const name of ['GET /events', 'GET /telemetry']) {
    const door = byName.get(name);
    assert.equal(door?.meta.sites.length, 2, `${name}: the fixture stopped testing the merge`);
    assert.equal(door?.meta.declaredInTest ?? false, false, name);
  }
});

test('the directory alone is enough when the filename says nothing', () => {
  // Strapi's mock route array lives in `services/mcp/__tests__/`, directus's mock server
  // in `tests/mock-license-server/src/routes/`. Neither filename carries `.test.` or
  // `.spec.`, so a rule that only read filenames would report both as the application's.
  assert.equal(byName.get('POST /mcp/tools/call')?.meta.declaredInTest, true);
  assert.equal(byName.get('GET /:license_key')?.meta.declaredInTest, true);
});

test('the set-aside leaves the denominator, and is said out loud rather than deducted', () => {
  // Both halves matter. A door nobody can knock on is not one of the doors a sentence
  // about coverage is counting — and a reader who cannot see the subtraction has no way
  // to disagree with it, which is the point of a caveat on evidence this thin.
  const stats = open.atlas.meta.stats;
  assert.equal(stats.routes, 9, 'every door is still on the map and still counted');
  assert.equal(stats.testRoutes, 5);
  const headline = authHeadline(stats);
  assert.equal(headline?.headline, '4 of 4 routes have no auth check App Atlas can see');
  assert.deepEqual(headline?.caveats, [
    '5 more are declared by the test suite rather than by the app; they are in no number above',
  ]);
});

test('the door stays on the screen carrying the reason it is not counted', () => {
  // `classifyOpenDoors` exists so that every unchecked door keeps its row with the fact
  // that explains it, and only the unexplained ones reach the headline. This is one more
  // reason on that list, not a second way of hiding a row.
  const verdicts = classifyOpenDoors(open.atlas.nodes, open.atlas.edges);
  const sails = byName.get('GET /res_sending_back_a_number/1');
  assert.equal(verdicts.get(sails.id)?.kind, 'in-test');
  assert.match(verdicts.get(sails.id)?.because ?? '', /nobody outside a test run/);
});

const guarded = await analyzeProject(path.join(here, 'fixtures', 'testdoorsguarded'), {
  followReferences: true,
  cache: 'off',
});

test('a door the suite declared is set aside even when something guards it', () => {
  // Counted over doors, not over open-door verdicts — a verdict is only ever reached for
  // a door with nothing on it, so a set-aside built from verdicts would keep every
  // guarded route the suite declares. directus is exactly this: all five of its mock
  // license server's routes come out wearing `authenticate` from `api/src/app.ts`, the
  // real application's own middleware, on a program directus does not ship.
  const stats = guarded.atlas.meta.stats;
  const verdicts = classifyOpenDoors(guarded.atlas.nodes, guarded.atlas.edges);
  assert.equal([...verdicts.values()].length, 0, 'the fixture stopped testing this — a door lost its guard');
  assert.equal(stats.routes, 2);
  assert.equal(stats.testRoutes, 1, 'a count taken over verdicts would be 0 here');
  assert.equal(authHeadline(stats)?.headline, 'the one route has an auth check — matched, not proven');
});

test('the hedge counts the routes the headline is about', () => {
  // `likelyOnlyRoutes` answers "how many of *those* were matched rather than proven", and
  // "those" is the assessed set. A set-aside route in it would make the two numbers in one
  // sentence come from two different populations.
  assert.equal(guarded.atlas.meta.stats.likelyOnlyRoutes, 1, 'the test-declared door joined the hedge');
});

test('when every route belongs to the suite, the reason given is the true one', () => {
  // Sails reaches this: its entire HTTP surface is scaffolding. The sentence that used to
  // live here says the routes were not followed to a handler, which would be App Atlas
  // confessing to a failure it did not have — the routes were read, and they were the
  // suite's. Driven through plain stats because no fixture produces an app with nothing
  // but test doors and nothing else worth keeping.
  const all = (over) => authHeadline({ routes: 4, unprotectedRoutes: 0, publicRoutes: 0, unreadableRoutes: 0, unreadFiles: 0, files: 10, ...over });
  assert.match(all({ testRoutes: 4 })?.headline ?? '', /^all 4 routes are declared by the test suite/);
  assert.match(all({ unlinkedRoutes: 4 })?.headline ?? '', /^all 4 routes are declared in a routing table/);
  assert.match(
    all({ testRoutes: 2, unlinkedRoutes: 2 })?.headline ?? '',
    /^no route was judged: 2 are declared by the test suite, and 2 are in a routing table/,
  );
  assert.equal(all({ testRoutes: 3, routes: 1 })?.headline, 'the one route is declared by the test suite — nothing here answers a URL in a deployed app');
});
