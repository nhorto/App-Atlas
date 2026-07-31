/**
 * @fileoverview SvelteKit and Remix, the two frameworks a weekend app is most likely to
 * be built with after Next.js (SPEC.md 5.3, issue #44).
 *
 * Both put the address in the file system and the handlers in the exports, so finding
 * the doors is mostly arithmetic on a path. The assertions that carry weight are the
 * other ones: a `hooks.server.ts` that tests `/admin` locks `/admin` and nothing else,
 * a layout that redirects is not a claim about the pages under it, a redirect in a
 * universal load is routing rather than a lock, and a file sitting in a routes folder
 * is not a door because of where it sits. Every one of those is a place where being
 * generous would print "protected" over something that is not.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyzeProject } from '../dist/node/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));

const kit = (await analyzeProject(path.join(here, 'fixtures', 'sveltekit'), { followReferences: true, cache: 'off' }))
  .atlas;
const remix = (await analyzeProject(path.join(here, 'fixtures', 'remix'), { followReferences: true, cache: 'off' }))
  .atlas;

/** Every door that answers a URL, named the way the screen names it. */
const doors = (atlas) =>
  atlas.nodes
    .filter((n) => n.meta.endpointKind === 'http-route')
    .map((n) => (n.meta.method === 'PAGE' ? `PAGE ${n.meta.route}` : n.name))
    .sort();

const door = (atlas, name) => atlas.nodes.find((n) => n.kind === 'endpoint' && n.name === name);
const guards = (node) => (node.meta.guards ?? []).map((g) => g.name).sort();

// ---------------------------------------------------------------------------
// SvelteKit — the folder is the address
// ---------------------------------------------------------------------------

test('reads SvelteKit doors off the file system, route groups and all', () => {
  assert.deepEqual(doors(kit), [
    // `hooks.server.ts` guards this one and nothing declares it but the folder.
    'DELETE /admin/purge',
    'GET /api/bottles',
    'PAGE /',
    'PAGE /account',
    'PAGE /cellar',
    // `(app)` shapes the folder tree and appears in no address; `[id]` is a parameter.
    'PAGE /cellar/:id',
    'POST /api/bottles',
    'POST /cellar',
    'POST /cellar?/delete',
  ]);
  assert.deepEqual(kit.meta.warnings, [], 'a clean fixture should produce no warnings');
});

test('a layout wraps pages without being one', () => {
  const sites = kit.nodes.filter((n) => n.kind === 'endpoint').flatMap((n) => n.meta.sites.map((s) => s.path));
  assert.ok(
    !sites.some((p) => p.includes('+layout')),
    'no door may be declared by a file that only wraps other files',
  );
});

test('a form action is a door at an address nothing else in the app mentions', () => {
  const named = door(kit, 'POST /cellar?/delete');
  assert.ok(named, 'a named action answers at /cellar?/delete and looks nothing like an endpoint');
  assert.equal(named.meta.framework, 'SvelteKit');
  assert.equal(named.meta.writes, true, 'an action exists to change something');
  // The part after `?` is a query string, so the *path* is what checks match against.
  assert.equal(named.meta.route, '/cellar');
  assert.ok(door(kit, 'POST /cellar'), 'and the default action is its own door beside it');
});

test('a check written in the handler is certain; the same check a file away is not', () => {
  const write = door(kit, 'POST /api/bottles');
  assert.deepEqual(guards(write), ["error(401, 'Not signed in')"]);
  assert.equal(write.meta.guards[0].confidence, 'certain', 'the refusal is in the handler itself');

  const detail = door(kit, '/cellar/:id');
  assert.deepEqual(guards(detail), ["getSessionUser → error(401, 'Not signed in')"]);
  const hop = detail.meta.guards[0];
  // Never `certain`: the reference graph proves the load mentions the helper, not that
  // every path through it runs the check.
  assert.equal(hop.confidence, 'likely');
  assert.equal(hop.path, 'src/lib/server/session.ts', 'the evidence points at the real refusal');
});

test('a helper is a check because it refuses somebody, not because of its name', () => {
  // `getSessionUser` reads as a lookup and matches no list of well-known guard names.
  // The only evidence it locks anything is the 401 in its body, which is the same rule
  // the Python and NestJS detectors already use.
  const detail = door(kit, '/cellar/:id');
  assert.ok(guards(detail).some((name) => name.startsWith('getSessionUser →')));
});

test('the handle hook reaches only as far as the path it actually tests', () => {
  // The hook refuses nobody except under `/admin`. Letting it cover the whole site
  // would badge every open door in the app as protected on the strength of one `if`.
  const admin = door(kit, 'DELETE /admin/purge');
  assert.deepEqual(guards(admin), ["error(401, 'Sign in first')"]);
  assert.equal(admin.meta.guards[0].confidence, 'likely', 'written a long way from the door');
  assert.equal(admin.meta.guards[0].path, 'src/hooks.server.ts');

  for (const name of ['GET /api/bottles', '/', '/cellar']) {
    assert.deepEqual(guards(door(kit, name)), [], `${name} is outside /admin and must stay open`);
  }
});

test('a layout that redirects is not a claim about the pages under it', () => {
  // `(app)/+layout.server.ts` redirects visitors without a session, and SvelteKit really
  // does run it before every page in the group. It is still not reported, for two
  // reasons a route address cannot express: the group's name is in no URL, so the only
  // pattern available covers the whole site — and a layout load does not run for a
  // `+server.ts` endpoint at all. Claiming it would lock `/api/bottles` from a file that
  // has never been near it.
  assert.deepEqual(guards(door(kit, '/cellar')), []);
  assert.equal(door(kit, '/cellar').meta.open.kind, 'page');
  assert.deepEqual(guards(door(kit, 'GET /api/bottles')), []);
});

test('a redirect in a universal load is routing, not a lock', () => {
  // `+page.ts` runs in the visitor's browser as well as on the server, so a redirect
  // written there is bypassable. A green badge on exactly that mistake is the worst
  // thing this tool could print.
  assert.deepEqual(guards(door(kit, '/account')), []);
});

test('a form post is not excused the way a page is', () => {
  // The "it is only a page" rule keeps marketing pages out of the headline count. An
  // action posts data, so it stays in it.
  assert.equal(door(kit, 'POST /cellar').meta.open.kind, 'worth-a-look');
  assert.equal(door(kit, '/').meta.open.kind, 'page');
  assert.equal(kit.meta.stats.unprotectedRoutes, 3, 'the two actions and the open GET');
});

test('names SvelteKit as a framework in play', () => {
  assert.ok(kit.meta.frameworks.includes('SvelteKit'));
});

// ---------------------------------------------------------------------------
// Remix / React Router 7 — the filename is the address
// ---------------------------------------------------------------------------

test('reads the address out of a Remix filename, dots and all', () => {
  assert.deepEqual(doors(remix), [
    // `api.reports/route.tsx`: in a folder, the folder is the address.
    'GET /api/reports',
    // `api.users.ts` has a loader and no component — an API endpoint in all but name.
    'GET /api/users',
    // `_index.tsx` answers at the address of the folder above it.
    'PAGE /',
    // `_auth.login.tsx`: the pathless layout segment is in no URL.
    'PAGE /login',
    // `notes.$noteId.tsx`: a dot is a slash and `$noteId` is a parameter.
    'PAGE /notes/:noteId',
    // `notes_.new.tsx`: the trailing underscore changes the nesting, not the address.
    'PAGE /notes/new',
    'POST /login',
    'POST /notes/:noteId',
    'POST /notes/new',
  ]);
  assert.deepEqual(remix.meta.warnings, []);
});

test('a pathless layout is not a door', () => {
  // `_auth.tsx` exports a component and answers at no address at all.
  assert.ok(!doors(remix).some((name) => name.includes('_auth')));
});

test('only route.tsx answers in a route folder', () => {
  // A route folder exists precisely so a route can keep code beside it. Turning
  // `api.reports/queries.server.ts` into `/api/reports/queries/server` would put a URL
  // on the map that answers nothing.
  assert.ok(!doors(remix).some((name) => name.includes('queries')));
});

test('a file in routes that exports no handler is not a door', () => {
  // `notes.server.ts` sits in `routes/` and exports one helper. The evidence for a door
  // is the exported handler, never the filename.
  assert.ok(!doors(remix).some((name) => name.includes('/notes/server')));
});

test('the check at the top of a loader is found through the helper that performs it', () => {
  // `requireUserId` is the Remix idiom, and the route file contains no check of its own.
  // Reporting these two as open would be the most expensive thing this tool could say
  // about the best-guarded route in the app.
  for (const name of ['/notes/:noteId', 'POST /notes/:noteId']) {
    const node = door(remix, name);
    assert.deepEqual(guards(node), ["requireUserId → redirect('/login?redirectTo=/notes')"]);
    assert.equal(node.meta.guards[0].confidence, 'likely');
    assert.equal(node.meta.guards[0].path, 'app/session.server.ts');
  }
});

test('an ordinary redirect is not a lock, and a bad request is not a refusal', () => {
  // `redirect('/notes/…')` after a write, and `json({ error }, { status: 400 })` on the
  // sign-in form. Reading either as a check would put a lock on the one page that has to
  // stay open and on a write that has nothing in front of it.
  assert.deepEqual(guards(door(remix, 'POST /notes/new')), []);
  assert.equal(door(remix, 'POST /notes/new').meta.writes, true);
  assert.deepEqual(guards(door(remix, 'POST /login')), []);
});

test('names the framework the project actually installed', () => {
  assert.ok(remix.meta.frameworks.includes('Remix'));
  assert.equal(door(remix, 'GET /api/users').meta.framework, 'Remix');
});
