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
/**
 * Bumped by hand when a prompt changes enough that old answers are no longer the
 * answer to the question we now ask. Every cache key carries it, so a bump
 * invalidates deliberately rather than by accident.
 */
export const PROMPT_VERSION = 2;
/** Cache key. Same content plus same question equals same answer, at any price. */
export function explanationKey(tier, hash) {
    return `${PROMPT_VERSION}|${tier}|${hash}`;
}
/**
 * Tokens are billed, not characters, and we need a number before we have spent
 * anything. Four characters per token is the usual rule of thumb for English prose
 * and source code alike; it is close enough to size a decision and we round the
 * money up rather than down.
 */
export function estimateTokens(text) {
    return Math.ceil(text.length / 4);
}
//# sourceMappingURL=types.js.map