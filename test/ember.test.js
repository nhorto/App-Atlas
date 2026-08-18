/**
 * @fileoverview An Ember application is not a React one (#293).
 *
 * Ghost's admin has been an Ember application since 2015. App Atlas printed `React`
 * above it — because Ghost embeds a handful of `admin-x-framework` React panes inside
 * that admin, so `react` was in the dependency list, while `ember-source` and the 57
 * Ember packages beside it appeared in no table in this repository at all. discourse's
 * front end, which has no such guest, read `frameworks: []`.
 *
 * #269 is the precedent and the same sentence with the halves swapped — outline's Koa
 * server went unnamed and the map read `React · Vite`, describing the half of the
 * repository the line was not there for.
 *
 * The signal is `ember-source`, the framework runtime, which no Ember application can
 * be without.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyzeProject } from '../dist/node/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const options = { followReferences: false, cache: 'off' };
const { atlas: app } = await analyzeProject(path.join(here, 'fixtures', 'emberapp'), options);

test('the fixture parsed, so a silent failure cannot pass as a pass', () => {
  assert.deepEqual(app.meta.warnings, []);
  assert.ok(app.nodes.some((n) => n.kind === 'type' && n.name === 'PostList'));
});

test('the framework line names Ember', () => {
  assert.deepEqual(app.meta.frameworks, ['Ember']);
});
