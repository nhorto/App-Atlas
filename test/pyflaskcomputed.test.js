/**
 * @fileoverview A route whose address the source computes is still a route (#142).
 *
 * `@routes.route(org_scoped_rule("/login"))` has no string literal to read, and the
 * detector's first act was `if (!route) continue` — which threw away the handler, the
 * methods and the guard along with the address. On getredash/redash that was 23 of 28
 * route decorators, `/login`, `/forgot` and `/reset/<token>` among them, while the
 * summary read `4 of 5 routes have no auth check` in the same confident type it uses
 * when the denominator is right.
 *
 * Dropping the door looks like the cautious choice and is not one. It is a claim — that
 * this handler answers no URL — and it is false. The trade the codebase had already
 * settled elsewhere applies exactly: a sqlx call whose SQL is built elsewhere still
 * proves the database is used, and only the arrow is missing.
 *
 * What must not happen is a fabricated address. `/login` is *inside* the call, but the
 * helper is a prefix and the real path is not the one in the parentheses — so the door
 * is labelled with the expression as written and `route` stays null, where nothing
 * downstream can match a prefix or a webhook pattern against it.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyzeProject } from '../dist/node/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const { atlas } = await analyzeProject(path.join(here, 'fixtures', 'pyflaskcomputed'), {
  followReferences: true,
  cache: 'off',
});

const routes = atlas.nodes.filter((n) => n.kind === 'endpoint' && n.meta.endpointKind === 'http-route');
const named = (name) => routes.find((n) => n.name === name);

test('the fixture parsed, so a silent failure cannot pass as a pass', () => {
  assert.deepEqual(atlas.meta.warnings, []);
});

test('a computed path is a door, and the literal one still is too', () => {
  // Four decorators, five doors: `login` lists two methods.
  assert.deepEqual(routes.map((n) => n.name).sort(), [
    "GET /api/config",
    "GET org_scoped_rule('/api/session')",
    "GET org_scoped_rule('/login')",
    "GET org_scoped_rule('/logout')",
    "POST org_scoped_rule('/login')",
  ]);
});

test('the label is the expression as written, never a reconstructed URL', () => {
  // `/login` is inside the call. Publishing it as the address would be inventing one:
  // the helper prefixes a tenant slug, so the real path is not what is in the brackets.
  assert.equal(named("GET org_scoped_rule('/login')").meta.route, null);
  assert.equal(named('GET /api/config').meta.route, '/api/config');
});

test('the guard survives, which is the fact the dropped door was taking with it', () => {
  // `login_required` was always readable. It had no door to attach to.
  assert.deepEqual(
    named("GET org_scoped_rule('/api/session')").meta.guards.map((g) => g.name),
    ['login_required'],
  );
});

test('an unresolved address does not excuse a route from the auth count', () => {
  // Unlike #139's Django routes, the handler here *is* linked and its decorators are
  // readable — so "no check" is evidence, not a blind spot, and these stay counted.
  assert.equal(atlas.meta.stats.unlinkedRoutes ?? 0, 0);
  assert.equal(atlas.meta.stats.routes, 5);
  assert.equal(atlas.meta.stats.unprotectedRoutes, 4);
});

test('a keyword argument is not an address', () => {
  // `@app.route(methods=["GET"])` has no path at all, and must not become a door named
  // after its own keyword argument.
  assert.equal(routes.some((n) => /methods=/.test(n.name)), false);
});
