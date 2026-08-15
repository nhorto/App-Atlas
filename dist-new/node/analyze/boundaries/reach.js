import { isInternalHost, serviceForHost, serviceForPackage } from './catalog.js';
import { hostOf, sendsData } from './outbound.js';
/**
 * How far a guard may travel from the check to the handler. Three covers the usual
 * `handler → requireOwner → requireUser → getServerSession`; beyond that "this
 * function can reach a check" stops being a claim about protection.
 */
const MAX_HOPS = 3;
/**
 * A guard sitting in a heavily-referenced function would otherwise walk the whole
 * project. Hitting this cap means the answer would have been "almost everything",
 * which is not a useful thing to tell anyone.
 */
const MAX_REACHED = 400;
/**
 * Atlas node id → the guards that node can reach, and how.
 *
 * Built by walking `references` edges backwards from each check, so the cost is one
 * bounded walk per guard rather than a search per endpoint.
 */
export function reachableGuards(guards, references, nodeNames) {
    const reached = new Map();
    if (references.length === 0)
        return reached;
    const callers = new Map();
    for (const edge of references) {
        const list = callers.get(edge.toId);
        if (list)
            list.push(edge.fromId);
        else
            callers.set(edge.toId, [edge.fromId]);
    }
    const label = (id) => nodeNames.get(id) ?? id;
    for (const finding of guards) {
        if (finding.scope !== 'node' || !finding.nodeId)
            continue;
        // `trail` holds, for each node, the chain of names between it and the check.
        const trail = new Map([[finding.nodeId, [label(finding.nodeId)]]]);
        const seen = new Set([finding.nodeId]);
        let frontier = [finding.nodeId];
        for (let hop = 0; hop < MAX_HOPS && frontier.length > 0 && seen.size < MAX_REACHED; hop++) {
            const next = [];
            for (const id of frontier) {
                const via = trail.get(id) ?? [];
                for (const caller of callers.get(id) ?? []) {
                    // For a guard found at its *definition*, a `file:` mention is an import, and
                    // an import is not a call — it is what deleted wiring leaves behind, so
                    // walking through it would keep a door "protected" after somebody removed
                    // the check from in front of it (see GuardFinding.definitionSite). A guard
                    // found at a call site keeps the hop: `export const GET = withTeam(…)` wires
                    // its check at module scope, and that reference dies with the wiring.
                    if (finding.definitionSite && !caller.startsWith('func:'))
                        continue;
                    if (seen.has(caller))
                        continue;
                    seen.add(caller);
                    if (seen.size > MAX_REACHED)
                        break;
                    trail.set(caller, [label(caller), ...via]);
                    next.push(caller);
                    const list = reached.get(caller);
                    const entry = { guard: finding.guard, via };
                    if (list)
                        list.push(entry);
                    else
                        reached.set(caller, [entry]);
                }
            }
            frontier = next;
        }
    }
    return reached;
}
/**
 * How a hop-found guard should read on screen: the helper the handler actually calls,
 * then what that helper checks with. Naming only the innermost call would leave the
 * reader looking for a `getServerSession` that is nowhere in their route file.
 */
export function guardThroughHops(reached) {
    // A function-refusal guard is named after the function that holds it, so the last
    // hop and the check share a name — `revalidate → revalidate` says one thing twice.
    const chain = [...reached.via, reached.guard.name].filter((name, i, all) => name !== all[i - 1]);
    return {
        ...reached.guard,
        name: chain.join(' → '),
        // Never `certain`. The reference graph proves the handler mentions the helper,
        // not that every path through the handler runs it.
        confidence: 'likely',
    };
}
// ---------------------------------------------------------------------------
// Wrapper modules
// ---------------------------------------------------------------------------
/**
 * `import { stripe } from "@/lib/stripe"` then `stripe.checkout.sessions.create(...)`.
 *
 * The detector that saw the call could not know what `stripe` is, and the detector
 * that saw `new Stripe(...)` could not know anyone calls it. Each left a note; this
 * pairs them up, once, when every file has been read.
 */
export function servicesThroughWrappers(findings) {
    const exports = findings.filter((f) => f.type === 'client-export');
    if (exports.length === 0)
        return [];
    const calls = findings.filter((f) => f.type === 'wrapper-call');
    if (calls.length === 0)
        return [];
    const out = [];
    for (const call of calls) {
        const wanted = resolveSpecifier(call.module, call.site.path);
        if (!wanted)
            continue;
        const match = exports.find((client) => client.exportName === call.exportName && pathsAgree(client.site.path, wanted));
        if (!match)
            continue;
        const service = serviceForPackage(match.package);
        if (!service)
            continue;
        out.push({
            type: 'service',
            name: service.name,
            category: service.category,
            package: match.package,
            host: null,
            external: true,
            writes: sendsData(call.dotted, service.category),
            site: call.site,
        });
    }
    return out;
}
/**
 * `fetchFeedVersion(EXPECTED.feedLatest)` in one file, `fetch(url)` in another (#89).
 *
 * The detector at the call site could resolve the address and could not know whether
 * anything sends it; the detector in the helper saw the request go out and could not
 * know where to. Pairing them is what separates an app that phones home from one that
 * writes a URL into its licence notices — the second has no `url-sink` on the other
 * end, so it stays silent, which is the promise #25 made.
 *
 * The host is reported and nothing more. An unrecognised domain is not guessed into a
 * brand: "an outside host we could not identify" is the honest line, and it is a great
 * deal more useful than "no outside service".
 */
export function servicesThroughUrlHelpers(findings) {
    const sinks = findings.filter((f) => f.type === 'url-sink');
    if (sinks.length === 0)
        return [];
    const calls = findings.filter((f) => f.type === 'url-through');
    if (calls.length === 0)
        return [];
    const out = [];
    for (const call of calls) {
        const wanted = resolveSpecifier(call.module, call.site.path);
        if (!wanted)
            continue;
        const match = sinks.find((sink) => sink.exportName === call.exportName &&
            sink.paramIndex === call.argIndex &&
            pathsAgree(sink.site.path, wanted));
        if (!match)
            continue;
        const host = hostOf(call.url);
        if (!host || isInternalHost(host))
            continue;
        const known = serviceForHost(host);
        out.push({
            type: 'service',
            name: known?.name ?? host,
            category: known?.category ?? 'other',
            package: null,
            host,
            external: true,
            writes: match.writes,
            site: call.site,
        });
    }
    return out;
}
/**
 * `curl.post("https://slack.com/…")`, where `curl` is a file this project wrote (item 42).
 *
 * healthchecks makes every one of its 282 outgoing requests through `hc/lib/curl.py`,
 * its own "requests-like interface for PycURL". No call site imports an HTTP library,
 * so the per-file readers saw a method call on a local module and stopped — and the
 * boundary view reported one outside company, email, for a product whose whole job is
 * notifying eleven others.
 *
 * Both halves have to be present. A module that exposes `post` and wraps nothing is a
 * mailbox; a URL handed to it says nothing about the network. Only the pair is a call.
 */
export function servicesThroughPyWrappers(findings) {
    const wrappers = findings.filter((f) => f.type === 'http-wrapper');
    if (wrappers.length === 0)
        return [];
    const calls = findings.filter((f) => f.type === 'wrapper-url-call');
    if (calls.length === 0)
        return [];
    const byPath = new Map(wrappers.map((wrapper) => [wrapper.path, wrapper]));
    const out = [];
    for (const call of calls) {
        const wrapper = byPath.get(call.modulePath);
        if (!wrapper || !wrapper.names.includes(call.name))
            continue;
        const host = hostOf(call.url);
        if (!host || isInternalHost(host))
            continue;
        const known = serviceForHost(host);
        out.push({
            type: 'service',
            name: known?.name ?? host,
            category: known?.category ?? 'other',
            package: null,
            host,
            external: true,
            writes: call.writes,
            site: call.site,
        });
    }
    return out;
}
/**
 * The module a specifier points at, as a path with no extension.
 *
 * Relative specifiers resolve exactly. Path aliases (`@/lib/stripe`, `~/server/db`)
 * are configured in a tsconfig we do not read, so they resolve to a *suffix* — which
 * is what `pathsAgree` then matches on. Anything else is a package, and a package is
 * not a wrapper.
 */
function resolveSpecifier(specifier, fromPath) {
    if (specifier.startsWith('./') || specifier.startsWith('../')) {
        const parts = fromPath.split('/').slice(0, -1);
        for (const segment of specifier.split('/')) {
            if (segment === '.' || segment === '')
                continue;
            if (segment === '..')
                parts.pop();
            else
                parts.push(segment);
        }
        return stripExtension(parts.join('/'));
    }
    if (specifier.startsWith('@/') || specifier.startsWith('~/'))
        return stripExtension(specifier.slice(2));
    if (specifier.startsWith('#'))
        return stripExtension(specifier.slice(1));
    return null;
}
function stripExtension(path) {
    return path.replace(/\.(m|c)?[jt]sx?$/, '').replace(/\/index$/, '');
}
/** True when the file that exports the client is the file the specifier meant. */
function pathsAgree(exportPath, wanted) {
    const normalized = stripExtension(exportPath);
    return normalized === wanted || normalized.endsWith(`/${wanted}`);
}
//# sourceMappingURL=reach.js.map