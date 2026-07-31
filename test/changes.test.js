/**
 * @fileoverview Tests for "what changed since the last run" (issue #41).
 *
 * The feature exists to answer one question — *what did the agent do to my app over the
 * weekend* — and it has exactly one way to fail badly: saying something changed when
 * nothing did, or saying nothing changed when a door came open. So the tests here are
 * mostly about restraint. The first run must say it has no baseline rather than report
 * four hundred additions; an atlas written by another version of the tool must be
 * refused rather than subtracted; and the one case worth interrupting somebody for — a
 * door that quietly lost its auth check — must survive the fact that the door's content
 * hash never moved.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  analyzeProject,
  AtlasGraph,
  describeChanges,
  diffAtlas,
  renderAtlasMarkdown,
} from '../dist/node/index.js';

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, '..', 'dist', 'node', 'cli.js');

/** Copies a fixture somewhere disposable, so tests may edit and delete files freely. */
function scratch(fixture, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `atlas-${name}-`));
  fs.cpSync(path.join(here, 'fixtures', fixture), dir, { recursive: true });
  return dir;
}

const analyze = async (dir) => (await analyzeProject(dir, { followReferences: true, cache: 'off' })).atlas;

/** Rewrites one file in place, so a test can describe an edit rather than perform one. */
function edit(dir, relPath, change) {
  const file = path.join(dir, ...relPath.split('/'));
  fs.writeFileSync(file, change(fs.readFileSync(file, 'utf8')));
}

// ---------------------------------------------------------------------------
// The first run, which is the case this feature is most able to get wrong.

test('a first run has no baseline, and says so instead of calling everything new', async () => {
  const dir = scratch('sample', 'first');
  const atlas = await analyze(dir);
  const changes = diffAtlas(null, atlas);

  assert.equal(changes.baseline, 'none');
  assert.equal(changes.since, null);
  // The atlas has four files, eight functions and two doors. None of them is "new".
  assert.deepEqual(changes.total, { added: 0, removed: 0, changed: 0 });
  assert.deepEqual(changes.byKind, {});
  assert.equal(changes.doors.newTotal, 0);
  assert.deepEqual(changes.doors.newOpen, []);

  const report = describeChanges(changes);
  assert.equal(report.tone, 'muted', 'no baseline is a caveat, not news');
  assert.match(report.headline.text, /first run/);
  assert.doesNotMatch(report.headline.text, /\bnew\b.*door/i);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a second run with nothing edited says nothing changed', async () => {
  const dir = scratch('sample', 'same');
  const changes = diffAtlas(await analyze(dir), await analyze(dir));

  assert.equal(changes.baseline, 'compared');
  assert.deepEqual(changes.total, { added: 0, removed: 0, changed: 0 });
  assert.equal(describeChanges(changes).headline.text, 'nothing changed since the last run');
  assert.equal(describeChanges(changes).tone, 'ok');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Doors, which are the only part of the diff worth interrupting somebody for.

test('a new route with no auth check is named, and leads the summary', async () => {
  const dir = scratch('sample', 'newdoor');
  const before = await analyze(dir);
  edit(dir, 'src/api/routes.ts', (text) =>
    text.replace(
      '  app.get(\'/me\'',
      "  app.post('/wipe', (_req, res) => res.json({ ok: true }));\n  app.get('/me'",
    ),
  );
  const changes = diffAtlas(before, await analyze(dir));

  assert.equal(changes.doors.newTotal, 1);
  assert.equal(changes.doors.newOpen.length, 1);
  assert.equal(changes.doors.newOpen[0].name, 'POST /wipe');
  assert.equal(changes.doors.newOpen[0].path, 'src/api/routes.ts');
  assert.equal(changes.doors.newOpen[0].line, 6);
  // The two doors that were already open are not new, and must not be reported as such.
  assert.equal(changes.byKind.endpoint.added, 1);

  const report = describeChanges(changes);
  assert.equal(report.tone, 'warn');
  assert.match(report.headline.text, /1 new door since the last run, with no auth check/);
  fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * The case that decided how the diff is built. An endpoint's `hash` covers its id and
 * how many places it was found — not its guards — so a route whose auth check is deleted
 * is byte-identical to the tool. Comparing hashes would report nothing at all.
 */
test('a door that lost its auth check is caught, even though its hash never moved', async () => {
  const dir = scratch('tsauth', 'lostcheck');
  const before = await analyze(dir);
  edit(dir, 'src/admin.routes.ts', (text) => text.replace('admin.use(requireAuth);', ''));
  const after = await analyze(dir);

  const id = 'endpoint:http-route:POST /admin/purge';
  const oldDoor = before.nodes.find((node) => node.id === id);
  const newDoor = after.nodes.find((node) => node.id === id);
  assert.equal(oldDoor.hash, newDoor.hash, 'the premise: the content hash is unmoved');
  assert.equal(oldDoor.meta.guards.length, 1);
  assert.equal(newDoor.meta.guards.length, 0);

  const changes = diffAtlas(before, after);
  assert.equal(changes.byKind.endpoint, undefined, 'no endpoint counts as added, removed or changed');
  assert.deepEqual(
    changes.doors.lostCheck.map((door) => door.name),
    ['POST /admin/purge'],
  );
  assert.match(describeChanges(changes).headline.text, /had an auth check last run has none now/);
  assert.equal(describeChanges(changes).tone, 'warn');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a door that vanished is reported, because a door that vanished is a fact', async () => {
  const dir = scratch('sample', 'gone');
  const before = await analyze(dir);
  edit(dir, 'src/api/routes.ts', (text) =>
    text.replace(/ {2}app\.get\('\/users\/:id'[\s\S]*?\}\);\n/, ''),
  );
  const changes = diffAtlas(before, await analyze(dir));

  assert.deepEqual(
    changes.doors.removed.map((door) => door.name),
    ['GET /users/:id'],
  );
  assert.equal(changes.doors.newTotal, 0);

  // Nothing opened, so the vanished door is the news and leads — but it is news rather
  // than an alarm, and the tone says so.
  const report = describeChanges(changes);
  assert.equal(report.headline.text, '1 door that was here last run is gone');
  assert.deepEqual(report.headline.doors, changes.doors.removed);
  assert.equal(report.tone, 'ok');
  fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * The decision written into `changes.ts`, pinned so it cannot drift by accident: ids are
 * addressed rather than content-addressed, so a rename is a removal plus an addition.
 * That is the honest reading — anything importing the old name is now broken.
 */
test('renaming a function reads as one removal and one addition, deliberately', async () => {
  const dir = scratch('sample', 'rename');
  const before = await analyze(dir);
  edit(dir, 'src/lib/format.ts', (text) => text.replaceAll('formatName', 'formatDisplayName'));
  const changes = diffAtlas(before, await analyze(dir));

  assert.equal(changes.byKind.function.added, 1, 'the new name');
  assert.equal(changes.byKind.function.removed, 1, 'the old name');
  // The file it lives in is a change rather than a swap, because its id is its path.
  assert.equal(changes.byKind.file.changed, 1);
  assert.equal(changes.byKind.file.added ?? 0, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Baselines that look like baselines and are not.

/** A minimal pair of atlases, so a mismatch can be described rather than manufactured. */
function pair(overrides) {
  const meta = { formatVersion: 3, toolVersion: '0.6.0', root: '/tmp/app', name: 'app', generatedAt: '2026-07-01T00:00:00.000Z', durationMs: 1, languages: [], frameworks: [], stats: {}, warnings: [] };
  const node = (id) => ({ id, kind: 'file', name: id, hash: id, meta: {} });
  return [
    { meta: { ...meta, ...overrides }, nodes: [node('file:a.ts'), node('file:b.ts')], edges: [] },
    { meta, nodes: [node('file:c.ts')], edges: [] },
  ];
}

test('an atlas from a different version of the tool is not a baseline', () => {
  const changes = diffAtlas(...pair({ toolVersion: '0.5.0' }));

  assert.equal(changes.baseline, 'incomparable');
  assert.match(changes.because, /App Atlas v0\.5\.0 and this is v0\.6\.0/);
  // The whole point: one file was added and two removed, and none of that is reported,
  // because a version that has learned a new framework overnight would report the
  // entire app as new and teach the reader to skip this section forever.
  assert.deepEqual(changes.total, { added: 0, removed: 0, changed: 0 });
  assert.equal(describeChanges(changes).tone, 'muted');
});

test('an atlas written for a different directory is not a baseline', () => {
  const changes = diffAtlas(...pair({ root: '/tmp/some-other-app' }));
  assert.equal(changes.baseline, 'incomparable');
  assert.match(changes.because, /some-other-app/);
  assert.deepEqual(changes.total, { added: 0, removed: 0, changed: 0 });
});

test('an atlas in an older on-disk format is not a baseline', () => {
  const changes = diffAtlas(...pair({ formatVersion: 2 }));
  assert.equal(changes.baseline, 'incomparable');
  assert.match(changes.because, /format v2 and this one is v3/);
});

// ---------------------------------------------------------------------------
// The exported brief.

test('ATLAS.md says there was nothing to compare against on a first run', async () => {
  const dir = scratch('sample', 'md-first');
  const atlas = await analyze(dir);
  atlas.meta.changes = diffAtlas(null, atlas);

  const markdown = renderAtlasMarkdown(new AtlasGraph(atlas));
  assert.match(markdown, /## What changed since the last run/);
  assert.match(markdown, /First run/);
  // An agent reading this must not come away thinking the app was rewritten overnight.
  assert.doesNotMatch(markdown, /new door/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('ATLAS.md leads with the new open doors once there is a baseline', async () => {
  const dir = scratch('sample', 'md-diff');
  const before = await analyze(dir);
  edit(dir, 'src/api/routes.ts', (text) =>
    text.replace(
      '  app.get(\'/me\'',
      "  app.post('/wipe', (_req, res) => res.json({ ok: true }));\n  app.get('/me'",
    ),
  );
  const atlas = await analyze(dir);
  atlas.meta.changes = diffAtlas(before, atlas);

  const markdown = renderAtlasMarkdown(new AtlasGraph(atlas));
  assert.match(markdown, /\*\*1 new door since the last run, with no auth check[^*]*\.\*\*/);
  assert.match(markdown, /- `POST \/wipe` — writes data — `src\/api\/routes\.ts:6`/);
  // Above the counts, which is the whole claim the placement makes.
  assert.ok(
    markdown.indexOf('## What changed since the last run') < markdown.indexOf('## By the numbers'),
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The baseline on disk, which is the part no unit test can see.

/** The atlas the CLI just wrote, read back the way `serve` and `export` read it. */
function writtenAtlas(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, '.app-atlas', 'atlas.json'), 'utf8'));
}

test('the CLI keeps the last run as the baseline for the next one', async () => {
  const dir = scratch('sample', 'cli');
  await run(process.execPath, [CLI, 'analyze', dir, '--no-ai', '-q']);
  assert.equal(writtenAtlas(dir).meta.changes.baseline, 'none', 'the first run has nothing behind it');

  edit(dir, 'src/api/routes.ts', (text) =>
    text.replace(
      '  app.get(\'/me\'',
      "  app.post('/wipe', (_req, res) => res.json({ ok: true }));\n  app.get('/me'",
    ),
  );
  const second = await run(process.execPath, [CLI, 'analyze', dir, '--no-ai']);
  const changes = writtenAtlas(dir).meta.changes;

  assert.equal(changes.baseline, 'compared');
  assert.deepEqual(
    changes.doors.newOpen.map((door) => door.name),
    ['POST /wipe'],
  );
  assert.match(second.stdout, /1 new door since the last run, with no auth check/);
  assert.match(second.stdout, /POST \/wipe/);
  fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * `--fresh` throws away the per-file cache, which is a different thing from the atlas.
 * Confusing the two would make "re-read everything" silently mean "forget everything",
 * and somebody who reached for it because a run looked wrong would lose the very
 * comparison they were trying to check.
 */
test('--fresh re-reads every file without destroying the baseline', async () => {
  const dir = scratch('sample', 'fresh');
  await run(process.execPath, [CLI, 'analyze', dir, '--no-ai', '-q']);
  await run(process.execPath, [CLI, 'analyze', dir, '--no-ai', '-q', '--fresh']);

  const changes = writtenAtlas(dir).meta.changes;
  assert.equal(changes.baseline, 'compared');
  assert.deepEqual(changes.total, { added: 0, removed: 0, changed: 0 });
  fs.rmSync(dir, { recursive: true, force: true });
});
