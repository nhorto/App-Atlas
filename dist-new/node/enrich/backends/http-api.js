const CONCURRENCY = 6;
const TIMEOUT_MS = 120_000;
/**
 * List prices per million tokens, used only to show an estimate before spending
 * anything. They drift, and a wrong estimate is worse than a vague one, so the
 * number is always presented as approximate and rounded up.
 */
const PRICING = {
    'claude-opus-5': { inputPerMillion: 15, outputPerMillion: 75 },
    'claude-sonnet-5': { inputPerMillion: 3, outputPerMillion: 15 },
    'claude-haiku-4-5-20251001': { inputPerMillion: 1, outputPerMillion: 5 },
};
const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-5';
/** Every API backend this machine is configured for, best first. */
export function detectApiBackends(options = {}) {
    const found = [];
    if (process.env.ANTHROPIC_API_KEY)
        found.push(anthropicBackend(options));
    const openai = openAiCompatibleBackend(options);
    if (openai)
        found.push(openai);
    return found;
}
export function apiBackendById(id, options = {}) {
    if (id === 'anthropic')
        return process.env.ANTHROPIC_API_KEY ? anthropicBackend(options) : null;
    if (id === 'openai')
        return openAiCompatibleBackend(options);
    return null;
}
function anthropicBackend(options) {
    const model = options.model ?? process.env.ANTHROPIC_MODEL ?? DEFAULT_ANTHROPIC_MODEL;
    return {
        id: 'anthropic',
        label: 'Anthropic API',
        billing: 'metered',
        pricing: PRICING[model],
        model,
        concurrency: CONCURRENCY,
        probe: () => probeWith((req, signal) => callAnthropic(model, req, signal)),
        run: (request, signal) => callAnthropic(model, request, signal),
    };
}
/**
 * OpenAI, or anything that imitates it. A base URL on localhost means a model running
 * on the user's own machine, which costs nothing and so never prompts for consent.
 */
function openAiCompatibleBackend(options) {
    const baseUrl = (process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
    const key = process.env.OPENAI_API_KEY;
    const local = isLocal(baseUrl);
    if (!key && !local)
        return null;
    const model = options.model ?? process.env.OPENAI_MODEL ?? 'gpt-5-mini';
    return {
        id: 'openai',
        label: local ? `Local model (${hostOf(baseUrl)})` : 'OpenAI-compatible API',
        billing: local ? 'local' : 'metered',
        model,
        concurrency: CONCURRENCY,
        probe: () => probeWith((req, signal) => callOpenAi(baseUrl, key, model, req, signal)),
        run: (request, signal) => callOpenAi(baseUrl, key, model, request, signal),
    };
}
/**
 * One throwaway question before we trust the backend with the whole repo. A wrong
 * model name, an expired key or a local server that is not running all surface here,
 * where the message can be shown to the user, rather than as forty bad summaries.
 */
async function probeWith(call) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
        const reply = await call({
            system: 'You reply with exactly what you are asked for, and nothing else.',
            user: 'Reply with exactly this word: ATLAS_READY',
            maxOutputTokens: 16,
        }, controller.signal);
        return reply.text.includes('ATLAS_READY')
            ? { ok: true }
            : { ok: false, reason: 'gave an unexpected answer' };
    }
    catch (err) {
        return { ok: false, reason: err.message };
    }
    finally {
        clearTimeout(timer);
    }
}
async function callAnthropic(model, request, signal) {
    const payload = await postJson('https://api.anthropic.com/v1/messages', {
        'x-api-key': process.env.ANTHROPIC_API_KEY ?? '',
        'anthropic-version': '2023-06-01',
    }, {
        model,
        max_tokens: request.maxOutputTokens,
        system: request.system,
        messages: [{ role: 'user', content: request.user }],
    }, signal);
    const content = payload.content ?? [];
    const text = content
        .filter((block) => block.type === 'text')
        .map((block) => block.text ?? '')
        .join('')
        .trim();
    if (!text)
        throw new Error('returned no text');
    const usage = payload.usage;
    return {
        text,
        usage: { inputTokens: usage?.input_tokens ?? 0, outputTokens: usage?.output_tokens ?? 0 },
    };
}
async function callOpenAi(baseUrl, key, model, request, signal) {
    // OpenAI's newer models reject `max_tokens`; the compatible servers mostly only
    // understand it. Pick by host rather than making the user care.
    const limitField = baseUrl.includes('api.openai.com') ? 'max_completion_tokens' : 'max_tokens';
    const payload = await postJson(`${baseUrl}/chat/completions`, key ? { authorization: `Bearer ${key}` } : {}, {
        model,
        [limitField]: request.maxOutputTokens,
        messages: [
            { role: 'system', content: request.system },
            { role: 'user', content: request.user },
        ],
    }, signal);
    const choices = payload.choices ?? [];
    const text = (choices[0]?.message?.content ?? '').trim();
    if (!text)
        throw new Error('returned no text');
    const usage = payload.usage;
    return {
        text,
        usage: { inputTokens: usage?.prompt_tokens ?? 0, outputTokens: usage?.completion_tokens ?? 0 },
    };
}
async function postJson(url, headers, body, signal) {
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.any([signal, timeout]),
    });
    if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`${res.status} ${res.statusText}${detail ? ` — ${apiMessage(detail)}` : ''}`);
    }
    return (await res.json());
}
/** Both APIs bury the useful sentence in `{ error: { message } }`. */
function apiMessage(detail) {
    try {
        const parsed = JSON.parse(detail);
        return parsed.error?.message ?? detail.slice(0, 200);
    }
    catch {
        return detail.slice(0, 200);
    }
}
function isLocal(baseUrl) {
    const host = hostOf(baseUrl);
    return host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host === '[::1]';
}
function hostOf(baseUrl) {
    try {
        return new URL(baseUrl).hostname;
    }
    catch {
        return baseUrl;
    }
}
//# sourceMappingURL=http-api.js.map