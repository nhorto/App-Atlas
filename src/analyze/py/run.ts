/**
 * @fileoverview Finding a Python interpreter, and talking to it.
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
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** `ast.unparse`, which every annotation in the output goes through, landed in 3.9. */
const MINIMUM_MINOR = 9;

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

export interface InterpreterSearch {
  interpreter: Interpreter | null;
  /** Something the user should know about — a bad APP_ATLAS_PYTHON, most likely. */
  warning: string | null;
}

/**
 * The first interpreter that answers. A virtual environment inside the project wins,
 * because that is the one the project itself runs on.
 */
export async function findInterpreter(root: string): Promise<InterpreterSearch> {
  const candidates: { command: string; args: string[] }[] = [];
  let warning: string | null = null;

  // An explicit setting is tried first and, if it does not answer, said out loud.
  // Silently falling back would leave someone staring at a variable they set correctly
  // pointing at a Python that no longer exists.
  const configured = process.env.APP_ATLAS_PYTHON;
  if (configured) {
    const version = await probe(configured, []);
    if (version) return { interpreter: { command: configured, args: [], version }, warning: null };
    warning = `APP_ATLAS_PYTHON is set to ${configured}, which did not answer as Python ${MINIMUM_MINOR}+. Looking elsewhere.`;
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
    const version = await probe(candidate.command, candidate.args);
    if (version) return { interpreter: { ...candidate, version }, warning };
  }
  return { interpreter: null, warning };
}

/**
 * Asks for a version and refuses anything that answers with prose instead.
 *
 * On Windows a bare `python3` is often a Microsoft Store stub that prints an
 * advertisement and exits — installed, on PATH, and completely unable to parse a file.
 */
async function probe(command: string, args: string[]): Promise<string | null> {
  const result = await run(command, [...args, '-c', 'import sys;print("%d.%d" % sys.version_info[:2])'], '', 5000);
  if (!result.ok) return null;
  const match = /^(\d+)\.(\d+)$/m.exec(result.stdout.trim());
  if (!match) return null;
  const [major, minor] = [Number(match[1]), Number(match[2])];
  if (major < 3 || (major === 3 && minor < MINIMUM_MINOR)) return null;
  return `${major}.${minor}`;
}

export interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** Runs a command with JSON on stdin, and never throws. */
export function run(command: string, args: string[], input: string, timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      resolve({ ok: false, stdout: '', stderr: (err as Error).message });
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
      finish({ ok: false, stdout: '', stderr: `timed out after ${timeoutMs}ms` });
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => errOut.push(chunk));
    child.on('error', (err: Error) => finish({ ok: false, stdout: '', stderr: err.message }));
    child.on('close', (code) =>
      finish({
        ok: code === 0,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(errOut).toString('utf8'),
      }),
    );

    child.stdin.on('error', () => undefined);
    child.stdin.end(input);
  });
}
