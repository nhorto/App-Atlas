import { agentCliById, detectAgentClis } from './agent-cli.js';
import { apiBackendById, detectApiBackends } from './http-api.js';
const BILLING_ORDER = { subscription: 0, local: 1, metered: 2 };
export async function selectBackend(options = {}) {
    const rejected = [];
    if (options.prefer && options.prefer !== 'auto') {
        const named = agentCliById(options.prefer, options) ?? apiBackendById(options.prefer, options);
        if (!named)
            return { backend: null, rejected, alternatives: [] };
        // Asked for by name, so a failure is reported rather than quietly worked around.
        const check = options.skipProbe ? { ok: true } : await named.probe();
        if (!check.ok)
            return { backend: null, rejected: [{ label: named.label, reason: check.reason }], alternatives: [] };
        return { backend: named, rejected, alternatives: [] };
    }
    const candidates = [...(await detectAgentClis(options)), ...detectApiBackends(options)].sort((a, b) => BILLING_ORDER[a.billing] - BILLING_ORDER[b.billing]);
    for (let i = 0; i < candidates.length; i++) {
        const candidate = candidates[i];
        const check = options.skipProbe ? { ok: true } : await candidate.probe();
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
export const BACKEND_IDS = ['auto', 'claude', 'codex', 'opencode', 'anthropic', 'openai'];
//# sourceMappingURL=index.js.map