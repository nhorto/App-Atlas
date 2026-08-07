/**
 * @fileoverview The terminal-facing half of the words layer.
 *
 * Owns the one moment in App Atlas where the tool might spend the user's money, and
 * the rule it enforces is the resolution of SPEC.md section 12, question 2: **ask
 * only when it costs — and say so always.**
 *
 * A subscription the user already pays for is free at the margin, so stopping to ask
 * about it buys them nothing and trains them to hit Enter without reading. An API key
 * spends real money, so it gets a real question with a real number attached, before
 * anything is sent. Same code path, different answer to "does this cost anything",
 * which is the only question that should decide whether someone is *interrupted*.
 *
 * What it does not decide is whether they are *told*. The first version of this file
 * conflated the two, and a bare `analyze` on a fresh install went away for twenty
 * seconds and came back having written fifteen explanations and reported a real
 * dollar cost — the number arriving after the money, on the first run somebody ever
 * did (#111). So the announcement is unconditional and the question is not: nothing
 * here happens without a line on screen first, and the backend that turns out to bill
 * gets the full prompt on the evidence of its own probe.
 */
import { createInterface } from 'node:readline/promises';
import pc from 'picocolors';
import type { Atlas } from '../model/types.js';
import { AtlasStore, atlasDbPath } from '../model/store.js';
import { selectBackend } from './backends/index.js';
import { enrichAtlas } from './index.js';
import type { CostEstimate, EnrichReport } from './index.js';
import type { EnrichBackend } from './types.js';

export interface WordsOptions {
  root: string;
  atlas: Atlas;
  /** False for `--no-ai`: docstrings only, nothing generated, always works offline. */
  enabled: boolean;
  /** A specific backend from `--ai <id>`. */
  backendId?: string;
  /**
   * A backend to use instead of discovering one. The programmatic seam for a caller
   * who has already chosen — and what lets the rules in this file be tested without
   * a real CLI on the machine running the tests.
   */
  backend?: EnrichBackend;
  model?: string;
  maxFiles?: number;
  /** Throw away cached explanations and write them again. */
  refresh?: boolean;
  /** Approve metered spending in advance, for scripts and CI. */
  assumeYes?: boolean;
  /**
   * Decline anything that would cost money instead of asking. `--watch` rebuilds on
   * every save, and a question that appears mid-edit — repeatedly — is not consent.
   * A subscription backend is unaffected, because it never reaches the question.
   */
  neverAsk?: boolean;
  quiet?: boolean;
  onProgress?: (stage: string, done: number, total: number) => void;
}

/**
 * Fills in every explanation it can, and returns what happened so the caller can
 * report it. Never throws: the map is the product, and the words are the polish on
 * top of it, so a backend having a bad day must not fail an analysis.
 */
export async function writeTheWords(options: WordsOptions): Promise<EnrichReport | null> {
  const { atlas, root, quiet } = options;
  const say = (line: string) => {
    if (!quiet) console.log(line);
  };

  const store = AtlasStore.open(atlasDbPath(root));
  try {
    if (options.refresh) store.clearExplanations();
    const cache = store.readExplanations();

    // Pass one: apply everything already paid for. On a repeat run this is usually
    // the whole job, and it happens without starting a process or opening a socket.
    const cached = await enrichAtlas({ atlas, backend: null, cache, maxFiles: options.maxFiles });

    // `--no-ai` means "don't call out to a model", not "forget the words you already
    // have". Re-reading the cache costs nothing and needs no network, and skipping it
    // meant an offline re-analysis silently replaced every plain-English name with the
    // folder name it was written to replace.
    if (!options.enabled) {
      if (cached.reusedFromCache > 0) {
        say(pc.dim(`  ${cached.reusedFromCache} explanations reused from earlier runs — no AI was run.`));
      }
      return cached;
    }

    if (cached.pendingItems === 0) {
      if (cached.reusedFromCache > 0) {
        say(pc.dim(`  ${cached.reusedFromCache} explanations reused from earlier runs — nothing new to write.`));
      }
      return cached;
    }

    const selection = options.backend
      ? { backend: options.backend, rejected: [], alternatives: [] }
      : await selectBackend({ prefer: options.backendId, model: options.model });
    for (const rejection of selection.rejected) {
      say(pc.yellow(`  ! ${rejection.label} is installed but did not answer: ${rejection.reason}`));
    }

    if (!selection.backend) {
      say('');
      if (options.backendId && options.backendId !== 'auto') {
        say(pc.yellow(`  Couldn't use --ai ${options.backendId}. Descriptions come from your docstrings only.`));
      } else {
        say(pc.dim('  No AI backend found, so descriptions come from your docstrings only.'));
        say(pc.dim('  Install Claude Code or Codex CLI to use a subscription you already have,'));
        say(pc.dim('  or set ANTHROPIC_API_KEY. Run with --no-ai to stop this message.'));
      }
      return cached;
    }

    // A backend that bills gets the question below. One that does not still gets a
    // sentence, because "free at the margin" is not free: it is a slice of somebody's
    // plan quota and twenty seconds of their time, and a run that spends either
    // without a word on screen fails the standard the consent prompt itself sets (#111).
    if (selection.backend.billing !== 'metered' && !options.neverAsk) {
      say(
        pc.dim(
          `  Writing ${cached.pendingItems} descriptions with ${selection.backend.label}` +
            `${selection.backend.billing === 'local' ? ' (on this machine)' : ' (your subscription, no API charge)'}` +
            ` — ${pc.cyan('--no-ai')} to skip.`,
        ),
      );
    }

    const report = await enrichAtlas({
      atlas,
      backend: selection.backend,
      cache,
      maxFiles: options.maxFiles,
      onProgress: options.onProgress,
      confirm: (estimate) => askPermission(estimate, options),
    });

    store.writeExplanations(report.additions);
    return report;
  } catch (err) {
    say(pc.yellow(`  ! Explanations were skipped: ${(err as Error).message}`));
    return null;
  } finally {
    store.close();
  }
}

/**
 * The moment before anything is spent. Everything needed to make the decision is on
 * screen — how much work, roughly how much money, which key, and what actually leaves
 * the machine — because a consent prompt that hides any of those is theatre.
 */
async function askPermission(estimate: CostEstimate, options: WordsOptions): Promise<boolean> {
  const { backend } = estimate;

  if (options.assumeYes) return true;

  if (options.neverAsk) {
    if (!options.quiet) {
      console.log(
        pc.dim(`  ${estimate.items} things have no description yet — run app-atlas analyze to write them.`),
      );
    }
    return false;
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    // No one is there to answer. Spending money on an unattended run without being
    // told to is the one outcome worse than not writing the descriptions.
    if (!options.quiet) {
      console.log('');
      console.log(pc.yellow('  Explanations need approval and this is not an interactive terminal.'));
      console.log(pc.dim(`  Re-run with ${pc.cyan('--ai-yes')} to approve ${money(estimate.costUsd)} of ${backend.label} usage.`));
    }
    return false;
  }

  console.log('');
  console.log(`  App Atlas can write plain-English descriptions for the parts of`);
  console.log(`  this app that have no docstring of their own.`);
  console.log('');
  console.log(`    ${pc.bold(String(estimate.items))} things to describe, in ${estimate.requests} ${estimate.requests === 1 ? 'request' : 'requests'}`);
  console.log(`    about ${pc.bold(compact(estimate.inputTokens + estimate.outputTokens))} tokens — ${pc.bold(money(estimate.costUsd))}, once`);
  console.log('');
  console.log(pc.dim(`  Using ${backend.label}${backend.model ? ` (${backend.model})` : ''}.`));
  console.log(pc.dim('  Names, paths and exports are sent. File contents are not.'));
  console.log(pc.dim('  Answers are cached, so unchanged code is never charged for twice.'));
  console.log('');

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`  Write them? ${pc.dim('[Y/n]')} `)).trim().toLowerCase();
    console.log('');
    return answer === '' || answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

/**
 * Prices drift and our token count is an estimate, so the number is always hedged and
 * always rounded up. Someone who expected "about 11 cents" and paid 9 is fine; the
 * reverse is a broken promise.
 */
function money(costUsd: number | null): string {
  if (costUsd === null) return 'an amount we cannot estimate for this model';
  if (costUsd < 0.01) return 'well under a cent';
  if (costUsd < 1) return `roughly ${Math.ceil(costUsd * 100)}¢`;
  return `roughly $${(Math.ceil(costUsd * 20) / 20).toFixed(2)}`;
}

function compact(tokens: number): string {
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens);
}

/**
 * What to say about a sentence that named one of your routes with the wrong verb.
 *
 * A description that quietly shrinks is worse than one that says why: the reader is
 * entitled to know that a claim was made and thrown out, not least because the claim
 * might have been right and the map wrong.
 */
function misattributions(report: EnrichReport): string[] {
  if (report.misattributedRoutes.length === 0) return [];
  return [
    `  Dropped a description that called ${report.misattributedRoutes.join(', ')} — your endpoints answer to different verbs.`,
    '  The sentence was removed rather than corrected: rewriting it would put words on screen that nothing wrote.',
  ];
}

/** The line printed after a successful pass, in the analysis summary. */
export function describeRun(report: EnrichReport): string[] {
  if (report.declined) return ['  No explanations were written.'];
  // A dropped sentence is said out loud even on a run that spent nothing, because the
  // text it was dropped from may have been written months ago and paid for once.
  if (report.backend === 'cache') return misattributions(report);

  const lines: string[] = [];
  const written = report.described + report.labelled;
  if (written > 0) {
    const cost =
      report.usage.costUsd && report.usage.costUsd > 0
        ? `, ${money(report.usage.costUsd)}`
        : report.backend === 'claude' || report.backend === 'codex' || report.backend === 'opencode'
          ? ' (your subscription, no API charge)'
          : '';
    lines.push(`  ${written} explanations written by ${report.backendLabel}${cost}.`);
  }
  if (report.reusedFromCache > 0) {
    lines.push(`  ${report.reusedFromCache} reused from earlier runs, unchanged.`);
  }
  if (report.filesSkipped > 0) {
    // A cap that is not reported reads as "we covered everything".
    lines.push(`  ${report.filesSkipped} more files were left undescribed — raise --ai-max-files to include them.`);
  }
  if (report.failedRequests > 0) {
    lines.push(`  ${report.failedRequests} of ${report.requests} requests failed, so some descriptions are missing.`);
  }
  if (report.contradictions.length > 0) {
    // The paragraph and the diagram are drawn from the same list and shown together, so
    // a company in one and not the other is visible to the reader before it is visible
    // to us. Nothing here changes a box — a generated sentence is not evidence — but a
    // lead this specific is worth printing.
    lines.push(
      `  The description names ${report.contradictions.join(', ')}, which no detector found.`,
      '  Either the write-up over-reached or something real is missing from the map.',
    );
  }
  lines.push(...misattributions(report));
  // A pass that ran and produced nothing usable has to say so. Silence here reads as
  // "there was nothing to describe", which is the opposite of what happened.
  if (written === 0 && report.requests > 0 && report.failedRequests === 0) {
    lines.push(`  ${report.backendLabel} answered ${report.requests} ${report.requests === 1 ? 'request' : 'requests'} but nothing came back in a usable shape.`);
    lines.push('  The descriptions were skipped rather than guessed at.');
  }
  return lines;
}
