/**
 * @fileoverview The enricher interface.
 *
 * Everything above this line — the explanation ladder, the cache, the trust tiers,
 * the validation — is backend-independent. A backend's whole job is to turn a
 * request into text. That is what makes "provider-agnostic" real rather than
 * aspirational: adding a provider means writing one `run` function.
 *
 * See SPEC.md section 5.5.
 */

/** Which rung of the tiered pass a request belongs to. */
export type EnrichTier = 'overview' | 'module' | 'file' | 'symbol';

/**
 * How the user pays for a backend. This is the only thing that decides whether we
 * interrupt them: a subscription they already have is free at the margin, so asking
 * is pure friction, while an API key spends real money and must be consented to.
 */
export type Billing = 'subscription' | 'metered' | 'local';

export interface Pricing {
  inputPerMillion: number;
  outputPerMillion: number;
}

export interface EnrichRequest {
  /** Standing instructions — tone, rules, output shape. */
  system: string;
  /** The facts to describe. Always self-contained: a backend never reads the repo. */
  user: string;
  /** Ceiling on the reply, so a confused model cannot run up a bill. */
  maxOutputTokens: number;
}

export interface EnrichUsage {
  inputTokens: number;
  outputTokens: number;
  /** What the backend itself reported, when it reports one. */
  costUsd?: number;
}

export interface EnrichReply {
  text: string;
  usage?: EnrichUsage;
}

export interface EnrichBackend {
  /** Stable id used by `--ai <id>` and stored beside every cached explanation. */
  id: string;
  /** What to call it in the terminal: "Claude Code", "Anthropic API". */
  label: string;
  billing: Billing;
  /** Present for metered backends; drives the estimate shown before the first pass. */
  pricing?: Pricing;
  /** Model name, where the backend has one worth naming. */
  model?: string;
  /** How many requests may be in flight. Processes are heavy; HTTP is not. */
  concurrency: number;
  /**
   * A cheap round trip that proves the backend actually answers. An installed agent
   * CLI is not a working one — it can be signed out, rate-limited, or pointed at a
   * base URL it has no credentials for. Without this check the failure text gets
   * written into the atlas as though it were a description.
   */
  probe(): Promise<{ ok: true } | { ok: false; reason: string }>;
  run(request: EnrichRequest, signal: AbortSignal): Promise<EnrichReply>;
}

/** One thing we want described, and the cache key that decides if we must pay for it. */
export interface EnrichTarget {
  nodeId: string;
  tier: EnrichTier;
  /**
   * Identity of everything that went into the prompt. Usually the node's content
   * hash — so unchanged code is never re-billed, which is the whole point.
   */
  hash: string;
}

export interface CachedExplanation {
  nodeId: string;
  tier: EnrichTier;
  hash: string;
  text: string;
  backend: string;
  createdAt: string;
}

/**
 * Bumped by hand when a prompt changes enough that old answers are no longer the
 * answer to the question we now ask. Every cache key carries it, so a bump
 * invalidates deliberately rather than by accident.
 */
export const PROMPT_VERSION = 1;

/** Cache key. Same content plus same question equals same answer, at any price. */
export function explanationKey(tier: EnrichTier, hash: string): string {
  return `${PROMPT_VERSION}|${tier}|${hash}`;
}

/**
 * Tokens are billed, not characters, and we need a number before we have spent
 * anything. Four characters per token is the usual rule of thumb for English prose
 * and source code alike; it is close enough to size a decision and we round the
 * money up rather than down.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
