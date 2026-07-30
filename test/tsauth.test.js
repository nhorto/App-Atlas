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

test('the fixture parsed, so a silent failure cannot pass as a pass', () => {
  assert.deepEqual(atlas.meta.warnings, []);
  assert.equal(atlas.nodes.filter((n) => n.kind === 'endpoint').length, 6);
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
