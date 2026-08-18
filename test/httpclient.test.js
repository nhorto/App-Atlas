/**
 * @fileoverview An HTTP client is not a router, and its calls are not doors (#236).
 *
 * Rocket.Chat reports 163 ways in. 150 of them come out of `tests/e2e/`, and every one is
 * a Playwright client calling a *deployed* Rocket.Chat over HTTP:
 *
 *   api.delete('/livechat/users/agent/user1'),
 *   api.delete('/canned-responses', { _id: cannedResponseId }),
 *
 * Its ~173 real `API.v1.addRoute(…)` registrations are read as none. So the map of that
 * application is its test suite's outbound traffic, and the application itself is missing.
 *
 * Three separate wrong things come from the one mistake, which is why this is worth a
 * rule rather than a filter:
 *
 *   - They are not routes. `api` is `apiContext`, and nothing is registered anywhere.
 *   - Their addresses are fragments. The client prepends `API_PREFIX = '/api/v1'`, so the
 *     door printed `DELETE /canned-responses` answers at `/api/v1/canned-responses` — a
 *     resolved address that is wrong, which is #199 exactly.
 *   - Being in a spec they are marked `declaredInTest`, whose verdict reads "nobody
 *     outside a test run can knock on this". Said about a public API route, that is the
 *     one direction of error this project exists to prevent.
 *
 * ## What separates a client call from a registration
 *
 * Not the receiver's name — `looksLikeRouter` takes `app`, `api`, `server` or `r` on the
 * name alone, and its own comment names `api.get('users')` on an HTTP client as the risk.
 * Not the path, which is a leading-slash string in both.
 *
 * A registration has a **handler**. `app.get('/res_redirect/1', (_req, res) => …)`
 * registers something; `api.get('/settings/Livechat_title')` registers nothing, and
 * `api.delete('/canned-responses', { _id })` hands over query parameters. Express agrees:
 * `app.get('/x')` with no handler is not a route — with a non-path string it is the
 * settings getter the leading-slash rule already exists to catch.
 *
 * The pairing in the fixture is the whole test. `tests/harness.test.ts` is Sails' shape —
 * a suite standing an address up, handler and all — and it has to stay a door and stay
 * marked. #247 is a rule about *whose* door it is; this is a rule about whether it is one.
 */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import { analyzeProject, classifyOpenDoors } from '../dist/node/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));

const { atlas } = await analyzeProject(path.join(here, 'fixtures', 'httpclient'), {
  followReferences: true,
  cache: 'off',
});
const doors = atlas.nodes.filter((node) => node.kind === 'endpoint');
const names = doors.map((node) => node.name).sort();
const byName = new Map(doors.map((node) => [node.name, node]));

test('a request client\'s calls are not ways into this application', () => {
  assert.deepEqual(names, ['GET /real', 'GET /res_redirect/1']);
});

test('the four client calls are gone by name', () => {
  // Named individually because each is a different argument shape, and a rule that
  // caught only one of them would leave the other three on the security screen.
  for (const gone of [
    'DELETE /livechat/users/agent/user1', // no second argument at all
    'DELETE /canned-responses',           // second argument is a bag of query parameters
    'GET /settings/Livechat_title',       // one argument, and a settings-shaped address
    'POST /abac/attributes',              // second argument is a request body
  ]) {
    assert.equal(byName.get(gone), undefined, `${gone} is a client call, not a door`);
  }
});

test('a second client library reads the same way', () => {
  // outline, on supertest rather than Playwright: 472 doors, 41 of them requests out of
  // `*.test.ts`. The receiver is `server`, which `looksLikeRouter` also takes on its name.
  for (const gone of [
    'GET /api/cron.daily',
    'GET /api/cron.daily?token=token',
    'POST /api/utils.gc',
    'GET /.well-known/oauth-protected-resource',
  ]) {
    assert.equal(byName.get(gone), undefined, `${gone} is a request, not a door`);
  }
});

test('a suite that stands an address up still has a door, and still says so', () => {
  // #247's case, unchanged. The handler is what makes it a registration; the directory is
  // what makes it the suite's. Both facts survive, and a rule that dropped this would be
  // a worse bug than the one above — Sails' entire surface is this shape.
  const harness = byName.get('GET /res_redirect/1');
  assert.ok(harness, 'a route a test really does register was dropped');
  assert.equal(harness.meta.declaredInTest, true);
  assert.equal(classifyOpenDoors(atlas.nodes, atlas.edges).get(harness.id)?.kind, 'in-test');
});

test("the application's own door is untouched", () => {
  assert.equal(byName.get('GET /real')?.meta.declaredInTest ?? false, false);
});
