/**
 * @fileoverview Django's routes, and the honest silence about who guards them (#139).
 *
 * Two claims, and the second matters as much as the first.
 *
 * The routes must be found at all. They were not: the `urls.py` reader lived at the
 * bottom of `detectRoutes`, below the early return that picks between FastAPI, Flask,
 * Quart and Sanic. A Django routing table imports none of those, so the function
 * returned before reaching it and the branch was dead code for two releases —
 * netbox-community/netbox came out as twelve ways in, not one of them HTTP. Every
 * Python fixture in this suite imported FastAPI, which is exactly why the suite stayed
 * green. This one imports Django and nothing else.
 *
 * And the routes must not be reported as unguarded. Django names a view in one file
 * and defines it in another, and this reader does not yet follow that link — so the
 * check on `widget_detail` is invisible from `urls.py`. Counting these as doors nobody
 * protects reported the tool's own stopping point as the application's, and on netbox
 * it said "84 of 84 have no auth check" about an app whose views sit behind a
 * permission mixin. Set aside, never hidden: the door stays on the map, out of the
 * count, and the sentence says which.
 */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import { analyzeProject } from '../dist/node/index.js';
import { authHeadline } from '../dist/node/model/exposure.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const { atlas } = await analyzeProject(path.join(here, 'fixtures', 'pydjango'), {
  followReferences: true,
  cache: 'off',
});

const routes = atlas.nodes.filter((n) => n.kind === 'endpoint' && n.meta.endpointKind === 'http-route');
const named = (name) => routes.find((n) => n.name === name);

test('the fixture parsed, so a silent failure cannot pass as a pass', () => {
  assert.deepEqual(atlas.meta.warnings, []);
});

test('a Django routing table is read without any other framework present', () => {
  // The regression itself. Before the fix this array was empty, and adding a single
  // `import flask` line to the fixture would have filled it — which is how the gate
  // rather than the reader was identified as the cause.
  assert.deepEqual(
    routes.map((n) => n.name).sort(),
    ['/legacy/widgets/', '/widgets/', '/widgets/<int:pk>/'],
  );
});

test('the framework is named as Django, not as whatever gate let it through', () => {
  assert.equal(named('/widgets/').meta.framework, 'Django');
});

test('re_path is a route, and its anchors are not part of the address', () => {
  // `^` and `$` are regex punctuation. Printed as-is they make a URL nobody can visit.
  assert.ok(named('/legacy/widgets/'), 're_path should be read with its anchors stripped');
});

test('include() is a prefix, not a door', () => {
  // `path('api/', include(...))` mounts another URLconf. netbox writes 290 of its 377
  // `path()` calls that way, so counting them trades an undercount for an overcount.
  assert.equal(routes.some((n) => n.name === '/api/'), false);
});

test('no method is invented, because the view decides it', () => {
  assert.equal(named('/widgets/').meta.method, null);
});

test('a route whose handler was never followed is not called unprotected', () => {
  // `widget_list` genuinely has no check and `widget_detail` genuinely has one. This
  // reader can tell neither from `urls.py`, so it must claim neither.
  for (const route of routes) {
    assert.equal(route.meta.handlerUnlinked, true, `${route.name} should be set aside`);
    assert.deepEqual(route.meta.guards, [], `${route.name} should claim no guard it cannot see`);
  }
  assert.equal(atlas.meta.stats.unprotectedRoutes, 0);
  assert.equal(atlas.meta.stats.unlinkedRoutes, 3);
});

test('the doors are still on the map — set aside, never hidden', () => {
  // #29 is the bug where a repo was told nothing answers a URL. The count coming out
  // of the auth verdict must not take the door off the map with it.
  assert.equal(atlas.meta.stats.routes, 3);
});

test('the headline says no verdict was reached rather than giving a green one', () => {
  const line = authHeadline(atlas.meta.stats);
  assert.equal(line.tone, 'warn');
  assert.match(line.headline, /not followed to its handler/);
  // The two sentences this must never produce: every route counted as open, or every
  // route counted as checked. Both were real outputs of the naive fix on netbox.
  assert.doesNotMatch(line.headline, /no auth check App Atlas can see/);
  assert.doesNotMatch(line.headline, /every one of the/);
});

test('a mix of assessed and unassessed routes keeps them in separate numbers', () => {
  // The denominator is what was actually judged. An unassessed door is neither
  // evidence of safety nor evidence of danger, so it belongs in neither total.
  const line = authHeadline({
    ...atlas.meta.stats,
    routes: 10,
    unprotectedRoutes: 2,
    unlinkedRoutes: 4,
  });
  assert.match(line.headline, /2 of 6 routes have no auth check/);
  assert.ok(
    line.caveats.some((c) => /4 more are declared in a routing table/.test(c)),
    'the set-aside routes must be stated, not silently dropped',
  );
});
