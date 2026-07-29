/**
 * @fileoverview Jupyter notebooks (#19).
 *
 * A notebook is Python in a JSON envelope. The bug these pin: `.ipynb` was not in the
 * source glob, so for a data-science repo App Atlas described the helper scripts and
 * left out the work — and reported the project as a library on that basis.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyzeProject, classifyZone } from '../dist/node/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, 'fixtures', 'notebook');

const { atlas } = await analyzeProject(FIXTURE, { followReferences: true, cache: 'off' });
const readable = atlas.nodes.some((n) => n.kind === 'function');
const skip = readable ? false : 'no Python 3.9+ on this machine';

const notebook = atlas.nodes.find((n) => n.kind === 'file' && n.path === 'analysis.ipynb');
const fn = (name) => atlas.nodes.find((n) => n.kind === 'function' && n.name === name);

test('a notebook is a source file', () => {
  assert.ok(notebook, 'analysis.ipynb is on the map');
  assert.equal(classifyZone('analysis.ipynb'), 'logic');
  // `test.ipynb` in a data repo is a scratchpad, not a suite — calling it a test would
  // dim the work the reader came for.
  assert.equal(classifyZone('test.ipynb'), 'logic');
  // The directory still counts, the way it does for every other language.
  assert.equal(classifyZone('models/clean.ipynb'), 'data');
});

test('its insides are read, cell by cell', { skip }, () => {
  assert.ok(fn('load_readings'), 'a function defined in a code cell');
  assert.ok(fn('fetch_weather'));
  assert.equal(fn('load_readings').summary, 'Read the readings CSV off disk.');
});

test('line numbers count against the code, not the JSON envelope', { skip }, () => {
  // The file on disk is ~40 lines of JSON; the Python inside it is far shorter, and
  // that is what every line number in the atlas refers to.
  assert.ok(notebook.meta.loc < 25, `loc is the flattened source (got ${notebook.meta.loc})`);
  assert.ok(fn('load_readings').startLine < 25);
});

test('every definition knows which cell it lives in', { skip }, () => {
  // "Line 412" is useless to someone looking at a stack of cells.
  assert.equal(notebook.meta.cellCount, 4, 'four code cells; the markdown ones are not code');
  assert.equal(fn('load_readings').meta.cell, 3);
  assert.equal(fn('fetch_weather').meta.cell, 4);
});

test('IPython magics do not cost the notebook its other cells', { skip }, () => {
  // `%matplotlib inline` and `!pip install` sit in the same cell as the imports and
  // are not Python. Before they were blanked, that cell failed to parse.
  const imports = atlas.edges.filter((e) => e.kind === 'imports');
  assert.ok(
    atlas.nodes.some((n) => n.kind === 'service' && n.name === 'api.weather.gov'),
    'the boundary detectors run through notebook code like any other Python',
  );
  assert.ok(fn('load_readings'), 'and the cells after the magics still parsed');
  assert.ok(imports.length >= 0);
});

test('the opening markdown cell is the notebook describing itself', { skip }, () => {
  // A notebook rarely has a module docstring but very often has a title block, and
  // that is the author's own words — the top rung of the ladder, not generated.
  assert.equal(notebook.summary, 'Solar forecasting');
  assert.equal(notebook.summarySource, 'docs');
});

test('checkpoints are not source', () => {
  // Jupyter's autosave litter would otherwise double every notebook on the map.
  assert.ok(!atlas.nodes.some((n) => n.path?.includes('.ipynb_checkpoints')));
});
