/**
 * @fileoverview Expo Router screens as "ways in" (SPEC.md 5.3).
 *
 * A file-routed native app has doors too — but they are doors into a *client*, not
 * doors a stranger reaches over the network. The point of these tests is the negative
 * one: a screen shows up as a way in, and it is NEVER counted among the routes whose
 * auth we grade. Twenty-four "no auth check" screens would bury the one edge function
 * that actually faces the internet, and that is the failure this whole design avoids.
 */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import { analyzeProject, AtlasGraph, buildBoundaryView, buildInsights } from '../dist/node/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, 'fixtures', 'expo');

const { atlas } = await analyzeProject(FIXTURE, { followReferences: true, cache: 'off' });
const graph = new AtlasGraph(atlas);
const boundaries = buildBoundaryView(graph);
const insights = buildInsights(graph);

const endpoints = atlas.nodes.filter((n) => n.kind === 'endpoint');
const screens = endpoints.filter((n) => n.meta.endpointKind === 'screen');

test('reads Expo Router screens off the file system', () => {
  const routes = screens.map((n) => n.meta.route).sort();
  assert.deepEqual(routes, ['/', '/cellar/:id', '/home', '/login']);
});

test('skips layouts and framework hooks', () => {
  // `_layout` wraps screens without being one; `+not-found` is a hook, not a route.
  const routes = screens.map((n) => n.meta.route);
  assert.ok(!routes.includes('/_layout'), 'a layout is not a screen');
  assert.ok(!routes.includes('/+not-found'), 'a +hook is not a screen');
  assert.equal(screens.length, 4, 'exactly the four navigable screens, nothing else');
});

test('a dynamic segment becomes a parameter, and a group shapes nav but not the URL', () => {
  const detail = screens.find((n) => n.meta.route === '/cellar/:id');
  assert.ok(detail, '[id] resolves to :id');
  assert.equal(detail.meta.method, 'SCREEN');
  assert.equal(detail.meta.framework, 'Expo Router');
  // `(tabs)/home.js` → `/home`: the parenthesised group never reaches the URL.
  assert.ok(screens.some((n) => n.meta.route === '/home'));
});

test('names Expo Router as a framework in play', () => {
  assert.ok(atlas.meta.frameworks.includes('Expo Router'));
});

test('the boundary view groups screens into their own way-in card', () => {
  const card = boundaries.inputs.find((c) => c.family === 'screens');
  assert.ok(card, 'screens are a family of their own, not lumped with API routes');
  assert.equal(card.count, 4);
  // A screen is not an auth-graded door, so the card must not carry an "open" count.
  assert.equal(card.openCount, undefined);
});

test('screens are NEVER graded for auth — this is the anti-cry-wolf guarantee', () => {
  // The insights auth list is the "who can get in over the network" list. Not one
  // screen may appear in it, or every mobile app would read as riddled with holes.
  for (const r of insights.auth.routes) {
    assert.notEqual(r.endpointKind, 'screen');
  }
  const screenRoutes = new Set(screens.map((n) => n.meta.route));
  for (const r of insights.auth.routes) {
    assert.ok(!screenRoutes.has(r.route), `${r.route} is a screen and must not be auth-graded`);
  }
  // And they must not inflate the headline counts either.
  assert.equal(atlas.meta.stats.unprotectedRoutes, 0, 'no network doors here, so none are open');
});
