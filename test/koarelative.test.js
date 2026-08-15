/**
 * @fileoverview Koa's router takes a path without a leading slash (#269).
 *
 * `routeCall` refused any first-argument string that did not start with `/`, and that
 * check is load-bearing: Express reads `app.get('trust proxy')` as a settings *getter*,
 * and sails has exactly that line. Counting before relaxing it — the rule this backlog
 * keeps re-learning — Ghost alone has 5,786 slashless calls on a router-shaped method,
 * nearly all of them `config.get('url')` and `Map.get`. So the check stays everywhere it
 * is not disproved.
 *
 * Koa is where it is disproved. Its router accepts a relative path and its users write
 * them: outline declares 192 of its 226 routes as `router.post('documents.list', …)`, and
 * reported **29 ways in out of 226** with its whole RPC-style API invisible.
 *
 * ## The two things this pins down
 *
 * **The relaxation is bound to the router, not to the repository.** `looksLikeRouter`
 * accepts a bare `app`, `api`, `server` or `r` on the name alone, so a rule asking "is
 * this project Koa?" would hand every one of them the relaxed path rule. `client.ts` is
 * that case, and it is not hypothetical — built against the looser gate it books an HTTP
 * client and a *Redis* `get` as three ways into the application.
 *
 * **A relative path is a fragment, so it is written as one.** The head is two hops away
 * and one of them is `koa-mount`. Printing `documents.list` gives an address nobody can
 * call; printing `/documents.list` invents the half that is missing, which is #199. So
 * `unreadHead` — the tail after an ellipsis, `route: null` — which is the answer this
 * codebase already settled on twice.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyzeProject } from '../dist/node/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const { atlas } = await analyzeProject(path.join(here, 'fixtures', 'koarelative'), {
  followReferences: true,
  cache: 'off',
});

const doors = atlas.nodes.filter((n) => n.kind === 'endpoint' && n.meta.endpointKind === 'http-route');
const byName = new Map(doors.map((n) => [n.name, n]));

test('the fixture parsed, so a silent failure cannot pass as a pass', () => {
  assert.deepEqual(atlas.meta.warnings, []);
  assert.deepEqual(
    [...byName.keys()].sort(),
    [
      'GET /documents/health',
      'GET /users/:id',
      'GET …documents.public',
      'POST …documents.info',
      'POST …documents.list',
    ],
  );
});

test('a Koa route declared without a leading slash is a way in', () => {
  // The defect: `router.post('documents.list', …)` produced nothing at all, and outline's
  // API — 192 of its 226 routes — was missing from the map.
  assert.ok(byName.has('POST …documents.list'));
  assert.ok(byName.has('POST …documents.info'));
});

test('its address is left unread rather than guessed', () => {
  // `/api` comes from `mount('/api', …)` and the separator from `use('/', …)`, neither of
  // which this pass reads. `route: null` is what the machinery downstream reads, and it
  // says "unknown" because that is true.
  assert.equal(byName.get('POST …documents.list').meta.route, null);
  assert.equal(byName.get('GET …documents.public').meta.route, null);
});

test('an absolute path in the same file keeps its address', () => {
  // The relaxation is per-call, not per-file: a route that *did* write a readable address
  // must not be swept into the unread spelling beside its neighbours.
  assert.equal(byName.get('GET /documents/health').meta.route, '/documents/health');
});

test("koa-router's named-route form records the path, not the name", () => {
  // `api.get('user.profile', '/users/:id', …)` — the name comes first, and reading
  // argument 0 would have recorded `user.profile` as the address of a door that answers
  // at `/users/:id`.
  assert.equal(byName.get('GET /users/:id').meta.route, '/users/:id');
  assert.ok(!byName.has('GET …user.profile'));
});

test('a public Koa route beside checked ones is still reported open', () => {
  // outline's `shares.sitemap` and `notifications.unsubscribe` are real unauthenticated
  // doors in files whose other routes are all checked. Reading the routes is only worth
  // doing if this one stays visible.
  assert.deepEqual(byName.get('GET …documents.public').meta.guards ?? [], []);
});

test('a slashless call on something that is not a Koa router is not a door', () => {
  // `api.get('users')` on an HTTP client and `r.get('events:count')` on Redis. Both
  // holders pass `looksLikeRouter` on their name alone, and against a gate keyed on the
  // repository's framework rather than the holder's binding, all three become ways in.
  for (const door of doors) {
    assert.notEqual(door.meta.sites?.[0]?.path, 'server/client.ts', `false door: ${door.name}`);
  }
});

test('the server framework is named', () => {
  // outline reported `React · Vite` — `koa` was simply absent from the framework table,
  // so the half of the repository the line existed to describe went unnamed.
  assert.ok(atlas.meta.frameworks.includes('Koa'), JSON.stringify(atlas.meta.frameworks));
});
