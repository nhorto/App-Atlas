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
  assert.equal(atlas.nodes.filter((n) => n.kind === 'endpoint').length, 4);
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
  assert.deepEqual(guardNames('POST /purge'), ['LockedRouter → Depends(who_is_asking)']);
});

test('…and not the routes sitting next to it in the same file', () => {
  // `/status` hangs off the plain router. Both routers are declared in one file, which
  // is why this has to be matched by variable rather than by path.
  assert.deepEqual(guardNames('GET /status'), []);
});
