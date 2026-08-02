/**
 * @fileoverview A .NET app nobody calls over a network.
 *
 * Every C# assertion elsewhere is about a web service. This one is the other shape, and
 * it is the shape that showed how much of the tier had quietly assumed the first: a
 * 209-file WinUI desktop app came back as **Code other code imports**, with 154 of its
 * own window classes offered as the public API nobody uses, **0%** of its files
 * documented in a repo where 151 of them carry `/// <summary>`, and 78 files reported as
 * imported by nothing — in an app whose windows are instantiated by markup this tool
 * does not read.
 *
 * Four wrong answers, one cause each, and all four were only visible on a real repo.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyzeProject, AtlasGraph, renderAtlasMarkdown } from '../dist/node/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const result = await analyzeProject(path.join(here, 'fixtures', 'csharpdesktop'), {
  cache: 'off',
  followReferences: true,
});
const nodes = result.atlas.nodes;
const summaryOf = (name) => nodes.find((node) => node.name === name && node.kind !== 'file')?.summary;

// ---------------------------------------------------------------------------
// What kind of project this is
// ---------------------------------------------------------------------------

test('a project that builds an executable is something you run', () => {
  // `<OutputType>WinExe</OutputType>` is .NET's `bin` field. Without reading it, a
  // desktop app exports names and answers no URL — which is the exact shape of a
  // library, and every desktop application ever written.
  assert.equal(result.atlas.meta.archetype.archetype, 'pipeline');
  assert.ok(
    result.atlas.meta.archetype.because.includes('a .NET project that builds an executable'),
    result.atlas.meta.archetype.because.join('; '),
  );
});

test('so its own classes are not offered as a public API', () => {
  // The library archetype turns every exported name into a door. On the repo this came
  // from that meant 154 window classes listed as ways in, on an app with no network
  // surface at all.
  assert.equal(nodes.filter((node) => node.kind === 'endpoint').length, 0);
});

// ---------------------------------------------------------------------------
// Documentation, which C# writes on the type
// ---------------------------------------------------------------------------

test('a doc comment inside a class body is read', () => {
  // Go declares everything at the top level, so collecting only top-level comments was
  // right until it wasn't. C# puts every method inside a class, and its `///` with it —
  // which meant 0 of 1161 functions in a documented repo had a description.
  assert.match(summaryOf('Refresh'), /Rebuilds the chart/);
  assert.match(summaryOf('TodayAsync'), /Today's totals/);
});

test('XML doc tags are furniture, and the reader is shown the words', () => {
  // Left in, the first thing on a card is `<summary>`, and the same sentence reaches
  // ATLAS.md and every prompt built from it.
  const doc = summaryOf('DashboardWindow');
  assert.ok(!doc.includes('<'), doc);
  // `<see cref="App"/>` and `<c>usage_intervals</c>` name a thing; the name survives.
  assert.match(doc, /Reached from App and from the widget board/);
  assert.match(summaryOf('Refresh'), /from usage_intervals and swaps it in/);
});

test('a file that declares one type is documented by that type', () => {
  // C# has no file-header convention: the `///` goes on the type and the file is named
  // after it. Counting only file-level docs reported a well-documented repo as 0%.
  assert.equal(result.atlas.meta.stats.documentedFiles, result.atlas.meta.stats.files);
  const file = nodes.find((node) => node.kind === 'file' && node.path.endsWith('UsageStore.cs'));
  assert.equal(file.summarySource, 'docs');
  assert.match(file.summary, /Every reading the tracker has taken/);
});

// ---------------------------------------------------------------------------
// What it refuses to say
// ---------------------------------------------------------------------------

test('markup this tool cannot read is counted, not ignored', () => {
  assert.deepEqual(result.atlas.meta.coverage.unreadFormats, [{ ext: '.xaml', count: 1 }]);
});

test('and "nothing imports this" is refused while that hole is in view', () => {
  // A WinUI window is instantiated by its markup and by nothing else — the C# half is a
  // partial class the markup names. So on a desktop app the import graph is missing
  // exactly the edges that would show its screens being used, and "78 files are imported
  // by nothing else" was that gap rather than a finding.
  const markdown = renderAtlasMarkdown(new AtlasGraph(result.atlas));
  assert.match(markdown, /Not reported: this project contains 1 \.xaml file/);
  assert.ok(!/files in this app are imported by nothing else/.test(markdown), markdown);
});

// ---------------------------------------------------------------------------
// It still finds the data
// ---------------------------------------------------------------------------

test('the database is read through raw ADO.NET, as desktop apps do', () => {
  const store = nodes.find((node) => node.kind === 'store');
  assert.equal(store.name, 'SQLite');
  assert.deepEqual(store.meta.tables, ['usage_intervals']);
});
