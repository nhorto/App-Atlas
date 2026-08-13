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
 * And the verdict about who guards them must be earned. Django names a view in one file
 * and defines it in another, so the check on `widget_detail` is invisible from
 * `urls.py`. Counting these as doors nobody protects reported the tool's own stopping
 * point as the application's — on netbox, "84 of 84 have no auth check" about an app
 * whose views sit behind a permission mixin — so for two releases every Django door was
 * set aside instead: on the map, out of the count, with a sentence saying which.
 *
 * Item 44 follows the link, and the fixture now holds both outcomes. Three views live
 * in this repo and are read: one locked, two open, all three counted. The fourth comes
 * from a package, has no file to open, and keeps the old honest silence — because the
 * rule was never "stay quiet about Django", it was "claim only what was actually read".
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
    ['/legacy/widgets/', '/signin/', '/widgets/', '/widgets/<int:pk>/'],
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

test('the guard on the view reaches the door the URLconf declares', () => {
  // The link `urls.py` → `views.py` that nothing followed until item 44. `login_required`
  // is written on `widget_detail` and named nowhere near the address it protects.
  const detail = named('/widgets/<int:pk>/');
  assert.equal(detail.meta.handlerUnlinked, undefined, 'the handler was found');
  assert.deepEqual(
    detail.meta.guards.map((g) => g.name),
    ['login_required'],
  );
});

test('a view with no check is reported as having none, not as unknown', () => {
  // The other half, and the reason following the link is worth doing: once the handler
  // is in hand, an open door is a fact rather than a gap.
  for (const name of ['/widgets/', '/legacy/widgets/']) {
    const route = named(name);
    assert.equal(route.meta.handlerUnlinked, undefined, `${name} should be linked`);
    assert.deepEqual(route.meta.guards, [], `${name} has no check`);
  }
});

test('a view this repo does not contain is still set aside, never counted', () => {
  // `auth_views.login_view` comes from a package. There is no file to open, so the
  // honest silence the rest of this fixture used to demonstrate still applies here —
  // and it must stay out of both totals rather than land in the unprotected one.
  const external = named('/signin/');
  assert.equal(external.meta.handlerUnlinked, true);
  assert.deepEqual(external.meta.guards, []);
  assert.equal(atlas.meta.stats.unlinkedRoutes, 1);
  assert.equal(atlas.meta.stats.unprotectedRoutes, 2);
});

test('the doors are still on the map — set aside, never hidden', () => {
  // #29 is the bug where a repo was told nothing answers a URL. The count coming out
  // of the auth verdict must not take the door off the map with it.
  assert.equal(atlas.meta.stats.routes, 4);
});

test('the headline counts what was judged and states what was not', () => {
  const line = authHeadline(atlas.meta.stats);
  // Two of the three readable doors are open, and the fourth is not in the denominator.
  assert.match(line.headline, /2 of 3 routes have no auth check/);
  assert.ok(
    line.caveats.some((c) => /1 more is declared in a routing table/.test(c)),
    'the set-aside route must be stated, not silently dropped',
  );
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
