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

test('NOT YET: a check written as a require-expression is not seen as a check', () => {
  // `require('…/auth/session').createSessionFromToken()` is a middleware factory: the
  // guard is what the call returns, one step deeper than the argument, and the name it
  // is reached by roots at `require` rather than at anything resolvable. Every route
  // here is genuinely behind that check and every one of them reports nothing — which
  // is the under-claiming direction, and still useless.
  const guards = graph
    .nodesOfKind('endpoint')
    .filter((node) => node.meta.endpointKind === 'http-route')
    .flatMap((node) => node.meta.guards ?? []);
  assert.deepEqual(guards, [], 'still nothing; #204 is not closed by the edges alone');
});
