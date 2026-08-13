/**
 * @fileoverview A middleware named like a check that refuses nobody (#237).
 *
 * `auth.ts` opens by warning that a name is not evidence, and then claims a check from
 * one. directus put `app.use(authenticate)` in front of 241 of its 253 doors; the name is
 * in `GUARD_NAMES`; and the middleware's own docstring says what it does — *"Verify the
 * passed JWT and assign the user ID and role to `req`"*. An anonymous caller carries no
 * token, `getAccountabilityForToken` skips its verification on `if (token)`, the request
 * keeps `{ role: null, user: null, admin: false }`, and it calls `next()`.
 *
 * `5 of 253 routes have no auth check` was the headline. 241 of the other 248 were held
 * up by that. It is NodeBB's `authenticateRequest` (#229) in a second framework, and the
 * largest false lock the corpus has produced.
 *
 * ## The rule runs one way only
 *
 * It proves *every exit hands control on*, and is never read backwards as "no proof of
 * continuing, therefore a check". `authenticateRequest` is why, and it is in this fixture:
 * a bare `return;` makes it structurally identical to a refusal, and it is not one. A rule
 * answering "is this a refusal?" from shape would claim it, and it stands on `/login`.
 *
 * Running one way is what makes it safe. It can only withdraw a claim that spelling
 * earned, and a withdrawn lock reports a door as open — the recoverable direction.
 *
 * ## What must survive it
 *
 * NodeBB's `ensureLoggedIn` refuses with `return notAllowed(req, res)` and contains no
 * status code at all. A rule that looked for a literal 401 would take a true lock off 162
 * NodeBB doors. That case is here, and it is the one worth breaking the build over.
 */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import { analyzeProject, classifyOpenDoors } from '../dist/node/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const { atlas } = await analyzeProject(path.join(here, 'fixtures', 'identityparser'), {
  followReferences: true,
  cache: 'off',
});
const doors = new Map(
  atlas.nodes.filter((node) => node.kind === 'endpoint').map((node) => [node.name, node]),
);
const verdicts = classifyOpenDoors(atlas.nodes, atlas.edges);
const guardsOn = (name) => (doors.get(name)?.meta.guards ?? []).map((guard) => guard.name);

test('a name is withdrawn when the body it stands for refuses nobody', () => {
  // directus's case. `authenticate` is an exact `GUARD_NAMES` hit and covers everything
  // through one `app.use`; every exit reaches `next()`, and the only throw is a re-throw
  // from a catch reached solely by somebody who did present a token.
  assert.deepEqual(guardsOn('GET /items'), []);
  assert.deepEqual(guardsOn('GET /activity'), []);
});

test('a refusal with no status code in it keeps its lock', () => {
  // The one worth breaking the build over. `ensureLoggedIn` refuses by calling a helper —
  // `return notAllowed(req, res)` — so nothing in the function is a 401 or a 403. NodeBB
  // writes both of its real checks this way, and they hold up 162 doors.
  assert.deepEqual(guardsOn('GET /admin/settings'), ['ensureLoggedIn']);
});

test('a body that cannot be proven to continue is left exactly as it was', () => {
  // `authenticateRequest` has a bare `return;`. It is not a refusal — NodeBB's inner
  // `authenticate()` hands back `true` for an anonymous caller — but nothing here can show
  // that, so nothing is concluded and the name stands. Read backwards, this rule would
  // *claim* it, which is how a forum's `/login` gets a lock on it.
  assert.deepEqual(guardsOn('GET /profile'), ['authenticateRequest']);
});

test('the door is told what stood in front of it, rather than nothing at all', () => {
  // Withdrawing the lock and saying nothing turns 241 false greens into 241 identical
  // reds, and `exposure.ts` opens by explaining why that is its own failure. The row now
  // names the thing a reader will otherwise find and mistake for a lock, exactly as this
  // tool did.
  const items = doors.get('GET /items');
  assert.equal(items?.meta.identityOnly, 'authenticate');
  assert.equal(verdicts.get(items.id)?.kind, 'identity-only');
  assert.match(verdicts.get(items.id)?.because ?? '', /^authenticate runs in front of this door and refuses nobody/);
});

test('naming it does not excuse it', () => {
  // The exposure is identical to a door with nothing in front of it, so it stays in the
  // number worth interrupting for. The split buys the reader a place to look, not a
  // smaller total — and a tone that read `public` here would be the false green back
  // under a new name.
  assert.equal(atlas.meta.stats.unprotectedRoutes, 2, 'the two unrefused doors are still counted');
});
