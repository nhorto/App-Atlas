/**
 * @fileoverview The biggest part of an alarming number deserves a sentence (#284).
 *
 * `@directus/api` reads *"245 of 253 routes have no auth check App Atlas can see"*, and
 * **219 of those 245** are one middleware:
 *
 * ```
 * tally: { worthALook: 26, identityOnly: 219, inTest: 2 }
 * { "authenticate": 220 }
 * ```
 *
 * `src/app.ts:328` is `app.use(authenticate)`, ahead of all forty routers below it. It
 * reads the token, sets `req.accountability`, and calls `next()` — no token means the
 * *public role*, not a 401. So the doors really are unprotected and #237 classified them
 * exactly right, down to the sentence on each one:
 *
 * > `authenticate` runs in front of this door and refuses nobody — it reads who is
 * > calling and hands them on
 *
 * No surface printed it. `AtlasStats` carries `publicRoutes`, `unlinkedRoutes`,
 * `testRoutes` and `likelyOnlyRoutes`; the identity-only count was folded into
 * `unprotectedRoutes` and thrown away, so `authHeadline` could not say a number it was
 * never handed. Third time in this family — #257 lost `unreadFrameworks` the same way and
 * #270 caught the recount eating it again.
 *
 * ## The total does not move
 *
 * 4 unprotected stays 4. A door nothing refuses is unprotected whether or not its cookie
 * was read, and shrinking it on the strength of a middleware that admits everyone is the
 * false comfort #237 refused to give. The claim is only that the reader is told what the
 * 219 are.
 *
 * ## What the fixture is shaped like
 *
 * directus's `app.ts`, at four doors instead of 253, with all four cases the count has to
 * tell apart:
 *
 *   - `/telemetry` mounted **above** `app.use(authenticate)` — genuinely bare, and the
 *     proof the split is about order rather than about the file. directus mounts
 *     `/deployments/webhooks` at line 322 for the same reason.
 *   - `/items` mounted below it — identity-only, three doors.
 *   - `/admin/settings` below it *and* behind `requireAdmin`, which answers 403 — guarded,
 *     and therefore in neither the count nor the list of names. `authenticate` reaches it
 *     too, so a rule that counted "has an identity middleware" rather than "is unprotected
 *     and has one" would report four.
 *
 * ## Why this spawns the CLI
 *
 * #270's rule: the broken path was the one every user takes and no test took. `stats` is
 * recounted from nodes after the words layer, and a stat that does not survive that
 * recount is one `analyzeProject` reports correctly and every real run loses.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { authHeadline } from '../dist/node/model/exposure.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, '..', 'dist', 'node', 'cli.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-identity-'));
const root = path.join(dir, 'identityonly');
fs.cpSync(path.join(here, 'fixtures', 'identityonly'), root, { recursive: true });
const printed = execFileSync(process.execPath, [CLI, 'analyze', root, '--no-ai'], {
  stdio: 'pipe',
  encoding: 'utf8',
}).replace(/\x1B\[[0-9;]*m/g, '');
const atlas = JSON.parse(fs.readFileSync(path.join(root, '.app-atlas', 'atlas.json'), 'utf8'));

const doors = new Map(
  atlas.nodes
    .filter((n) => n.kind === 'endpoint' && n.meta.endpointKind === 'http-route')
    .map((n) => [n.name, n.meta]),
);

test('the fixture parsed and the doors landed where they were put', () => {
  assert.deepEqual(atlas.meta.warnings, []);
  assert.deepEqual(
    [...doors.keys()].sort(),
    ['DELETE /items/:pk', 'GET /admin/settings', 'GET /items/', 'POST /items/', 'POST /telemetry/'],
  );
});

test('a middleware that refuses nobody is not a check, and a door above it has nothing at all', () => {
  // The premise, asserted before the number that rests on it. If `authenticate` ever
  // starts reading as a guard this fails here rather than passing quietly with a smaller
  // count, and `/telemetry` is what proves the attribution follows registration order —
  // it is in the same file, below the same app, and above the `app.use` line.
  assert.deepEqual(doors.get('GET /items/').guards, []);
  assert.equal(doors.get('GET /items/').identityOnly, 'authenticate');
  assert.equal(doors.get('POST /telemetry/').identityOnly, undefined);
  assert.deepEqual(doors.get('POST /telemetry/').guards, []);
});

test('the CLI writes the count, it does not fold it away', () => {
  // The defect in one assertion. The verdict was on every door the whole time; the number
  // was computed, added into `unprotectedRoutes`, and dropped before `authHeadline`.
  const s = atlas.meta.stats;
  assert.equal(s.identityOnlyRoutes, 3);
  assert.deepEqual(s.identityOnlyGuards, ['authenticate']);
  // Unchanged, and that is the point: this says what the number is made of, not that it
  // is smaller (#237).
  assert.equal(s.unprotectedRoutes, 4);
});

test('a guarded door is in neither the count nor the names', () => {
  // `authenticate` reaches `/admin/settings` too and `build.ts` writes the name on it.
  // Counting by "has an identity middleware" would say 4 and name a middleware fronting
  // a door the caveat is not about.
  assert.equal(doors.get('GET /admin/settings').identityOnly, 'authenticate');
  assert.deepEqual(
    doors.get('GET /admin/settings').guards.map((g) => g.name),
    ['requireAdmin'],
  );
  assert.equal(atlas.meta.stats.identityOnlyRoutes, 3, 'the guarded door joined the count');
});

test('so the reader gets the sentence rather than a bare number', () => {
  assert.match(printed, /4 of 5 routes have no auth check App Atlas can see/);
  assert.match(printed, /3 of those are not bare: authenticate runs in front of them and refuses nobody/);
  // Under the headline it qualifies, not above it.
  assert.ok(
    printed.indexOf('4 of 5 routes have no auth check') < printed.indexOf('3 of those are not bare'),
    'the caveat printed above the headline it belongs to',
  );
});

test('when every open door has one, the caveat says so instead of counting', () => {
  // The other half of the wording, which the fixture cannot reach — it keeps `/telemetry`
  // bare on purpose. A pure function, so this asks it directly rather than building a
  // second fixture to produce one string.
  const headline = authHeadline({
    ...atlas.meta.stats,
    routes: 4,
    unprotectedRoutes: 3,
    identityOnlyRoutes: 3,
    testRoutes: 0,
  });
  assert.match(headline.caveats[0], /^all of them have authenticate in front/);
  assert.match(headline.caveats[0], /whatever decides what they may do is further in/);
});

test('a project with no such middleware says nothing about one', () => {
  // #116, from the side that matters here: a caveat that appears on every map is one
  // readers learn to skip. Every other repo in the corpus has zero identity-only doors.
  const quiet = authHeadline({ ...atlas.meta.stats, identityOnlyRoutes: 0, identityOnlyGuards: [] });
  assert.ok(
    !quiet.caveats.some((c) => /refuses nobody/.test(c)),
    JSON.stringify(quiet.caveats),
  );
});
