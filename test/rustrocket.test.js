/**
 * @fileoverview A framework we name but do not read is not "nothing answers a URL" (#257).
 *
 * `dani-garcia/vaultwarden` declares 305 Rocket routes across 60 Rust files. App Atlas
 * reported zero, and then said why: `"because": ["a crate that builds an executable",
 * "nothing answers a URL"]` — about a password server, in an atlas whose own framework
 * list on the same screen read `["Diesel", "Rocket"]`. There was no auth headline at
 * all, because `authHeadline` returns null at zero routes.
 *
 * Declining to read Rocket's routes is a defensible decision and it stands; the file
 * that declines says so in writing. Turning that decision into a positive finding is
 * the move this project treats as unrecoverable, and it is the whole of the bug. The
 * existing caveat could not catch it: that one is keyed on unparseable file extensions,
 * and Rust files parse fine. The gap was "parsed, but no route reader for this
 * framework", which nothing expressed.
 *
 * The control is Tauri, in `rustarchetype.test.js`'s neighbour fixture — its commands
 * *are* read, so a Tauri crate with no doors really has none and must keep saying so.
 * A fix that quiets every Rust crate would pass every assertion here and be wrong.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyzeProject } from '../dist/node/index.js';
import { authHeadline } from '../dist/node/model/exposure.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const analyze = (name) =>
  analyzeProject(path.join(here, 'fixtures', name), { followReferences: false, cache: 'off' });

const { atlas } = await analyze('rustrocket');
const { atlas: tauri } = await analyze('rustengine');

test('the fixture parsed, so a silent failure cannot pass as a pass', () => {
  assert.deepEqual(atlas.meta.warnings, []);
  assert.ok(atlas.nodes.some((n) => n.kind === 'function' && n.name === 'bind_address'));
});

test('Rocket is still detected and named — the contradiction was internal', () => {
  // The fact that made this checkable rather than merely absent: the tool knew.
  assert.ok(atlas.meta.frameworks.includes('Rocket'), JSON.stringify(atlas.meta.frameworks));
});

test('the routes are still not read, because that is not what this fixes', () => {
  // Scope marker. #257 splits in two and this is only the first half; when someone
  // writes the Rocket reader, this assertion is the one that should fail and be
  // deleted, and the caveat assertions below should fail with it.
  assert.equal(atlas.meta.stats.routes, 0);
});

test('the archetype no longer claims nothing answers a URL', () => {
  const because = atlas.meta.archetype.because;
  assert.ok(
    !because.includes('nothing answers a URL'),
    `the claim survived: ${JSON.stringify(because)}`,
  );
  assert.ok(
    because.some((why) => /Rocket declared, whose routes App Atlas does not read/.test(why)),
    `expected the caveat, got ${JSON.stringify(because)}`,
  );
});

test('the archetype itself is unchanged — Cargo settled that separately', () => {
  // The evidence for "something you run" is `src/main.rs` beside a manifest, which has
  // nothing to do with the route question. Suppressing the claim must not cost #140's
  // fix, or a Rust workspace goes back to being a library with 971 public internals.
  assert.equal(atlas.meta.archetype.archetype, 'pipeline');
  assert.equal(atlas.meta.archetype.label, 'Something you run');
  assert.ok(atlas.meta.archetype.because.some((why) => /crate that builds an executable/.test(why)));
});

test('the auth sentence exists at all, and hedges instead of staying silent', () => {
  const headline = authHeadline(atlas.meta.stats);
  assert.ok(headline, 'authHeadline returned null — a password server got no auth sentence');
  assert.equal(headline.tone, 'warn');
  assert.match(headline.headline, /Rocket/);
  assert.match(headline.headline, /never in view/);
});

test('the fact is on the atlas, so every surface reads the same one', () => {
  // Stamped from the manifest rather than derived from nodes: no node exists for a
  // route nobody read, so nothing downstream could recover this on its own.
  assert.deepEqual(atlas.meta.stats.unreadFrameworks, ['Rocket']);
});

test('Tauri is the control: its commands are read, so its silence is earned', () => {
  assert.ok(tauri.meta.frameworks.includes('Tauri'), JSON.stringify(tauri.meta.frameworks));
  assert.equal(tauri.meta.stats.unreadFrameworks, undefined);
  assert.ok(
    tauri.meta.archetype.because.includes('nothing answers a URL'),
    `a Tauri crate must keep the claim, got ${JSON.stringify(tauri.meta.archetype.because)}`,
  );
});
