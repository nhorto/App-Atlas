import { classifyOpenDoors } from './exposure.js';
const CAPTIONS = {
    'web-app': { inputs: 'What gets in', app: 'Your app', outputs: 'Where data goes' },
    service: { inputs: 'What calls it', app: 'Your service', outputs: 'Where data goes' },
    library: { inputs: 'What consumers can call', app: 'Your library', outputs: 'What it reaches for' },
    pipeline: { inputs: 'What it reads', app: 'Your code', outputs: 'What it writes' },
    analysis: { inputs: 'Where the data comes from', app: 'The analysis', outputs: 'What it produces' },
    unknown: { inputs: 'What gets in', app: 'Your code', outputs: 'Where data goes' },
};
/** Kept in this order on screen: how a request arrives, roughly. */
const INPUT_FAMILIES = [
    { family: 'screens', label: 'Screens', kinds: ['screen'] },
    // The doors between a desktop app's interface and its engine. Beside the screens
    // because that is who calls them; never in the auth table, for the same reason the
    // screens are not.
    { family: 'commands', label: 'Commands your screens call', kinds: ['ipc'] },
    { family: 'pages', label: 'Pages', kinds: ['http-route'], match: (meta) => meta.method === 'PAGE' },
    { family: 'routes', label: 'API routes', kinds: ['http-route'], match: (meta) => meta.method !== 'PAGE' },
    { family: 'actions', label: 'Server actions', kinds: ['server-action'] },
    { family: 'webhooks', label: 'Webhooks', kinds: ['webhook'] },
    { family: 'cron', label: 'Scheduled jobs', kinds: ['cron'] },
    { family: 'queue', label: 'Background jobs', kinds: ['queue'] },
    // Started by the app rather than by a schedule or a queue — a .NET hosted service.
    // Its own family for the same reason it is its own kind: it has no schedule to print
    // and nothing enqueues to it, and filing it under either would say one of those.
    { family: 'workers', label: 'Background services', kinds: ['worker'] },
    { family: 'realtime', label: 'Realtime', kinds: ['realtime'] },
    // Doors a deployment file opens rather than code. Their own card, never folded in with
    // the API routes: they carry no auth verdict, and a card whose "open" badge counted
    // them would be counting ports nothing is supposed to check.
    { family: 'ports', label: 'Ports a deployment file publishes', kinds: ['port'] },
    // A library's whole boundary. Split in two because the commitments are different:
    // changing a function's behaviour breaks callers at runtime, changing a type's
    // shape breaks them at compile time.
    {
        family: 'exports',
        label: 'Functions you can call',
        kinds: ['export'],
        match: (meta) => meta.framework === 'function',
    },
    {
        family: 'export-types',
        label: 'Types you can import',
        kinds: ['export'],
        match: (meta) => meta.framework !== 'function',
    },
    { family: 'cli', label: 'Command line', kinds: ['cli'] },
    { family: 'env', label: 'Environment & config', kinds: ['env'] },
    // `file-read` is deliberately absent: the filesystem is a store, and it was a door
    // and a store at once, both drawn and both called "Files on disk". Old atlases still
    // carry the kind, so the type keeps it; nothing emits it any more.
];
const ZONE_ORDER = ['ui', 'api', 'logic', 'data', 'config', 'test', 'unknown'];
const ZONE_LABELS = {
    ui: 'Interface',
    api: 'API',
    logic: 'Logic',
    data: 'Data',
    config: 'Config',
    test: 'Tests',
    unknown: 'Other',
};
const MAX_OUTPUT_CARDS = 9;
export function buildBoundaryView(graph) {
    const endpoints = graph.nodesOfKind('endpoint');
    const services = graph.nodesOfKind('service');
    const stores = graph.nodesOfKind('store');
    const flows = [];
    const zoneWeights = new Map();
    // Card badges and the summary line under them have to be counting the same thing,
    // or the screen argues with itself: "8 open" on the Pages card above "1 route has
    // no auth check" is a reader's first reason to distrust both (#24).
    const openDoors = classifyOpenDoors(graph.allNodes(), graph.allEdges());
    const archetype = graph.meta.archetype?.archetype;
    // For an app, the request comes first and the database is somewhere data is put. For
    // an analysis, the data comes first: the file is where the work starts, and the whole
    // left-hand column is the answer to "where did this come from". The pipeline caption
    // has promised "What it reads" since the archetypes were built, and until now that
    // column held environment variables.
    const readsFirst = archetype === 'analysis' || archetype === 'pipeline';
    const sources = readsFirst ? stores.filter((node) => node.meta.reads > 0) : [];
    const sourceIds = new Set(sources.map((node) => node.id));
    const inputs = [
        ...buildInputs(graph, endpoints, flows, zoneWeights, openDoors),
        ...buildSources(graph, sources, flows, zoneWeights),
    ];
    // A store that is read and never written belongs on the left and nowhere else. One
    // that is both is genuinely both, and saying so twice — "6 reads" in, "1 write" out —
    // is the shape of the work rather than a duplicate.
    const kept = stores.filter((node) => !sourceIds.has(node.id) || node.meta.writes > 0);
    const outputs = buildOutputs(graph, services, kept, flows, zoneWeights);
    return {
        appName: graph.meta.name,
        archetype,
        captions: CAPTIONS[archetype ?? 'unknown'],
        inputs,
        zones: buildZones(graph, zoneWeights),
        outputs,
        flows,
        summary: {
            // Same count `listDoors` reports, for the same reason: the env inventory is a list
            // of variables, not a path anybody travels. It keeps its own card in `inputs`.
            endpoints: endpoints.filter((node) => node.meta.endpointKind !== 'env').length,
            openRoutes: graph.meta.stats.unprotectedRoutes,
            externalServices: services.length,
            stores: stores.length,
            envVars: graph.meta.stats.envVars,
        },
    };
}
// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------
function buildInputs(graph, endpoints, flows, zoneWeights, openDoors) {
    const cards = [];
    for (const { family, label, kinds, match } of INPUT_FAMILIES) {
        const members = endpoints.filter((node) => {
            const meta = node.meta;
            if (!kinds.includes(meta.endpointKind))
                return false;
            return match ? match(meta) : true;
        });
        if (members.length === 0)
            continue;
        let paths = 0;
        let open = 0;
        for (const node of members) {
            const meta = node.meta;
            paths += Math.max(1, meta.sites.length);
            if (openDoors.get(node.id)?.kind === 'worth-a-look')
                open++;
            // A door's flow lands in the zone of whatever code answers it.
            for (const edge of graph.edgesFrom(node.id)) {
                if (edge.kind !== 'exposed-by')
                    continue;
                const zone = graph.getNodeById(edge.toId)?.zone;
                if (zone)
                    addFlow(flows, zoneWeights, `input:${family}`, `zone:${zone}`, edge.weight);
            }
        }
        // Endpoints nobody could attribute to code (a cron declared only in vercel.json)
        // would otherwise be a card with no band leaving it.
        if (!flows.some((flow) => flow.fromId === `input:${family}`)) {
            addFlow(flows, zoneWeights, `input:${family}`, `zone:${members[0].zone}`, members.length);
        }
        cards.push({
            id: `input:${family}`,
            name: label,
            detail: inputDetail(family, members),
            count: paths,
            memberIds: members.map((node) => node.id),
            members: members.length > 1 ? members.map((node) => ({ id: node.id, name: node.name })) : undefined,
            nodeId: members.length === 1 ? members[0].id : null,
            family,
            openCount: isAuthFamily(family) ? open : undefined,
        });
    }
    return cards;
}
/**
 * The stores an analysis or a pipeline reads, drawn as the inputs they are.
 *
 * Same node as the output card when the code writes to it as well, so clicking either
 * lands on the same box on the Map. Only the direction differs, because only the
 * direction did.
 */
function buildSources(graph, sources, flows, zoneWeights) {
    return sources.map((node) => {
        const meta = node.meta;
        const id = `input:${node.id}`;
        for (const edge of graph.edgesTo(node.id)) {
            if (edge.kind !== 'reads-from')
                continue;
            const zone = graph.getNodeById(edge.fromId)?.zone;
            if (zone)
                addFlow(flows, zoneWeights, id, `zone:${zone}`, edge.weight);
        }
        if (!flows.some((flow) => flow.fromId === id)) {
            addFlow(flows, zoneWeights, id, `zone:${node.zone}`, meta.reads);
        }
        return {
            id,
            name: node.name,
            detail: `${meta.client} · ${meta.reads} ${meta.reads === 1 ? 'read' : 'reads'}`,
            count: meta.reads,
            memberIds: [node.id],
            nodeId: node.id,
            family: 'source',
        };
    });
}
function isAuthFamily(family) {
    return family === 'pages' || family === 'routes' || family === 'actions' || family === 'realtime';
}
function inputDetail(family, members) {
    const count = members.length;
    if (family === 'env') {
        const vars = members[0].meta.vars ?? [];
        return `${vars.length} ${vars.length === 1 ? 'variable' : 'variables'}`;
    }
    if (family === 'cli' || family === 'files') {
        // Every member is its own entry point, and each carries its own call sites — count
        // them all, not just the first member's. Eleven runnable scripts are eleven places,
        // not one.
        const sites = members.reduce((n, m) => n + m.meta.sites.length, 0);
        return `${sites} ${sites === 1 ? 'place' : 'places'}`;
    }
    const noun = INPUT_NOUNS[family] ?? 'entry point';
    return `${count} ${count === 1 ? noun : `${noun}s`}`;
}
const INPUT_NOUNS = {
    screens: 'screen',
    pages: 'page',
    routes: 'route',
    actions: 'action',
    webhooks: 'webhook',
    cron: 'scheduled job',
    queue: 'worker',
    workers: 'service',
    realtime: 'subscription',
    ports: 'published port',
    exports: 'function',
    'export-types': 'type',
};
// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------
function buildOutputs(graph, services, stores, flows, zoneWeights) {
    const candidates = [];
    for (const node of stores) {
        const meta = node.meta;
        candidates.push({
            node,
            card: {
                id: node.id,
                name: node.name,
                detail: storeDetail(meta),
                count: meta.sites.length,
                memberIds: [node.id],
                nodeId: node.id,
                family: 'store',
            },
        });
    }
    for (const node of services) {
        const meta = node.meta;
        candidates.push({
            node,
            card: {
                id: node.id,
                name: node.name,
                detail: serviceDetail(meta),
                count: meta.sites.length,
                memberIds: [node.id],
                nodeId: node.id,
                family: meta.category,
            },
        });
    }
    // Stores first, then whatever is used most — the database is almost always the
    // thing a person is looking for.
    candidates.sort((a, b) => {
        const byFamily = (a.card.family === 'store' ? 0 : 1) - (b.card.family === 'store' ? 0 : 1);
        if (byFamily !== 0)
            return byFamily;
        return b.card.count - a.card.count || a.card.name.localeCompare(b.card.name);
    });
    const shown = candidates.slice(0, MAX_OUTPUT_CARDS);
    const rest = candidates.slice(MAX_OUTPUT_CARDS);
    for (const { node, card } of shown) {
        for (const edge of graph.edgesTo(node.id)) {
            if (edge.kind !== 'reads-from' && edge.kind !== 'writes-to')
                continue;
            const zone = graph.getNodeById(edge.fromId)?.zone;
            if (zone)
                addFlow(flows, zoneWeights, `zone:${zone}`, card.id, edge.weight);
        }
    }
    const cards = shown.map((entry) => entry.card);
    if (rest.length > 0) {
        const id = 'output:other';
        for (const { node } of rest) {
            for (const edge of graph.edgesTo(node.id)) {
                if (edge.kind !== 'reads-from' && edge.kind !== 'writes-to')
                    continue;
                const zone = graph.getNodeById(edge.fromId)?.zone;
                if (zone)
                    addFlow(flows, zoneWeights, `zone:${zone}`, id, edge.weight);
            }
        }
        cards.push({
            id,
            name: `${rest.length} more`,
            detail: rest
                .slice(0, 4)
                .map((entry) => entry.card.name)
                .join(', '),
            count: rest.reduce((sum, entry) => sum + entry.card.count, 0),
            memberIds: rest.map((entry) => entry.node.id),
            members: rest.map((entry) => ({ id: entry.node.id, name: entry.card.name })),
            nodeId: null,
            family: 'other',
        });
    }
    return cards;
}
function storeDetail(meta) {
    const parts = [meta.client];
    if (meta.tables.length > 0) {
        parts.push(`${meta.tables.length} ${meta.tables.length === 1 ? 'table' : 'tables'}`);
    }
    if (meta.writes > 0)
        parts.push(`${meta.writes} ${meta.writes === 1 ? 'write' : 'writes'}`);
    // A store nothing writes to is still a store something reads, and a card that says
    // only "pandas" looks like a box we could not finish.
    else if (meta.reads > 0)
        parts.push(`${meta.reads} ${meta.reads === 1 ? 'read' : 'reads'}`);
    return parts.join(' · ');
}
function serviceDetail(meta) {
    const source = meta.packages[0] ?? meta.hosts[0] ?? '';
    return source ? `${CATEGORY_LABELS[meta.category] ?? meta.category} · ${source}` : CATEGORY_LABELS[meta.category] ?? meta.category;
}
const CATEGORY_LABELS = {
    payments: 'Payments',
    ai: 'AI',
    email: 'Email',
    sms: 'SMS',
    auth: 'Accounts',
    storage: 'File storage',
    analytics: 'Analytics',
    search: 'Search',
    monitoring: 'Monitoring',
    queue: 'Jobs',
    other: 'Service',
};
// ---------------------------------------------------------------------------
// The middle
// ---------------------------------------------------------------------------
function buildZones(graph, zoneWeights) {
    const fileCounts = new Map();
    for (const file of graph.nodesOfKind('file')) {
        fileCounts.set(file.zone, (fileCounts.get(file.zone) ?? 0) + 1);
    }
    const present = new Set(zoneWeights.keys());
    // A zone with no boundary traffic is still part of the app; show the big ones so the
    // middle box is the app rather than only the parts that touch the outside world.
    for (const [zone, count] of fileCounts) {
        if (zone !== 'test' && zone !== 'unknown' && count > 0)
            present.add(zone);
    }
    return ZONE_ORDER.filter((zone) => present.has(zone)).map((zone) => ({
        zone,
        label: ZONE_LABELS[zone],
        files: fileCounts.get(zone) ?? 0,
    }));
}
function addFlow(flows, zoneWeights, fromId, toId, weight) {
    const existing = flows.find((flow) => flow.fromId === fromId && flow.toId === toId);
    if (existing)
        existing.weight += weight;
    else
        flows.push({ fromId, toId, weight });
    const zoneId = fromId.startsWith('zone:') ? fromId : toId.startsWith('zone:') ? toId : null;
    if (zoneId) {
        const zone = zoneId.slice(5);
        zoneWeights.set(zone, (zoneWeights.get(zone) ?? 0) + weight);
    }
}
//# sourceMappingURL=boundary.js.map