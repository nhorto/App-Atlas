/**
 * @fileoverview A refusal written as a thrown type, in a file with no status code (#265).
 *
 * mastodon's streaming API is guarded and every rule in `auth.ts` was blind to it.
 * `streaming/index.js` contains **zero** `401` and `403` literals — `rejectionLine`,
 * `rejectionOutsideCatch` and `REJECT_STATUS` were all looking for a number that file
 * never writes. It refuses with a class instead:
 *
 * ```js
 * reject(new AuthenticationError('Missing access token'));
 * ```
 *
 * The issue said this was only worth answering if the mapping to a status turned out to
 * be findable, because otherwise the evidence is a class *name* — and a name is what
 * `auth.ts` spends its first hundred lines warning against. It is findable, one hop away,
 * and `RequestError` sits in the same file at 400 as the standing proof that the rule has
 * to read the code rather than the spelling.
 *
 * ## Four things had to be true at once
 *
 * The door needed all of them, which is why this took four changes rather than one:
 *
 *   1. the file-level gate had to stop demanding a status literal to look at a file at all
 *      — by construction the status is somewhere else;
 *   2. the raise had to be resolved to its declaration and *that* read for a 401;
 *   3. `reject` had to join `REJECT_CALLS`, or a promise rejection was never looked at;
 *   4. a promise executor had to count as the calling function's own body.
 *
 * The fourth is the one with a rule behind it. #261 pinned the refusal scan to a
 * function's own statements so a factory could not lend its product's lock to a bare
 * mention, and that is right. An executor is not a product: `new Promise(fn)` runs `fn`
 * synchronously, before the constructor returns. A returned function is unreachable from
 * here by construction — it is a `return`, not an argument — and `/reports` is in this
 * fixture to keep it that way.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyzeProject } from '../dist/node/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const { atlas } = await analyzeProject(path.join(here, 'fixtures', 'typedrefusal'), {
  followReferences: true,
  cache: 'off',
});

const doors = new Map(
  atlas.nodes
    .filter((n) => n.kind === 'endpoint' && n.meta.endpointKind === 'http-route')
    .map((n) => [n.meta.route, (n.meta.guards ?? []).map((g) => g.name).sort()]),
);

test('the fixture parsed, so a silent failure cannot pass as a pass', () => {
  assert.deepEqual(atlas.meta.warnings, []);
  assert.deepEqual([...doors.keys()].sort(), ['/documents', '/health', '/reports', '/streaming/events']);
});

test('a refusal written as a type is read, in a file with no status code', () => {
  // `gateStreamRequest` matches nothing in the guard vocabulary — deliberately, so that a
  // pass here can only mean the body was read. The refusal is two hops out and inside a
  // promise executor, which is mastodon's shape exactly.
  assert.deepEqual(doors.get('/streaming/events'), ['gateStreamRequest']);
});

test('a type carrying a 400 is not a refusal of identity', () => {
  // The discriminator. `RequestError` is declared beside `AuthenticationError`, spelled
  // the same way, thrown the same way, and means something else entirely. A rule reading
  // names takes this door; a rule reading the status does not.
  assert.deepEqual(doors.get('/documents'), []);
});

test('a factory that is mentioned rather than called still lends nothing', () => {
  // #261's rule, which this must not undo. `makeStreamGate` builds something that throws
  // a 401, but the door never called it, so the refusal belongs to a function this route
  // does not run.
  assert.deepEqual(doors.get('/reports'), []);
});

test('a door with nothing in front of it is still open', () => {
  assert.deepEqual(doors.get('/health'), []);
});
