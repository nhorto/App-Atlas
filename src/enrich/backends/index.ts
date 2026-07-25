/**
 * @fileoverview Choosing who writes the words.
 *
 * The order is not about quality, it is about the user's wallet. A subscription they
 * already pay for comes first, then a model running on their own machine, and only
 * then something that bills per token. Someone who has Claude Code installed should
 * never be quietly charged for an API call they did not ask for.
 *
 * Every candidate has to prove it works before it is chosen, so "installed" is never
 * mistaken for "usable" (see agent-cli.ts for why that distinction is load-bearing).
 */
import type { Billing, EnrichBackend } from '../types.js';
import { agentCliById, detectAgentClis } from './agent-cli.js';
import { apiBackendById, detectApiBackends } from './http-api.js';

export interface SelectOptions {
  /** A specific backend id from `--ai <id>`, or undefined to choose automatically. */
  prefer?: string;
  /** Overrides the backend's own default model. */
  model?: string;
  /** Skip the round trip that proves a backend answers. Tests only. */
  skipProbe?: boolean;
}

export interface Selection {
  backend: EnrichBackend | null;
  /** Backends that were present but did not work, and what they said. */
  rejected: { label: string; reason: string }[];
  /** Backends we could have used but did not need. Shown as "also available". */
  alternatives: string[];
}

const BILLING_ORDER: Record<Billing, number> = { subscription: 0, local: 1, metered: 2 };

export async function selectBackend(options: SelectOptions = {}): Promise<Selection> {
  const rejected: Selection['rejected'] = [];

  if (options.prefer && options.prefer !== 'auto') {
    const named = agentCliById(options.prefer, options) ?? apiBackendById(options.prefer, options);
    if (!named) return { backend: null, rejected, alternatives: [] };
    // Asked for by name, so a failure is reported rather than quietly worked around.
    const check = options.skipProbe ? { ok: true as const } : await named.probe();
    if (!check.ok) return { backend: null, rejected: [{ label: named.label, reason: check.reason }], alternatives: [] };
    return { backend: named, rejected, alternatives: [] };
  }

  const candidates = [...(await detectAgentClis(options)), ...detectApiBackends(options)].sort(
    (a, b) => BILLING_ORDER[a.billing] - BILLING_ORDER[b.billing],
  );

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    const check = options.skipProbe ? { ok: true as const } : await candidate.probe();
    if (check.ok) {
      return {
        backend: candidate,
        rejected,
        alternatives: candidates.slice(i + 1).map((c) => c.label),
      };
    }
    rejected.push({ label: candidate.label, reason: check.reason });
  }

  return { backend: null, rejected, alternatives: [] };
}

/** Names accepted by `--ai`, for the CLI's help text and error messages. */
export const BACKEND_IDS = ['auto', 'claude', 'codex', 'opencode', 'anthropic', 'openai'] as const;
