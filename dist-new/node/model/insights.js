import { classifyOpenDoors, isAuthRelevant, unreadableFiles } from './exposure.js';
export function buildInsights(graph) {
    const endpoints = graph.nodesOfKind('endpoint');
    const nodes = graph.allNodes();
    const openDoors = classifyOpenDoors(nodes, graph.allEdges());
    const routes = [];
    let envMeta = null;
    for (const node of endpoints) {
        const meta = node.meta;
        if (meta.endpointKind === 'env') {
            envMeta = meta;
            continue;
        }
        if (!isAuthRelevant(meta))
            continue;
        routes.push({
            id: node.id,
            name: node.name,
            method: meta.method,
            route: meta.route,
            endpointKind: meta.endpointKind,
            framework: meta.framework,
            writes: meta.writes,
            protection: protectionOf(meta.guards),
            open: openDoors.get(node.id) ?? null,
            guards: meta.guards,
            sites: meta.sites,
        });
    }
    routes.sort(byUrgency);
    const openOfKind = (kind) => routes.filter((route) => route.open?.kind === kind).length;
    return {
        auth: {
            total: routes.length,
            protectedCount: routes.filter((route) => route.protection === 'protected').length,
            likelyCount: routes.filter((route) => route.protection === 'likely').length,
            openCount: openOfKind('worth-a-look') + openOfKind('identity-only'),
            // Every verdict lands in a bucket, or the meter's segments stop summing to
            // `total` and the bar quietly misstates its proportions (#161). "Unchecked with
            // a reason" mirrors computeStats.publicRoutes; `unlinked` sits with `unreadable`
            // because "not followed" is our ignorance, not the door's openness, and `in-test`
            // sits there too because "the suite declared it" is a fact about which program we
            // are looking at rather than about whether anything guards it (#247).
            publicCount: openOfKind('page') + openOfKind('auth-mount') + openOfKind('generated') + openOfKind('declared-public'),
            unreadableCount: openOfKind('unreadable') + openOfKind('unlinked') + openOfKind('in-test'),
            unread: unreadableFiles(nodes),
            routes,
        },
        services: buildServices(graph),
        stores: buildStores(graph),
        tables: buildTableProtection(graph),
        env: buildEnv(envMeta),
    };
}
/**
 * Row-level security, table by table. On a Supabase-style app the browser talks to
 * Postgres directly with a published key, so RLS is not a database detail — it is
 * the auth model, and a table without it is an open route by another name.
 */
function buildTableProtection(graph) {
    const list = [];
    for (const node of graph.nodesOfKind('type')) {
        const meta = node.meta;
        if (meta.typeKind !== 'table')
            continue;
        const rls = meta.rls
            ? {
                enabled: meta.rls.enabled,
                policyCount: meta.rls.policies.length,
                commands: [...new Set(meta.rls.policies.map((policy) => policy.command))],
            }
            : null;
        list.push({
            id: node.id,
            name: node.name,
            declared: meta.observed !== true,
            rls,
            path: node.path,
            line: node.startLine,
        });
    }
    // Problems first: no row security, then locked-out tables, then the unknowns.
    const rank = (table) => table.rls === null ? 2 : !table.rls.enabled ? 0 : table.rls.policyCount === 0 ? 1 : 3;
    list.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
    return {
        total: list.length,
        unprotected: list.filter((table) => rank(table) === 0).length,
        locked: list.filter((table) => rank(table) === 1).length,
        unknown: list.filter((table) => table.rls === null).length,
        list,
    };
}
function protectionOf(guards) {
    if (guards.length === 0)
        return 'open';
    return guards.some((guard) => guard.confidence === 'certain') ? 'protected' : 'likely';
}
/**
 * The order someone should read the list in, so it is the order we return it in:
 * unexplained open doors that write data, then the rest of the unexplained ones, then
 * the ones we could not examine — an admission of ignorance outranks any reassurance
 * — then the checks we are less sure of, and only then the doors that are open for a
 * reason and the doors that are shut.
 */
function byUrgency(a, b) {
    const rank = (route) => {
        switch (route.open?.kind) {
            case 'worth-a-look':
                return route.writes ? 0 : 1;
            case 'unreadable':
                return 2;
            case 'page':
            case 'auth-mount':
                return 4;
            default:
                return route.protection === 'likely' ? 3 : 5;
        }
    };
    return rank(a) - rank(b) || (a.route ?? a.name).localeCompare(b.route ?? b.name);
}
function buildServices(graph) {
    return graph
        .nodesOfKind('service')
        .map((node) => {
        const meta = node.meta;
        const sends = graph.edgesTo(node.id).some((edge) => edge.kind === 'writes-to');
        return {
            id: node.id,
            name: node.name,
            category: meta.category,
            evidence: [...meta.packages, ...meta.hosts],
            callSites: meta.sites.length,
            sends,
            sites: meta.sites,
        };
    })
        .sort((a, b) => b.callSites - a.callSites || a.name.localeCompare(b.name));
}
function buildStores(graph) {
    return graph
        .nodesOfKind('store')
        .map((node) => {
        const meta = node.meta;
        return {
            id: node.id,
            name: node.name,
            client: meta.client,
            storeKind: meta.storeKind,
            tables: meta.tables,
            // An atlas written before #86 has no such field; `?? []` keeps a cached one
            // readable rather than making the whole run fail on a missing list.
            catalogTables: meta.catalogTables ?? [],
            reads: meta.reads,
            writes: meta.writes,
        };
    })
        .sort((a, b) => b.reads + b.writes - (a.reads + a.writes));
}
function buildEnv(meta) {
    const vars = meta?.vars ?? [];
    return {
        exampleFile: meta?.envExample ?? null,
        total: vars.length,
        // Secrets first: a missing `.env.example` entry for an API key is a different
        // problem from a missing entry for a feature flag.
        // Platform variables are excluded, not hidden: they still appear in the full list,
        // badged as set by the host. What they must not do is inflate a count whose whole
        // meaning is "you forgot to write these down".
        undocumented: vars
            .filter((entry) => !entry.documented && !entry.platform)
            .sort((a, b) => Number(b.secret) - Number(a.secret) || a.name.localeCompare(b.name)),
        vars,
    };
}
//# sourceMappingURL=insights.js.map