/**
 * @fileoverview A package of tests is not code other code imports (#174).
 *
 * immich-e2e — 80 files of Playwright and vitest — took the library archetype and
 * published 72 of its fixture generators as "ways in" on the workspace summary,
 * beside immich-web's 58 as if they were the same kind of fact. Nothing imports an
 * e2e suite; its exports are shared between its own specs.
 *
 * The evidence is the manifest, and all three facts are required because each alone
 * describes real packages: no runtime dependencies, a test runner among the dev
 * ones, and no entry point that exists — immich-e2e's `main: index.js` names a file
 * the package does not contain, and an entry point that is not there declares
 * nothing. The counter-fixture is the zero-dependency *library*: same empty deps,
 * same vitest, but its `main` exists, so its exports stay a commitment.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyzeProject } from '../dist/node/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const analyze = (name) =>
  analyzeProject(path.join(here, 'fixtures', name), { followReferences: true, cache: 'off' });

test('a test suite is called one, and its helpers are not doors', async () => {
  const { atlas } = await analyze('tstestpkg');
  assert.equal(atlas.meta.archetype.label, 'A test suite');
  assert.equal(atlas.meta.archetype.archetype, 'unknown');
  const exportDoors = atlas.nodes.filter((n) => n.kind === 'endpoint' && n.meta.endpointKind === 'export');
  assert.equal(exportDoors.length, 0, exportDoors.map((n) => n.name).join(', '));
});

test('a zero-dependency library whose main exists keeps its API', async () => {
  const { atlas } = await analyze('tszerodep');
  assert.equal(atlas.meta.archetype.archetype, 'library');
  const exportDoors = atlas.nodes.filter((n) => n.kind === 'endpoint' && n.meta.endpointKind === 'export');
  assert.ok(exportDoors.length > 0, 'clamp is somebody\'s API');
});
