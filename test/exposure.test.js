/**
 * @fileoverview Why an unchecked door is unchecked (issues #24 and #36).
 *
 * "12 routes have no auth check" was a true sentence about a repo whose true answer
 * was one: eight of the twelve were marketing pages and one was the address people
 * sign in through. A number like that does not merely overstate the problem — it
 * teaches the reader that the number is noise, and the tenth route, the one that
 * mattered, never gets opened.
 *
 * The other half is the opposite failure. When a file will not parse, every check it
 * declared vanishes and the routes behind it report as wide open. That is a confident
 * wrong answer where the honest one is "I could not look", and this product cannot
 * afford either direction of that error.
 *
 * So the tests below are mostly about what must *not* be excused: a page that writes
 * to the database, a route that merely imports the auth package, a route with nothing
 * behind it at all.
 */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import { analyzeProject } from '../dist/node/index.js';
import { authHeadline } from '../dist/node/model/exposure.js';
import { AtlasGraph } from '../dist/node/model/graph.js';
import { buildInsights } from '../dist/node/model/insights.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const analyze = (name) =>
  analyzeProject(path.join(here, 'fixtures', name), { followReferences: true, cache: 'off' });

const { atlas } = await analyze('exposure');
const insights = buildInsights(AtlasGraph.fromAtlas(atlas));

const door = (route) => atlas.nodes.find((n) => n.kind === 'endpoint' && n.meta.route === route);
const why = (route) => door(route)?.meta.open?.kind ?? null;

test('the headline counts only the doors nothing explains', () => {
  // Six doors, none of them checked. The old headline said six.
  assert.equal(atlas.meta.stats.routes, 6);
  assert.equal(atlas.meta.stats.unprotectedRoutes, 3);
  assert.equal(atlas.meta.stats.publicRoutes, 3);
});

test('the buckets account for every door, so nothing is quietly dropped', () => {
  const { auth } = insights;
  assert.equal(
    auth.protectedCount + auth.likelyCount + auth.openCount + auth.publicCount + auth.unreadableCount,
    auth.total,
  );
  assert.equal(auth.routes.length, auth.total, 'every door is still on the screen');
});

test('a page the browser renders is not a security finding', () => {
  assert.equal(why('/'), 'page');
  assert.equal(why('/pricing'), 'page');
});

test('…but a page that writes to the database is', () => {
  // `/admin` inserts a row on render. "It is only a page" is exactly the excuse that
  // would hide it, so the excuse does not apply when the handler writes.
  assert.equal(door('/admin').meta.writes, true, 'the write behind the page was seen');
  assert.equal(why('/admin'), 'worth-a-look');
});

test('the door people sign in through cannot require a session', () => {
  assert.equal(why('/api/auth/*'), 'auth-mount');
  assert.match(door('/api/auth/*').meta.open.because, /NextAuth/);
});

test('importing the auth package is not itself a reason to be excused', () => {
  // `/api/report` imports a type from next-auth and checks nothing. Excusing it
  // because the package appears in the file would put a real open door out of sight.
  assert.equal(why('/api/report'), 'worth-a-look');
  assert.equal(why('/api/export'), 'worth-a-look');
});

test('the reason is stated on the door, not left to the reader to guess', () => {
  for (const route of insights.auth.routes) {
    if (!route.open || route.open.kind === 'worth-a-look') continue;
    assert.ok(route.open.because, `${route.route} claims a reason but does not give one`);
  }
});

test('the doors worth reading are sorted to the top of the list', () => {
  const first = insights.auth.routes.slice(0, 3).map((r) => r.route);
  assert.deepEqual(new Set(first), new Set(['/admin', '/api/report', '/api/export']));
});

// ---------------------------------------------------------------------------
// #36: a file we could not read is not a file with nothing in it

const { atlas: blind } = await analyze('pyblind');
const blindDoor = (route) => blind.nodes.find((n) => n.kind === 'endpoint' && n.meta.route === route);

test('the fixture really is unparseable, so this is not testing a typo of mine', () => {
  assert.equal(blind.meta.stats.unreadFiles, 1);
  assert.match(blind.meta.warnings.join('\n'), /Could not read app\/deps\.py/);
});

test('a route whose check lives in an unreadable file is unexamined, not unprotected', () => {
  // This is FastAPI's own template: the routes annotate `CurrentUser`, and what makes
  // that a lock is a `Depends` in the one file Python 3 refuses to parse.
  assert.equal(blindDoor('/items').meta.open.kind, 'unreadable');
  assert.match(blindDoor('/items').meta.open.because, /app\/deps\.py/);
  assert.equal(blind.meta.stats.unreadableRoutes, 2);
});

test('…and does not count towards the number people act on', () => {
  assert.equal(blind.meta.stats.unprotectedRoutes, 1, 'only /health, which imports nothing broken');
});

test('a route that imports nothing broken keeps its open badge', () => {
  assert.equal(blindDoor('/health').meta.open.kind, 'worth-a-look');
});

test('the unreadable file is named on the security screen, not only in a warning', () => {
  const { auth } = buildInsights(AtlasGraph.fromAtlas(blind));
  assert.deepEqual(
    auth.unread.map((f) => f.path),
    ['app/deps.py'],
  );
  assert.match(auth.unread[0].because, /parenthesized/);
});

// ---------------------------------------------------------------------------
// One sentence, four surfaces

test('the headline never reads greener than what the analyzer actually saw', () => {
  const line = authHeadline(blind.meta.stats);
  assert.equal(line.tone, 'warn');
  assert.match(line.headline, /1 of 3 routes have no auth check/);
  assert.ok(
    line.caveats.some((c) => /could not read/.test(c)),
    'the file it could not read has to be said out loud',
  );
});

test('a repo with nothing to report says so plainly, with no hedge', () => {
  const line = authHeadline({ routes: 4, unprotectedRoutes: 0, publicRoutes: 0, unreadableRoutes: 0, unreadFiles: 0 });
  assert.equal(line.tone, 'ok');
  assert.equal(line.headline, 'every one of the 4 routes has an auth check');
  assert.deepEqual(line.caveats, []);
});

test('"checked" and "open on purpose" are never collapsed into one claim', () => {
  const line = authHeadline({ routes: 9, unprotectedRoutes: 0, publicRoutes: 8, unreadableRoutes: 0, unreadFiles: 0 });
  assert.equal(line.headline, 'every one of the 9 routes is checked, or open on purpose');
});

test('nothing to protect means nothing to say', () => {
  assert.equal(authHeadline({ routes: 0, unprotectedRoutes: 0, publicRoutes: 0, unreadableRoutes: 0, unreadFiles: 0 }), null);
});
