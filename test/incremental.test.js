/**
 * @fileoverview Tests for incremental re-analysis.
 *
 * The only thing that matters here is that a fast answer is the *same* answer. Every
 * test edits a throwaway copy of a fixture, analyzes it incrementally, and compares the
 * result against a full analysis of the identical tree. A cache that is quick and
 * subtly wrong would be far worse than no cache at all.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyzeProject } from '../dist/node/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = path.join(here, 'fixtures', 'sample');

/** Copies a fixture somewhere disposable, so tests may edit and delete files freely. */
function scratch(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `atlas-${name}-`));
  fs.cpSync(SAMPLE, dir, { recursive: true });
  return dir;
}

/** Node and edge identity, ignoring the ordering the two runs happen to produce. */
function shape(atlas) {
  return {
    nodes: atlas.nodes.map((n) => `${n.id}@${n.hash}`).sort(),
    edges: atlas.edges.map((e) => `${e.id}×${e.weight}`).sort(),
  };
}

/** A full analysis of the same tree, from a copy with no cache in it. */
async function fullAnalysisOf(dir) {
  const clean = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-check-'));
  fs.cpSync(dir, clean, { recursive: true });
  fs.rmSync(path.join(clean, '.app-atlas'), { recursive: true, force: true });
  const { atlas } = await analyzeProject(clean, { followReferences: true, cache: 'off' });
  fs.rmSync(clean, { recursive: true, force: true });
  return atlas;
}

test('a second run reuses every file and produces the same atlas', async () => {
  const dir = scratch('same');
  const first = (await analyzeProject(dir, { followReferences: true })).atlas;
  const second = (await analyzeProject(dir, { followReferences: true })).atlas;

  assert.equal(first.meta.incremental.reused, 0, 'nothing to reuse on a first run');
  assert.equal(second.meta.incremental.reused, 4, 'every file unchanged the second time');
  assert.equal(second.meta.incremental.analyzed, 0);
  assert.deepEqual(shape(second), shape(first));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('editing one file re-reads only that file and whatever imports it', async () => {
  const dir = scratch('edit');
  await analyzeProject(dir, { followReferences: true });

  // `user.ts` declares User; format.ts, routes.ts and Badge.tsx all import it.
  const file = path.join(dir, 'src', 'models', 'user.ts');
  fs.writeFileSync(file, `${fs.readFileSync(file, 'utf8')}\nexport type Extra = { note: string };\n`);

  const { atlas } = await analyzeProject(dir, { followReferences: true });
  assert.equal(atlas.meta.incremental.analyzed, 4, 'the file plus its three importers');
  assert.ok(atlas.nodes.some((n) => n.kind === 'type' && n.name === 'Extra'));
  assert.deepEqual(shape(atlas), shape(await fullAnalysisOf(dir)));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a file nobody imports invalidates nobody else', async () => {
  const dir = scratch('leaf');
  await analyzeProject(dir, { followReferences: true });

  const file = path.join(dir, 'src', 'components', 'Badge.tsx');
  fs.writeFileSync(file, `${fs.readFileSync(file, 'utf8')}\nexport const badgeVersion = 2;\n`);

  const { atlas } = await analyzeProject(dir, { followReferences: true });
  assert.equal(atlas.meta.incremental.analyzed, 1);
  assert.equal(atlas.meta.incremental.reused, 3);
  fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * The case the whole invalidation rule exists for: an importer that was *not* edited
 * still holds edges pointing at ids that no longer exist.
 */
test('renaming an export updates the references from files that were not touched', async () => {
  const dir = scratch('rename');
  await analyzeProject(dir, { followReferences: true });

  const file = path.join(dir, 'src', 'lib', 'format.ts');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replaceAll('formatName', 'formatDisplayName'));
  // Only the definition is renamed; the callers still say `formatName` and no longer
  // resolve. A stale cache would keep claiming they call something that is gone.
  const { atlas } = await analyzeProject(dir, { followReferences: true });

  assert.deepEqual(shape(atlas), shape(await fullAnalysisOf(dir)));
  assert.ok(atlas.nodes.some((n) => n.name === 'formatDisplayName'));
  assert.ok(!atlas.edges.some((e) => e.toId.endsWith('#formatName')), 'no edge points at the old name');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('deleting a file removes it and re-reads whoever imported it', async () => {
  const dir = scratch('delete');
  await analyzeProject(dir, { followReferences: true });

  fs.rmSync(path.join(dir, 'src', 'components', 'Badge.tsx'));
  const { atlas } = await analyzeProject(dir, { followReferences: true });

  assert.ok(!atlas.nodes.some((n) => n.path === 'src/components/Badge.tsx'));
  assert.deepEqual(shape(atlas), shape(await fullAnalysisOf(dir)));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('changing the analysis flags throws the whole cache away', async () => {
  const dir = scratch('flags');
  await analyzeProject(dir, { followReferences: true });

  // Reference edges were not asked for this time, so nothing cached under the previous
  // flags may be reused — a reused slice would smuggle them back in.
  const without = (await analyzeProject(dir, { followReferences: false })).atlas;
  assert.equal(without.meta.incremental.reused, 0);
  assert.ok(!without.edges.some((e) => e.kind === 'references'));

  const withAgain = (await analyzeProject(dir, { followReferences: true })).atlas;
  assert.equal(withAgain.meta.incremental.reused, 0);
  assert.ok(withAgain.edges.some((e) => e.kind === 'references'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('cache: off leaves no trace in the project', async () => {
  const dir = scratch('untouched');
  await analyzeProject(dir, { followReferences: true, cache: 'off' });
  assert.equal(fs.existsSync(path.join(dir, '.app-atlas')), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('cache: refresh reads everything again, then leaves a usable cache', async () => {
  const dir = scratch('refresh');
  await analyzeProject(dir, { followReferences: true });

  const refreshed = (await analyzeProject(dir, { followReferences: true, cache: 'refresh' })).atlas;
  assert.equal(refreshed.meta.incremental.reused, 0);

  const after = (await analyzeProject(dir, { followReferences: true })).atlas;
  assert.equal(after.meta.incremental.reused, 4);
  fs.rmSync(dir, { recursive: true, force: true });
});
