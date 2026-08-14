/**
 * @fileoverview A refusal one call away from the name is still a refusal (#261).
 *
 * Everything in `auth.ts` above `refusalBehindTheName` is spelling, and that is the safe
 * way round — a name is cheap to read and cheap to be wrong about, so it grades `likely`
 * and the file opens by warning about it. But spelling has a floor. parse-server puts
 * `Middlewares.handleParseHeaders` in the argument list of `POST /files/:filename`, and
 * `promiseEnforceMasterKeyAccess` in front of 33 more doors, and every one of them
 * reported no check at all. Both names begin with a verb about the request. No list of
 * nouns catches that, and `GUARD_NAMES` growing a thirty-first entry is the move this
 * file has already refused twice.
 *
 * So the road `readsIdentityWithoutRefusing` opened runs both ways: the body was already
 * being read to *withdraw* a lock the spelling earned, and now it is read to grant one
 * the spelling missed.
 *
 * Two of these tests are the reason the first attempt at this issue was reverted rather
 * than shipped. A body read that walks descendants cannot tell *this function refuses*
 * from *this function returns something that refuses* — and a middleware factory is
 * exactly the second thing. Ghost's `createSessionFromToken()` is one, and reading it as
 * a check breaks four tests including two deliberate under-claims.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyzeProject } from '../dist/node/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const { atlas } = await analyzeProject(path.join(here, 'fixtures', 'tsonehop'), {
  followReferences: true,
  cache: 'off',
});

const doors = new Map(
  atlas.nodes
    .filter((n) => n.kind === 'endpoint' && n.meta.endpointKind === 'http-route')
    .map((n) => [`${n.meta.method} ${n.meta.route}`, n.meta.guards ?? []]),
);
const names = (key) => (doors.get(key) ?? []).map((g) => g.name);

test('the fixture parsed, so a silent failure cannot pass as a pass', () => {
  assert.deepEqual(atlas.meta.warnings, []);
  assert.deepEqual([...doors.keys()].sort(), [
    'DELETE /files/:filepath',
    'GET /health',
    'GET /ping',
    'GET /profile',
    'GET /schemas',
    'POST /files/:filename',
  ]);
});

test('a check whose refusal is one call away is read', () => {
  // `handleParseHeaders` contains no 401 and no 403. It calls `invalidRequest`, and that
  // is where `res.status(403)` lives — 750 lines down the file in the real repo. This is
  // the door #261 was filed about, and a body read alone reaches nothing here.
  assert.deepEqual(names('POST /files/:filename'), ['Middlewares.handleParseHeaders']);
  assert.deepEqual(names('DELETE /files/:filepath'), ['Middlewares.handleParseHeaders']);
});

test('a check that refuses in its own body is read, whatever it is called', () => {
  // `promiseEnforceMasterKeyAccess` begins with `promise`. It stands in front of 34 doors
  // in parse-server and matched nothing.
  assert.deepEqual(names('GET /schemas'), ['Middlewares.promiseEnforceMasterKeyAccess']);
});

test('a factory is not a check, however unambiguous the refusal it returns', () => {
  // The one that must not move. `createHeaderChecker` returns a function holding a 403,
  // and `forEachDescendant` walks straight into it — so the scan is pinned to the
  // function's own statements. A refusal one function further down belongs to whatever
  // this one produced. Ghost writes its session middleware this way and the routes behind
  // it are deliberately left unclaimed (`cjsauth`), which this change must not overturn.
  assert.deepEqual(names('GET /profile'), []);
});

test('two hops is further than this goes, and that bound is the claim', () => {
  // `prepareRequest` calls `handleParseHeaders` calls `invalidRequest`. Following calls
  // until a 401 turns up eventually finds one in somebody's error formatter and puts it
  // on a door nobody checks — the failure `functionRefusalDetector` bounds its own reach
  // against. One hop, and the door reports what is true: App Atlas cannot see a check.
  assert.deepEqual(names('GET /health'), []);
});

test('middleware that decorates a request is not a check', () => {
  assert.deepEqual(names('GET /ping'), []);
});

test('the evidence points at the refusal, in the file that holds it', () => {
  // The registration is in `server.ts`; the proof is in `middlewares.ts`. Every
  // registration site used to overwrite the line unconditionally, which was right while
  // the path was the registration's too — and produces a link to an unrelated line of
  // another file the moment it is not. A citation that looks checkable and is wrong is
  // worse than none, so a guard that brought its own site now keeps it (`guardAt`).
  const [guard] = doors.get('POST /files/:filename');
  assert.equal(guard.path, 'src/middlewares.ts');
  assert.equal(guard.confidence, 'likely', 'one function’s behaviour, blessed by no framework');
  assert.equal(guard.provider, 'custom');

  const source = readFileSync(path.join(here, 'fixtures', 'tsonehop', 'src', 'middlewares.ts'), 'utf8');
  assert.match(source.split('\n')[guard.line - 1], /res\.status\(403\)/);
});

test('a door with a check this tool has read is not counted as unprotected', () => {
  // The whole point of reading it: three of these six doors are locked, and the number a
  // reader sees has to say so or the count is the thing that stops being read.
  assert.equal(atlas.meta.stats.routes, 6);
  assert.equal(atlas.meta.stats.unprotectedRoutes, 3);
});
