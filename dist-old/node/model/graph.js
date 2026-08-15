import { CONTAINER_KINDS } from './types.js';
import { describeChanges } from './changes.js';
import { rankFiles } from './rank.js';
import { findUnimported } from './unimported.js';
const MAX_LEVEL_NODES = 400;
const MAX_OUTSIDE_NEIGHBORS = 8;
/** The kinds that are the outside world, as opposed to more of the user's code. */
const WORLD_KINDS = new Set(['store', 'service', 'endpoint']);
const MAX_NEIGHBORS = 60;
/** Enough to show what a file is shaped around; more would be a schema dump. */
const MAX_TYPES_USED = 12;
export class AtlasGraph {
    meta;
    rootId;
    nodes = new Map();
    children = new Map();
    relations = [];
    incoming = new Map();
    outgoing = new Map();
    pathCache = new Map();
    /** Built on the first stack-frame lookup and kept; most runs never ask for it. */
    pathIndex = null;
    constructor(atlas) {
        this.meta = atlas.meta;
        for (const node of atlas.nodes)
            this.nodes.set(node.id, node);
        for (const node of atlas.nodes) {
            if (!node.parentId)
                continue;
            const list = this.children.get(node.parentId);
            if (list)
                list.push(node);
            else
                this.children.set(node.parentId, [node]);
        }
        for (const edge of atlas.edges) {
            if (edge.kind === 'contains')
                continue;
            this.relations.push(edge);
            pushTo(this.outgoing, edge.fromId, edge);
            pushTo(this.incoming, edge.toId, edge);
        }
        const app = atlas.nodes.find((n) => n.kind === 'app');
        this.rootId = app?.id ?? atlas.nodes[0]?.id ?? '';
    }
    static fromAtlas(atlas) {
        return new AtlasGraph(atlas);
    }
    getNodeById(id) {
        return this.nodes.get(id);
    }
    /** Every node of one kind, in id order. The boundary and insight views live off this. */
    nodesOfKind(kind) {
        const out = [];
        for (const node of this.nodes.values()) {
            if (node.kind === kind)
                out.push(node);
        }
        return out.sort((a, b) => a.id.localeCompare(b.id));
    }
    /** Everything, for the passes that ask a question of the whole atlas at once. */
    allNodes() {
        return [...this.nodes.values()];
    }
    /** Every edge except containment, which is the tree rather than a relationship. */
    allEdges() {
        return this.relations;
    }
    edgesFrom(id) {
        return this.outgoing.get(id) ?? [];
    }
    edgesTo(id) {
        return this.incoming.get(id) ?? [];
    }
    /** Root-first chain of ancestors, ending with the node itself. */
    pathTo(id) {
        const cached = this.pathCache.get(id);
        if (cached)
            return cached;
        const chain = [];
        const seen = new Set();
        let current = this.nodes.get(id);
        while (current && !seen.has(current.id)) {
            seen.add(current.id);
            chain.unshift(current.id);
            current = current.parentId ? this.nodes.get(current.parentId) : undefined;
        }
        this.pathCache.set(id, chain);
        return chain;
    }
    /** The child of `levelId` that contains `nodeId` (or `nodeId` itself). */
    ancestorAtLevel(nodeId, levelId) {
        const chain = this.pathTo(nodeId);
        const index = chain.indexOf(levelId);
        if (index === -1)
            return undefined;
        return chain[index + 1];
    }
    breadcrumb(id) {
        return this.pathTo(id)
            .map((nodeId) => this.nodes.get(nodeId))
            .filter((n) => Boolean(n));
    }
    childrenOf(id) {
        return this.children.get(id) ?? [];
    }
    /** One screen's worth of graph: the children of `levelId` and the edges between them. */
    getLevel(levelId) {
        const self = this.nodes.get(levelId) ?? null;
        const all = this.childrenOf(levelId);
        const sorted = [...all].sort(compareForDisplay);
        const truncated = sorted.length > MAX_LEVEL_NODES;
        const visible = truncated ? sorted.slice(0, MAX_LEVEL_NODES) : sorted;
        const visibleIds = new Set(visible.map((n) => n.id));
        const aggregated = new Map();
        const outsideIn = new Map();
        const outsideOut = new Map();
        // The outside world, kept by identity. A cross-boundary edge names the exact
        // store, service or endpoint on its far side; discarding that and keeping a
        // count was making the reader infer the most interesting fact on the screen.
        const outside = new Map();
        const noteOutside = (world, insideId, weight, out, kind) => {
            if (!world || world.id === levelId || visibleIds.has(world.id))
                return;
            let entry = outside.get(world.id);
            if (!entry) {
                entry = { node: world, flows: [], total: 0 };
                outside.set(world.id, entry);
            }
            entry.total += weight;
            const flow = entry.flows.find((f) => f.insideId === insideId && f.out === out);
            if (flow) {
                flow.weight += weight;
                if (!flow.kinds.includes(kind))
                    flow.kinds.push(kind);
            }
            else {
                entry.flows.push({ insideId, weight, out, kinds: [kind] });
            }
        };
        for (const edge of this.relations) {
            const from = this.ancestorAtLevel(edge.fromId, levelId);
            const to = this.ancestorAtLevel(edge.toId, levelId);
            if (from && to) {
                if (from === to)
                    continue;
                if (!visibleIds.has(from) || !visibleIds.has(to))
                    continue;
                const id = `${from}->${to}`;
                const existing = aggregated.get(id);
                if (existing) {
                    existing.weight += edge.weight;
                    if (!existing.kinds.includes(edge.kind))
                        existing.kinds.push(edge.kind);
                }
                else {
                    aggregated.set(id, { id, fromId: from, toId: to, weight: edge.weight, kinds: [edge.kind] });
                }
            }
            else if (from && visibleIds.has(from)) {
                outsideOut.set(from, (outsideOut.get(from) ?? 0) + edge.weight);
                noteOutside(this.worldNeighborOf(edge.toId), from, edge.weight, true, edge.kind);
            }
            else if (to && visibleIds.has(to)) {
                outsideIn.set(to, (outsideIn.get(to) ?? 0) + edge.weight);
                noteOutside(this.worldNeighborOf(edge.fromId), to, edge.weight, false, edge.kind);
            }
        }
        const nodes = visible.map((node) => {
            const kids = this.childrenOf(node.id);
            return {
                ...node,
                childCount: kids.length,
                drillable: CONTAINER_KINDS.has(node.kind) && kids.length > 0,
                outsideIn: outsideIn.get(node.id) ?? 0,
                outsideOut: outsideOut.get(node.id) ?? 0,
                preview: [...kids].sort(compareForDisplay).slice(0, 5).map((k) => k.name),
            };
        });
        return {
            levelId,
            self,
            breadcrumb: this.breadcrumb(levelId),
            nodes,
            edges: [...aggregated.values()].sort((a, b) => b.weight - a.weight),
            // Heaviest flows first, capped: eight ghost cards is a boundary, twenty is fog.
            outside: [...outside.values()].sort((a, b) => b.total - a.total).slice(0, MAX_OUTSIDE_NEIGHBORS),
            truncated,
            totalChildren: all.length,
        };
    }
    /**
     * The store, service or endpoint a node belongs to, if it belongs to one — the
     * "outside world" a cross-boundary edge should be attributed to. A table hangs off
     * its store, so a query into an observed table reads as traffic to the database.
     * Plain code elsewhere in the app returns null and stays a mere count.
     */
    worldNeighborOf(id) {
        let node = this.nodes.get(id);
        while (node) {
            if (WORLD_KINDS.has(node.kind))
                return node;
            node = node.parentId ? this.nodes.get(node.parentId) : undefined;
        }
        return null;
    }
    /** Everything the detail panel needs about one node. */
    getNode(id) {
        const node = this.nodes.get(id);
        if (!node)
            return null;
        const outgoingAll = this.outgoing.get(id) ?? [];
        const incomingAll = this.incoming.get(id) ?? [];
        const toLink = (edge, direction) => {
            const otherId = direction === 'out' ? edge.toId : edge.fromId;
            const other = this.nodes.get(otherId);
            if (!other)
                return null;
            return { edge, other, direction };
        };
        const outgoing = outgoingAll
            .slice()
            .sort((a, b) => b.weight - a.weight)
            .slice(0, MAX_NEIGHBORS)
            .map((e) => toLink(e, 'out'))
            .filter((l) => Boolean(l));
        const incoming = incomingAll
            .slice()
            .sort((a, b) => b.weight - a.weight)
            .slice(0, MAX_NEIGHBORS)
            .map((e) => toLink(e, 'in'))
            .filter((l) => Boolean(l));
        return {
            node,
            breadcrumb: this.breadcrumb(id),
            children: [...this.childrenOf(id)].sort(compareForDisplay).slice(0, 300),
            incoming,
            outgoing,
            incomingTotal: incomingAll.length,
            outgoingTotal: outgoingAll.length,
            typesUsed: this.typesUsedBy(outgoingAll),
        };
    }
    /**
     * The distinct type nodes a set of outgoing edges reference, heaviest first. Read
     * from the full edge list rather than the capped `outgoing` slice, so the shapes a
     * file works with never fall off the end of a long list of ordinary calls.
     */
    typesUsedBy(outgoingAll) {
        const seen = new Map();
        for (const edge of outgoingAll) {
            if (edge.kind !== 'references')
                continue;
            const target = this.nodes.get(edge.toId);
            if (!target || target.kind !== 'type')
                continue;
            const existing = seen.get(target.id);
            if (existing)
                existing.weight += edge.weight;
            else
                seen.set(target.id, { node: target, weight: edge.weight });
        }
        return [...seen.values()]
            .sort((a, b) => b.weight - a.weight || a.node.name.localeCompare(b.node.name))
            .slice(0, MAX_TYPES_USED)
            .map((entry) => entry.node);
    }
    /** The landing view: headline numbers plus the top-level shape of the app. */
    getOverview() {
        const topLevel = this.getLevel(this.rootId).nodes;
        // Import edges are recorded between files already, but a `references` edge can hang
        // off a function inside one. Lifting every endpoint to the file that contains it
        // means the ranker sees one graph rather than two, and `rankFiles` keeps only the
        // import edges it wants.
        const fileEdges = [];
        for (const edge of this.relations) {
            const fromId = this.nearestOfKind(edge.fromId, 'file');
            const toId = this.nearestOfKind(edge.toId, 'file');
            if (fromId && toId)
                fileEdges.push({ ...edge, fromId, toId });
        }
        const whereToLookFirst = rankFiles(this.nodes.values(), fileEdges);
        const zoneCounts = {};
        for (const node of this.nodes.values()) {
            if (node.kind !== 'file')
                continue;
            zoneCounts[node.zone] = (zoneCounts[node.zone] ?? 0) + 1;
        }
        return {
            meta: this.meta,
            rootId: this.rootId,
            app: this.nodes.get(this.rootId) ?? null,
            topLevel,
            whereToLookFirst,
            zoneCounts,
            changes: describeChanges(this.meta.changes),
            unimported: findUnimported(this.allNodes(), this.relations, this.meta),
        };
    }
    /** Walks up from a node until it finds an ancestor of the requested kind. */
    nearestOfKind(id, kind) {
        const chain = this.pathTo(id);
        for (let i = chain.length - 1; i >= 0; i--) {
            if (this.nodes.get(chain[i])?.kind === kind)
                return chain[i];
        }
        return undefined;
    }
    /**
     * Every file path in the atlas, repo-relative — what a pasted stack frame has to be
     * matched against before anything else can be said about it.
     */
    filePaths() {
        return [...this.byPath().keys()];
    }
    /**
     * The most specific thing declared at one line of one file.
     *
     * A stack frame is a path and a number, and the question it is really asking is
     * "what is this inside". So the answer is the innermost range that contains the
     * line — the function rather than the file it sits in — and the file itself only
     * when the line falls between the things in it, which is where a stray `throw` at
     * module scope lands.
     */
    nodeAt(path, line) {
        let best = null;
        let smallest = Infinity;
        let file = null;
        for (const node of this.byPath().get(path) ?? []) {
            if (node.kind === 'file')
                file = node;
            if (node.startLine === null || node.endLine === null)
                continue;
            if (line < node.startLine || line > node.endLine)
                continue;
            const span = node.endLine - node.startLine;
            if (span < smallest) {
                smallest = span;
                best = node;
            }
        }
        return best ?? file;
    }
    /** Path → everything declared in it, built once and kept. */
    byPath() {
        if (this.pathIndex)
            return this.pathIndex;
        const index = new Map();
        for (const node of this.nodes.values()) {
            // Modules carry the directory they stand for, which is not a file a frame can
            // name, and would otherwise swallow every lookup for a path inside it.
            if (!node.path || node.kind === 'module' || node.kind === 'app')
                continue;
            const found = index.get(node.path);
            if (found)
                found.push(node);
            else
                index.set(node.path, [node]);
        }
        this.pathIndex = index;
        return index;
    }
    search(query, limit = 30) {
        const q = query.trim().toLowerCase();
        if (!q)
            return [];
        const scored = [];
        for (const node of this.nodes.values()) {
            const name = node.name.toLowerCase();
            const nodePath = (node.path ?? '').toLowerCase();
            let score = 0;
            if (name === q)
                score = 100;
            else if (name.startsWith(q))
                score = 80;
            else if (name.includes(q))
                score = 60;
            else if (nodePath.includes(q))
                score = 30;
            if (score === 0)
                continue;
            // Prefer bigger structural things when scores tie.
            score += kindBoost(node.kind);
            scored.push({ node, score });
        }
        return scored
            .sort((a, b) => b.score - a.score || a.node.name.length - b.node.name.length)
            .slice(0, limit)
            .map((s) => s.node);
    }
}
function pushTo(map, key, edge) {
    const list = map.get(key);
    if (list)
        list.push(edge);
    else
        map.set(key, [edge]);
}
const KIND_ORDER = {
    app: 0,
    zone: 1,
    module: 2,
    file: 3,
    type: 4,
    function: 5,
    endpoint: 6,
    service: 7,
    store: 8,
};
function compareForDisplay(a, b) {
    const byKind = (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9);
    if (byKind !== 0)
        return byKind;
    return a.name.localeCompare(b.name);
}
function kindBoost(kind) {
    if (kind === 'module')
        return 8;
    if (kind === 'file')
        return 6;
    if (kind === 'type')
        return 4;
    return 0;
}
//# sourceMappingURL=graph.js.map