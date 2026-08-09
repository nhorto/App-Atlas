/**
 * @fileoverview A credential check is not a route guard (#147, part two).
 *
 * Part one (#148) stopped the escalation: Gin's `POST /login`, whose 401 answers a
 * wrong *password*, stopped reading as certainly protected and read as guarded at
 * `likely` — less wrong, not right. This is the rest: a handler that issues or
 * verifies a credential is the door people sign in through, `auth-mount`, the same
 * shelf the C# tier's SIGN_IN_CALLS and the Supabase sign-in rule (#40) use.
 *
 * The Go-shaped difficulty is distance. The realworld app signs a caller in as
 * `UsersLogin → Response → GenToken`, and only the last touches the JWT library — so
 * the sign-in call is found by walking the project's reference graph from the handler,
 * two hops and no further. The fixture pins both distances: login reaches bcrypt's
 * password check in one hop, register reaches the mint only through the serializer in
 * two.
 *
 * Explicitly rejected, still: matching the name `login`. The fixture's handlers could
 * be renamed to anything and every assertion here would hold.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyzeProject } from '../dist/node/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const { atlas } = await analyzeProject(path.join(here, 'fixtures', 'gosignin'), {
  followReferences: true,
  cache: 'off',
});

const routes = atlas.nodes.filter((n) => n.kind === 'endpoint' && n.meta.endpointKind === 'http-route');
const named = (name) => routes.find((n) => n.name === name);

test('the login route is the sign-in door, not a route guarding itself', () => {
  const login = named('POST /users/login');
  assert.ok(login, `have: ${routes.map((n) => n.name).join(', ')}`);
  assert.equal(login.meta.open?.kind, 'auth-mount');
  assert.ok(login.meta.signInCall, 'signInCall stamped');
});

test("the 401 it answers a wrong password with is no longer a guard", () => {
  // Pre-fix this door wore `UsersLogin@likely` — the handler attached to itself via
  // the rejection reading. The mint outranks that reading; the guard list is empty.
  assert.deepEqual(named('POST /users/login').meta.guards, []);
});

test('one hop: login reaches the bcrypt password check through CheckPassword', () => {
  assert.match(named('POST /users/login').meta.signInCall.call, /CompareHashAndPassword/);
});

test('two hops: register reaches the mint only through the serializer', () => {
  const register = named('POST /users');
  assert.equal(register.meta.open?.kind, 'auth-mount');
  assert.match(register.meta.signInCall.call, /SignedString/);
});

test('the route next to the mint is not excused by proximity', () => {
  const ping = named('GET /ping');
  assert.equal(ping.meta.open?.kind, 'worth-a-look');
  assert.equal(ping.meta.signInCall, undefined);
});

test('the headline counts the sign-in doors as public-with-a-reason, not unprotected', () => {
  assert.equal(atlas.meta.stats.unprotectedRoutes, 1);
  assert.equal(atlas.meta.stats.publicRoutes, 2);
});
