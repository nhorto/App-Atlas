/**
 * @fileoverview Deleting the session cookie is signing out (#186).
 *
 * sveltejs/realworld's twenty-one doors came out twenty right and one wrong, and the
 * one was the whole worry list: `POST /settings?/logout`, whose body is
 * `cookies.delete('jwt')`. Deleting your own cookie requires nothing to be true first
 * — it is the mirror of the sign-in door, and `SignInKind` has carried `'sign-out'`
 * since #40. What was missing was the spelling: every recognised sign-out is a named
 * call into an auth library, and an app that issues its own cookie has none to call.
 *
 * A reader who opens the only finding on a repo, sees a logout, and concludes the list
 * is decoration is #116 happening in a single click.
 *
 * The counter-case is in the fixture on purpose: `cookies.delete('theme')` is a
 * preference, not a session, and stays on the worry list. The cookie's name is the
 * evidence — never the handler's, which is #147's rule.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyzeProject } from '../dist/node/index.js';
import { authHeadline } from '../dist/node/model/exposure.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const { atlas } = await analyzeProject(path.join(here, 'fixtures', 'sveltesignout'), {
  followReferences: true,
  cache: 'off',
});

const doors = atlas.nodes.filter((n) => n.kind === 'endpoint');
const door = (fragment) => doors.find((n) => n.name.includes(fragment));

test('the logout action is the sign-in door, not a door nobody checked', () => {
  const logout = door('logout');
  assert.ok(logout, doors.map((n) => n.name).join(', '));
  assert.equal(logout.meta.open?.kind, 'auth-mount');
  assert.match(logout.meta.open.because, /cookies\.delete\('jwt'\).*ends a session rather than checking for one/);
});

test('deleting a preference is not signing out', () => {
  const reset = door('reset');
  assert.ok(reset, doors.map((n) => n.name).join(', '));
  assert.equal(reset.meta.open?.kind, 'worth-a-look');
});

test('the real check beside it is untouched', () => {
  assert.ok((door('save')?.meta.guards ?? []).length > 0, 'save keeps its 401');
});

test('the headline counts the preference reset and nothing else', () => {
  assert.equal(atlas.meta.stats.unprotectedRoutes, 1);
  assert.match(authHeadline(atlas.meta.stats).headline, /1 of \d+ routes/);
});
