/**
 * @fileoverview Where a TypeScript route's auth actually lives.
 *
 * The Python drive established that a check is normally written in the wiring — on the
 * mount, in middleware, on a class three links up — and never in the file declaring the
 * route. TypeScript has all three shapes and had read none of them correctly:
 *
 *   - `admin.use(requireAuth)` on a sub-router was reported as protecting *every door in
 *     the repo*, because the pattern it produces (`/:path*`) is relative to a mount
 *     written in another file, and nothing put the two together;
 *   - a NestJS controller extending a guarded base class read as wide open;
 *   - and `import { admin } from './admin.routes'` resolved to `./admin`, so the mount
 *     was lost and the route lost its prefix — on exactly the naming convention (`.routes`,
 *     `.controller`, `.module`) that NestJS repos are built from.
 *
 * The first of those is the expensive one. Saying a door is locked when it is not is the
 * one mistake this tool must not make, and it was making it repo-wide from one line.
 *
 * Issue #40 added the mirror image of all three: a door that has no check *and should
 * not*. A handler that calls the auth library's own sign-in cannot demand a session
 * first, and reporting it alongside the genuinely open ones is how a security list
 * teaches its reader to skim. The tests for it live here rather than beside the rest of
 * the exposure rules on purpose — the fixture is Express and NestJS, so a rule that only
 * worked on the Next.js server actions the issue was reported against would fail them.
 */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import { analyzeProject } from '../dist/node/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const { atlas } = await analyzeProject(path.join(here, 'fixtures', 'tsauth'), {
  followReferences: true,
  cache: 'off',
});

const endpoint = (name) => atlas.nodes.find((n) => n.kind === 'endpoint' && n.name === name);
const guardNames = (name) => (endpoint(name)?.meta.guards ?? []).map((g) => g.name);
const why = (name) => endpoint(name)?.meta.open?.kind ?? null;

test('the fixture parsed, so a silent failure cannot pass as a pass', () => {
  assert.deepEqual(atlas.meta.warnings, []);
  assert.equal(atlas.nodes.filter((n) => n.kind === 'endpoint').length, 13);
});

// --- a check written on a router ---

test('a check on a sub-router guards that router', () => {
  // `admin.use(requireAuth)` in `admin.routes.ts`, and the `/admin` it answers under is
  // in `server.ts`. Neither file contains both halves.
  assert.deepEqual(guardNames('POST /admin/purge'), ['requireAuth']);
});

test('…and nothing else in the application', () => {
  // The whole point. `/:path*` read literally is every route in the repo, and this is a
  // sibling router mounted right beside the locked one.
  assert.deepEqual(guardNames('GET /open/status'), []);
  assert.deepEqual(guardNames('GET /healthz'), []);
});

test('a router-scoped check is likely, never certain', () => {
  // The mount is a fact; that the middleware runs before every one of these routes and
  // turns strangers away is an inference from how the framework is wired.
  assert.equal(endpoint('POST /admin/purge').meta.guards[0].confidence, 'likely');
});

// --- the class chain ---

test('a controller inherits the check its own file never mentions', () => {
  // `ReportsController extends Reporting extends SignedIn`, and `SignedIn` is where
  // `@UseGuards(SessionGuard)` is written — two links up, in another file.
  assert.deepEqual(guardNames('GET /reports'), ['SignedIn → UseGuards(SessionGuard)']);
  assert.deepEqual(guardNames('DELETE /reports/:id'), ['SignedIn → UseGuards(SessionGuard)']);
});

test('the guard names the class that declares the check, not the one that inherits it', () => {
  // `Reporting` is a link in the chain and nothing else. Naming it would send a reader
  // to a file with no check in it.
  const guard = endpoint('GET /reports').meta.guards[0];
  assert.equal(guard.how, 'config');
  assert.equal(guard.confidence, 'likely', 'inherited through the framework, not written here');
  assert.equal(guard.path, 'src/base.controllers.ts');
});

test('a sibling controller with no check in its chain stays open', () => {
  // `LivenessController extends Anyone` is declared the same way, in the same shape,
  // with the same amount of auth vocabulary in it as the guarded one — none.
  assert.deepEqual(guardNames('GET /live'), []);
});

// --- the address the mount decides ---

test('a file named for what it holds is still the file the import means', () => {
  // `./admin.routes` is a whole file name, not a name with a suffix. Trimming past the
  // last dot made it `./admin`, which matches nothing, so the mount was dropped and the
  // route kept the address it has on its own router rather than the one it answers at.
  assert.ok(endpoint('POST /admin/purge'), 'the mount prefix survived the import');
  assert.equal(endpoint('POST /purge'), undefined, 'and the unmounted spelling is gone');
});

// --- #40: the door that has no check and should not have one ---

test('a handler that calls the auth library\'s own sign-in is the sign-in door', () => {
  assert.deepEqual(guardNames('POST /session'), [], 'the premise: nothing checks it');
  assert.equal(why('POST /session'), 'auth-mount');
  assert.equal(why('DELETE /session'), 'auth-mount');
});

test('…however the library publishes it', () => {
  // Supabase hands its sign-in out as a method on a client the app built itself, which
  // leaves the shape of the call as the only evidence. NextAuth hands its own out as an
  // ordinary import, where the package is the evidence and the name is only the label.
  assert.match(endpoint('POST /session').meta.open.because, /calls supabase\.auth\.signInWithPassword/);
  assert.equal(endpoint('POST /federated').meta.signInCall.provider, 'NextAuth');
  assert.equal(why('POST /federated'), 'auth-mount');
});

test('the evidence is the call and never the name of the thing making it', () => {
  // `POST /session/visit` is answered by a method called `signIn` that signs nobody in,
  // and `POST /session` by one called `handleSubmit` that does. Read the names and both
  // come out backwards — and the second mistake takes a real open door off the list.
  assert.equal(why('POST /session/visit'), 'worth-a-look');
  assert.equal(endpoint('POST /session/visit').meta.signInCall, undefined);
  assert.equal(endpoint('POST /session').meta.signInCall.call, 'supabase.auth.signInWithPassword');
});

test('signing somebody in does not explain writing the app\'s own data as well', () => {
  assert.equal(endpoint('POST /session/join').meta.signInCall.what, 'sign-up');
  assert.equal(why('POST /session/join'), 'worth-a-look', 'the row it writes is unexplained');
});

test('a call that needs a session already is not a way of getting one', () => {
  // `auth.updateUser` changes the password of whoever is signed in; `auth.admin.*` takes
  // a service key and signs somebody else out. Both need a caller already through the
  // door, so a door onto either of them is a finding like any other.
  assert.equal(why('PUT /session/password'), 'worth-a-look');
  assert.equal(why('POST /session/revoke'), 'worth-a-look');
});

test('signing out reads as signing out, not as a door reached before a session', () => {
  // Every sentence here is shown to somebody who cannot read the code. "Reached before
  // you have a session" would be plainly untrue of a sign-out, and a sentence that is
  // nearly right is how a reader stops believing the ones that are.
  assert.match(
    endpoint('DELETE /session').meta.open.because,
    /calls supabase\.auth\.signOut — Supabase's own sign-out routine, which ends a session rather than checking for one/,
  );
});
