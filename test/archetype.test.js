/**
 * @fileoverview What kind of project is this?
 *
 * The archetype decides which view opens first, so getting it wrong sends someone to a
 * screen with nothing on it. These tests run the real analyzer over the fixtures
 * rather than hand-building node lists, because the signal that matters most — the
 * doors the boundary detectors found — only exists after a real pass.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyzeProject, AtlasGraph, buildBoundaryView, buildInsights } from '../dist/node/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => path.join(here, 'fixtures', name);

const analyze = (name) => analyzeProject(fixture(name), { followReferences: false, cache: 'off' });

test('a project with routes and an interface is an app with a front end', async () => {
  const { atlas } = await analyze('sample');
  assert.equal(atlas.meta.archetype.archetype, 'web-app');
  assert.equal(atlas.meta.archetype.label, 'An app with a front end');
});

test('a file-routed native app counts as an app, on its screens alone', async () => {
  const { atlas } = await analyze('expo');
  assert.equal(atlas.meta.archetype.archetype, 'web-app');
  // No network doors at all in that fixture — the screens are the whole case.
  assert.ok(atlas.meta.archetype.because.some((why) => /screen/.test(why)));
});

test('exports and no doors of any kind make a library', async () => {
  const { atlas } = await analyze('lib');
  assert.equal(atlas.meta.archetype.archetype, 'library');
  assert.equal(atlas.meta.archetype.label, 'Code other code imports');
  assert.ok(atlas.meta.archetype.because.some((why) => /exported name/.test(why)));
});

test('a command-line entry point beats the exports beside it', async () => {
  const { atlas } = await analyze('pipeline');
  assert.equal(atlas.meta.archetype.archetype, 'pipeline');
  assert.equal(atlas.meta.archetype.label, 'Something you run');
  // The fixture exports a helper too. A thing you run is still a thing you run.
  assert.ok(atlas.meta.archetype.because.some((why) => /command-line|command/.test(why)));
});

test('every verdict shows the signals it was built from', async () => {
  for (const name of ['sample', 'lib', 'pipeline']) {
    const { atlas } = await analyze(name);
    const verdict = atlas.meta.archetype;
    assert.ok(verdict.because.length > 0, `${name} gave no reasons`);
    assert.ok(verdict.label.length > 0, `${name} gave no label`);
  }
});

test('the verdict survives being written out and read back', async () => {
  const { atlas } = await analyze('lib');
  const roundTripped = JSON.parse(JSON.stringify(atlas));
  assert.deepEqual(roundTripped.meta.archetype, atlas.meta.archetype);
});

// --- the boundary a library actually has (issue #16) ---

test("a library's exported names become doors in the atlas", async () => {
  const { atlas } = await analyze('lib');
  const doors = atlas.nodes.filter((n) => n.kind === 'endpoint' && n.meta.endpointKind === 'export');
  assert.deepEqual(
    doors.map((d) => d.name).sort(),
    ['Duration', 'clamp', 'format'],
  );
  // Each door opens onto the symbol it names, which is what puts the band in that
  // symbol's own zone rather than a generic API one.
  for (const door of doors) {
    const exposed = atlas.edges.filter((e) => e.kind === 'exposed-by' && e.fromId === door.id);
    assert.equal(exposed.length, 1, `${door.name} should open onto exactly one symbol`);
  }
});

test('an export door carries the docstring of the thing it opens onto', async () => {
  const { atlas } = await analyze('lib');
  const format = atlas.nodes.find((n) => n.kind === 'endpoint' && n.name === 'format');
  assert.equal(format.summary, 'Renders a duration the way a person would say it out loud.');
  assert.equal(format.summarySource, 'docs');
});

test('an export is never counted as a route that needs auth', async () => {
  const { atlas } = await analyze('lib');
  const insights = buildInsights(new AtlasGraph(atlas));
  assert.equal(insights.auth.total, 0, 'exports must not appear in auth coverage');
  assert.equal(atlas.meta.stats.unprotectedRoutes, 0);
  assert.equal(atlas.meta.stats.routes, 0);
});

test('an app does not get export doors, or every helper would be one', async () => {
  const { atlas } = await analyze('sample');
  const doors = atlas.nodes.filter((n) => n.kind === 'endpoint' && n.meta.endpointKind === 'export');
  assert.equal(doors.length, 0);
});

test('the boundary view names its columns for the kind of project', async () => {
  const lib = buildBoundaryView(new AtlasGraph((await analyze('lib')).atlas));
  assert.equal(lib.captions.inputs, 'What consumers can call');
  assert.equal(lib.captions.outputs, 'What it reaches for');
  assert.equal(lib.archetype, 'library');

  const pipeline = buildBoundaryView(new AtlasGraph((await analyze('pipeline')).atlas));
  assert.equal(pipeline.captions.inputs, 'What it reads');
  assert.equal(pipeline.captions.outputs, 'What it writes');

  const app = buildBoundaryView(new AtlasGraph((await analyze('sample')).atlas));
  assert.equal(app.captions.inputs, 'What gets in');
});

test("a library's public surface is split into calls and shapes", async () => {
  const view = buildBoundaryView(new AtlasGraph((await analyze('lib')).atlas));
  const families = view.inputs.map((card) => card.family);
  assert.ok(families.includes('exports'), 'expected a card for exported functions');
  assert.ok(families.includes('export-types'), 'expected a card for exported types');

  const calls = view.inputs.find((card) => card.family === 'exports');
  assert.equal(calls.name, 'Functions you can call');
  assert.equal(calls.detail, '2 functions');
  // Nothing guards an import, and saying "0 open" about one would be a false alarm.
  assert.equal(calls.openCount, undefined);
});
