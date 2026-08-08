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
import { renderAtlasMarkdown } from '../dist/node/export/markdown.js';
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
  // Six doors, none of them checked. The old headline said six. The Stripe webhook the
  // fixture also carries is not among them: a verified webhook is not a route with no
  // auth, it is a route whose auth is a signature.
  assert.equal(atlas.meta.stats.routes, 6);
  assert.equal(atlas.meta.stats.unprotectedRoutes, 3);
  assert.equal(atlas.meta.stats.publicRoutes, 3);
});

/**
 * Issue #122, found by running the published package over a real repo.
 *
 * A payment webhook was reported in the tool's most alarming words — "nothing checks
 * these, and nothing explains why" — while its handler verified an HMAC of the raw body
 * against the endpoint secret. Nothing gets past that without the shared secret, which
 * makes it a stronger check than a session cookie, not the absence of one.
 *
 * The machinery to say so was already here: a `webhook` finding promotes the door and
 * marks it verified. What was missing was one spelling. The detector matched
 * `constructEvent` and not `constructEventAsync` — and the async form is the only one
 * that works on an edge runtime, where there is no synchronous crypto. So the repos most
 * likely to have a Stripe webhook at all were exactly the ones it could not see.
 */
test('a signature is a check, even though it never mentions a user', () => {
  const webhook = door('/api/stripe/webhook');
  assert.ok(webhook, 'the webhook is on the map');
  assert.equal(webhook.meta.endpointKind, 'webhook', 'the verification is what makes it one');
  assert.equal(webhook.meta.verified, true);

  const guards = webhook.meta.guards ?? [];
  assert.equal(guards.length, 1);
  assert.equal(guards[0].name, 'Stripe signature check');
  assert.equal(guards[0].provider, 'Stripe');
  assert.equal(
    guards[0].confidence,
    'certain',
    'the call cannot succeed without the secret, so it is graded like a check inside the handler',
  );
  assert.equal(why('/api/stripe/webhook'), null, 'and it never reaches the unchecked-door classification at all');
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
  // The reason carries Python's own words for why it refused the file. The fixture's
  // broken line is a Python 2 `print`, whose message has been stable since 3.6 —
  // unlike the `except A, B:` message this used to match, which PEP 758 deleted.
  assert.match(auth.unread[0].because, /[Mm]issing parentheses/);
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

// ---------------------------------------------------------------------------
// The clean sweep does not read greener than the evidence (#116)

test('a headline where nothing was proven says so', () => {
  // Found on a real Expo app: 21 doors, every check an RLS policy read out of a
  // migration — real evidence, honestly graded `likely` on every card, and the
  // headline told its owner the app was fully locked. The cards keep the grade M2
  // promised; the sentence people repeat in a meeting was dropping it.
  const line = authHeadline({
    routes: 4,
    unprotectedRoutes: 0,
    publicRoutes: 0,
    unreadableRoutes: 0,
    unreadFiles: 0,
    likelyOnlyRoutes: 4,
  });
  assert.equal(line.headline, 'every one of the 4 routes has an auth check — all matched, none proven');
  assert.match(line.caveats.join(' '), /matched by a pattern rather than proven/);
});

test('a headline where some were proven counts the ones that were not', () => {
  // The real shape of that app: 20 doors behind policies, one behind a call the
  // analyzer could point at. "None proven" would be as wrong in the other direction.
  const line = authHeadline({
    routes: 21,
    unprotectedRoutes: 0,
    publicRoutes: 0,
    unreadableRoutes: 0,
    unreadFiles: 0,
    likelyOnlyRoutes: 20,
  });
  assert.match(line.headline, /^every one of the 21 routes has an auth check, though 20 of those were matched/);
});

test('a proven sweep keeps the clean sentence it earned', () => {
  const line = authHeadline({
    routes: 4,
    unprotectedRoutes: 0,
    publicRoutes: 0,
    unreadableRoutes: 0,
    unreadFiles: 0,
    likelyOnlyRoutes: 0,
  });
  assert.equal(line.headline, 'every one of the 4 routes has an auth check');
  assert.deepEqual(line.caveats, []);
});

test('the hedge never lands on a headline that already has worse news', () => {
  // A count of unprotected doors is the more urgent fact and carries "App Atlas can
  // see" already. Two hedges in one sentence is a sentence nobody finishes.
  const line = authHeadline({
    routes: 10,
    unprotectedRoutes: 3,
    publicRoutes: 0,
    unreadableRoutes: 0,
    unreadFiles: 0,
    likelyOnlyRoutes: 7,
  });
  assert.equal(line.headline, '3 of 10 routes have no auth check App Atlas can see');
  assert.doesNotMatch(line.caveats.join(' '), /matched by a pattern/);
});

test('an atlas from before this stat existed still produces a sentence', () => {
  // `likelyOnlyRoutes` is absent from every atlas written by an earlier version, and a
  // missing number must read as "nothing to add" rather than as a hedge or a crash.
  const line = authHeadline({ routes: 4, unprotectedRoutes: 0, publicRoutes: 0, unreadableRoutes: 0, unreadFiles: 0 });
  assert.equal(line.headline, 'every one of the 4 routes has an auth check');
});

/**
 * Issue #58. A Python project analyzed on a machine whose interpreter never answered has
 * no doors for the same reason a blindfolded person has no traffic to report, and every
 * screen then reaches the cheerful branch above. Zero is only good news when somebody
 * looked.
 */
test('…but no doors and unread files is not nothing to say, it is nothing seen', () => {
  const line = authHeadline({ routes: 0, unprotectedRoutes: 0, publicRoutes: 0, unreadableRoutes: 0, unreadFiles: 5 });
  assert.equal(line.tone, 'warn');
  assert.equal(
    line.headline,
    'no routes were found — but App Atlas could not read 5 files, so this is not the same as saying there are none',
  );
});

test('the brief an agent reads is caveated before its numbers, not after them', () => {
  const markdown = renderAtlasMarkdown(AtlasGraph.fromAtlas(blind));
  const numbers = markdown.indexOf('## By the numbers');
  const caveat = markdown.indexOf('**App Atlas could not read 1 file**');
  assert.ok(caveat > numbers, 'the caveat sits inside the section it qualifies');
  assert.ok(caveat < markdown.indexOf('## Ways in'), 'and before anything derived from those numbers');
});
