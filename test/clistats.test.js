/**
 * @fileoverview The stats the CLI writes are the stats the analyzer computed (#270).
 *
 * `produceAtlas` counts the numbers again after the words layer, because descriptions are
 * written and stale docstrings flagged once the first count is already done. It counts
 * from **nodes** — so any stat that is *about things which never became nodes* has to be
 * carried across by hand or it is silently discarded.
 *
 * That has now happened twice. #171 lost the unread-backbone hedge and huginn printed its
 * unhedged sliver again; the fix carried `unreadLanguages` over and left a comment saying
 * why. #257 then added `unreadFrameworks` — a stat of exactly that kind, for exactly that
 * reason — and the recount ate it too. Every CLI run since #263 gave an Axum crate no auth
 * sentence at all, while the archetype on the same map said its routes were unread.
 *
 * ## Why this test spawns the CLI
 *
 * Because nothing else does, and that is the whole reason the defect survived. The suite
 * was green throughout: `rustrocket.test.js` asserted `stats.unreadFrameworks` through
 * `analyzeProject`, which computes it correctly and always did. The broken path was the
 * one every user takes and no test took.
 *
 * So this runs `dist/node/cli.js analyze` and reads the file it writes, in a scratch copy
 * so no fixture acquires an `.app-atlas` directory or a `.gitignore` line.
 *
 * ## The vacuity guard
 *
 * Each case asserts the framework is still **detected** before asserting the caveat. #138
 * is the reason: a licensing test that checked for a license without first checking the
 * font was still there would have passed by dropping the font. Delete Axum from
 * `RUST_ROUTES_NOT_READ` and these must fail loudly rather than quietly agree.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { authHeadline } from '../dist/node/model/exposure.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, '..', 'dist', 'node', 'cli.js');

/** Run the real CLI over a throwaway copy, and hand back the atlas it wrote. */
function analyzeWithTheCli(fixture) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-cli-'));
  const root = path.join(dir, fixture);
  fs.cpSync(path.join(here, 'fixtures', fixture), root, { recursive: true });
  execFileSync(process.execPath, [CLI, 'analyze', root, '--no-ai', '--quiet'], {
    stdio: 'pipe',
    encoding: 'utf8',
  });
  return JSON.parse(fs.readFileSync(path.join(root, '.app-atlas', 'atlas.json'), 'utf8'));
}

const axum = analyzeWithTheCli('rustaxum');

test('the crate parsed and Axum is named, so the caveat cannot pass vacuously', () => {
  assert.deepEqual(axum.meta.warnings, []);
  assert.ok(axum.meta.frameworks.includes('Axum'), JSON.stringify(axum.meta.frameworks));
  assert.equal(axum.meta.stats.routes, 0, 'no reader runs for Axum — that is the premise');
});

test('the CLI writes the unread-framework fact, it does not count it away', () => {
  // The defect, in one assertion. `analyzeProject` had this right the whole time; the
  // recount in `produceAtlas` dropped it on the floor between there and disk.
  assert.deepEqual(axum.meta.stats.unreadFrameworks, ['Axum']);
});

test('so a reader gets the sentence rather than silence', () => {
  // What the missing stat cost: `authHeadline` returns null at zero routes unless it is
  // told a framework went unread, and a null headline is how a service with real routes
  // got no auth line at all — the exact failure #257 was filed for, arriving by a
  // different route after #263 was supposed to have ended it.
  const headline = authHeadline(axum.meta.stats);
  assert.ok(headline, 'a crate with an unread framework got no auth sentence');
  assert.equal(headline.tone, 'warn');
  assert.match(headline.headline, /Axum/);
  assert.match(headline.headline, /never in view/);
});

test('the archetype and the auth column agree, which is what #257 is about', () => {
  // They disagreed: the archetype kept its reason, because it is computed once and
  // stored, while the stat feeding the auth sentence was recomputed and lost. A map
  // contradicting itself on one screen is the thing that made this checkable.
  assert.ok(
    axum.meta.archetype.because.some((why) => /Axum declared, whose routes App Atlas does not read/.test(why)),
    JSON.stringify(axum.meta.archetype.because),
  );
  assert.ok(!axum.meta.archetype.because.includes('nothing answers a URL'));
});
