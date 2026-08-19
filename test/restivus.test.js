/**
 * @fileoverview A Restivus registration, in either of its two spellings (#236).
 *
 * Rocket.Chat declares its HTTP surface 462 times, two ways:
 *
 *   API.v1.addRoute(
 *     'canned-responses.get',
 *     { authRequired: true, permissionsRequired: ['view-canned-responses'] },
 *     { async get() { … } },
 *   );
 *
 *   API.v1.get('licenses.info', { authRequired: true, … }, async function action() { … });
 *
 * and App Atlas read none of them. What it showed instead was 13 doors, none of which is
 * the API — so the second-largest chat server on GitHub came back as an app with almost
 * no way in. That is the direction of error this project exists to prevent, and #300
 * already removed the noise that was hiding it.
 *
 * The shape is Restivus', which Rocket.Chat's `APIClass` is descended from. Neither
 * spelling is a variant of `app.get(path, handler)`, and they fail to be one for opposite
 * reasons. `addRoute` has no verb in the callee — the verbs are the *keys* of the object
 * handed over last. The typed form has the verb in the right place and a relative path on
 * a receiver named `v1`, which is the shape `routeCall` refuses on purpose.
 *
 * ## What makes it a registration
 *
 * Not the name. `addRoute` is vue-router's too, and vue-router has the same two
 * arities — a record alone, or a parent name and a child record. A trie has one. So the
 * fixture asks both of those alongside, with paths, and neither may become a door.
 *
 * What separates them is the same fact #300 turned on, one level in: a registration hands
 * over handlers, and here they arrive keyed by verb. `{ path: 'users', component: … }`
 * has no verb key; `{ handler: 'usersShow', priority: 2 }` has no verb key. `{ async
 * get() {…}, async post() {…} }` is three tokens of a framework saying what answers GET
 * and what answers POST, and there is no reading of it that is not a route.
 *
 * For the typed spelling the same question is asked of the options object in the middle,
 * because there the handler is where a `cache.get(key, { ttl }, fallback)` puts one. Only
 * words this framework invented count: `authRequired`, `permissionsRequired`. 288 of
 * Rocket.Chat's 289 typed registrations carry one.
 *
 * ## The address stays half-read
 *
 * `canned-responses.get` answers at `/api/v1/canned-responses.get`, and the `/api/v1` is
 * assembled at runtime from two fields of a class and a mount in another file:
 *
 *   this.apiPath = [properties.apiPath, properties.version].filter(Boolean).join('/')
 *
 * So the head is unread, and it is printed as unread — `…canned-responses.get`, no
 * separator, which is #199 and #269's answer and not a new one. Inventing
 * `/canned-responses.get` would be an address nobody can call.
 */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import { analyzeProject } from '../dist/node/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));

const { atlas } = await analyzeProject(path.join(here, 'fixtures', 'restivus'), {
  followReferences: true,
  cache: 'off',
});
const doors = atlas.nodes.filter((node) => node.kind === 'endpoint');
const names = doors.map((node) => node.name).sort();
const byName = new Map(doors.map((node) => [node.name, node]));

test('every registration is a way in, and nothing else is', () => {
  assert.deepEqual(names, [
    'DELETE …abac/attributes/:_id',
    'DELETE …canned-responses',
    'GET /healthz',
    'GET …abac/attributes',
    'GET …canned-responses',
    'GET …canned-responses.get',
    'GET …channels.list',
    'GET …licenses.info',
    'GET …livechat/config',
    'POST …canned-responses',
    'POST …licenses.add',
    'POST …livechat/visitor.status',
  ]);
});

test('the head is left unread rather than invented', () => {
  const door = byName.get('GET …canned-responses.get');
  assert.equal(door.meta.route, null);
  assert.equal(door.meta.method, 'GET');
});

test('one registration with three verbs is three doors, and two of them write', () => {
  assert.equal(byName.get('GET …canned-responses').meta.writes, false);
  assert.equal(byName.get('POST …canned-responses').meta.writes, true);
  assert.equal(byName.get('DELETE …canned-responses').meta.writes, true);
});

test('the two-argument form has no options and is still a door', () => {
  const door = byName.get('POST …livechat/visitor.status');
  assert.deepEqual(door.meta.guards, []);
  assert.equal(door.meta.route, null);
});

test('the checks written in the options are the checks on the door', () => {
  const door = byName.get('GET …canned-responses.get');
  const found = door.meta.guards.map((guard) => guard.name).sort();
  assert.deepEqual(found, ['authRequired', 'view-canned-responses']);
  for (const guard of door.meta.guards) {
    assert.equal(guard.how, 'config');
    assert.equal(guard.confidence, 'certain');
  }
});

test('`authRequired: false` is somebody saying the door is open on purpose', () => {
  const door = byName.get('GET …livechat/config');
  assert.deepEqual(door.meta.guards, []);
  assert.equal(door.meta.open?.kind, 'declared-public');
});

test('another library\'s addRoute registers a screen, and is not a door', () => {
  assert.equal(names.some((name) => name.includes('users')), false);
  assert.equal(names.some((name) => name.includes('admin')), false);
});

test('the typed spelling is the same registration with the verb moved', () => {
  const door = byName.get('GET …licenses.info');
  assert.equal(door.meta.route, null);
  assert.equal(door.meta.writes, false);
  assert.deepEqual(
    door.meta.guards.map((guard) => guard.name).sort(),
    ['authRequired', 'view-privileged-setting'],
  );
  assert.equal(byName.get('POST …licenses.add').meta.writes, true);
});

test('two-factor is a check, and it is read where it is written', () => {
  const found = byName.get('POST …licenses.add').meta.guards.map((guard) => guard.name).sort();
  assert.deepEqual(found, ['authRequired', 'twoFactorRequired']);
});

test('a permission required of one verb is not a check on another', () => {
  const found = byName.get('GET …channels.list').meta.guards.map((guard) => guard.name).sort();
  assert.deepEqual(found, ['authRequired', 'view-c-room']);
});

test('three arguments and a callable last one is not enough to be a door', () => {
  assert.equal(names.some((name) => name.includes('sessions')), false);
  assert.equal(names.some((name) => name.includes('url')), false);
});

test('the verbs return the API object, so registrations chain', () => {
  const door = byName.get('DELETE …abac/attributes/:_id');
  assert.equal(door.meta.writes, true);
  assert.deepEqual(door.meta.guards.map((guard) => guard.name), ['authRequired']);
  // `dottedName` flattens the chain; what is printed is the method as it was written.
  assert.equal(door.meta.sites[0].snippet, "delete('abac/attributes/:_id', …)");
});
