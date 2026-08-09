/**
 * @fileoverview Where a Python route's auth actually lives (issue #32).
 *
 * Python frameworks put the lock everywhere except inside the handler: in the
 * signature's type, in a name aliased two files away, in the class the router was
 * built from. A detector that reads only the handler body reports every one of these
 * as wide open — which is not an imprecise answer, it is the opposite of the true one.
 *
 * The fixture is deliberately hostile to name-matching. Nothing in it is called
 * `get_current_user` or `require_auth`; the checker is `who_is_asking`, and the only
 * reason to believe it is a check is that it raises a 401. The negative cases matter
 * as much: a dependency that *fetches* is not a lock, and a router that carries a
 * check guards the routes registered on it and not the ones beside them.
 */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import { analyzeProject } from '../dist/node/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const { atlas } = await analyzeProject(path.join(here, 'fixtures', 'pyauth'), {
  followReferences: true,
  cache: 'off',
});

const endpoint = (name) => atlas.nodes.find((n) => n.kind === 'endpoint' && n.name === name);
const guardNames = (name) => (endpoint(name)?.meta.guards ?? []).map((g) => g.name);

test('the fixture parsed, so a silent failure cannot pass as a pass', () => {
  assert.deepEqual(atlas.meta.warnings, []);
  assert.equal(atlas.nodes.filter((n) => n.kind === 'endpoint').length, 10);
});

test('a check is recognised by what it does, not by what it is called', () => {
  // `who_is_asking` matches no auth vocabulary at all. It raises a 401, which is the
  // whole of the evidence and is a fact about the code.
  assert.deepEqual(guardNames('GET /profile'), ['Whoever → Depends(who_is_asking)']);
});

test('the alias names the annotation the reader will actually find', () => {
  const guard = endpoint('GET /profile').meta.guards[0];
  // A reader looking for `who_is_asking` in their route file would not find one —
  // their signature says `Whoever`.
  assert.match(guard.name, /^Whoever → /);
  assert.equal(guard.confidence, 'likely', 'a dependency is evidence, never proof');
  assert.equal(guard.path, 'api/gatekeeping.py', 'evidence points at the check itself');
});

test('a dependency that fetches something is not a lock', () => {
  // `fetch_tenant` is injected exactly like the checker is, and refuses nobody.
  // Counting it would make the security screen worthless by making it always green.
  assert.deepEqual(guardNames('GET /tenant'), []);
});

test('a router that carries a check guards what is registered on it', () => {
  // Named for its full address: `@locked.post("/purge")` on a router built with
  // `prefix="/admin"` answers at `/admin/purge`, and that is what a reader would type.
  assert.deepEqual(guardNames('POST /admin/purge'), ['LockedRouter → Depends(who_is_asking)']);
});

test('…and not the routes sitting next to it in the same file', () => {
  // `/status` hangs off the plain router. Both routers are declared in one file, which
  // is why this has to be matched by variable rather than by path.
  assert.deepEqual(guardNames('GET /status'), []);
});

// --- the lock three classes up (found while fixing #37) ---

/**
 * A class-based view injects the class's dependencies into every route declared on it,
 * so a controller can be entirely guarded and mention a caller nowhere in its own file.
 * mealie writes it this way: `AdminBackupController(BaseAdminController)`, and two
 * links up, `user: PrivateUser = Depends(get_current_user)`. 130 of its 189 routes read
 * as having no visible check.
 */
test('a controller inherits the check its own file never mentions', () => {
  assert.deepEqual(guardNames('GET /reports'), ['SignedIn → Depends(who_is_asking)']);
  assert.deepEqual(guardNames('DELETE /reports/{report_id}'), ['SignedIn → Depends(who_is_asking)']);
});

test('the guard names the class that declares the check, not the one that inherits it', () => {
  // `Reporting` is a link in the chain and nothing else. Naming it would send a reader
  // to a file with no check in it.
  const guard = endpoint('GET /reports').meta.guards[0];
  assert.equal(guard.how, 'config');
  assert.equal(guard.confidence, 'likely');
  assert.equal(guard.path, 'api/gatekeeping.py');
});

test('a sibling controller with no check in its chain stays open', () => {
  // `LivenessController(Anyone)` is declared in the same file, the same way, with the
  // same amount of auth vocabulary in it — none. A rule that read the file instead of
  // the hierarchy would have to get one of these two wrong.
  assert.deepEqual(guardNames('GET /live'), []);
});

test('a dependency the whole hierarchy shares is still not a lock', () => {
  // `_Controller.tenant = Depends(fetch_tenant)` sits above both controllers. It
  // fetches and refuses nobody, so it cannot be what makes either of them guarded.
  const everyGuard = atlas.nodes
    .filter((n) => n.kind === 'endpoint')
    .flatMap((n) => n.meta.guards ?? [])
    .map((g) => g.name);
  assert.ok(!everyGuard.some((name) => /fetch_tenant/.test(name)), everyGuard.join(' | '));
});

// ---------------------------------------------------------------------------
// The lock written on the decorator (#136)
// ---------------------------------------------------------------------------

/**
 * Found by running the published package over FastAPI's own full-stack template, which
 * reported `11 of 23 routes have no auth check` when the true answer was 6. Five of the
 * five wrong ones were administrator-only, guarded like this.
 *
 * A handler that never touches the user object takes no `CurrentUser` parameter, so the
 * decorator is the *only* place its lock is written down — and nothing read it. The
 * signature path and the `@login_required` path each covered half the idiom and left
 * this between them.
 */
test('a dependency on the decorator is a lock, even with nothing in the signature', () => {
  assert.deepEqual(guardNames('GET /summaries'), ['who_is_asking']);
});

test('…and stays one when a formatter wraps the decorator', () => {
  // The first explanation for this bug was that layout mattered. It does not — the
  // Python tier reads an AST — but the wrapped spelling is what a formatter produces
  // for any decorator with three arguments, so it is the common case and it is pinned.
  assert.deepEqual(guardNames('GET /exports'), ['who_is_asking']);
});

test('a decorator dependency that fetches is still not a check', () => {
  // The discrimination this file exists for, arriving by a new route. `fetch_tenant`
  // turns nobody away, so depending on it from the decorator is no more a lock than
  // depending on it from the signature — which `GET /tenant` already proves.
  assert.deepEqual(guardNames('GET /pings'), []);
});

test('the grade is likely, because the check is a fact about another function', () => {
  const guard = endpoint('GET /summaries').meta.guards[0];
  assert.equal(guard.confidence, 'likely', 'never certain: what makes it a lock lives elsewhere');
});
