/**
 * @fileoverview Guided tours, derived rather than written (SPEC.md 6.4).
 *
 * A walkthrough is the delivery mechanism for everything else this tool knows: a
 * sequence of steps, each one a place on the map, a set of things to light up, a
 * paragraph, and the code underneath it. What makes it worth building is that the
 * steps come out of the graph — "what happens when someone posts to /api/checkout" is
 * a traversal, not an essay, so it is right on a codebase nobody has ever seen and it
 * stays right after the next commit.
 *
 * Every `body` here is a statement of compiler-derived fact, phrased in plain English
 * and assembled from counts and names. Where a node has a description of its own it
 * rides along as a `quote`, labelled with where it came from — so a tour never blurs
 * the line between what the code says and what a model said about it.
 *
 * Nothing in this file calls a model. Tours are free, work offline, and are the same
 * on every run.
 */
import { authHeadline } from './exposure.js';
/** How many flows to offer up front. More than a handful stops being a suggestion. */
const MAX_FLOW_TOURS = 5;
const MAX_TRACE_DEPTH = 4;
const MAX_TRACED_NODES = 60;
/**
 * How many hops of the path to walk one at a time.
 *
 * The whole point of the middle of a tour is that it moves, so the cap is on the walk
 * rather than on what is reported: past this the remaining hops are still counted, they
 * are just not each given a step of their own.
 */
const MAX_WALK_HOPS = 4;
/**
 * How many doors to weigh before giving up on filling the offered list. Most are
 * rejected for walking nowhere, so the list has to look past the first five.
 */
const MAX_DOORS_WEIGHED = 40;
export function buildTours(graph) {
    const flows = [];
    for (const endpoint of majorEntryPoints(graph)) {
        if (flows.length >= MAX_FLOW_TOURS)
            break;
        const tour = flowTour(graph, endpoint);
        // A door with nothing behind it makes a one-step tour, which is not a tour.
        if (tour && tour.steps.length >= 2)
            flows.push(tour);
    }
    return [welcomeTour(graph), ...flows];
}
/**
 * The walkthrough for whatever the reader just opened, built when they open it.
 *
 * The offered list is short on purpose — five suggestions is a suggestion and twenty-four
 * is a directory — but "we only suggested five" was silently becoming "only five exist".
 * A reader who searched their way to the twelfth route found no button and no reason
 * given, which reads as *this door is not worth explaining*.
 *
 * Given a door, this is its own flow. Given a file or a function, it is the flow of the
 * door that leads there — the question somebody looking at `checkout.ts` is actually
 * asking is what reaches it. Exactly one door or nothing: two doors is two answers, and
 * picking one of them would be inventing the reader's question for them.
 */
export function tourFor(graph, nodeId) {
    const node = graph.getNodeById(nodeId);
    if (!node)
        return null;
    const door = node.kind === 'endpoint' ? node : theDoorThatLeadsHere(graph, node);
    if (!door)
        return null;
    const tour = flowTour(graph, door);
    return tour && tour.steps.length >= 2 ? tour : null;
}
function theDoorThatLeadsHere(graph, node) {
    const doors = graph
        .edgesTo(node.id)
        .filter((edge) => edge.kind === 'exposed-by')
        .map((edge) => graph.getNodeById(edge.fromId))
        .filter((found) => found?.kind === 'endpoint');
    const distinct = new Map(doors.map((found) => [found.id, found]));
    return distinct.size === 1 ? [...distinct.values()][0] : null;
}
// ---------------------------------------------------------------------------
// Welcome to your codebase
// ---------------------------------------------------------------------------
function welcomeTour(graph) {
    const stats = graph.meta.stats;
    const auth = authHeadline(stats);
    const app = graph.getNodeById(graph.rootId) ?? null;
    const overview = graph.getOverview();
    // Sorted by size, because the welcome step introduces them as "the biggest" —
    // and the level's own order is layout order, which made that claim a lie.
    const modules = overview.topLevel
        .filter((node) => node.kind === 'module')
        .sort((a, b) => Number(b.meta.descendantFileCount ?? b.childCount ?? 0) - Number(a.meta.descendantFileCount ?? a.childCount ?? 0))
        .slice(0, 6);
    // Without the env inventory, which is a list of variables rather than a way in. The
    // count beside this list comes from `stats.endpoints`, and the two have to be counting
    // the same things or the sentence contradicts itself inside one line: "22 ways in: 19
    // routes, 1 config source, 1 scheduled job, 1 webhook and 1 server action" adds to 23.
    const endpoints = graph
        .nodesOfKind('endpoint')
        .filter((node) => node.meta.endpointKind !== 'env');
    const stores = graph.nodesOfKind('store');
    const services = graph.nodesOfKind('service');
    const steps = [];
    steps.push({
        id: 'welcome:what',
        title: 'What this is',
        body: [
            `${graph.meta.name} is ${countOf(stats.files, 'file')} of ${graph.meta.languages.includes('typescript') ? 'TypeScript and JavaScript' : 'source code'}`,
            graph.meta.frameworks.length > 0 ? `built with ${list(graph.meta.frameworks)}` : null,
            `— ${countOf(stats.linesOfCode, 'line')} across ${countOf(stats.modules, 'folder')}.`,
        ]
            .filter(Boolean)
            .join(' '),
        quote: app?.summary ?? null,
        quoteSource: app?.summarySource ?? null,
        focusIds: [graph.rootId],
        levelId: graph.rootId,
        codeId: null,
    });
    steps.push({
        id: 'welcome:in',
        title: 'How the outside gets in',
        body: endpoints.length === 0
            ? 'App Atlas found no routes, webhooks or scheduled jobs — nothing here answers the outside world directly.'
            : [
                `${sentenceCase(countOf(stats.endpoints, 'way'))} in: ${describeDoors(endpoints)}.`,
                auth ? `${sentenceCase(auth.headline)}.` : null,
                // Only the first caveat: a walkthrough card is three lines, and the
                // security screen is where the full accounting belongs. Skipping the last
                // one when the headline is hedged is what keeps the card from stuttering —
                // that caveat is the long form of a clause the headline already carries.
                firstCaveat(auth),
            ]
                .filter(Boolean)
                .join(' '),
        quote: null,
        quoteSource: null,
        focusIds: endpoints.slice(0, 12).map((node) => node.id),
        levelId: graph.rootId,
        codeId: null,
        tone: auth?.tone === 'warn' ? 'warn' : undefined,
    });
    if (modules.length > 0) {
        // The two boundary containers are not parts of the code, so they are not counted
        // as such — "5 parts" when two of them are the inbound and outbound groups is the
        // kind of small wrongness that costs a reader their trust in every other number.
        const parts = overview.topLevel.filter((node) => node.kind === 'module' || node.kind === 'file').length;
        steps.push({
            id: 'welcome:parts',
            title: 'The parts it is made of',
            // Real folder names, not the generated ones. The count beside each is its whole
            // subtree, while a generated name may have been written about a cut across it
            // (#94) — and a step's body carries no provenance mark to say which is which, so
            // the only honest string here is the one the reader can find on disk.
            body: `The code divides into ${countOf(parts, 'part')} at the top level. The biggest: ${list(modules.map((node) => `${node.name} (${countOf(Number(node.meta.descendantFileCount ?? node.childCount), 'file')})`))}.`,
            quote: null,
            quoteSource: null,
            focusIds: modules.map((node) => node.id),
            levelId: graph.rootId,
            codeId: null,
        });
    }
    if (stores.length + services.length > 0) {
        steps.push({
            id: 'welcome:out',
            title: 'Where your data ends up',
            body: [
                stores.length > 0 ? `Data is kept in ${list(stores.map(describeStore))}.` : null,
                services.length > 0
                    ? `It is also sent to ${countOf(services.length, 'outside company', 'outside companies')}: ${list(services.slice(0, 6).map((node) => node.name))}.`
                    : null,
            ]
                .filter(Boolean)
                .join(' '),
            quote: null,
            quoteSource: null,
            focusIds: [...stores, ...services].slice(0, 12).map((node) => node.id),
            levelId: graph.rootId,
            codeId: null,
        });
    }
    const busiest = overview.whereToLookFirst.slice(0, 5);
    if (busiest.length > 0) {
        const names = labelsFor(busiest.map((entry) => entry.node));
        const by = busiest[0].imports;
        steps.push({
            id: 'welcome:start',
            title: 'Where to start reading',
            body: `${names[0]} pulls more of this codebase together than anything else — it imports ${by} ${by === 1 ? 'file' : 'files'} directly, and reaches most of the rest through them. That is usually either the way in or the place the app is assembled. After that: ${list(names.slice(1))}.`,
            quote: busiest[0].node.summary,
            quoteSource: busiest[0].node.summarySource,
            focusIds: busiest.map((entry) => entry.node.id),
            levelId: parentOf(graph, busiest[0].node.id),
            codeId: busiest[0].node.id,
        });
    }
    return {
        id: 'tour:welcome',
        title: 'Welcome to your codebase',
        subtitle: `${steps.length} steps · start here`,
        kind: 'welcome',
        steps,
    };
}
// ---------------------------------------------------------------------------
// What happens when…
// ---------------------------------------------------------------------------
/**
 * The doors worth a tour, in the order they should be offered.
 *
 * Scoring answers which door matters most: a route that writes data matters more than
 * one that reads it, and a door with code behind it matters more than one declared in
 * a config file and never wired up.
 *
 * Which doors get *seen* is a second question, and sorting alone answers it badly. A
 * file-routed app has two dozen screens and perhaps one edge function, so ranking on
 * score alone buries the edge function. Ranking every network door above every screen
 * fails the other way: an app whose routes are all inferred from a database schema
 * fills every slot with them and never mentions the screens somebody actually built.
 * So the two kinds are dealt out in turn, and the best network door still goes first.
 *
 * A door with no code behind it is left out of the offered list entirely. Frameworks
 * that publish routes from a schema — PostgREST reads one door per verb per table
 * straight out of a migration — can declare dozens that no file in the repo answers,
 * and a tour of one is a knock with nobody home: the steps that would say what runs,
 * what it reaches and where it lands all have nothing to report. Those doors are real
 * and belong on the map; they are just not a walk. Asking for one by name still
 * builds it — it is only the unprompted suggestion that has to earn its place.
 */
function majorEntryPoints(graph) {
    const ranked = graph
        .nodesOfKind('endpoint')
        .filter((node) => {
        const meta = node.meta;
        // The env "door" is an inventory, not a path anyone travels.
        return meta.endpointKind !== 'env' && meta.endpointKind !== 'file-read';
    })
        .map((node) => {
        const meta = node.meta;
        const answering = graph
            .edgesFrom(node.id)
            .filter((edge) => edge.kind === 'exposed-by')
            .map((edge) => edge.toId);
        let score = answering.length * 3;
        if (meta.writes)
            score += 6;
        if (meta.endpointKind === 'webhook')
            score += 4;
        if (meta.endpointKind === 'server-action')
            score += 2;
        if (meta.method === 'PAGE')
            score -= 3;
        score += Math.min(meta.sites.length, 4);
        score += Math.min(reachOf(graph, answering), 6);
        return { node, score, handlers: answering.length };
    })
        .filter((entry) => entry.score > 0 && entry.handlers > 0)
        .sort((a, b) => b.score - a.score || a.node.name.localeCompare(b.node.name))
        .map((entry) => entry.node);
    const network = ranked.filter((node) => !isScreen(node));
    const screens = ranked.filter(isScreen);
    return dealInTurn([network, screens]).slice(0, MAX_DOORS_WEIGHED);
}
function isScreen(node) {
    return node.meta.endpointKind === 'screen';
}
/**
 * How many distinct pieces of code the answering code touches directly.
 *
 * Every screen in a file-routed app scores the same on everything else — one handler,
 * no writes of its own, one site — so without this they tie and fall back to
 * alphabetical order, which offered a home screen that renders a logo ahead of the
 * form that is the whole point of the app. One hop is enough to tell those apart and
 * cheap enough to run over every door; the full walk is the tour's own job.
 */
function reachOf(graph, fromIds) {
    const reached = new Set();
    for (const id of fromIds) {
        for (const edge of graph.edgesFrom(id)) {
            if (edge.kind === 'references')
                reached.add(edge.toId);
        }
    }
    return reached.size;
}
/**
 * Deal one from each group in turn until every group is empty, so no single group can
 * take every slot. Groups keep their own order, and the first group's best still comes
 * out first overall.
 */
function dealInTurn(groups) {
    const out = [];
    for (let depth = 0; groups.some((group) => depth < group.length); depth++) {
        for (const group of groups) {
            if (depth < group.length)
                out.push(group[depth]);
        }
    }
    return out;
}
function flowTour(graph, endpoint) {
    const meta = endpoint.meta;
    const handlers = graph
        .edgesFrom(endpoint.id)
        .filter((edge) => edge.kind === 'exposed-by')
        .map((edge) => graph.getNodeById(edge.toId))
        .filter((node) => Boolean(node));
    const walk = walkFrom(graph, handlers);
    const outputs = outputsOf(graph, [...handlers, ...walk.reached]);
    const steps = [];
    // 1. the door
    steps.push({
        id: `${endpoint.id}:door`,
        title: 'Something knocks',
        body: `${sentenceCase(trigger(endpoint))}. ${doorDetail(meta)}`,
        quote: endpoint.summary,
        quoteSource: endpoint.summarySource,
        focusIds: [endpoint.id],
        levelId: parentOf(graph, endpoint.id),
        codeId: handlers[0]?.id ?? null,
    });
    // 2. what answers
    if (handlers.length > 0) {
        const first = handlers[0];
        steps.push({
            id: `${endpoint.id}:handler`,
            title: 'Your code answers',
            body: handlers.length === 1
                ? `${nameAndPlace(first)} runs.`
                : `${countOf(handlers.length, 'piece')} of code answer it, starting with ${nameAndPlace(first)}.`,
            quote: first.summary,
            quoteSource: first.summarySource,
            focusIds: handlers.map((node) => node.id),
            levelId: parentOf(graph, first.id),
            codeId: first.id,
        });
    }
    // 3. the walk itself — one hop per step, following one real path
    walk.hops.forEach((node, index) => {
        const from = index === 0 ? walk.startedAt : walk.hops[index - 1];
        steps.push({
            id: `${endpoint.id}:hop${index}`,
            // The name of the thing you are looking at, so the step titles and the dots along
            // the top finally say something different from each other.
            title: node.name,
            body: [
                `${from.name} uses ${nameAndPlace(node)}.`,
                // Said once, on the first hop, because it governs every hop after it: these are
                // references the compiler resolved, and a reference is one piece of code naming
                // another. No static reading of the source can say what ran.
                index === 0
                    ? 'Each step from here follows a reference in the source — one piece of code naming another — rather than a recording of a run.'
                    : null,
            ]
                .filter(Boolean)
                .join(' '),
            quote: node.summary,
            quoteSource: node.summarySource,
            // Both ends of the hop, so the step shows the move rather than the destination.
            focusIds: [from.id, node.id],
            levelId: parentOf(graph, node.id),
            codeId: node.id,
        });
    });
    // 4. where it lands
    if (outputs.length > 0) {
        steps.push({
            id: `${endpoint.id}:out`,
            title: 'And ends up here',
            body: `Along the way it touches ${list(outputs.map((node) => (node.kind === 'store' ? describeStore(node) : describeService(node))))}.`,
            quote: null,
            quoteSource: null,
            focusIds: outputs.map((node) => node.id),
            levelId: parentOf(graph, outputs[0].id),
            codeId: null,
        });
    }
    // The walk followed one path, and the last thing said about it has to be how much of
    // the neighbourhood that left out — otherwise a four-step line through a screen that
    // touches forty pieces reads as the whole of what happens behind that door. It hangs
    // off the last step there is rather than off the landing step, because a flow that
    // touches no store or service has no landing step and is exactly the wide, branching
    // kind this most needs saying about.
    const breadth = besides(walk);
    const closing = steps[steps.length - 1];
    if (breadth && closing)
        closing.body = `${closing.body} ${breadth}`;
    // 5. the warning, if it is one
    if (meta.guards.length === 0 && meta.writes && isReachableByStrangers(meta)) {
        steps.push({
            id: `${endpoint.id}:auth`,
            title: 'Nobody is checking who called',
            body: `App Atlas found no auth check on this door, and the code behind it writes data. Anyone who knows the address can reach it. If that is deliberate — a public sign-up, a webhook verified by signature — nothing is wrong; if it is not, this is the kind of thing worth fixing today.`,
            quote: null,
            quoteSource: null,
            focusIds: [endpoint.id],
            levelId: parentOf(graph, endpoint.id),
            codeId: null,
            tone: 'warn',
        });
    }
    else if (meta.guards.length > 0) {
        const guard = meta.guards[0];
        steps.push({
            id: `${endpoint.id}:auth`,
            title: 'What is guarding it',
            body: `${checker(guard)} checks the caller${guard.path ? ` in ${guard.path}` : ''}${guard.confidence === 'certain' ? '' : ' — App Atlas is fairly, not entirely, sure this covers it'}.${reachedThrough(guard)}`,
            quote: null,
            quoteSource: null,
            focusIds: [endpoint.id],
            levelId: parentOf(graph, endpoint.id),
            codeId: null,
        });
    }
    return {
        id: `tour:${endpoint.id}`,
        title: `What happens when ${trigger(endpoint)}`,
        subtitle: `${steps.length} steps · traced from the code`,
        kind: 'flow',
        steps,
    };
}
/**
 * A path through the code behind a door, rather than a list of what it can touch.
 *
 * The middle of a tour used to be one step reading "it reaches 41 other pieces of your
 * code, including" and six names in breadth-first order. Every word of that was true and
 * it answered nothing: the six were at six different depths, the map could only show one
 * of them, and the reader was told about the whole middle of their app in a sentence
 * they could not follow. The question somebody starts a walkthrough to ask is *what
 * happens next*, which is a path.
 *
 * So one path is chosen and walked a hop at a time. Which path: the one that reaches a
 * store or an outside service, because that is where the consequence is, preferring a
 * write over a read and the shortest route to it. A flow that touches nothing outside
 * itself — most screens — falls back to the busiest thing it reaches, which is the piece
 * of code the rest of the flow is built around.
 *
 * The breadth is not thrown away, it is demoted: the landing step says how much of the
 * neighbourhood this one path did not cover, so a four-step walk through a screen that
 * touches forty pieces never reads as the whole of what happens there.
 */
function walkFrom(graph, handlers) {
    const roots = new Set(handlers.map((node) => node.id));
    const cameFrom = new Map();
    const depthOf = new Map(handlers.map((node) => [node.id, 0]));
    const seen = new Set(roots);
    const reached = [];
    let frontier = handlers;
    let capped = false;
    /** The node that touches a store or service, and how good a landing it is. */
    let landing = null;
    for (let depth = 1; depth <= MAX_TRACE_DEPTH && frontier.length > 0; depth++) {
        const next = [];
        for (const node of frontier) {
            for (const edge of graph.edgesFrom(node.id)) {
                const target = graph.getNodeById(edge.toId);
                if (!target)
                    continue;
                if (target.kind === 'store' || target.kind === 'service') {
                    const writes = edge.kind === 'writes-to';
                    const here = { via: node.id, writes, depth: depthOf.get(node.id) ?? depth };
                    if (!landing || better(here, landing))
                        landing = here;
                    continue;
                }
                if (edge.kind !== 'references' || seen.has(target.id))
                    continue;
                if (target.kind !== 'function' && target.kind !== 'file')
                    continue;
                if (reached.length >= MAX_TRACED_NODES) {
                    capped = true;
                    continue;
                }
                seen.add(target.id);
                cameFrom.set(target.id, node.id);
                depthOf.set(target.id, depth);
                next.push(target);
                reached.push(target);
            }
        }
        frontier = next;
    }
    const target = landing?.via ?? busiest(graph, reached);
    const chain = target ? pathBack(cameFrom, target, roots) : [];
    const nodes = chain.map((id) => graph.getNodeById(id)).filter((node) => Boolean(node));
    return {
        startedAt: nodes[0] ?? handlers[0],
        hops: nodes.slice(1, 1 + MAX_WALK_HOPS),
        reached,
        countCapped: capped,
    };
}
/**
 * Which landing makes the better walk.
 *
 * A path with a hop in it beats one without, and that clause is doing more work than it
 * looks. The ordinary shape of a route handler is that it writes to the database itself
 * *and* calls other code — so ranking on "shortest write" alone made the handler its own
 * landing, the walk collapsed to nothing, and the door with the most going on behind it
 * was the one that showed the least. Nothing is hidden by preferring the longer way
 * round: the landing step lists every store and service the whole neighbourhood touches,
 * direct writes included.
 *
 * After that a write beats a read, because that is where the consequence is, and a
 * shorter route beats a longer one.
 */
function better(a, b) {
    if (a.depth > 0 !== b.depth > 0)
        return a.depth > 0;
    if (a.writes !== b.writes)
        return a.writes;
    return a.depth < b.depth;
}
/**
 * The piece of code the rest of a flow is built around: whatever names the most others.
 *
 * Used when nothing behind the door reaches a store or a service, which is the ordinary
 * case for a screen that only renders. Walking to the busiest node beats walking to the
 * first one breadth-first order happened to produce, which was alphabetical noise.
 */
function busiest(graph, nodes) {
    let best = null;
    for (const node of nodes) {
        const uses = graph.edgesFrom(node.id).filter((edge) => edge.kind === 'references').length;
        if (!best || uses > best.uses || (uses === best.uses && node.name.localeCompare(best.name) < 0)) {
            best = { id: node.id, uses, name: node.name };
        }
    }
    return best?.id ?? null;
}
/** The route the search took to get here, read back the way a reader would follow it. */
function pathBack(cameFrom, from, roots) {
    const chain = [from];
    let at = from;
    while (!roots.has(at)) {
        const previous = cameFrom.get(at);
        if (!previous || chain.includes(previous))
            break;
        chain.push(previous);
        at = previous;
    }
    return chain.reverse();
}
/** What the walk went past, said plainly, or nothing when it went past nothing. */
function besides(walk) {
    const others = walk.reached.length - walk.hops.length;
    if (others <= 0)
        return null;
    return `That is one path of several: the code behind this door also reaches ${walk.countCapped ? 'at least ' : ''}${countOf(others, 'other piece')} this walk did not follow.`;
}
function outputsOf(graph, nodes) {
    const found = new Map();
    for (const node of nodes) {
        for (const edge of graph.edgesFrom(node.id)) {
            const target = graph.getNodeById(edge.toId);
            if (!target || (target.kind !== 'store' && target.kind !== 'service'))
                continue;
            found.set(target.id, target);
        }
    }
    return [...found.values()].slice(0, 8);
}
// ---------------------------------------------------------------------------
// Phrasing
// ---------------------------------------------------------------------------
/**
 * "index.ts in supabase/functions/chat/index.ts" says the file name twice.
 * When the thing that runs *is* the file, its path is the whole story.
 */
function nameAndPlace(node) {
    if (!node.path)
        return node.name;
    const base = node.path.split('/').pop() ?? '';
    return base === node.name || base === `${node.name}.ts` || base === `${node.name}.js`
        ? node.path
        : `${node.name} in ${node.path}`;
}
/** The clause that finishes "What happens when …". */
function trigger(endpoint) {
    const meta = endpoint.meta;
    const route = meta.route ?? endpoint.name;
    switch (meta.endpointKind) {
        case 'http-route':
            // "sends ANY to" is analyzer jargon leaking out — a route that accepts any
            // method is simply called.
            if (meta.method === 'PAGE')
                return `someone opens ${route}`;
            if (!meta.method || meta.method === 'ANY')
                return `something calls ${route}`;
            return `something sends ${meta.method} to ${route}`;
        case 'server-action':
            return `the page calls ${route}`;
        // Deliberately not named: `framework` is the convention that *found* the webhook,
        // not whoever calls it, and "Next.js calls your webhook" is simply false.
        case 'webhook':
            return `an outside service calls your webhook at ${route}`;
        case 'cron':
            return `the schedule fires${meta.schedule ? ` (${meta.schedule})` : ''}`;
        case 'queue':
            return `a background job runs`;
        case 'worker':
            // The schedule is only ever one the code declared; without one, "with the app"
            // is the whole truth — it starts when the app does and runs on its own.
            return `${endpoint.name} runs${meta.schedule ? ` (${meta.schedule})` : ' with the app'}`;
        case 'realtime':
            return `a client subscribes to ${route}`;
        case 'cli':
            return `the command line runs it`;
        case 'screen':
            return `someone opens ${route}`;
        default:
            return `${route} is reached`;
    }
}
function doorDetail(meta) {
    const where = meta.sites[0];
    const parts = [`Found by the ${meta.framework} convention`];
    if (where)
        parts.push(`at ${where.path}:${where.line}`);
    return `${parts.join(' ')}.${meta.writes ? ' The code behind it writes data.' : ''}`;
}
function describeDoors(endpoints) {
    const counts = new Map();
    for (const node of endpoints) {
        const meta = node.meta;
        const noun = DOOR_NOUNS[meta.endpointKind] ?? 'entry point';
        counts.set(noun, (counts.get(noun) ?? 0) + 1);
    }
    return list([...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([noun, count]) => countOf(count, noun)));
}
const DOOR_NOUNS = {
    // Without this a file-routed app reports "23 entry points and 21 routes", where the
    // entry points are its screens and the noun is the one word that does not say so.
    screen: 'screen',
    'http-route': 'route',
    'server-action': 'server action',
    webhook: 'webhook',
    cron: 'scheduled job',
    queue: 'background worker',
    worker: 'background service',
    realtime: 'realtime channel',
    cli: 'command',
    env: 'config source',
    'file-read': 'file read',
};
/**
 * The name of the thing doing the checking.
 *
 * A custom guard found several calls deep carries its whole route in its name —
 * `CellarBottleForm → suggest → sendMessage → supabase.auth.getSession` — and using that
 * as the subject of a sentence produces a line nobody can read. The last segment is the
 * check; how the code got there is a separate clause, in [[reachedThrough]].
 */
function checker(guard) {
    if (guard.provider !== 'custom')
        return guard.provider;
    const chain = segments(guard.name);
    return chain[chain.length - 1] ?? guard.name;
}
/**
 * The route to a guard the door does not call directly, as its own sentence or nothing.
 *
 * Worth saying whoever provides the check. "Clerk checks the caller in session.ts" is
 * true and leaves out the part a reader needs to find it — that the door gets there by
 * calling `requireOwner`, which is the name they would search for.
 */
function reachedThrough(guard) {
    const chain = segments(guard.name);
    return chain.length > 1 ? ` The code reaches it through ${chain.slice(0, -1).join(' → ')}.` : '';
}
function segments(name) {
    return name
        .split('→')
        .map((step) => step.trim())
        .filter(Boolean);
}
function describeStore(node) {
    const meta = node.meta;
    const tables = meta.tables.length > 0 ? ` (${countOf(meta.tables.length, 'table')})` : '';
    return `${node.name}${tables}`;
}
function describeService(node) {
    const meta = node.meta;
    return `${node.name}${meta.category !== 'other' ? ` for ${meta.category}` : ''}`;
}
function isReachableByStrangers(meta) {
    return meta.endpointKind === 'http-route' || meta.endpointKind === 'server-action' || meta.endpointKind === 'realtime';
}
/**
 * `route.ts` four times in a row tells the reader nothing. Framework conventions name
 * files by position rather than by content, so those get their folder back.
 */
const POSITIONAL_NAMES = new Set([
    'route.ts',
    'route.tsx',
    'page.ts',
    'page.tsx',
    'index.ts',
    'index.tsx',
    'layout.tsx',
    'handler.ts',
    'mod.ts',
]);
function withFolder(node) {
    return node.path ? node.path.split('/').slice(-2).join('/') : node.name;
}
/**
 * Names for a set of files, disambiguated within that set. Listing `types.ts` twice
 * looks like a mistake even when both are real; `model/types.ts` and `web/types.ts`
 * are two answers rather than one repeated.
 */
function labelsFor(nodes) {
    const seen = new Map();
    for (const node of nodes)
        seen.set(node.name, (seen.get(node.name) ?? 0) + 1);
    return nodes.map((node) => (seen.get(node.name) ?? 0) > 1 || POSITIONAL_NAMES.has(node.name) ? withFolder(node) : node.name);
}
function parentOf(graph, id) {
    const chain = graph.breadcrumb(id);
    return chain[chain.length - 2]?.id ?? graph.rootId;
}
/**
 * A count and its noun. Grouped, because every other surface groups: the walkthrough
 * said "30465 lines" on a card sitting next to a panel reading "30,465", and the reader
 * has to stop and check whether those are the same number.
 */
function countOf(value, one, many) {
    return `${value.toLocaleString('en-US')} ${value === 1 ? one : (many ?? `${one}s`)}`;
}
/**
 * The caveat worth the one line a card has for it, or nothing.
 *
 * The hedge caveat is dropped when the headline already carries it — see `AuthHeadline.hedged`.
 */
function firstCaveat(auth) {
    if (!auth)
        return null;
    const worth = auth.hedged ? auth.caveats.slice(0, -1) : auth.caveats;
    return worth[0] ? `${sentenceCase(worth[0])}.` : null;
}
function list(items) {
    const clean = items.filter(Boolean);
    if (clean.length === 0)
        return '';
    if (clean.length === 1)
        return clean[0];
    return `${clean.slice(0, -1).join(', ')} and ${clean[clean.length - 1]}`;
}
function sentenceCase(text) {
    return text.charAt(0).toUpperCase() + text.slice(1);
}
//# sourceMappingURL=tours.js.map