/**
 * @fileoverview A backbone that belongs to no package still belongs to the repository (#273).
 *
 * discourse is a Rails application. App Atlas read it as 52 npm packages — `discourse`,
 * `pretty-text`, `asset-processor` — printed 2,227 ways in beside the first of them, and
 * never once said the word Ruby. 11,133 `.rb` files, `config/routes.rb` alone 1,993 lines,
 * and not a number in the output was drawn from any of it.
 *
 * The hedge for exactly this exists and is three years' worth of settled (#171: huginn's
 * 469 Ruby files mapped as "18 files, 1 way in"). It could not fire, because it is
 * computed **per map** and a map is one scope: every discourse scope is under `frontend/`
 * or `plugins/`, the Rails application is in none of them, and a language that belongs to
 * no scope has no map to appear on.
 *
 * ## Why the root-scope rule did not catch it either
 *
 * #185 adds the repo itself as a scope "when most of the code is not in any package",
 * which is this repository to the letter. Measured:
 *
 * ```
 * frontend/discourse   2,067 readable files
 * the repo root          146 readable files   …and 7,153 Ruby ones
 * ```
 *
 * `measure()` weighs scopes by `SOURCE_GLOB`, so the root loses fourteen to one on the
 * strength of files it does not count. The language App Atlas cannot read is structurally
 * the one guaranteed to lose the scope that would have hedged for it.
 *
 * That is not fixed by reweighing `measure()`. A root scope on discourse is a second
 * analysis of all 52 packages merged into one map — the hairball SPEC 5.6 exists to
 * avoid, ~100s of work — to deliver one sentence. So the sentence is said once, at the
 * level it is true of, which is what `repoPublishedPorts` already does for the repo's own
 * published ports.
 *
 * ## Why this test spawns the CLI
 *
 * Because the workspace listing is printed and nothing else, and #270 is the precedent:
 * "the broken path was the one every user takes and no test took". `findWorkspace` and
 * `analyzeProject` are both correct here and always were — neither is on the path where
 * the sentence goes missing.
 *
 * ## The control is the same fixture with the Ruby removed
 *
 * A hedge that fires everywhere is worth as much as one that fires nowhere (#116). The
 * second case deletes `app/` and `config/` from the copy and asserts silence, so the only
 * difference between a repo that gets the sentence and one that does not is the thing the
 * sentence is about.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, '..', 'dist', 'node', 'cli.js');

/** A throwaway copy, so no fixture acquires an `.app-atlas` directory. */
function copyOf(fixture) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-backbone-'));
  const root = path.join(dir, fixture);
  fs.cpSync(path.join(here, 'fixtures', fixture), root, { recursive: true });
  return root;
}

function runTheCli(root, ...args) {
  return execFileSync(process.execPath, [CLI, 'analyze', root, '--no-ai', ...args], {
    stdio: 'pipe',
    encoding: 'utf8',
  });
}

const workspace = runTheCli(copyOf('rubybackbone'));

test('the workspace listing ran, so a missing sentence cannot pass as a silent one', () => {
  // The vacuity guard. Delete a package and these fail loudly rather than quietly agreeing
  // that no hedge was needed — a listing that never printed has nothing to hedge.
  assert.match(workspace, /2 packages in this workspace/);
  assert.match(workspace, /\bweb\b/);
  assert.match(workspace, /\badmin\b/);
});

test('a language in no package is still said, above the packages that are not it', () => {
  assert.match(workspace, /most of this repository is 8 Ruby files, which App Atlas cannot read/);
  // The readable side named too, because "cannot read" without a denominator is a mood
  // rather than a fact: 8 against 2 is what makes the 2 worth discounting.
  assert.match(workspace, /every package below is drawn from the 2 files it can/);
  // Above everything it discredits (#171), not filed under it. A reader who has already
  // formed a picture from two confident package lines is not un-forming it afterwards.
  const hedge = workspace.indexOf('most of this repository is 8 Ruby files');
  const firstPackageLine = workspace.search(/^ {2}web {2,}\d+ file/m);
  assert.ok(firstPackageLine > 0, 'no package line to be above');
  assert.ok(hedge > 0 && hedge < firstPackageLine, 'the hedge printed below the list it is about');
});

test('with the Ruby gone the same workspace says nothing at all', () => {
  const root = copyOf('rubybackbone');
  fs.rmSync(path.join(root, 'app'), { recursive: true });
  fs.rmSync(path.join(root, 'config'), { recursive: true });
  const output = runTheCli(root);

  assert.match(output, /2 packages in this workspace/, 'the listing still ran');
  assert.doesNotMatch(output, /cannot read/);
});

test('narrowing to one package does not narrow the repository around it', () => {
  // `--scope web` is somebody choosing one of 52 packages, not somebody saying the other
  // 51 and the Rails application do not exist. The package itself is readable TypeScript,
  // so its own hedge is correctly silent and the repo's has to speak in its place.
  const output = runTheCli(copyOf('rubybackbone'), '--scope', 'web');

  assert.match(output, /1 way in|1 route/, 'the package was analyzed, so silence would mean the defect');
  assert.match(
    output,
    /most of the repository around this package is 8 Ruby files, which App Atlas cannot read/,
  );
  assert.match(output, /the numbers below cover this package only/);
});
