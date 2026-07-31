/**
 * @fileoverview Finding a Python interpreter, talking to it, and saying what went wrong
 * when there isn't one.
 *
 * The extractor runs inside Python because Python's own `ast` module is the only
 * parser guaranteed to agree with the interpreter about what a file says. That trade
 * costs one dependency App Atlas cannot install: an interpreter has to already be
 * there. It usually is — a Python project you can run is a Python project that has one
 * — and when it isn't, the files still appear on the map without their insides.
 *
 * Installed is not the same as working, which M3 learned the hard way from a signed-out
 * agent CLI. On Windows a bare `python3` is often a Microsoft Store stub that prints an
 * advertisement and exits, so every candidate answers a real question before it is
 * trusted.
 *
 * And "no Python here" is not the same as "Python here was too busy to answer" (issue
 * #58). Only the first is something the reader can fix by installing anything, so the
 * search reports which of the two it was and this file owns the words for saying it.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** `ast.unparse`, which every annotation in the output goes through, landed in 3.9. */
const MINIMUM_MINOR = 9;

/**
 * How long one candidate gets to say which version of Python it is.
 *
 * The first answer was five seconds, and a Windows CI runner under load disproved it:
 * four candidates timed out in a row and a machine with Python 3.12 on it was reported
 * as having no Python at all (issue #58). Every `.py` file came back unparsed, the
 * archetype collapsed, and nothing on the page said why.
 *
 * A cold interpreter start is milliseconds when nothing else is happening. An
 * on-access antivirus scan of the binary, a `.venv` on a network share, and a runner
 * whose cores are all committed to another job each add seconds, and they add up rather
 * than replace one another. Thirty is far outside anything a working interpreter needs
 * and still inside what a badly behaved machine can take.
 *
 * Patience is cheap here for two reasons. It is spent once per analysis rather than
 * once per file. And it is only ever spent when something is already wrong: a machine
 * with no Python waits for nothing at all, because the operating system refuses to
 * start a program that is not there and says so immediately.
 */
const DEFAULT_PROBE_TIMEOUT_MS = 30_000;

/** Below this a "timeout" says nothing about the interpreter, only about the clock. */
const MIN_PROBE_MS = 1_000;

/**
 * The wait one candidate gets, in milliseconds.
 *
 * `APP_ATLAS_PYTHON_TIMEOUT` overrides it, in seconds, for a machine stranger than the
 * ones the default was chosen for — the same escape hatch as `APP_ATLAS_PYTHON`, for
 * the same reason: the number above is a good guess and a guess is all it is.
 */
export function probeTimeoutMs(): number {
  const configured = Number.parseFloat(process.env.APP_ATLAS_PYTHON_TIMEOUT ?? '');
  return Number.isFinite(configured) && configured > 0
    ? Math.max(MIN_PROBE_MS, Math.round(configured * 1000))
    : DEFAULT_PROBE_TIMEOUT_MS;
}

/**
 * How long the whole search gets, however many candidates it has to try.
 *
 * A project can offer six candidates — three virtual environment layouts and three
 * names on PATH — and six patient waits in a row is an analysis that looks hung, which
 * is its own kind of dishonesty. One long wait is the point of the number above; the
 * second is there so a machine that is merely slow gets a chance at a different
 * interpreter. After two, waiting longer is not going to change the answer.
 */
function searchBudgetMs(): number {
  return probeTimeoutMs() * 2;
}

/** How many files go to one process. Bounded so a huge repo cannot blow up memory. */
export const BATCH_SIZE = 400;

export interface Interpreter {
  command: string;
  args: string[];
  /** `3.12` — reported in warnings so a version problem is obvious. */
  version: string;
}

/** Where the extractor script sits next to this compiled module. */
export function extractorPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'extract.py');
}

/**
 * What happened when one candidate was asked which version of Python it is.
 *
 * The distinction the rest of this file exists to preserve is between `absent` — there
 * is no such program on this machine, which the reader fixes by installing Python — and
 * `timed-out`, which says the program is there and the machine would not let it answer.
 * Those are different sentences and only one of them is anybody's to act on.
 */
export type ProbeOutcome =
  | { kind: 'ok'; version: string }
  | { kind: 'absent' }
  | { kind: 'timed-out'; waitedMs: number }
  | { kind: 'too-old'; version: string }
  | { kind: 'not-python' };

/**
 * Why the search came back with nothing — the fact the reader is owed, and the one
 * thing that decides whether there is anything for them to go and install.
 */
export type MissingInterpreter =
  | { reason: 'not-found' }
  | { reason: 'timed-out'; command: string; waitedMs: number }
  | { reason: 'too-old'; command: string; version: string };

export interface InterpreterSearch {
  interpreter: Interpreter | null;
  /** Something the user should know about — a bad APP_ATLAS_PYTHON, most likely. */
  warning: string | null;
  /** Why nothing was found. Null whenever an interpreter was. */
  missing: MissingInterpreter | null;
}

/**
 * The first interpreter that answers. A virtual environment inside the project wins,
 * because that is the one the project itself runs on.
 *
 * The whole search is bounded, so a machine where nothing answers still finishes; what
 * it will not do is call a slow machine an empty one without saying so.
 */
export async function findInterpreter(root: string): Promise<InterpreterSearch> {
  const candidates: { command: string; args: string[] }[] = [];
  let warning: string | null = null;
  const failures: MissingInterpreter[] = [];
  const deadline = Date.now() + searchBudgetMs();

  // An explicit setting is tried first and, if it does not answer, said out loud.
  // Silently falling back would leave someone staring at a variable they set correctly
  // pointing at a Python that no longer exists.
  const configured = process.env.APP_ATLAS_PYTHON;
  if (configured) {
    const outcome = await probeInterpreter(configured, [], probeTimeoutMs());
    if (outcome.kind === 'ok') {
      return { interpreter: { command: configured, args: [], version: outcome.version }, warning: null, missing: null };
    }
    warning = `APP_ATLAS_PYTHON is set to ${configured}, which ${refusalOf(outcome)}. Looking elsewhere.`;
    record(failures, configured, outcome);
  }

  for (const dir of ['.venv', 'venv', 'env']) {
    for (const rel of [path.join(dir, 'Scripts', 'python.exe'), path.join(dir, 'bin', 'python')]) {
      const full = path.join(root, rel);
      if (fs.existsSync(full)) candidates.push({ command: full, args: [] });
    }
  }

  if (process.platform === 'win32') {
    // `python3` on Windows is usually the Store stub, so trying it first costs a
    // process start to be told an advertisement. The launcher is the reliable one.
    candidates.push({ command: 'python', args: [] }, { command: 'py', args: ['-3'] }, { command: 'python3', args: [] });
  } else {
    candidates.push({ command: 'python3', args: [] }, { command: 'python', args: [] });
  }

  for (const candidate of candidates) {
    // A candidate that cannot be given a meaningful wait is not asked at all: probing
    // with the dregs of the budget would manufacture a timeout that says nothing.
    const left = Math.min(probeTimeoutMs(), deadline - Date.now());
    if (left < MIN_PROBE_MS) break;
    const outcome = await probeInterpreter(candidate.command, candidate.args, left);
    if (outcome.kind === 'ok') return { interpreter: { ...candidate, version: outcome.version }, warning, missing: null };
    record(failures, candidate.command, outcome);
  }
  return { interpreter: null, warning, missing: interpreterProblem(failures) };
}

/**
 * The one fact to report when several candidates failed in several different ways.
 *
 * A timeout wins, because it is the only outcome that can change on its own: the same
 * command on the same machine tomorrow may answer in a tenth of a second, and telling
 * somebody to install a Python they already have sends them off to fix the wrong thing.
 * A version that is too old comes next, because it names something real that is here.
 * "Nothing was found" is what is left — including the Microsoft Store stub, which is
 * installed, on PATH, and no more use than an empty machine.
 */
export function interpreterProblem(failures: MissingInterpreter[]): MissingInterpreter {
  return (
    failures.find((f) => f.reason === 'timed-out') ??
    failures.find((f) => f.reason === 'too-old') ?? { reason: 'not-found' }
  );
}

/** Keeps the failures worth reporting; a stub or a crash is simply "not found". */
function record(failures: MissingInterpreter[], command: string, outcome: ProbeOutcome): void {
  if (outcome.kind === 'timed-out') failures.push({ reason: 'timed-out', command, waitedMs: outcome.waitedMs });
  else if (outcome.kind === 'too-old') failures.push({ reason: 'too-old', command, version: outcome.version });
}

/**
 * Asks one candidate which version of Python it is, and says what came back.
 *
 * On Windows a bare `python3` is often a Microsoft Store stub that prints an
 * advertisement and exits — installed, on PATH, and completely unable to parse a file.
 * Anything that answers with prose instead of a version number is refused for that
 * reason, and so is anything older than the extractor can use.
 */
export async function probeInterpreter(
  command: string,
  args: string[],
  timeoutMs: number = probeTimeoutMs(),
): Promise<ProbeOutcome> {
  const result = await run(
    command,
    [...args, '-c', 'import sys;print("%d.%d" % sys.version_info[:2])'],
    '',
    timeoutMs,
  );
  if (result.timedOut) return { kind: 'timed-out', waitedMs: timeoutMs };
  // The operating system saying there is no such program is the one refusal that means
  // "nothing is installed". Every other refusal came from something that does exist.
  if (result.startError === 'ENOENT') return { kind: 'absent' };
  if (result.startError || !result.ok) return { kind: 'not-python' };

  const match = /^(\d+)\.(\d+)$/m.exec(result.stdout.trim());
  if (!match) return { kind: 'not-python' };
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const version = `${major}.${minor}`;
  if (major < 3 || (major === 3 && minor < MINIMUM_MINOR)) return { kind: 'too-old', version };
  return { kind: 'ok', version };
}

/** How a single refusal reads inside a sentence about the command that gave it. */
function refusalOf(outcome: ProbeOutcome): string {
  switch (outcome.kind) {
    case 'timed-out':
      return `had said nothing after ${seconds(outcome.waitedMs)}`;
    case 'absent':
      return 'is not on this machine';
    case 'too-old':
      return `is Python ${outcome.version}, and App Atlas needs 3.${MINIMUM_MINOR} or later`;
    default:
      return `did not answer as Python 3.${MINIMUM_MINOR}+`;
  }
}

/**
 * Why a Python file has no insides on the map, written to sit after "could not read
 * this file because…". Carried on every unread file node, so the security screen names
 * the cause beside the file rather than leaving it in a warning nobody scrolled to.
 */
export function unreadReason(missing: MissingInterpreter): string {
  switch (missing.reason) {
    case 'timed-out':
      return `the Python interpreter did not answer within ${seconds(missing.waitedMs)}, so nothing in it was read`;
    case 'too-old':
      return `the only Python here is ${missing.version}, and App Atlas needs 3.${MINIMUM_MINOR} or later`;
    default:
      return `no Python 3.${MINIMUM_MINOR}+ interpreter was available to read it`;
  }
}

/**
 * The warning a reader sees when a Python project was mapped without a Python reader.
 *
 * It says the same thing three ways on purpose: what is missing, what that costs every
 * number in the atlas, and — the part the three cases disagree about — whether there is
 * anything for the reader to go and do.
 */
export function missingInterpreterWarning(missing: MissingInterpreter, fileCount: number): string {
  const files = `${fileCount} Python ${fileCount === 1 ? 'file' : 'files'}`;
  const cost =
    fileCount === 1
      ? 'It is on the map without its insides, so anything it declares — a route, a check, a table — is missing from every number here.'
      : 'They are on the map without their insides, so anything they declare — a route, a check, a table — is missing from every number here.';
  const install = `Install Python 3.${MINIMUM_MINOR} or later, or set APP_ATLAS_PYTHON to point at an interpreter.`;

  switch (missing.reason) {
    case 'timed-out':
      return (
        `Found ${files} but the Python interpreter did not answer in time: ${missing.command} was asked its ` +
        `version and had said nothing after ${seconds(missing.waitedMs)}. That is a busy machine rather than a ` +
        'missing Python, so there is probably nothing for you to install and the next run may read everything. ' +
        `${cost} APP_ATLAS_PYTHON_TIMEOUT sets the wait, in seconds.`
      );
    case 'too-old':
      return (
        `Found ${files} but the only Python here is ${missing.version} (${missing.command}), and App Atlas ` +
        `needs 3.${MINIMUM_MINOR} or later. ${cost} ${install}`
      );
    default:
      return `Found ${files} but no Python 3.${MINIMUM_MINOR}+ to read them with. ${cost} ${install}`;
  }
}

/** `30s`, `1.5s` — a wait as a reader would say it rather than as a timer stores it. */
function seconds(ms: number): string {
  const value = ms / 1000;
  return `${Number.isInteger(value) ? value : value.toFixed(1)}s`;
}

export interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  /** True when the command was still running when its time ran out. */
  timedOut: boolean;
  /**
   * The operating system's own refusal to start the command, when that is what
   * happened. `ENOENT` means there is no such program here — a different fact from a
   * program that started and then failed, and the two lead to different advice.
   */
  startError: string | null;
}

/** Runs a command with JSON on stdin, and never throws. */
export function run(command: string, args: string[], input: string, timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        // `extract.py` lives inside App Atlas, not inside the project being read, so the
        // `__pycache__` CPython would helpfully write goes into App Atlas's own install
        // directory — somebody else's `node_modules`, which may be read-only and is
        // certainly not ours to litter in.
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
      });
    } catch (err) {
      resolve({
        ok: false,
        stdout: '',
        stderr: (err as Error).message,
        timedOut: false,
        startError: codeOf(err),
      });
      return;
    }

    const out: Buffer[] = [];
    const errOut: Buffer[] = [];
    let settled = false;
    const finish = (result: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, stdout: '', stderr: `timed out after ${timeoutMs}ms`, timedOut: true, startError: null });
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => errOut.push(chunk));
    child.on('error', (err: Error) =>
      finish({ ok: false, stdout: '', stderr: err.message, timedOut: false, startError: codeOf(err) }),
    );
    child.on('close', (code) =>
      finish({
        ok: code === 0,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(errOut).toString('utf8'),
        timedOut: false,
        startError: null,
      }),
    );

    child.stdin.on('error', () => undefined);
    child.stdin.end(input);
  });
}

/**
 * The `errno` name behind a failure to start — `ENOENT` for a program that is not
 * there, `EACCES` for one that is but may not be run. Anything without a code still
 * counts as a refusal, because the process never started either way.
 */
function codeOf(err: unknown): string {
  return (err as NodeJS.ErrnoException | undefined)?.code ?? 'ESPAWN';
}
