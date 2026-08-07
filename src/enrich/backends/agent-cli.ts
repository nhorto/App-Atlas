/**
 * @fileoverview Backends that borrow the agent CLI the user already has.
 *
 * This is the flagship backend, and the reason is demographic: the people this tool
 * is built for steer Claude Code, Codex or OpenCode every day. They have a
 * *subscription*, not an API key. Running enrichment through the CLI they already
 * pay for makes plain-English explanations free at the margin and needs no setup, no
 * key, and no account — which is the difference between a feature people turn on and
 * a feature people read about.
 *
 * Three things here are not obvious, and all three are load-bearing:
 *
 * 1. **Nothing from the project ever reaches the command line.** Prompts go in on
 *    stdin. Fixed flags are the only argv, so there is no quoting hazard and no way
 *    for a file path or a table name in someone's repo to become part of a command.
 *
 * 2. **The inherited environment is scrubbed.** App Atlas is very often run from
 *    inside an agent session — that is the whole audience — and a parent session
 *    exports variables that point a child CLI at a gateway it has no credentials
 *    for. Left alone, passthrough fails exactly for the users most likely to want it.
 *
 * 3. **Installed is not the same as working.** A CLI can be present and signed out,
 *    and it will still exit zero while printing its complaint to stdout. Every
 *    backend proves itself with one throwaway question before we trust a word of it.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { EnrichBackend, EnrichReply, EnrichRequest } from '../types.js';

/** Agent CLIs start a whole runtime per call; a handful at once is plenty. */
const CONCURRENCY = 3;
const PROBE_TIMEOUT_MS = 60_000;
const REQUEST_TIMEOUT_MS = 180_000;
const PROBE_TOKEN = 'ATLAS_READY';

interface CliSpec {
  id: string;
  label: string;
  command: string;
  /** Fixed arguments. Never interpolated with anything from the analyzed project. */
  args: (model: string | undefined, outFile: string) => string[];
  /** Some CLIs write their answer to a file instead of stdout. */
  usesOutputFile?: boolean;
  /** Pull the answer out of whatever the tool printed. */
  parse?: (stdout: string) => EnrichReply | { error: string };
}

const CLIS: CliSpec[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    command: 'claude',
    // --output-format json is what lets us see `is_error`, so a signed-out CLI is a
    // failure we detect rather than a sentence we display.
    args: (model) => [
      '-p',
      '--output-format',
      'json',
      '--no-session-persistence',
      ...(model ? ['--model', model] : []),
    ],
    parse: parseClaudeJson,
  },
  {
    id: 'codex',
    label: 'Codex CLI',
    command: 'codex',
    // `-` reads the prompt from stdin; `-o` writes just the final message, which
    // saves us guessing where the answer ends and the tool's own chatter begins.
    args: (model, outFile) => [
      'exec',
      '--ephemeral',
      '--skip-git-repo-check',
      '--color',
      'never',
      '-s',
      'read-only',
      ...(model ? ['-m', model] : []),
      '-o',
      outFile,
      '-',
    ],
    usesOutputFile: true,
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    command: 'opencode',
    // Documented form is `opencode run <message>`; we send the message on stdin to
    // keep rule 1 above. If a future version rejects that, the probe catches it and
    // we fall through to the next backend rather than writing nonsense.
    args: (model) => ['run', ...(model ? ['--model', model] : [])],
  },
];

export interface AgentCliOptions {
  /** Passed through to the CLI's own model flag. Left off entirely by default, so
   *  the user's configured model wins. */
  model?: string;
}

/** Every agent CLI on this machine, in the order we would rather use them. */
export async function detectAgentClis(options: AgentCliOptions = {}): Promise<EnrichBackend[]> {
  const found: EnrichBackend[] = [];
  for (const spec of CLIS) {
    if (await isInstalled(spec.command)) found.push(makeBackend(spec, options));
  }
  return found;
}

export function agentCliById(id: string, options: AgentCliOptions = {}): EnrichBackend | null {
  const spec = CLIS.find((c) => c.id === id);
  return spec ? makeBackend(spec, options) : null;
}

function makeBackend(spec: CliSpec, options: AgentCliOptions): EnrichBackend {
  const backend: EnrichBackend = {
    id: spec.id,
    label: spec.label,
    // Usually right: the user is paying a flat fee for this tool, and nothing we send
    // adds to a bill. But an agent CLI can equally be authenticated with an API key,
    // and then every call is billed per token — so this is the *assumption*, and the
    // probe below is allowed to overturn it before anything real is spent.
    billing: 'subscription',
    model: options.model,
    concurrency: CONCURRENCY,
    probe: async () => {
      try {
        const reply = await invoke(
          spec,
          options,
          `Reply with exactly this word and nothing else: ${PROBE_TOKEN}`,
          PROBE_TIMEOUT_MS,
        );
        // The probe is one real request, and a metered CLI prices it. That number is
        // evidence and the table above is a guess, so the evidence wins: a Claude Code
        // signed in with an API key is reclassified here, before the first paid batch,
        // and gets the same question an API key has always got (#111).
        if ((reply.usage?.costUsd ?? 0) > 0) backend.billing = 'metered';
        if (reply.text.includes(PROBE_TOKEN)) return { ok: true as const };
        return { ok: false as const, reason: firstLine(reply.text) || 'gave an unexpected answer' };
      } catch (err) {
        return { ok: false as const, reason: (err as Error).message };
      }
    },
    run: (request: EnrichRequest, signal: AbortSignal) =>
      // CLIs vary in how (and whether) they take a system prompt, so the standing
      // instructions ride along at the top of the message. One shape for all three.
      invoke(spec, options, `${request.system}\n\n---\n\n${request.user}`, REQUEST_TIMEOUT_MS, signal),
  };
  return backend;
}

async function invoke(
  spec: CliSpec,
  options: AgentCliOptions,
  prompt: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<EnrichReply> {
  const outFile = spec.usesOutputFile
    ? path.join(os.tmpdir(), `app-atlas-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`)
    : '';

  try {
    const { stdout, stderr, code } = await run(
      spec.command,
      spec.args(validModel(options.model), outFile),
      prompt,
      timeoutMs,
      signal,
    );

    if (spec.usesOutputFile) {
      const written = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8').trim() : '';
      if (written) return { text: written };
      throw new Error(code === 0 ? 'wrote no answer' : firstLine(stderr) || `exited with code ${code}`);
    }

    if (spec.parse) {
      const parsed = spec.parse(stdout);
      if ('error' in parsed) throw new Error(parsed.error);
      return parsed;
    }

    const text = stdout.trim();
    if (!text) throw new Error(firstLine(stderr) || `exited with code ${code}`);
    return { text };
  } finally {
    if (outFile) fs.rmSync(outFile, { force: true });
  }
}

/** Claude Code's `--output-format json` envelope: the answer plus what it cost. */
function parseClaudeJson(stdout: string): EnrichReply | { error: string } {
  const line = stdout.trim().split('\n').filter(Boolean).pop() ?? '';
  try {
    const payload = JSON.parse(line) as {
      result?: string;
      is_error?: boolean;
      total_cost_usd?: number;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    if (payload.is_error) return { error: payload.result ?? 'the CLI reported an error' };
    if (typeof payload.result !== 'string' || !payload.result.trim()) return { error: 'returned nothing' };
    return {
      text: payload.result,
      usage: {
        inputTokens: payload.usage?.input_tokens ?? 0,
        outputTokens: payload.usage?.output_tokens ?? 0,
        // Subscription runs report zero, which is exactly the number we want to show.
        costUsd: payload.total_cost_usd,
      },
    };
  } catch {
    return { error: 'printed something that was not JSON' };
  }
}

interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

function run(
  command: string,
  args: string[],
  stdin: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    // npm installs these as .cmd shims on Windows, which cannot be executed
    // directly, so the shell has to be involved there. Node deprecates passing an
    // args *array* alongside `shell: true` (DEP0190) — and prints a warning into
    // every analyze — so on Windows the argv is joined into the one string form
    // the shell actually receives. Safe here only because argv is entirely fixed
    // flags — see rule 1.
    const options = {
      env: childEnv(),
      // A temp directory, so the CLI has no repo to wander into and leaves no session
      // files behind in the project being analyzed.
      cwd: os.tmpdir(),
      stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'],
    };
    const child =
      process.platform === 'win32'
        ? spawn([command, ...args].map(quoteForShell).join(' '), { ...options, shell: true })
        : spawn(command, args, options);

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      fn();
    };

    const timer = setTimeout(() => {
      child.kill();
      finish(() => reject(new Error(`took longer than ${Math.round(timeoutMs / 1000)}s`)));
    }, timeoutMs);

    const onAbort = () => {
      child.kill();
      finish(() => reject(new Error('cancelled')));
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => finish(() => reject(new Error(describeSpawnError(err, command)))));
    child.on('close', (code) => finish(() => resolve({ stdout, stderr, code })));

    child.stdin.on('error', () => {
      /* the child may exit before it reads; the close handler reports why */
    });
    child.stdin.end(stdin);
  });
}

/**
 * The environment a child CLI should see.
 *
 * When App Atlas is run from inside an agent session — which is the common case for
 * this audience — the parent exports session-scoped variables that redirect a child
 * CLI to a gateway holding none of the user's credentials. The child then reports
 * itself signed out even though the user is signed in perfectly well.
 *
 * Redirection variables are only removed when a parent session is detected, so a user
 * who genuinely configured their own base URL or proxy keeps it.
 */
/** Quotes one argument for the Windows shell. Our argv is fixed flags, so this only
 * ever has to defend against a model name with a space in it. */
function quoteForShell(arg: string): string {
  return /[\s"]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg;
}

function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const insideAgentSession = Boolean(env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT || env.CODEX_SANDBOX);

  for (const key of Object.keys(env)) {
    if (key.startsWith('CLAUDE_CODE_') || key === 'CLAUDECODE' || key === 'CLAUDE_PID') delete env[key];
  }
  if (insideAgentSession) {
    for (const key of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_MODEL', 'OPENAI_BASE_URL']) {
      delete env[key];
    }
  }
  // Colour codes in a captured answer are noise we would have to strip out again.
  env.NO_COLOR = '1';
  return env;
}

/** Model names reach a command line, so they get the only validation argv needs. */
function validModel(model: string | undefined): string | undefined {
  if (!model) return undefined;
  return /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,63}$/.test(model) ? model : undefined;
}

async function isInstalled(command: string): Promise<boolean> {
  try {
    const { code } = await run(command, ['--version'], '', 15_000);
    return code === 0;
  } catch {
    return false;
  }
}

function describeSpawnError(err: NodeJS.ErrnoException, command: string): string {
  if (err.code === 'ENOENT') return `${command} is not on your PATH`;
  return err.message;
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0]?.trim() ?? '';
}
