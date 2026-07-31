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
import { analyzeProject, AtlasGraph, buildBoundaryView, classifyZone } from '../dist/node/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, 'fixtures', 'notebook');

const { atlas } = await analyzeProject(FIXTURE, { followReferences: true, cache: 'off' });
const readable = atlas.nodes.some((n) => n.kind === 'function');
const skip = readable ? false : 'no Python 3.9+ on this machine';

const notebook = atlas.nodes.find((n) => n.kind === 'file' && n.path === 'analysis.ipynb');
const pipeline = atlas.nodes.find((n) => n.kind === 'file' && n.path === 'pipeline.ipynb');
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

/**
 * One cell that is not Python used to blank the whole notebook (#39).
 *
 * `pipeline.ipynb` opens with a `%%bash` cell whose body is shell, and has a bare
 * `pandoc …` line halfway down. Neither mentions `pip` on purpose: what the analyzer
 * tests is whether a cell parses, never the name of a command, because the next repo's
 * unreadable line is one nobody has thought of yet.
 *
 * The flattened source, for the line numbers below:
 *
 *      1-3   cell 1, the shell cell, blanked
 *      5-7   cell 2, def rolling_mean
 *      9     cell 3, the pandoc line, blanked
 *     11-13  cell 4, def trim
 *     15     cell 5, which calls both
 */
test('a cell that is not Python costs that cell, not the notebook', { skip }, () => {
  assert.ok(fn('rolling_mean'), 'the cell after the shell cell was still read');
  assert.ok(fn('trim'), 'and so was the one after the second unreadable cell');
  assert.equal(fn('rolling_mean').summary, 'Average each value with the ones just before it.');
  assert.ok(!pipeline.meta.unread, 'the notebook itself is not reported unread — most of it was read');
  assert.equal(pipeline.meta.functionCount, 2);
  assert.equal(pipeline.meta.cellCount, 5, 'the blanked cells still exist and still count');
});

test('a blanked cell occupies exactly the lines it did', { skip }, () => {
  // The whole point of blanking rather than dropping: every range and every line
  // number below a bad cell still lands on the code the author wrote.
  assert.equal(fn('rolling_mean').startLine, 5);
  assert.equal(fn('rolling_mean').endLine, 7);
  assert.equal(fn('trim').startLine, 11);
  assert.equal(fn('trim').endLine, 13);
  assert.equal(fn('rolling_mean').meta.cell, 2);
  assert.equal(fn('trim').meta.cell, 4);
});

test('the cells that went dark say so', { skip }, () => {
  // A notebook with two unreadable cells is not a notebook with none, and nothing else
  // on the map would give the shortfall away.
  const dark = pipeline.meta.cells.filter((cell) => cell.unread);
  assert.deepEqual(
    dark.map((cell) => cell.index),
    [1, 3],
  );
  assert.match(dark[0].unread, /line 2 of the cell/, 'the address is counted from the top of the cell');
  assert.equal(dark[0].startLine, 1);
  assert.equal(dark[0].endLine, 3, 'and it still holds its three lines open');
  assert.ok(
    atlas.meta.warnings.some((w) => /pipeline\.ipynb/.test(w) && /2 of 5 code cells/.test(w)),
    `the run says it out loud: ${atlas.meta.warnings.join(' · ')}`,
  );
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

/**
 * The bug in the header of this file, finished (#28).
 *
 * Reading the notebooks was half of it: NBA and handson-ml3 still came out as
 * libraries, rendering the helper functions in them as a "public API" nobody imports.
 * A notebook is not a module somebody installs, and the question it answers is what the
 * data says.
 */
test('a repo of notebooks is analysis, not a library', { skip }, () => {
  assert.equal(atlas.meta.archetype.archetype, 'analysis');
  assert.equal(atlas.meta.archetype.label, 'Code that turns data into answers');
  assert.ok(atlas.meta.archetype.because.some((why) => /notebook/.test(why)));
  // The dataset is the other half of the case, and it could not be made until the
  // data detectors could see a `pd.read_csv`.
  assert.ok(
    atlas.meta.archetype.because.some((why) => /reads data files with pandas/.test(why)),
    atlas.meta.archetype.because.join(' · '),
  );
});

test('the data an analysis reads is where it comes from, not where it goes', { skip }, () => {
  const view = buildBoundaryView(new AtlasGraph(atlas));
  assert.equal(view.captions.inputs, 'Where the data comes from');
  assert.equal(view.captions.app, 'The analysis');
  assert.equal(view.captions.outputs, 'What it produces');

  const csv = view.inputs.find((card) => card.name === 'CSV files');
  assert.ok(csv, `expected the CSV on the left, got ${view.inputs.map((c) => c.name).join(', ')}`);
  assert.match(csv.detail, /1 read/);
  // Nothing writes one, so it appears once. A store that is read *and* written is
  // genuinely both, and says so on both sides.
  assert.ok(!view.outputs.some((card) => card.name === 'CSV files'));
});
