/**
 * @fileoverview A Gin group built in the argument, and the check standing over it (#194).
 *
 * `users.UsersRegister(v1.Group("/users"))` — no router variable anywhere, which is why
 * the rule that looked for one never fired on the realworld example, and why every door
 * in it printed `POST …/login (UsersLogin)` instead of `POST /api/users/login`.
 *
 * Composing those addresses is only half of it, and the dangerous half is the other one.
 * `Group()` copies the host's middleware as it runs, so a check added to the parent
 * afterwards never reaches the child — and the group made before the first `Use` is the
 * one that hands out sessions. An address composed with the wrong check beside it is a
 * worse answer than the honest ellipsis it replaced, which is the finding this issue was
 * opened to record rather than repeat.
 */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import { analyzeProject } from '../dist/node/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, 'fixtures', 'ginhandover');

const { atlas } = await analyzeProject(FIXTURE, { followReferences: true, cache: 'off' });
const doors = atlas.nodes.filter((node) => node.kind === 'endpoint');
const byName = new Map(doors.map((node) => [node.name, node]));
const guardsOn = (name) => byName.get(name)?.meta.guards.map((guard) => guard.name) ?? null;

test('a group built in the argument gives its doors a real address', () => {
  assert.deepEqual(
    doors.map((node) => node.name).sort(),
    [
      'GET /api/admin/settings',
      'GET /api/articles/:slug',
      'GET /api/ping',
      'GET …/orphan (Orphan)',
      'POST /api/articles',
      'POST /api/users',
      'POST /api/users/login',
    ].sort(),
  );
});

test('three functions sharing one parameter name keep three prefixes', () => {
  // `articles/routers.go` calls it `router` in both of its register functions, and
  // `users/routers.go` does too. Named after the file, all of them would land under
  // whichever prefix the merge happened to resolve first.
  assert.equal(byName.get('POST /api/articles')?.meta.route, '/api/articles');
  assert.equal(byName.get('POST /api/users/login')?.meta.route, '/api/users/login');
});

test('a group made before the check does not stand behind it', () => {
  // `v1.Group("/users")` runs on the line above the first `v1.Use`, so nothing in front
  // of it. This is the door that hands out sessions; a lock here is the worst single
  // false green the tool can print.
  assert.deepEqual(guardsOn('POST /api/users/login'), []);
  assert.deepEqual(guardsOn('POST /api/users'), []);
});

test('a check its caller can switch off is not claimed over a whole group', () => {
  // `AuthMiddleware(auto401 bool)` puts its 401 behind `if auto401`, and is attached
  // twice — once each way. The IR carries a nested call as its callee and drops the
  // argument, so the two attachments are identical here. Neither is claimed.
  assert.deepEqual(guardsOn('GET /api/articles/:slug'), []);
  assert.deepEqual(guardsOn('POST /api/articles'), []);
});

test('a check with no switch on it still locks its group', () => {
  // The withdrawal above is about one specific kind of unreadable, not about group
  // checks in general. `RequireAdmin` takes no arguments and always refuses.
  assert.deepEqual(guardsOn('GET /api/admin/settings'), ['RequireAdmin']);
});

test('a group nobody hands over still gets the ellipsis', () => {
  // #151's net, and the thing the first attempt at this switched off without failing a
  // single test. `OrphanRegister` is never called, so its prefix is unknowable and its
  // fragment is not an address.
  const orphan = byName.get('GET …/orphan (Orphan)');
  assert.ok(orphan, 'the unresolvable door lost its ellipsis');
  assert.equal(orphan.meta.route, null, 'an address that could not be read is not an address');
});

test('a complete address on the engine is untouched by any of this', () => {
  assert.equal(byName.get('GET /api/ping')?.meta.route, '/api/ping');
});
