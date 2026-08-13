/**
 * @fileoverview A name that begins like a check, on a thing that is a router.
 *
 * `app.use('/auth', authRouter)` mounts a router. The prefix rule #221 added — a guard's
 * name with the app's own suffix on the end — reads `authRouter` as a check, so directus
 * reported `POST /auth/logout`, `POST /auth/refresh` and both halves of its password
 * reset as locked by a "check" that is the router those doors are declared on. The five
 * doors in that repo which most need to read as open were the five wearing a lock.
 *
 * Two rules answer it, because two different things are knowable:
 *
 *   - the project builds a router in the module the argument names, which is evidence
 *     and settles `authApi` — a name that gives nothing away by its spelling;
 *   - the name ends in `Router`, which is only spelling, and is all that is left when
 *     the router is a local the mount reader could not resolve.
 *
 * Neither may touch #221's own case, so `authAdminApi` is here too: it is Ghost's, it is
 * a real check on 218 doors, and it is the reason the prefix rule exists at all.
 */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import { analyzeProject } from '../dist/node/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, 'fixtures', 'tsguardname');

const { atlas } = await analyzeProject(FIXTURE, { followReferences: true, cache: 'off' });

const doors = new Map(
  atlas.nodes
    .filter((node) => node.kind === 'endpoint')
    .map((node) => [`${node.meta.method} ${node.meta.route}`, node.meta.guards.map((guard) => guard.name)]),
);

test('a mounted router is not a check, however its name begins', () => {
  // `authApi` is `auth` + a capital and does not end in `Router`, so nothing about the
  // name settles it. What settles it is that `auth.api.ts` builds a router.
  assert.deepEqual(doors.get('POST /auth/logout'), ['requireAuth']);
  assert.deepEqual(doors.get('POST /auth/password/reset'), ['requireAuth']);
});

test('one call can mount a router and apply a check, and keeps the check', () => {
  // `app.use('/admin', requireAuth, adminApi)` — the withdrawal is per argument, not per
  // line, or the check written beside a mount would go with it.
  assert.deepEqual(doors.get('GET /admin/settings'), ['requireAuth']);
});

test('a router the mount reader cannot resolve is still not a check', () => {
  // `authRouter` is assigned rather than declared, and built by a factory, so there is no
  // mount to read and no declaration to follow. It reaches every door in the project as a
  // catch-all matcher or none of them.
  for (const [door, guards] of doors) {
    assert.ok(!guards.includes('authRouter'), `${door} claims the router it hangs off as a check`);
  }
});

test('the check the prefix rule exists for is untouched', () => {
  // #221. If this ever fails, 218 of Ghost's admin routes have gone quiet.
  assert.deepEqual(doors.get('GET /posts'), ['authAdminApi', 'requireAuth']);
});

test('a second registration of a check does not silence the first', () => {
  // `requireAuth` is applied twice: globally at the top of `app.ts`, and again on
  // `/admin` further down. Asking the second one where `/auth/logout` sits gives an
  // answer about a registration that never covered it — and keyed by name, that answer
  // used to switch off the global registration too, which is a door losing its real
  // check by way of a line it has nothing to do with.
  assert.ok(doors.get('POST /auth/logout')?.includes('requireAuth'));
  assert.ok(doors.get('POST /auth/password/reset')?.includes('requireAuth'));
});
