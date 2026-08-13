/**
 * @fileoverview A check written in a registration scope is not written on its doors (#255).
 *
 * Found by pointing the tool at mastodon, which had never been in the corpus. Its Node
 * streaming server declares four HTTP routes and a WebSocket connection, and the screen
 * said `every one of the 5 routes has an auth check — all matched, none proven`. Three of
 * those five have nothing in front of them at all, and one of them is `/metrics`.
 *
 * The mechanism is one line of `guessHandlerId` meeting one line of `guardConfidence`.
 * An inline arrow is not a node in the atlas, so "which function answers this door" walks
 * up past it and answers with whatever encloses the `app.get(…)` call — in mastodon,
 * `startServer`, 1,317 lines holding every registration in the program, the WebSocket
 * handler, and `authorizeListAccess`. The check's node is that same function. So
 * `handlerIds.has(guard.nodeId)` is true, the reach grades `certain`, and a routine that
 * authorizes a subscription to a timeline list is reported as the lock on a Prometheus
 * endpoint.
 *
 * It is the failure `guardConfidence` already documents at file granularity, one level
 * in. "We could not find the handler" and "the handler is the whole file" are different
 * statements, and so are "this is the handler" and "this is the 1,300-line function the
 * handler was typed inside".
 *
 * The discriminator is not the obvious one. *Sharing* an id between several doors looks
 * like the tell and is not: gin-realworld's `ArticleUpdate` serves `/api/articles/:slug`
 * and `/api/articles/:slug/` from one Go function that does its own checking, and it is
 * both shared and correct. What separates the cases is whether the node was ever the
 * handler — which only the code that made the id can answer.
 *
 * `/admin/keys` is the price, and it is in the fixture rather than in a paragraph. Its
 * check is called inside its own handler, which is the genuine version of what mastodon
 * only looked like, and the two are indistinguishable from an id because `ctx.enclosing`
 * collapses both to the same function. So it reports open while being checked. That is
 * the recoverable direction, and `handlerSpan` — which already exists for C# lambdas — is
 * the way back.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyzeProject } from '../dist/node/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const { atlas } = await analyzeProject(path.join(here, 'fixtures', 'scopereg'), {
  followReferences: true,
  cache: 'off',
});

const routes = atlas.nodes.filter((n) => n.kind === 'endpoint' && n.meta.endpointKind === 'http-route');
const named = (name) => routes.find((n) => n.name === name);
const guardsOn = (name) => named(name).meta.guards.map((g) => g.name);

test('the fixture parsed, so a silent failure cannot pass as a pass', () => {
  assert.deepEqual(atlas.meta.warnings, []);
});

test('every door in the scope is found', () => {
  assert.deepEqual(routes.map((n) => n.name).sort(), [
    'GET /admin/keys',
    'GET /api/items',
    'GET /favicon.ico',
    'GET /health',
    'GET /metrics',
    'GET /settings',
  ]);
});

test('a check elsewhere in the registration scope reaches no door', () => {
  // The regression this file exists for. `authorizeListAccess` is written in the same
  // function as these three registrations and stands in front of none of them. Before
  // this rule, all three came out carrying it — along with `requireAdmin`, graded
  // `certain`, from a handler two doors away.
  for (const name of ['GET /favicon.ico', 'GET /health', 'GET /metrics']) {
    assert.deepEqual(guardsOn(name), [], name);
  }
});

test('a Prometheus endpoint with nothing in front of it says so', () => {
  // Named separately because this is the sentence that cost the most. Nobody re-checks a
  // door they were told was locked, so a false green on `/metrics` is worse than no
  // answer about `/metrics`.
  const metrics = named('GET /metrics');
  assert.deepEqual(metrics.meta.guards, []);
  assert.equal(metrics.meta.handlerUnlinked, undefined, 'the door was read, not skipped');
});

test('the router that really is gated keeps its gate', () => {
  // `api.use(requireSession)` names the router it guards, so it is a fact about `api`
  // rather than about the function the line was typed in. Refusing the scope must not
  // take this with it — a rule that returns every door to red has only moved the failure.
  assert.deepEqual(guardsOn('GET /api/items'), ['requireSession']);
});

test('a module-scope registration still reads its file', () => {
  // One level out, where the id is the *file*. That case is deliberately graded `likely`
  // rather than refused, and narrowing the strong rule must not empty the set the weak
  // one tests — `[].every(…)` is true, which is the trap the size check below
  // `guardConfidence` already carries a paragraph about.
  assert.deepEqual(guardsOn('GET /settings'), ['requireSession']);
});

test('a check called inside a door’s own handler is given up, and under-claims', () => {
  // The measured cost. `requireAdmin` is called in this door's handler and nowhere else,
  // so the door is genuinely checked and is reported open. `ctx.enclosing` collapses an
  // inline arrow into the function around it, so this is the same node — and therefore
  // the same evidence — as a check written beside the registration. Telling them apart
  // needs the handler's span, not its id.
  assert.deepEqual(guardsOn('GET /admin/keys'), []);
});

test('the count is of doors nothing was found in front of, and it is four', () => {
  // Zero before this change: every door in the fixture read as protected, and the one
  // that reads protected for a real reason was buried among them. A number that says
  // everything is fine is the one a reader stops checking.
  assert.equal(atlas.meta.stats.routes, 6);
  assert.equal(atlas.meta.stats.unprotectedRoutes, 4);
});
