/**
 * @fileoverview The two things that happen before the command loads.
 *
 * Both are about somebody's first contact with this tool, and both are invisible from
 * inside the process that gets them right — an ESM import is hoisted above every
 * statement written beside it, so a guard that lives in the command runs after the
 * import it was meant to guard. That is why `cli.ts` is a preflight and `main.ts` is
 * the command, and why these tests spawn the real binary rather than importing it.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { isSqliteExperimentalWarning, nodeIsTooOld } from '../dist/node/preflight.js';

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, '..', 'dist', 'node', 'cli.js');

// ---------------------------------------------------------------------------
// Node's version (#112)
// ---------------------------------------------------------------------------

/**
 * Runs the published entry point with `process.versions.node` lied about.
 *
 * A loader is the only way to test this without an actual Node 20 on the machine, and
 * it exercises the real file: the guard reads `process.versions.node` exactly as it
 * would on somebody's old install.
 */
async function withNodeVersion(version) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-pre-'));
  try {
    const shim = path.join(dir, 'shim.mjs');
    fs.writeFileSync(
      shim,
      `Object.defineProperty(process.versions, 'node', { value: ${JSON.stringify(version)}, configurable: true });\n` +
        `await import(${JSON.stringify(CLI)});\n`,
    );
    try {
      const { stdout, stderr } = await run(process.execPath, [shim, '--version'], { cwd: dir });
      return { code: 0, stdout, stderr };
    } catch (err) {
      return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('an old Node gets a sentence, not a stack trace', async () => {
  // `engines` is not enforced by npx or npm install — they warn at most, and the
  // warning scrolls past. Before this, Node 20 met App Atlas with `SyntaxError: The
  // requested module 'node:sqlite' does not provide an export named 'DatabaseSync'`,
  // which nobody reads as "my Node is old".
  const { code, stderr } = await withNodeVersion('20.11.0');
  assert.equal(code, 1, 'and it exits non-zero, so a script knows too');
  assert.match(stderr, /needs Node 22\.5 or newer/);
  assert.match(stderr, /you have 20\.11\.0/, 'the version they have is named');
  assert.doesNotMatch(stderr, /DatabaseSync|SyntaxError|at .*\.js:\d+/, 'no stack trace survives');
});

test('the floor is a floor, not an equality', async () => {
  // 22.4 is below it and 24 is above it. A check written as a string compare would
  // get the second of these wrong, and "24" < "22.5" is exactly the shape of bug that
  // ships quietly.
  assert.equal((await withNodeVersion('22.4.0')).code, 1);
  assert.equal((await withNodeVersion('24.0.0')).code, 0);
  assert.equal((await withNodeVersion('22.5.0')).code, 0, 'the floor itself is allowed');
});

// ---------------------------------------------------------------------------
// Node's warning about its own experiment (#114)
// ---------------------------------------------------------------------------

test('the first two lines are ours, not Node\'s roadmap', async () => {
  // `node:sqlite` is marked experimental, so every command opened with two lines
  // about somebody else's plans before App Atlas said anything at all.
  const { stdout, stderr } = await run(process.execPath, [CLI, '--version']);
  assert.match(stdout.trim(), /^\d+\.\d+\.\d+$/);
  assert.doesNotMatch(stderr, /ExperimentalWarning/);
  assert.doesNotMatch(stderr, /trace-warnings/);
});

test('every other warning still reaches the reader', () => {
  // Suppressed by type *and* text, never wholesale: `--no-warnings` would have been
  // one flag and would have hidden deprecations and unhandled rejections with it. A
  // warning nobody expected is exactly when somebody needs to see one.
  assert.equal(isSqliteExperimentalWarning('SQLite is an experimental feature', 'ExperimentalWarning'), true);
  assert.equal(isSqliteExperimentalWarning('Fetch API is an experimental feature', 'ExperimentalWarning'), false);
  assert.equal(isSqliteExperimentalWarning('SQLite is going away', 'DeprecationWarning'), false);
  assert.equal(isSqliteExperimentalWarning(new Error('SQLite is an experimental feature'), { type: 'ExperimentalWarning' }), true);
});

test('the floor is compared as numbers, not as text', () => {
  // '24.0.0' < '22.5.0' as strings, which would have made every future Node an
  // unsupported one — quietly, for everybody, on the day 24 shipped.
  assert.equal(nodeIsTooOld('20.11.0'), true);
  assert.equal(nodeIsTooOld('22.4.9'), true);
  assert.equal(nodeIsTooOld('22.5.0'), false, 'the floor itself is allowed');
  assert.equal(nodeIsTooOld('24.0.0'), false);
  assert.equal(nodeIsTooOld('100.0.0'), false);
});
