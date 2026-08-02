/**
 * @fileoverview Code that says it is retired is not drawn as live architecture (#87).
 *
 * The repo this came from has been through two rewrites and kept the old lanes on disk.
 * App Atlas read `DEPRECATED 2026-04-30 … do not run as part of the pipeline` out of a
 * docstring, printed it verbatim, and went on counting the file among the app's 238 —
 * and the generated overview offered a folder called `parked` as one of the app's two
 * headline data flows.
 *
 * The shape of the fix is *marked, never dropped*. Deleting these files would be its own
 * confident falsehood: the archived script says in the same breath that it is kept as a
 * backstop, and somebody still runs it by hand. So the assertions below come in pairs —
 * the file is out of the prose and out of what to read first, and it is still in the map
 * and still counted.
 *
 * The single most important test here is the negative one. `pipeline.mjs` says it
 * "replaced the deprecated purchasing exporter", and a rule that reads that as a
 * self-declaration would retire the very code that superseded the dead lane.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyzeProject, AtlasGraph, buildGroups, collectAppFacts, renderAtlasMarkdown } from '../dist/node/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const result = await analyzeProject(path.join(here, 'fixtures', 'retired'), {
  cache: 'off',
  followReferences: true,
});
const graph = new AtlasGraph(result.atlas);
const files = result.atlas.nodes.filter((node) => node.kind === 'file');
const retired = files.filter((node) => node.meta.retired).map((node) => node.path).sort();

// ---------------------------------------------------------------------------
// What counts as saying so
// ---------------------------------------------------------------------------

test('the folder can say it, and the file can say it', () => {
  assert.deepEqual(retired, [
    'parked/station-estimates/screen.mjs',
    'src/_archive/purchasing.mjs',
    'src/legacy-report.mjs',
    'src/superseded.mjs',
  ]);
});

test('the evidence travels with the verdict', () => {
  const by = (p) => files.find((node) => node.path === p).meta.retired;
  assert.equal(by('src/_archive/purchasing.mjs').evidence, 'path');
  assert.equal(by('src/_archive/purchasing.mjs').says, '_archive');
  assert.equal(by('parked/station-estimates/screen.mjs').says, 'parked');

  // The file's own words, so a reader can check the call rather than take it.
  assert.equal(by('src/superseded.mjs').evidence, 'docstring');
  assert.match(by('src/superseded.mjs').says, /^SUPERSEDED by pipeline\.mjs/);
  assert.equal(by('src/legacy-report.mjs').says, '@deprecated');
});

test('a docstring that mentions deprecation is not a docstring that declares it', () => {
  // `pipeline.mjs` says it "replaced the deprecated purchasing exporter". Reading that
  // as a self-declaration would retire the live lane and leave the dead one standing,
  // which is the exact inversion of what this issue is about.
  const pipeline = files.find((node) => node.path === 'src/pipeline.mjs');
  assert.equal(pipeline.meta.retired, undefined, `${pipeline.summary}`);
});

// ---------------------------------------------------------------------------
// Marked, not dropped
// ---------------------------------------------------------------------------

test('a retired file is still in the map and still counted', () => {
  // The archived script says it is kept as a backstop. Dropping it would hide something
  // somebody still runs, and the reader would have no way to find out it exists.
  assert.equal(files.length, 8);
  assert.equal(result.atlas.meta.stats.files, 8);
  assert.ok(files.some((node) => node.path === 'src/_archive/purchasing.mjs'));
});

test('the count is stated, so leaving them out of the prose is never silent', () => {
  assert.equal(result.atlas.meta.retiredFiles, 4);
});

test('the export names them and quotes what they said', () => {
  const markdown = renderAtlasMarkdown(graph);
  assert.match(markdown, /## Code that says it is retired/);
  assert.match(markdown, /4 files describe themselves/);
  assert.match(markdown, /src\/_archive\/purchasing\.mjs` — in `_archive\//);
  assert.match(markdown, /src\/superseded\.mjs` — says "SUPERSEDED by pipeline\.mjs/);
});

// ---------------------------------------------------------------------------
// What they lose
// ---------------------------------------------------------------------------

test('a retired file is never where to look first', () => {
  const start = graph.getOverview().whereToLookFirst.map((entry) => entry.node.path);
  assert.deepEqual(start, ['src/index.mjs', 'src/pipeline.mjs', 'src/report.mjs']);
  for (const dead of retired) {
    assert.ok(!start.includes(dead), `${dead} is the last place to send a reader`);
  }
});

test('the architecture paragraph is never given a parked folder to describe', () => {
  // The narrowest unambiguous part of the issue, and the one that produced the worst
  // sentence: given `parked/station-estimates` in the outline, the model offered "a
  // station-estimates screen in parked/station-estimates hands its request across to
  // scripts" as one of the app's two main flows. Held at the material rather than at
  // the sentence — what the model is handed decides what it is able to say.
  const facts = collectAppFacts(result.atlas, buildGroups(result.atlas.nodes, result.atlas.edges).groups);
  const paths = facts.groups.map((group) => group.path);
  assert.ok(!paths.some((p) => p.startsWith('parked')), `got ${paths.join(', ')}`);

  // And no live group is described as handing off *into* one, or the sentence names a
  // destination that is not in the list it was given.
  for (const group of facts.groups) {
    assert.ok(!group.handsOffTo.some((to) => to.startsWith('parked')), `${group.path} → ${group.handsOffTo.join(', ')}`);
  }
});
