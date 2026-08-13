/**
 * @fileoverview A check somewhere in the scope a route was registered in (#255).
 *
 * Found by pointing the tool at `mastodon/mastodon`, which it had never seen. Its Node
 * streaming server declares four HTTP routes and **none of them has a check**. All four
 * were reported guarded — `GET /metrics` among them — and the headline read *"every one
 * of the 5 routes has an auth check"* for a server where none of them does.
 *
 * `guessHandlerId` answers with `ctx.enclosing(handler ?? call)`, and an inline arrow is
 * not a node in the atlas, so the best it can offer is the function the registration sits
 * inside. In mastodon that is `startServer`: ~1,300 lines holding all four registrations,
 * a WebSocket handler, and an `authorizeListAccess` five hundred lines below them that
 * authorizes a *timeline list* inside a subscription. `guardConfidence`'s first line then
 * read it as a check written on the door's own handler.
 *
 * It is the failure the rule beneath it already documents at file granularity —
 *
 *   > "We could not find the handler at all" is a different statement from "the handler
 *   > is the whole file" … which is how `mux.Handle("/debug/vars", expvar.Handler())`
 *   > came to be reported as protected.
 *
 * — one level in: *the handler is this whole 1,300-line function*.
 *
 * ## What the id has to distinguish
 *
 * Not "is this scope shared". gin-realworld has two doors on
 * `func:articles/routers.go#ArticleUpdate` and both are right: that id **is** the handler,
 * shared only because `/slug` and `/slug/` are one Go function that checks for itself.
 * The question is whether an id names the door's handler or the scope its registration
 * was written in, which is knowable where the id is made.
 *
 * ## Refused, not graded down
 *
 * `likely` would leave the same lock on the same screen in a paler colour. What a check
 * shares with the door here is a file region, and reach measured that way is the thing
 * `guardConfidence`'s other rule already declines. The cost is a check called *inside* an
 * inline handler, which cannot be told from one called inside the handler beside it, and
 * losing a real lock reports a door as open — the recoverable direction.
 * `EndpointFinding.handlerSpan` is how that gets paid back; it is not paid here.
 *
 * ## Deliberately not widened to realtime
 *
 * `emitRealtime` makes its id the same way, and marking it too was tried and measured:
 * NodeBB's socket connection loses `authorize`, which is **genuine** — `allowRequest:
 * (req, cb) => authorize(req, …)` is socket.io's connection gate and refuses with an
 * error. A real lock lost for no demonstrated false green is the wrong trade, so realtime
 * keeps the older reading and this fixture's `connection` still carries its guard.
 */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import { analyzeProject } from '../dist/node/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const { atlas } = await analyzeProject(path.join(here, 'fixtures', 'scopedguard'), {
  followReferences: true,
  cache: 'off',
});
const doors = new Map(
  atlas.nodes.filter((node) => node.kind === 'endpoint').map((node) => [node.name, node]),
);
const guardsOn = (name) => (doors.get(name)?.meta.guards ?? []).map((guard) => guard.name);

test('a check elsewhere in the registration scope is not this door’s check', () => {
  // mastodon's four, and the one that matters is `/metrics` — a Prometheus endpoint
  // reported as locked when nothing locks it.
  for (const name of ['GET /metrics', 'GET /favicon.ico', 'GET /api/v1/streaming/health']) {
    assert.deepEqual(guardsOn(name), [], `${name} borrowed a check from its enclosing function`);
  }
});

test('a check in the door’s own argument list is untouched', () => {
  // The rule narrows what a *handler id* proves. It must not touch the evidence somebody
  // wrote beside the door, which `middlewareGuards` reads and which never consults an id.
  assert.deepEqual(guardsOn('GET /admin/settings'), ['requireAdmin']);
  assert.equal(doors.get('GET /admin/settings')?.meta.guards[0].confidence, 'certain');
});

test('the door next to it inherits nothing by sharing a function', () => {
  // The second half, and the one a fix to `guardConfidence` alone does not reach: the
  // reference walk reads `handlerIds` directly and never asks about confidence. `mountAdmin`
  // imports `requireAdmin` for the door on the line above; this one references nothing.
  //
  // On the corpus this is the larger half — directus reported all seven of its MCP OAuth
  // routes carrying all seven checks found anywhere in that file, including
  // `/.well-known/oauth-authorization-server`, which is public by specification.
  assert.deepEqual(guardsOn('GET /admin/ping'), []);
});

test('a realtime door keeps the older reading, on purpose', () => {
  // Measured rather than assumed: marking `emitRealtime` the same way costs NodeBB's
  // socket `authorize`, which is a genuine connection gate. Stated here so the
  // inconsistency reads as a decision and not an oversight.
  assert.deepEqual(guardsOn('connection'), ['authorizeListAccess']);
});
