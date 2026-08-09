/**
 * @fileoverview Zero files that could be read is not zero percent documented (#184).
 *
 * spring-petclinic printed `0% of files have a docstring App Atlas can read (0/0)`
 * one line under the sentence explaining that its 49 Java files were never read — the
 * honest admission contradicted by a grade, and `0%` is the worst mark on the scale.
 * The same empty denominator is reachable on a package whose files are all generated,
 * which #126 says nobody should be documenting anyway.
 *
 * This fixture is the shape at its purest: Java the tool cannot read, a compose file
 * it can, and therefore a real door with no source file behind it.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyzeProject, AtlasGraph, renderAtlasMarkdown } from '../dist/node/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const { atlas } = await analyzeProject(path.join(here, 'fixtures', 'javaonly'), {
  followReferences: true,
  cache: 'off',
});

test('the premise: nothing readable, and the map knows it', () => {
  assert.equal(atlas.meta.stats.files, 0);
  assert.deepEqual(atlas.meta.stats.unreadLanguages, [{ ext: '.java', count: 2 }]);
});

test('ATLAS.md says there was nothing to read, and never prints a percentage', () => {
  const markdown = renderAtlasMarkdown(new AtlasGraph(atlas));
  assert.match(markdown, /No files App Atlas could read, so nothing here is scored/);
  assert.doesNotMatch(markdown, /\d+% of files carry a docstring/);
});

test('the port it can read is still a real door', () => {
  const doors = atlas.nodes.filter((n) => n.kind === 'endpoint');
  assert.equal(doors.length, 1);
  assert.equal(doors[0].meta.endpointKind, 'port');
});
