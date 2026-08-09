/**
 * @fileoverview A Rust workspace that builds a server is not a library (#140).
 *
 * `pub` in a Cargo workspace is not a public API. Rust's module system *forces* it on
 * anything one crate needs another to see, so on a multi-crate repo "exported" describes
 * nearly every internal item there is. With no signal saying the workspace builds
 * something you run, `classifyArchetype` walked past `service`, past `pipeline`, and
 * landed on `library` — at which point `buildExportDoors` turned all of it into the
 * front door. LemmyNet/lemmy reported 1,065 ways in; 13 were real, and the other 1,051
 * were its own internals plus a TypeScript test harness.
 *
 * The signal is Cargo's own and needs no compiler: `src/main.rs` beside a manifest, or
 * a `[[bin]]` section in one. It is the exact counterpart of `<OutputType>Exe`, which
 * `archetype.ts` already carries for the same reason after a WinUI desktop app was
 * handed a public API of 154 of its own window classes.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyzeProject } from '../dist/node/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const { atlas } = await analyzeProject(path.join(here, 'fixtures', 'rustserver'), {
  followReferences: false,
  cache: 'off',
});

const doors = atlas.nodes.filter((n) => n.kind === 'endpoint');

test('the fixture parsed, so a silent failure cannot pass as a pass', () => {
  assert.deepEqual(atlas.meta.warnings, []);
  assert.ok(atlas.nodes.some((n) => n.kind === 'function' && n.name === 'find_account'));
});

test('a workspace with a main.rs is something you run, not something you import', () => {
  assert.equal(atlas.meta.archetype.archetype, 'pipeline');
  assert.equal(atlas.meta.archetype.label, 'Something you run');
});

test('the verdict says which crate made it, so a wrong guess is a bug report', () => {
  assert.ok(
    atlas.meta.archetype.because.some((why) => /crate that builds an executable/.test(why)),
    `expected a crate reason, got ${JSON.stringify(atlas.meta.archetype.because)}`,
  );
});

test('no pub item becomes a door', () => {
  // The regression. Before the fix every one of these was an `export` door, and on a
  // real workspace that is a thousand of them burying the handful that are real.
  const exports = doors.filter((n) => n.meta.endpointKind === 'export');
  assert.deepEqual(exports.map((n) => n.name), []);
});

test('the env var the binary reads is still found', () => {
  // Narrowing the archetype must not cost the map anything it legitimately had.
  const env = doors.find((n) => n.meta.endpointKind === 'env');
  assert.ok(env, 'the env door should survive');
  assert.ok(env.meta.vars.some((v) => v.name === 'SERVER_BIND'));
});
