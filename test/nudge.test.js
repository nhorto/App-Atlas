/**
 * @fileoverview What the run says about docstrings, and when it says nothing (#124).
 *
 * A repo where every file carried a docstring was congratulated on 100% coverage and
 * then, in the same sentence, instructed to go and teach its agent to write docstrings.
 * The nudge was printed unconditionally — the tool was not reading its own number.
 *
 * Small, but it sits directly under the auth headline, which is the one line here that
 * most needs believing. A tool that argues with its own arithmetic in public is trusted
 * slightly less on the arithmetic that matters, and this one punished exactly the
 * behaviour the product spends a whole subcommand asking for.
 *
 * Spawned rather than imported: the sentence only exists in the CLI's own output, and a
 * unit test of a string builder would not have caught a wrong branch in the printing.
 * Each run works on a copy, so no fixture gains an `.app-atlas/` directory.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, '..', 'dist', 'node', 'cli.js');

/** Analyzes a throwaway copy of a fixture and returns what the CLI printed. */
async function analyze(fixture) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-nudge-'));
  try {
    fs.cpSync(path.join(here, 'fixtures', fixture), dir, { recursive: true });
    const { stdout } = await run(process.execPath, [CLI, 'analyze', dir, '--no-ai'], { cwd: dir });
    return stdout;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('a repo that documented everything is not told to go and document it', async () => {
  const out = await analyze('documented');
  assert.match(out, /100% of files have a docstring/, 'the number is still worth printing');
  assert.doesNotMatch(out, /app-atlas init/, 'the instruction is not');
});

test('a repo that documented nothing still gets told how', async () => {
  // The other half of the branch. Suppressing the nudge everywhere would have been a
  // smaller diff and the wrong fix — the line earns its place on almost every repo.
  const out = await analyze('exposure');
  assert.match(out, /0% of files have a docstring/);
  assert.match(out, /app-atlas init/, 'where there is something to teach, it still teaches');
});
