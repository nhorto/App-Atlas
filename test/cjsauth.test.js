/**
 * @fileoverview The CommonJS half of JavaScript, which the import graph could not see (#204).
 *
 * Dogfooding `TryGhost/Ghost` returned 437 import edges across 2,459 files, and every
 * conclusion App Atlas draws about a repo that depends on one file reaching another was
 * being drawn on a fraction of them. The visible symptom was the auth column — 263 of
 * 263 routes reported with no check — but that was the smallest part of it.
 *
 * The fixture is Ghost's own wiring, cut down to the line that causes it:
 *
 *   backendApp.use('/ghost', require('…/auth/session').createSessionFromToken(), require('../admin')());
 *
 * Three things in one line. This file covers the first — the edges — and pins the two
 * that are still open so the next change has something that fails when it starts working.
 */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import { analyzeProject, AtlasGraph } from '../dist/node/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, 'fixtures', 'cjsauth');

const { atlas } = await analyzeProject(FIXTURE, { followReferences: true, cache: 'off' });
const graph = new AtlasGraph(atlas);

const importsFrom = (relPath) =>
  graph
    .allEdges()
    .filter((edge) => edge.kind === 'imports' && edge.fromId === `file:${relPath}`)
    .map((edge) => edge.toId.replace(/^file:/, ''));

test('a relative require is an import edge, the same as a static import', () => {
  const from = 'core/server/web/parent/backend.js';
  assert.deepEqual(importsFrom(from).sort(), [
    'core/server/services/auth/session.js',
    'core/server/web/admin/index.js',
  ]);
});

test('what the require took out of the module is what the edge carries', () => {
  // `require('…/session').createSessionFromToken` names one thing; `require('../admin')()`
  // names none, and an empty list is the honest answer for a module taken whole.
  const edges = graph
    .allEdges()
    .filter((edge) => edge.kind === 'imports' && edge.fromId === 'file:core/server/web/parent/backend.js');
  const session = edges.find((edge) => edge.toId.endsWith('session.js'));
  const admin = edges.find((edge) => edge.toId.endsWith('admin/index.js'));

  assert.deepEqual(session.meta.symbols, ['createSessionFromToken']);
  assert.deepEqual(admin.meta.symbols, []);
});

test('an external require is a package, not a missing file', () => {
  // `require('express')` must not end up in the unresolved list, where it would read as
  // a link between two of this project's files that went missing.
  const backend = graph.getNodeById('file:core/server/web/parent/backend.js');
  assert.ok(backend, 'the file is on the map');
  assert.ok(
    !importsFrom('core/server/web/parent/backend.js').some((to) => to.includes('express')),
    'a package is not a file in this repo',
  );
});

test('the routes carry the prefix they are mounted under', () => {
  // Two things had to be true at once for this line to be readable, and neither was:
  // the router arrives as `require('../admin')()`, and it is built inside a factory
  // function where nothing was looking for it.
  const routes = graph
    .nodesOfKind('endpoint')
    .filter((node) => node.meta.endpointKind === 'http-route')
    .filter((node) => String(node.path).includes('/admin/'))
    .map((node) => `${node.meta.method} ${node.meta.route}`)
    .sort();
  assert.deepEqual(routes, ['DELETE /ghost/users/:id', 'GET /ghost/users', 'POST /ghost/users']);
});

test('a router built inside a factory function is still a router', () => {
  // `sf.getVariableDeclarations()` stops at the file scope, so `const router =
  // express.Router()` inside `module.exports = function () {…}` registered nothing —
  // and a mount can only attach to a router something registered. This is the dominant
  // CommonJS shape, and it was invisible.
  const admin = graph
    .nodesOfKind('endpoint')
    .filter((node) => node.meta.endpointKind === 'http-route')
    .filter((node) => String(node.path).includes('/admin/'));
  assert.equal(admin.length, 3);
  assert.ok(
    admin.every((node) => node.meta.route.startsWith('/ghost/')),
    'every one of them found its prefix, not just the first',
  );
});

test('middleware named after what it guards is read as a check', () => {
  // `router.get('/users', mw.authAdminApi, …)`. Ghost declares 218 of its 261 admin
  // routes exactly this way, and an exact-match list of guard names saw none of them —
  // which is most of what "263 of 263 unprotected" was measuring.
  const users = graph
    .nodesOfKind('endpoint')
    .find((node) => node.meta.route === '/ghost/users' && node.meta.method === 'GET');
  assert.deepEqual(
    users.meta.guards.map((guard) => [guard.name, guard.confidence]),
    [['mw.authAdminApi', 'likely']],
  );
});

test('a name that merely starts with the letters of a check is not one', () => {
  // `mw.authorList` on a blogging platform is a list of authors. The rule anchors on a
  // word boundary — `auth` followed by a capital — so `authAdminApi` matches and
  // `author…` cannot, and Ghost is full of `authorExists`, `authorImage`,
  // `authorFacebook`. Reading one of those as a lock is the failure worth designing
  // against: a route reported as protected when nothing protects it.
  const post = graph
    .nodesOfKind('endpoint')
    .find((node) => node.meta.route === '/ghost/users' && node.meta.method === 'POST');
  assert.deepEqual(post.meta.guards, []);
});

test('a check found by its name alone never claims certainty', () => {
  // An exact name out of the known list is `certain`; a name that only *begins* like one
  // is good evidence and not the same thing. Everything this rule finds says so.
  const named = graph
    .nodesOfKind('endpoint')
    .flatMap((node) => node.meta.guards ?? [])
    .filter((guard) => guard.name.includes('authAdminApi'));
  assert.ok(named.length > 0);
  assert.ok(named.every((guard) => guard.confidence !== 'certain'));
});

// ---------------------------------------------------------------------------
// Still open — the rest of #204
// ---------------------------------------------------------------------------

test('a mount through the app’s own wrapper method is followed', () => {
  // `frontendApp.lazyUse(BASE_API_PATH, require('../members')())` — two things at once,
  // and Ghost's seven `lazyUse` calls carry every API mount in that repo.
  //
  // `lazyUse` is not on any whitelist and must never be: it is a mount here because
  // `core/shared/express.js` assigns it onto the router and its body forwards its own
  // first parameter to `app.use`. In a repo that never wrote that line the same call is
  // nothing at all, and mounting it would hand a route an address nobody serves it at.
  const session = graph.nodesOfKind('endpoint').find((node) => String(node.meta.route).endsWith('/session'));
  assert.ok(session, 'the route itself is found');
  assert.equal(session.meta.route, '/ghost/api/session');
});

test('the prefix is read from the constant the mount names', () => {
  // `BASE_API_PATH` is declared in `core/shared/url-utils.js`, three directories from
  // the mount that uses it. Resolved through the repo-wide constant index, which already
  // refuses when two files disagree about a name's value.
  const session = graph.nodesOfKind('endpoint').find((node) => String(node.meta.route).endsWith('/session'));
  assert.ok(session.meta.route.startsWith('/ghost/api'), `read the constant, got ${session.meta.route}`);
});

test('a check reached only through a require-expression is left unclaimed, on purpose', () => {
  // `app.use('/ghost', require('…/auth/session').createSessionFromToken(), router)`.
  //
  // Not an oversight — a decision. `createSessionFromToken` begins like no check this
  // tool knows, `dottedName` gives `require.createSessionFromToken` whose root resolves
  // to nothing, and it is a middleware *factory* besides, so the guard is whatever the
  // call returns, in a package. The only evidence left is that the module path contains
  // `auth`, and a path is not a name: the same rule would read `services/auth/logger` or
  // `services/auth/errors` as a lock on whatever they sit in front of.
  //
  // So these routes report no check, which is true — App Atlas cannot see one — and
  // under-claiming is the direction this feature is allowed to be wrong in. Anything
  // that changes this has to bring evidence better than a folder name.
  const admin = graph
    .nodesOfKind('endpoint')
    .filter((node) => node.meta.endpointKind === 'http-route')
    .filter((node) => node.meta.method === 'DELETE');
  assert.equal(admin.length, 1);
  assert.deepEqual(admin[0].meta.guards, []);
});
