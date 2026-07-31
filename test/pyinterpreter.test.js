/**
 * @fileoverview What App Atlas says when it cannot find a Python to read Python with.
 *
 * Issue #58: a Windows CI runner under load timed out four interpreter probes in a row,
 * and a machine with Python 3.12 installed was reported as having no Python at all. Every
 * `.py` file came back unparsed, the archetype collapsed, the security screen named three
 * files it could not read instead of one — and nothing anywhere said that the reason was
 * a busy machine rather than a missing interpreter.
 *
 * None of these tests may depend on a slow machine, because a test that only passes under
 * load is a test that never runs. The interpreter that "never answers" here is a real
 * program that really sleeps for a minute, probed with a wait of one second, so the
 * timeout is a fact about the fixture and not about the runner.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyzeProject } from '../dist/node/index.js';
import {
  findInterpreter,
  interpreterProblem,
  missingInterpreterWarning,
  probeInterpreter,
  probeTimeoutMs,
  run,
  unreadReason,
} from '../dist/node/analyze/py/run.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PYAPP = path.join(here, 'fixtures', 'pyapp');

// Node is the one interpreter every machine running this suite is guaranteed to have, so
// the fakes are Node scripts. `probeInterpreter` appends `-c <python snippet>` to whatever
// arguments it is given; a script file ignores the extra argument, which is exactly the
// indifference a real interpreter shows to a question it has already answered.
const fakes = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-fake-python-'));
const fake = (name, body) => {
  const file = path.join(fakes, `${name}.js`);
  fs.writeFileSync(file, body);
  return [process.execPath, [file]];
};

const [node, hangs] = fake('hangs', 'setTimeout(() => {}, 60_000);\n');
const [, says312] = fake('says312', 'console.log("3.12");\n');
const [, says37] = fake('says37', 'console.log("3.7");\n');
const [, advertises] = fake(
  'advertises',
  // What a Microsoft Store stub does: exits zero, having said nothing about Python.
  'console.log("Python was not found; run without arguments to install from the Microsoft Store");\n',
);
const NOWHERE = 'app-atlas-no-such-python-b1a7f0';

after(() => fs.rmSync(fakes, { recursive: true, force: true }));

// ---------------------------------------------------------------------------
// The bound itself

test('a command that is still running when its time is up is reported as a timeout', async () => {
  const result = await run(node, hangs, '', 400);
  assert.equal(result.timedOut, true);
  assert.equal(result.ok, false);
  assert.equal(result.startError, null, 'it started perfectly well; it just never finished');
});

test('a command that is not on this machine is reported as never having started', async () => {
  const result = await run(NOWHERE, [], '', 400);
  assert.equal(result.startError, 'ENOENT');
  assert.equal(result.timedOut, false, 'nothing was waited for, so nothing timed out');
});

test('the probe waits thirty seconds by default, and honours an override in seconds', () => {
  delete process.env.APP_ATLAS_PYTHON_TIMEOUT;
  assert.equal(probeTimeoutMs(), 30_000);
  process.env.APP_ATLAS_PYTHON_TIMEOUT = '90';
  assert.equal(probeTimeoutMs(), 90_000);
  // A wait shorter than a second says something about the clock rather than about the
  // interpreter, so the floor holds even when someone asks for less.
  process.env.APP_ATLAS_PYTHON_TIMEOUT = '0.01';
  assert.equal(probeTimeoutMs(), 1_000);
  process.env.APP_ATLAS_PYTHON_TIMEOUT = 'soon';
  assert.equal(probeTimeoutMs(), 30_000, 'nonsense falls back rather than disabling the bound');
  delete process.env.APP_ATLAS_PYTHON_TIMEOUT;
});

// ---------------------------------------------------------------------------
// Five ways a candidate can fail, and only one of them means "install Python"

test('an interpreter that does not answer in time is a timeout, not an absence', async () => {
  assert.deepEqual(await probeInterpreter(node, hangs, 400), { kind: 'timed-out', waitedMs: 400 });
});

test('an interpreter that is not installed is absent', async () => {
  assert.deepEqual(await probeInterpreter(NOWHERE, [], 4_000), { kind: 'absent' });
});

test('a Python older than 3.9 is named, not merely refused', async () => {
  assert.deepEqual(await probeInterpreter(node, says37, 4_000), { kind: 'too-old', version: '3.7' });
});

test('a Store stub answers with prose and is refused for it', async () => {
  assert.deepEqual(await probeInterpreter(node, advertises, 4_000), { kind: 'not-python' });
});

test('anything from 3.9 up is accepted, and says which version it is', async () => {
  assert.deepEqual(await probeInterpreter(node, says312, 4_000), { kind: 'ok', version: '3.12' });
});

// ---------------------------------------------------------------------------
// Which failure gets reported when several candidates fail differently

test('a timeout outranks everything, because it is the one that can change on its own', () => {
  const problem = interpreterProblem([
    { reason: 'too-old', command: 'python', version: '3.7' },
    { reason: 'timed-out', command: '/proj/.venv/bin/python', waitedMs: 30_000 },
  ]);
  assert.equal(problem.reason, 'timed-out');
});

test('a Python that is too old outranks having found nothing at all', () => {
  assert.deepEqual(interpreterProblem([{ reason: 'too-old', command: 'python', version: '3.7' }]), {
    reason: 'too-old',
    command: 'python',
    version: '3.7',
  });
});

test('a Store stub leaves nothing worth reporting, so the answer is "not found"', () => {
  assert.deepEqual(interpreterProblem([]), { reason: 'not-found' });
});

// ---------------------------------------------------------------------------
// The words the reader actually reads

test('a missing interpreter tells the reader to install one', () => {
  const warning = missingInterpreterWarning({ reason: 'not-found' }, 5);
  assert.match(warning, /^Found 5 Python files but no Python 3\.9\+ to read them with\./);
  assert.match(warning, /missing from every number here/);
  assert.match(warning, /Install Python 3\.9 or later/);
});

test('an interpreter that ran out of time says so, and does not send anyone shopping', () => {
  const warning = missingInterpreterWarning(
    { reason: 'timed-out', command: '/usr/bin/python3', waitedMs: 30_000 },
    5,
  );
  assert.match(warning, /did not answer in time/);
  assert.match(warning, /\/usr\/bin\/python3 was asked its version and had said nothing after 30s/);
  assert.match(warning, /busy machine rather than a missing Python/);
  assert.match(warning, /APP_ATLAS_PYTHON_TIMEOUT sets the wait/);
  assert.doesNotMatch(warning, /Install Python/, 'there is nothing to install; that is the whole point');
});

test('a Python that is too old names the version it found', () => {
  const warning = missingInterpreterWarning({ reason: 'too-old', command: 'python', version: '3.7' }, 1);
  assert.match(warning, /^Found 1 Python file but the only Python here is 3\.7 \(python\)/);
  assert.match(warning, /It is on the map without its insides/);
  assert.match(warning, /Install Python 3\.9 or later/);
});

test('every unread file carries the cause, not just the fact', () => {
  assert.equal(unreadReason({ reason: 'not-found' }), 'no Python 3.9+ interpreter was available to read it');
  assert.equal(
    unreadReason({ reason: 'timed-out', command: 'python3', waitedMs: 30_000 }),
    'the Python interpreter did not answer within 30s, so nothing in it was read',
  );
  assert.equal(
    unreadReason({ reason: 'too-old', command: 'python3', version: '3.8' }),
    'the only Python here is 3.8, and App Atlas needs 3.9 or later',
  );
});

// ---------------------------------------------------------------------------
// End to end, on a machine with one interpreter that never replies
//
// The fake has to be an executable the operating system will start, and on Windows that
// means a real `Scripts\python.exe` — a compiled binary this suite has no way to produce.
// The bound itself is covered above on every platform; what is left below is the wiring,
// which is not where the OS difference lives.

const posix = process.platform === 'win32' ? 'a fake interpreter needs a real .exe on Windows' : false;

/** A copy of the Python fixture whose only interpreter sleeps for a minute. */
function projectWithADeafInterpreter() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-deaf-python-'));
  fs.cpSync(PYAPP, dir, { recursive: true });
  const bin = path.join(dir, '.venv', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  // Node by absolute path, because the test below empties PATH and a `#!/bin/sh` script
  // would then be unable to find any command to sleep with — it would exit instantly and
  // prove the opposite of what it is here to prove.
  fs.writeFileSync(path.join(bin, 'python'), `#!${process.execPath}\nsetTimeout(() => {}, 60_000);\n`, {
    mode: 0o755,
  });
  return dir;
}

/**
 * Runs `body` on a machine that has no Python anywhere except the one the fixture holds.
 *
 * Emptying PATH is what makes this deterministic rather than a question about whoever's
 * laptop is running the suite: `python3` and `python` are then refused by the operating
 * system instantly, and the fixture's own absolute path is the only candidate left.
 */
async function onAMachineWithOnlyThatInterpreter(body) {
  const saved = { ...process.env };
  process.env.PATH = '';
  delete process.env.APP_ATLAS_PYTHON;
  process.env.APP_ATLAS_PYTHON_TIMEOUT = '1';
  try {
    return await body();
  } finally {
    process.env.PATH = saved.PATH ?? '';
    if (saved.APP_ATLAS_PYTHON) process.env.APP_ATLAS_PYTHON = saved.APP_ATLAS_PYTHON;
    delete process.env.APP_ATLAS_PYTHON_TIMEOUT;
  }
}

test('the search names the interpreter that never replied', { skip: posix }, async () => {
  const dir = projectWithADeafInterpreter();
  const search = await onAMachineWithOnlyThatInterpreter(() => findInterpreter(dir));
  assert.equal(search.interpreter, null);
  assert.equal(search.missing.reason, 'timed-out', 'not "not-found" — something was there');
  assert.match(search.missing.command, /\.venv[/\\]bin[/\\]python$/);
  assert.equal(search.missing.waitedMs, 1_000);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a Python project read without Python says so, and says why', { skip: posix }, async () => {
  const dir = projectWithADeafInterpreter();
  const { atlas } = await onAMachineWithOnlyThatInterpreter(() =>
    analyzeProject(dir, { followReferences: true, cache: 'off' }),
  );
  fs.rmSync(dir, { recursive: true, force: true });

  const warning = atlas.meta.warnings.find((w) => /Python/.test(w));
  assert.ok(warning, 'the atlas has to carry the reason, whatever any screen does with it');
  assert.match(warning, /did not answer in time/);
  assert.match(warning, /busy machine rather than a missing Python/);

  // The five fixture files are all on the map, and every one of them says it was not read
  // — the fact the security screen reads to caveat its own numbers.
  const files = atlas.nodes.filter((node) => node.kind === 'file' && node.language === 'python');
  assert.equal(files.length, 5);
  assert.equal(atlas.meta.stats.unreadFiles, 5);
  assert.ok(
    files.every((file) => /did not answer within 1s/.test(String(file.meta.unread))),
    'the cause travels on the file, so it survives into the atlas and onto the screen',
  );
});
