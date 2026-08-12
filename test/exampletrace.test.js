/**
 * @fileoverview The example stack shown in an empty paste box (#214).
 *
 * The placeholder used to be a hardcoded trace from a wine-cellar app, shown to every
 * project that opened the Trace tab. Building it from the graph fixes that and creates a
 * sharper obligation than the one it replaced: the paths are now real, so they have to
 * be *right*. A path that is nearly a file in this project is worse than one that is
 * obviously from somewhere else.
 *
 * The test that matters is the round trip — pasting the example back into the tool has to
 * place every frame. That is the same claim the screen makes by showing it, checked
 * rather than asserted.
 */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import { analyzeProject, AtlasGraph, exampleTrace, parseFrames, traceError } from '../dist/node/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => path.join(here, 'fixtures', name);

const atlasOf = async (name) => (await analyzeProject(fixture(name), { followReferences: true, cache: 'off' })).atlas;
const analyze = async (name) => new AtlasGraph(await atlasOf(name));

const boundaryAtlas = await atlasOf('boundary');
const boundary = new AtlasGraph(boundaryAtlas);

test('the example is a trace this tool can actually read', () => {
  const example = exampleTrace(boundary);
  assert.ok(example, 'the boundary fixture has functions, so there is an example to build');

  const frames = parseFrames(example.text);
  assert.equal(frames.length, example.frames.length, 'every line it prints parses back as a frame');
  assert.ok(frames.every((frame) => frame.language === example.language));
});

test('every path and line in the example is one the atlas holds', () => {
  const example = exampleTrace(boundary);
  const placed = traceError(boundary, example.text);

  // The whole point of the change: not "these look like paths" but "these are this
  // project's paths, at lines this project's code starts on".
  assert.ok(placed.origin, 'the innermost frame is code in this project');
  assert.ok(
    placed.frames.every((found) => found.nodeId),
    `every frame places: ${placed.frames.map((f) => `${f.frame.rawPath}:${f.frame.line}`).join(', ')}`,
  );
  assert.deepEqual(
    placed.frames.map((found) => `${found.path}:${found.sourceLine ?? found.frame.line}`),
    example.frames,
    'what it says the frames are is what the tracer makes of them',
  );
});

test('the example names no test file and no parked one', () => {
  const example = exampleTrace(boundary);
  for (const frame of example.frames) {
    const node = boundary.getNodeById(`file:${frame.slice(0, frame.lastIndexOf(':'))}`);
    assert.ok(node, `${frame} is a file in the atlas`);
    assert.notEqual(node.zone, 'test', 'a fixture is not where anybody debugs');
  }
});

test('the same repo gets the same example every time', () => {
  // A placeholder that shuffles between reloads reads as live output rather than as an
  // example, which is most of what was wrong with the old one.
  assert.equal(exampleTrace(boundary).text, exampleTrace(boundary).text);
});

test('it shows a stack rather than a single line when the code has a caller to show', () => {
  const example = exampleTrace(boundary);
  assert.ok(example.frames.length > 1, 'two frames read as a stack; one reads as a line of log');
});

test('a Python project gets a Python traceback, not a V8 one', async () => {
  const python = await analyze('pyapp');
  const example = exampleTrace(python);
  assert.ok(example);
  assert.equal(example.language, 'python');
  assert.match(example.text, /^ {2}File ".+", line \d+, in \S+$/m);
  assert.ok(
    traceError(python, example.text).frames.every((found) => found.nodeId),
    'and it places, the same as the JavaScript one',
  );
});

test('an atlas with nothing to print a frame from gets no example at all', () => {
  // Rather than a plausible-looking fallback. A repo of config and Markdown has no
  // function to illustrate with, and inventing one here is the bug this file exists for.
  const bare = new AtlasGraph({
    ...boundaryAtlas,
    nodes: boundaryAtlas.nodes.filter((node) => node.kind !== 'function'),
    edges: [],
  });
  assert.equal(exampleTrace(bare), null);
});
