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
// By kind as well as name: a screen door and the class its markup completes share a
// name, deliberately, and only one of them carries the docstring.
const summaryOf = (name, kind = 'type') => nodes.find((node) => node.name === name && node.kind === kind)?.summary;

// ---------------------------------------------------------------------------
// What kind of project this is
// ---------------------------------------------------------------------------

test('an app with screens is an app with a front end', () => {
  // Once the markup is read, the screens settle it outright — and a desktop app opening
  // on Boundaries is right, because a person is the way in and the database is where it
  // goes. `<OutputType>` is the answer when there is no markup; see `csharpconsole`.
  assert.equal(result.atlas.meta.archetype.archetype, 'web-app');
  assert.ok(result.atlas.meta.archetype.because.includes('1 screen'), result.atlas.meta.archetype.because.join('; '));
});

test('its own classes are still not offered as a public API', () => {
  // The library archetype turns every exported name into a door. On the repo this came
  // from that meant 154 window classes listed as ways in. The doors it has now are its
  // screens, and there is exactly one of those.
  const doors = nodes.filter((node) => node.kind === 'endpoint');
  assert.deepEqual(doors.map((door) => `${door.meta.endpointKind} ${door.name}`), ['screen DashboardWindow']);
});

// ---------------------------------------------------------------------------
// Documentation, which C# writes on the type
// ---------------------------------------------------------------------------

test('a doc comment inside a class body is read', () => {
  // Go declares everything at the top level, so collecting only top-level comments was
  // right until it wasn't. C# puts every method inside a class, and its `///` with it —
  // which meant 0 of 1161 functions in a documented repo had a description.
  assert.match(summaryOf('Refresh', 'function'), /Rebuilds the chart/);
  assert.match(summaryOf('TodayAsync', 'function'), /Today's totals/);
});

test('XML doc tags are furniture, and the reader is shown the words', () => {
  // Left in, the first thing on a card is `<summary>`, and the same sentence reaches
  // ATLAS.md and every prompt built from it.
  const doc = summaryOf('DashboardWindow');
  assert.ok(!doc.includes('<'), doc);
  // `<see cref="App"/>` and `<c>usage_intervals</c>` name a thing; the name survives.
  assert.match(doc, /Reached from App and from the widget board/);
  assert.match(summaryOf('Refresh', 'function'), /from usage_intervals and swaps it in/);
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

test('the markup is read, so nothing is counted as unreadable', () => {
  // It used to be on the unread list, and "78 files are imported by nothing else" on the
  // repo this came from was that hole rather than a finding. The hole is closed, so the
  // question can be answered instead of refused.
  assert.deepEqual(result.atlas.meta.coverage.unreadFormats, []);
  const markdown = renderAtlasMarkdown(new AtlasGraph(result.atlas));
  assert.ok(!/Not reported: this project contains/.test(markdown), markdown);
});

test('the markup instantiates the class, and that is an edge', () => {
  // `<Window x:Class="Glance.App.DashboardWindow">` is the only thing that ever
  // constructs that class. Without this edge the app's own window is reached by nothing.
  const window = nodes.find((node) => node.kind === 'type' && node.name === 'DashboardWindow');
  const edge = result.atlas.edges.find((e) => e.toId === window.id && e.fromId.endsWith('.xaml'));
  assert.ok(edge, 'the code-behind is reached from its markup');
  assert.equal(edge.meta.via, 'x:Class');
  assert.equal(edge.confidence, 'certain', 'the compiler enforces the pairing');
});

// ---------------------------------------------------------------------------
// It still finds the data
// ---------------------------------------------------------------------------

test('the database is read through raw ADO.NET, as desktop apps do', () => {
  const store = nodes.find((node) => node.kind === 'store');
  assert.equal(store.name, 'SQLite');
  assert.deepEqual(store.meta.tables, ['usage_intervals']);
});

// ---------------------------------------------------------------------------
// The other .NET app shape: no markup at all
// ---------------------------------------------------------------------------

const console_ = await analyzeProject(path.join(here, 'fixtures', 'csharpconsole'), { cache: 'off' });

test('a console app is something you run, on the strength of OutputType alone', () => {
  // No screens, no routes, and it exports names — which is the exact shape of a library
  // and was how a 209-file desktop app got filed before `<OutputType>` was read.
  // `<OutputType>Exe</OutputType>` is .NET's `bin` field and settles it.
  assert.equal(console_.atlas.meta.archetype.archetype, 'pipeline');
  assert.ok(
    console_.atlas.meta.archetype.because.includes('a .NET project that builds an executable'),
    console_.atlas.meta.archetype.because.join('; '),
  );
});

test('and nobody imports a console app, so it has no public API', () => {
  assert.equal(console_.atlas.nodes.filter((node) => node.kind === 'endpoint').length, 0);
});
