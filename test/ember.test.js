/**
 * @fileoverview An Ember application is not a React one, and not a library (#293).
 *
 * Ghost's admin has been an Ember application since 2015. App Atlas printed `React`
 * above it — because Ghost embeds a handful of `admin-x-framework` React panes inside
 * that admin, so `react` was in the dependency list, while `ember-source` and the 57
 * Ember packages beside it appeared in no table in this repository at all. The verdict
 * underneath was right by luck: the SPA branch wants a UI framework, and the guest
 * supplied one. discourse's front end, which has no such guest, read `frameworks: []`
 * and was filed as a library holding 2,233 of its own helpers as the way in.
 *
 * #269 is the precedent and the same sentence with the halves swapped — outline's Koa
 * server went unnamed and the map read `React · Vite`, describing the half of the
 * repository the line was not there for.
 *
 * The signal is `ember-source`, the framework runtime, which no Ember application can
 * be without. An addon lists it too, to build and test against, and that is the false
 * positive this file spends a fixture on: what keeps an addon a library is its `main`,
 * the thing an app that is only ever built and served does not have.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyzeProject } from '../dist/node/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const options = { followReferences: false, cache: 'off' };
const { atlas: app } = await analyzeProject(path.join(here, 'fixtures', 'emberapp'), options);
const { atlas: addon } = await analyzeProject(path.join(here, 'fixtures', 'emberaddon'), options);

test('the fixtures parsed, so a silent failure cannot pass as a pass', () => {
  assert.deepEqual(app.meta.warnings, []);
  assert.ok(app.nodes.some((n) => n.kind === 'type' && n.name === 'PostList'));
});

test('the framework line names Ember', () => {
  assert.deepEqual(app.meta.frameworks, ['Ember']);
});

test('an Ember app is an app with a front end, and says so on its own evidence', () => {
  assert.equal(app.meta.archetype.archetype, 'web-app');
  assert.equal(app.meta.archetype.label, 'An app with a front end');
  assert.ok(
    app.meta.archetype.because.includes('Ember'),
    `expected Ember in the reasoning, got ${JSON.stringify(app.meta.archetype.because)}`,
  );
});

test('no component becomes a door', () => {
  // The regression the label prevents. Filed as a library, every exported component of
  // an application becomes an entry in its public API — 2,233 of them on discourse.
  const exports = app.nodes.filter((n) => n.kind === 'endpoint' && n.meta.endpointKind === 'export');
  assert.deepEqual(exports.map((n) => n.name), []);
});

test('an Ember addon declares ember-source too, and is still a library', () => {
  // The guard. This fixture clears both of the other two conditions the SPA branch
  // asks for — the framework is named, `addon/components/` is interface code — so the
  // only thing standing between it and a wrong verdict is its `main`. Delete that field
  // from the fixture and this test is what notices.
  assert.deepEqual(addon.meta.frameworks, ['Ember']);
  assert.equal(addon.meta.archetype.archetype, 'library');
  assert.equal(addon.meta.archetype.label, 'Code other code imports');
});
