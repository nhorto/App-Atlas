/**
 * @fileoverview Words about an error, on top of a path that was already worked out.
 *
 * The division this file exists to hold: **the path is computed, the story is written**.
 * Everything about *where* the error went — which files the frames landed in, which
 * ways in can reach them — comes out of `model/errortrace.ts` and never from a model.
 * What arrives here is that finished path, and the only job is the closing paragraph
 * somebody stuck on an error actually wants: what could be going wrong, and what to
 * look at first.
 *
 * It is written this way for a practical reason rather than a principled one. If a
 * model picks the files, it will sometimes name a plausible file that had nothing to
 * do with the crash — and the reader, who is already frustrated enough to be pasting
 * a stack trace, will go and read it. Handing it a fixed path removes that failure
 * outright: it cannot point somewhere off the path, because the path is all it gets.
 * `dropUngroundedFiles` then enforces what the prompt asks for, because a rule a model
 * is merely told is a rule it can forget.
 *
 * The second entry point is for the paste with no frames in it — somebody typing "it
 * crashes when I save". There is no path to compute, so there is nothing to stand on,
 * and the honest shape is different: the search picks real candidates out of the atlas
 * and the model only *chooses among them*. It never produces a path, so it cannot
 * invent one, and every id it picks is checked against the graph before it is shown.
 */
import { selectBackend } from '../enrich/backends/index.js';
import { errorPathRequest, startingPointRequest } from '../enrich/prompts.js';
import { explanationKey } from '../enrich/types.js';
import { cleanParagraph, dropUngroundedFiles, dropWrongMethods, methodsByRoute, parseJsonReply, } from '../enrich/validate.js';
import { traceError } from '../model/errortrace.js';
import { installedPackages } from '../model/packages.js';
import { bundleMaps } from '../model/sourcemap.js';
import { AtlasStore, atlasDbPath } from '../model/store.js';
import { hashParts } from '../util/hash.js';
import { readSource } from './source.js';
/** How many real places to put in front of the model when there is no stack trace. */
const MAX_CANDIDATES = 30;
/** Words too common to search on — every codebase matches them. */
const STOPWORDS = new Set([
    'the', 'and', 'but', 'for', 'with', 'when', 'this', 'that', 'from', 'have', 'has', 'was', 'were',
    'app', 'application', 'error', 'errors', 'crash', 'crashes', 'crashed', 'broken', 'breaks', 'break',
    'fail', 'fails', 'failed', 'failing', 'bug', 'issue', 'problem', 'not', 'work', 'works', 'working',
    'something', 'anything', 'happens', 'happen', 'idea', 'why', 'know', 'get', 'gets', 'getting',
]);
export class ErrorHelper {
    options;
    resolved = null;
    constructor(options) {
        this.options = options;
    }
    /**
     * The closing paragraph for a pasted trace.
     *
     * The trace is walked again here rather than trusting anything the browser sends
     * back, so what the model is shown is what the compiler found, not what a request
     * body claimed it found.
     */
    async explainTrace(graph, pasted) {
        const traced = traceError(graph, pasted, bundleMaps(graph.meta.root), installedPackages(graph.meta.root));
        if (traced.parsedNothing)
            return { error: 'There are no stack frames in that paste to explain.' };
        if (!traced.origin?.nodeId) {
            return { error: 'None of those frames is code in this project, so there is no path here to explain.' };
        }
        const origin = graph.getNodeById(traced.origin.nodeId);
        if (!origin)
            return { error: 'The frame this started from is no longer in the atlas — re-run the analysis.' };
        const facts = {
            message: firstLine(pasted),
            origin: {
                name: origin.name,
                kind: origin.kind === 'function' ? 'function' : 'file',
                path: traced.origin.path ?? origin.path ?? '',
                // The line in the source, which is not the line the trace printed when the frame
                // came out of a bundle. Handing the model the bundle's line 1 next to a source
                // path is handing it a location that does not exist.
                line: traced.origin.sourceLine ?? traced.origin.frame.line,
                source: readSource(graph.meta.root, origin)?.code,
            },
            yours: traced.yours.map((found) => ({
                name: found.nodeName ?? found.frame.functionName ?? '',
                path: found.path ?? '',
                line: found.sourceLine ?? found.frame.line,
            })),
            outside: summariseOutside(traced),
            doors: traced.doors.slice(0, 8).map((reach) => ({
                name: `${reach.door.method ?? reach.door.endpointKind} ${reach.door.route ?? reach.door.name}`,
                via: reach.viaNames.join(' → '),
                hops: reach.hops,
            })),
            exits: [],
        };
        // Everything the model is allowed to name a file by. Anything else it writes is a
        // file it was not given, and gets dropped rather than trusted.
        const allowed = new Set();
        for (const found of traced.frames) {
            if (found.path)
                allowed.add(found.path);
            allowed.add(found.frame.rawPath);
        }
        const hash = hashParts('error', JSON.stringify(facts));
        const key = explanationKey('symbol', hash);
        const store = openStore(atlasDbPath(graph.meta.root));
        const routes = methodsByRoute(graph.nodesOfKind('endpoint').map((endpoint) => endpoint.meta));
        try {
            const hit = store?.readExplanations().get(key);
            if (hit) {
                // Tidied and checked on the way out as well as on the way in, so an answer
                // cached before either existed is fixed by the upgrade rather than kept as it
                // was written.
                const checked = ground(plain(hit.text) ?? '', allowed, routes);
                if (checked.text)
                    return { text: checked.text, cached: true, dropped: checked.dropped };
            }
            if (!this.options.enabled)
                return { error: 'Explanations are turned off for this atlas (--no-ai).' };
            const backend = await this.backend();
            if (!backend) {
                return { error: 'No AI backend is available. Install Claude Code or Codex CLI, or set ANTHROPIC_API_KEY.' };
            }
            const reply = await backend.run(errorPathRequest(facts), new AbortController().signal);
            const written = plain(cleanParagraph(reply.text, 5));
            if (!written)
                return { error: `${backend.label} did not return a usable explanation.` };
            store?.writeExplanations(new Map([
                [
                    key,
                    {
                        nodeId: origin.id,
                        tier: 'symbol',
                        hash,
                        text: written,
                        backend: backend.id,
                        createdAt: new Date().toISOString(),
                    },
                ],
            ]));
            const checked = ground(written, allowed, routes);
            if (!checked.text) {
                return {
                    error: `${backend.label} wrote about files that are not on this path, so its answer was dropped.`,
                };
            }
            return { text: checked.text, backend: backend.label, cached: false, dropped: checked.dropped };
        }
        catch (err) {
            return { error: err.message };
        }
        finally {
            store?.close();
        }
    }
    /**
     * Where to start when the paste has no frames in it.
     *
     * The candidates are searched out of the atlas first, so the model is choosing from
     * things that exist rather than remembering a path. Every id it returns is checked
     * against the graph on the way out — a pick that is not a real node is dropped, not
     * shown with a caveat.
     */
    async guessStart(graph, description) {
        const candidates = searchCandidates(graph, description);
        if (candidates.length === 0) {
            return { error: 'Nothing in this codebase matched those words, so there is nowhere to suggest starting.' };
        }
        if (!this.options.enabled)
            return { error: 'Suggestions are turned off for this atlas (--no-ai).' };
        const backend = await this.backend();
        if (!backend) {
            return { error: 'No AI backend is available. Install Claude Code or Codex CLI, or set ANTHROPIC_API_KEY.' };
        }
        try {
            const reply = await backend.run(startingPointRequest({
                description,
                candidates: candidates.map((node) => ({
                    id: node.id,
                    name: node.name,
                    kind: node.kind,
                    path: node.path ?? '',
                    summary: node.summary,
                })),
            }), new AbortController().signal);
            const parsed = parseJsonReply(reply.text);
            if (!parsed)
                return { error: `${backend.label} did not return a usable answer.` };
            const numbers = Array.isArray(parsed.picks) ? parsed.picks : [];
            const picks = [];
            const already = new Set();
            for (const raw of numbers) {
                if (picks.length >= 4)
                    break;
                const node = candidates[Number(raw) - 1];
                // A pick outside the list it was given is not a near miss to be shown with a
                // caveat — it is the one thing this path exists to make impossible.
                if (!node || !graph.getNodeById(node.id))
                    continue;
                // Models name the same place twice when it matches on two of the words. Two
                // rows pointing at one file reads as two suggestions, which overstates a guess
                // that is thin enough already.
                if (already.has(node.id))
                    continue;
                already.add(node.id);
                picks.push({ nodeId: node.id, name: node.name, kind: node.kind, path: node.path });
            }
            // A paragraph rather than a label: `cleanSentence` caps words and ends in an
            // ellipsis, which turned a whole reason into "…the code that writes the…".
            return { picks, because: plain(cleanParagraph(parsed.because, 2)), backend: backend.label };
        }
        catch (err) {
            return { error: err.message };
        }
    }
    backend() {
        if (!this.resolved) {
            this.resolved = selectBackend({ prefer: this.options.backendId, model: this.options.model })
                .then((selection) => selection.backend)
                .catch(() => null);
        }
        return this.resolved;
    }
}
// ---------------------------------------------------------------------------
function ground(text, allowed, routes) {
    const files = dropUngroundedFiles(text, allowed);
    if (!files.text)
        return { text: null, dropped: files.wrong };
    const verbs = dropWrongMethods(files.text, routes);
    return { text: verbs.text, dropped: [...files.wrong, ...verbs.wrong] };
}
/**
 * Backticks out of prose that is rendered as plain text.
 *
 * The prompt asks for no markdown and models mostly comply, but they reach for
 * `identifier` fences by reflex when naming a function. On a screen that renders text
 * verbatim those arrive as literal grave accents, which reads as a bug in the tool
 * rather than a habit of the writer.
 */
function plain(text) {
    if (!text)
        return text;
    const stripped = text.replace(/`+/g, '').replace(/\s{2,}/g, ' ').trim();
    return stripped.length > 0 ? stripped : null;
}
/** The error line, which is the one part of a paste worth quoting back. */
function firstLine(pasted) {
    const line = pasted
        .split(/\r?\n/)
        .map((one) => one.trim())
        .find((one) => one.length > 0 && !/^\s*(at |File ")/.test(one));
    return (line ?? '').slice(0, 300);
}
function summariseOutside(traced) {
    const counts = new Map();
    for (const found of traced.frames) {
        if (!found.reason)
            continue;
        counts.set(found.reason, (counts.get(found.reason) ?? 0) + 1);
    }
    const say = {
        dependency: 'in a dependency',
        runtime: 'in the runtime itself',
        'unknown-file': 'in a file this analysis has not read',
        ambiguous: 'in a file whose name matches several here',
        minified: 'in build output no source map here places',
    };
    return [...counts.entries()].map(([reason, count]) => `${count} ${say[reason] ?? reason}`);
}
/**
 * Real places in the codebase whose names or descriptions match what somebody typed.
 *
 * Mechanical on purpose. This is the list the model is allowed to choose from, so it
 * has to be built by search rather than by asking — the safety of the whole prose lane
 * rests on every option being something that actually exists.
 */
function searchCandidates(graph, description) {
    const words = [...new Set(description.toLowerCase().match(/[a-z][a-z0-9]{2,}/g) ?? [])]
        .filter((word) => !STOPWORDS.has(word))
        .slice(0, 8);
    const found = new Map();
    for (const word of words) {
        for (const node of graph.search(word, 12)) {
            if (node.kind === 'app' || node.kind === 'zone')
                continue;
            if (!found.has(node.id))
                found.set(node.id, node);
            if (found.size >= MAX_CANDIDATES)
                break;
        }
        if (found.size >= MAX_CANDIDATES)
            break;
    }
    return [...found.values()];
}
function openStore(dbPath) {
    try {
        return AtlasStore.open(dbPath);
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=errorhelp.js.map