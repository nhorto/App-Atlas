/**
 * @fileoverview "Nothing in this app imports these files" (issue #46).
 *
 * The feature is one query over the import graph and about nine reasons not to run it,
 * so that is the shape of this file: a handful of tests that the right file is found,
 * and a great many that the wrong one is not.
 *
 * The asymmetry is the point. A missing row costs a reader one thing they had to find
 * for themselves; a wrong row is somebody being told, by a tool that sounds certain,
 * that they can delete their own middleware. Every exclusion below was put there by a
 * real repository: the lazily-imported CLI subcommand is NASCAR-Analytics, the page
 * files reached through an unresolvable `@/` alias are PocketBase, the store imported
 * only from a `.vue` file is Gitea, and the entry point named in an HTML file nobody
 * parses is App Atlas's own web app.
 */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import { analyzeProject } from '../dist/node/index.js';
import { renderAtlasMarkdown } from '../dist/node/export/markdown.js';
import { AtlasGraph } from '../dist/node/model/graph.js';
import { findUnimported } from '../dist/node/model/unimported.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => path.join(here, 'fixtures', name);

const analyze = (name, options = {}) =>
  analyzeProject(fixture(name), { followReferences: true, cache: 'off', ...options });

const view = (atlas) => findUnimported(atlas.nodes, atlas.edges, atlas.meta);
const paths = (atlas) => view(atlas).files.map((file) => file.path).sort();
/** The *file* node for a path. A door declared in that file shares its path. */
const fileNode = (atlas, relPath) =>
  atlas.nodes.find((node) => node.kind === 'file' && node.path === relPath);

const { atlas: app } = await analyze('unimported');

// ---------------------------------------------------------------------------
// What it finds
// ---------------------------------------------------------------------------

test('the abandoned file is named, and it is the only ordinary one', () => {
  const found = paths(app);
  assert.ok(found.includes('src/lib/abandoned.ts'), `expected the abandoned draft, got ${found.join(', ')}`);
});

test('the head of an abandoned pair is listed and its tail is not', () => {
  const found = paths(app);
  assert.ok(found.includes('src/lib/chain-a.ts'), 'nothing imports chain-a');
  // chain-b is imported — by chain-a, which is itself abandoned. Following that chain
  // would be reachability from a set of roots, and a set of roots missing one entry
  // point condemns everything under it.
  assert.ok(!found.includes('src/lib/chain-b.ts'), 'chain-b is imported by chain-a, so it is imported');
});

test('exactly those two, and nothing else', () => {
  assert.deepEqual(paths(app), ['src/lib/abandoned.ts', 'src/lib/chain-a.ts']);
});

test('the answer says how many files it weighed up, so the number reads as a proportion', () => {
  const result = view(app);
  assert.equal(result.answered, true);
  assert.equal(result.because, null);
  assert.ok(result.considered >= result.total, 'the denominator cannot be smaller than the list');
  assert.ok(result.considered > 2, 'the fixture has more files than the two that are listed');
});

// ---------------------------------------------------------------------------
// What it must never name
// ---------------------------------------------------------------------------

test("a framework's own files are not abandoned just because nothing imports them", () => {
  const found = paths(app);
  // Nothing in any Next.js app imports its layout or its middleware. Both are read by
  // name, by the framework, and both are load-bearing.
  assert.ok(!found.includes('src/app/layout.tsx'));
  assert.ok(!found.includes('src/middleware.ts'));
  assert.ok(!found.includes('src/app/page.tsx'));
});

test('the framework that owns a file is written onto the file, not guessed at each time', () => {
  const layout = fileNode(app, 'src/app/layout.tsx');
  assert.equal(layout.meta.frameworkOwned, 'Next.js App Router');
  const middleware = fileNode(app, 'src/middleware.ts');
  assert.equal(middleware.meta.frameworkOwned, 'Next.js');
});

test('a file a package.json script runs is a declared way in', () => {
  assert.ok(!paths(app).includes('scripts/seed.ts'));
  const seed = fileNode(app, 'scripts/seed.ts');
  assert.equal(seed.meta.declaredEntry, 'scripts.seed');
});

test('a file only the tests import is not on the list', () => {
  // Deliberate: "only your tests use this" is a real and different finding, and mixing
  // it in would put a well-tested helper next to an abandoned draft.
  assert.ok(!paths(app).includes('src/lib/only-tested.ts'));
  assert.ok(!paths(app).includes('src/__tests__/only-tested.test.ts'), 'a test is not asked about at all');
});

test('a module that exports nothing is not evidence of anything', () => {
  // Nothing was ever going to import it. It is a script, an entry point or a side
  // effect, and every one of those is reached from outside the import graph.
  assert.ok(!paths(app).includes('src/lib/side-effects.ts'));
});

test('a file reached only through a dynamic import() is imported', () => {
  // NASCAR-Analytics loads every CLI subcommand this way. Before the import graph knew
  // about `await import('./export.ts')`, both of its subcommands were reported as files
  // nothing pointed at — two rows, both wrong, on a repo with two findings.
  assert.ok(!paths(app).includes('src/lib/lazy-target.ts'));
  const edge = app.edges.find(
    (e) => e.kind === 'imports' && e.fromId === 'file:src/app/page.tsx' && e.toId === 'file:src/lib/lazy-target.ts',
  );
  assert.ok(edge, 'the dynamic import is a real edge in the graph, not a special case here');
  assert.equal(edge.confidence, 'certain', 'a literal specifier the compiler can see is not a guess');
});

// ---------------------------------------------------------------------------
// The refusals — every one of them a case where an empty answer would be a lie
// ---------------------------------------------------------------------------

test('--no-refs is refused outright, with the reason', async () => {
  const { atlas } = await analyze('unimported', { followReferences: false });
  const result = view(atlas);
  assert.equal(result.answered, false);
  assert.equal(result.files.length, 0);
  assert.match(result.because, /--no-refs/);
});

test('the run records whether it traced who uses what', async () => {
  assert.equal(app.meta.coverage.references, true);
  const { atlas } = await analyze('unimported', { followReferences: false });
  assert.equal(atlas.meta.coverage.references, false);
});

test('an atlas from before coverage was recorded is not assumed to be complete', () => {
  const older = { ...app.meta, coverage: undefined };
  const result = findUnimported(app.nodes, app.edges, older);
  assert.equal(result.answered, false);
  assert.match(result.because, /did not record/);
});

test('one app inside a bigger repo cannot see the sibling that imports it', async () => {
  const { atlas } = await analyzeProject(fixture('mono/apps/web'), {
    followReferences: true,
    cache: 'off',
    repoRoot: fixture('mono'),
  });
  assert.equal(atlas.meta.coverage.wholeRepo, false);
  const result = view(atlas);
  assert.equal(result.answered, false);
  assert.match(result.because, /larger repo/);
});

test('a library is refused, because its callers are outside the repo by definition', async () => {
  const { atlas } = await analyze('lib');
  assert.equal(atlas.meta.archetype.archetype, 'library');
  const result = view(atlas);
  assert.equal(result.answered, false);
  assert.match(result.because, /other code imports/);
});

test('an unresolvable path alias means links are missing, so nothing is claimed', async () => {
  const { atlas } = await analyze('aliased');
  const page = fileNode(atlas, 'src/app/page.tsx');
  assert.deepEqual(page.meta.unresolvedImports, ['@/lib/thing']);
  const result = view(atlas);
  assert.equal(result.answered, false);
  assert.match(result.because, /@\/lib\/thing/);
  // …and the file the alias pointed at is exactly the one that would have been named.
  assert.equal(result.files.length, 0);
});

test('a stylesheet behind the same alias is not a missing link', async () => {
  // `import '@/styles/globals.css'` never was a module, and treating it as a broken
  // link would silence this feature on every well-built Next.js app in existence.
  const { atlas } = await analyze('unimported');
  const withAlias = atlas.nodes.filter((node) => node.kind === 'file' && node.meta.unresolvedImports);
  assert.equal(withAlias.length, 0);
});

// ---------------------------------------------------------------------------
// How it reads
// ---------------------------------------------------------------------------

test('every answer carries the caveat that outlives every improvement', () => {
  for (const result of [view(app), findUnimported(app.nodes, app.edges, { ...app.meta, coverage: undefined })]) {
    assert.ok(result.caveats.length > 0);
    assert.match(result.caveats[0], /list to check, not a list to delete/);
  }
});

test('nothing in the wording is an instruction to delete anything', () => {
  const markdown = renderAtlasMarkdown(AtlasGraph.fromAtlas(app));
  const section = markdown.slice(markdown.indexOf('## Files nothing else imports'));
  assert.ok(!/\bdead code\b/i.test(section), 'a verdict, where a fact was available');
  assert.ok(!/\bunused\b/i.test(section.split('\n##')[0]), '"unused" is a conclusion; "nothing imports it" is not');
  assert.match(section, /imported by nothing else in it/);
});

test('the brief writes the section even when there is nothing to report', async () => {
  // An absent section is one an agent fills in with an assumption, and "no abandoned
  // files were found" and "nobody looked for them" are opposite facts about a repo.
  const { atlas } = await analyze('lib');
  const markdown = renderAtlasMarkdown(AtlasGraph.fromAtlas(atlas));
  assert.match(markdown, /## Files nothing else imports/);
  assert.match(markdown, /Not reported: this project is code other code imports/);
});

test('the overview carries the same answer the brief does', () => {
  const overview = AtlasGraph.fromAtlas(app).getOverview();
  assert.deepEqual(
    overview.unimported.files.map((file) => file.path).sort(),
    ['src/lib/abandoned.ts', 'src/lib/chain-a.ts'],
  );
});
