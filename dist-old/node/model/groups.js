/**
 * A folder big enough to be worth splitting into its subfolders.
 *
 * Below this, a group is already small enough that naming its parts adds nothing: eight
 * files is a paragraph's worth of thing. Above it, "your `src` folder" is not a group,
 * it is the app.
 */
const SPLIT_ABOVE = 12;
/**
 * How many groups the splitting is allowed to produce.
 *
 * A budget on how finely *we* cut, and deliberately not a ceiling on the answer. A repo
 * that already has twenty top-level packages — every Go repo of any size — gets twenty
 * groups, because its own top level is not something this tool chose and truncating it
 * would drop a real part of the architecture on the floor. What the budget stops is us
 * opening folder after folder until the overview is the file list again with longer names.
 *
 * The root bucket can also push the count one over. Displaying fewer than all of them is
 * a decision for whatever is doing the displaying, which knows how much room it has.
 */
const MAX_GROUPS = 12;
/** How many members, doors or neighbours to name before saying "and N more". */
const MAX_NAMED = 10;
/**
 * Where a file goes when no folder in the cut is above it.
 *
 * Two cases reach this, and both are real. A repo can keep load-bearing files at its top
 * level — the fixture's `middleware.ts` is the Clerk check that guards half the app — and
 * a flat repo can have no subfolders at all, which without this would cluster into
 * nothing and describe none of itself.
 */
const ROOT_GROUP = { id: 'module:.', path: '', name: 'the repo root' };
/**
 * Cut the codebase into groups and work out the shape of each one.
 *
 * Deterministic: the same atlas gives the same groups in the same order, every run. That
 * matters more than it sounds. The bake-off found that CodeBoarding's *membership* was
 * byte-identical across two cold runs while every label changed, and a reader who runs a
 * tool twice and gets a differently-shaped answer stops believing either one.
 */
export function buildGroups(nodes, edges) {
    const all = [...nodes];
    const modules = all.filter((node) => node.kind === 'module');
    const files = all.filter((node) => node.kind === 'file');
    const cut = cutFolderTree(modules);
    // Every file answers to exactly one group: the deepest cut folder above it, or the root
    // bucket when there is none. Matching on the path rather than walking parent ids keeps a
    // file whose folder was collapsed out of the module tree from falling through.
    const groupOfPath = new Map();
    let ungroupedFiles = 0;
    let usedRoot = false;
    for (const file of files) {
        if (!file.path) {
            ungroupedFiles++;
            continue;
        }
        const owner = deepestOwner(file.path, cut);
        groupOfPath.set(file.path, owner ?? ROOT_GROUP.id);
        if (!owner)
            usedRoot = true;
    }
    const draft = new Map();
    for (const [id, node] of cut) {
        draft.set(id, blankDraft(id, dirPathOf(node), node.name));
    }
    // The root bucket exists only when something landed in it, so a tidy repo does not get
    // an empty group named after its own top level.
    if (usedRoot)
        draft.set(ROOT_GROUP.id, blankDraft(ROOT_GROUP.id, ROOT_GROUP.path, ROOT_GROUP.name));
    for (const file of files) {
        const id = groupOfPath.get(file.path ?? '');
        const entry = id ? draft.get(id) : undefined;
        if (!entry)
            continue;
        entry.files.push(file);
        entry.zones.set(file.zone, (entry.zones.get(file.zone) ?? 0) + 1);
    }
    attachOwned(all, draft, groupOfPath);
    attachLinks(edges, draft, groupOfPath, byId(all));
    // An arrow has to name the group at the other end, so the paths are resolved from the
    // drafts rather than from the finished groups — which do not all exist yet.
    const pathOf = new Map();
    for (const [id, entry] of draft)
        pathOf.set(id, entry.path);
    const groups = [...draft.values()]
        .filter((entry) => entry.files.length > 0)
        .map((entry) => finish(entry, pathOf))
        // Biggest first, then by path, so two groups of equal size never swap places between
        // runs on nothing more than map insertion order.
        .sort((a, b) => b.fileCount - a.fileCount || a.path.localeCompare(b.path));
    return { groups, ungroupedFiles };
}
// ---------------------------------------------------------------------------
// The cut
// ---------------------------------------------------------------------------
/**
 * Choose which folders are groups.
 *
 * Starts at the top of the tree and repeatedly opens up the biggest folder that is both
 * too big to describe in one sentence and has subfolders to open into. A folder that is
 * opened keeps its place in the cut only if it holds files of its own — otherwise it is
 * just a container and its children stand in for it.
 *
 * Exported because the cut is the claim. A test that pins which folders came back is
 * testing the thing this file exists to get right, and it can do it without a model.
 */
export function cutFolderTree(modules) {
    const byPath = new Map();
    for (const node of modules)
        byPath.set(dirPathOf(node), node);
    const childrenOf = new Map();
    for (const node of modules) {
        const parent = node.parentId ?? '';
        const list = childrenOf.get(parent);
        if (list)
            list.push(node);
        else
            childrenOf.set(parent, [node]);
    }
    // The roots are the modules with no module parent — usually the children of the app
    // node, but a repo whose module tree starts deeper is handled by the same rule.
    const moduleIds = new Set(modules.map((node) => node.id));
    const roots = modules.filter((node) => !node.parentId || !moduleIds.has(node.parentId));
    const cut = new Map();
    for (const node of roots)
        cut.set(node.id, node);
    // Folders that will not be opened again: either they have just been opened, or opening
    // them would blow the budget. Without this the loop would pick the same folder forever,
    // because a folder that keeps its place after being opened still reports the same size.
    const settled = new Set();
    for (;;) {
        const candidate = [...cut.values()]
            .filter((node) => !settled.has(node.id) &&
            descendants(node) > SPLIT_ABOVE &&
            (childrenOf.get(node.id) ?? []).length > 0)
            // Deterministic pick: biggest, and path breaks the tie.
            .sort((a, b) => descendants(b) - descendants(a) || dirPathOf(a).localeCompare(dirPathOf(b)))[0];
        if (!candidate)
            break;
        const kids = childrenOf.get(candidate.id) ?? [];
        const keepsPlace = ownFiles(candidate) > 0;
        const after = cut.size + kids.length - (keepsPlace ? 0 : 1);
        settled.add(candidate.id);
        // One folder too wide to open is not a reason to stop opening the others. A repo whose
        // biggest folder is a hundred test fixtures would otherwise leave its actual source in
        // a single undescribed lump, which is the shape this whole file exists to avoid.
        if (after > MAX_GROUPS)
            continue;
        if (!keepsPlace)
            cut.delete(candidate.id);
        for (const kid of kids)
            cut.set(kid.id, kid);
    }
    const result = new Map();
    for (const node of cut.values())
        result.set(node.id, node);
    return result;
}
/**
 * The deepest cut folder containing this file.
 *
 * Longest matching prefix wins, so a file in `src/lib/stripe/` belongs to `src/lib/stripe`
 * when that was cut and to `src/lib` when it was not.
 */
function deepestOwner(filePath, cut) {
    let bestId = null;
    let bestLength = -1;
    for (const [id, node] of cut) {
        const dir = dirPathOf(node);
        const inside = dir === '' || filePath === dir || filePath.startsWith(`${dir}/`);
        if (!inside)
            continue;
        if (dir.length > bestLength) {
            bestLength = dir.length;
            bestId = id;
        }
    }
    return bestId;
}
function blankDraft(id, path, name) {
    return {
        id,
        path,
        name,
        files: [],
        zones: new Map(),
        doors: [],
        publicApi: [],
        stores: new Set(),
        services: new Set(),
        dependsOn: new Map(),
        usedBy: new Map(),
    };
}
/** Hang every door, table and outside service on the group whose code reaches it. */
function attachOwned(all, draft, groupOfPath) {
    const groupsFor = (sites) => {
        const seen = new Set();
        const out = [];
        for (const site of sites ?? []) {
            const id = groupOfPath.get(site.path);
            if (!id || seen.has(id))
                continue;
            seen.add(id);
            const entry = draft.get(id);
            if (entry)
                out.push(entry);
        }
        return out;
    };
    for (const node of all) {
        if (node.kind === 'endpoint') {
            const meta = node.meta;
            // The env "door" is a list of variables, not a way in. It is a real node for the
            // security screen and pure noise in a description of what a folder does.
            if (meta.endpointKind === 'env')
                continue;
            if (meta.endpointKind === 'export') {
                // Its name is the symbol; its route is the file it lives in, which the group
                // already accounts for.
                for (const entry of groupsFor(meta.sites))
                    entry.publicApi.push(node.name);
                continue;
            }
            // Reading a file off disk is a way data gets in, but it is not somewhere a caller
            // arrives, and the same exclusion is already made for the personal-data trace.
            if (meta.endpointKind === 'file-read')
                continue;
            const door = {
                name: meta.route ? `${meta.method ?? meta.endpointKind} ${meta.route}` : node.name,
                guards: (meta.guards ?? []).map((guard) => guard.name),
                ...(meta.open ? { openKind: meta.open.kind } : {}),
                ...(meta.open?.because ? { openBecause: meta.open.because } : {}),
            };
            for (const entry of groupsFor(meta.sites))
                entry.doors.push(door);
        }
        else if (node.kind === 'service') {
            const meta = node.meta;
            for (const entry of groupsFor(meta.sites))
                entry.services.add(node.name);
        }
        else if (node.kind === 'store') {
            const meta = node.meta;
            for (const entry of groupsFor(meta.sites))
                entry.stores.add(node.name);
        }
    }
}
/**
 * Fold every file-to-file edge up into an edge between groups.
 *
 * Edges inside a group are dropped: that a folder imports itself is not a fact about the
 * folder. What survives is the handoff, which is the thing a paragraph about architecture
 * is actually made of.
 */
function attachLinks(edges, draft, groupOfPath, nodesById) {
    for (const edge of edges) {
        if (edge.kind !== 'imports' && edge.kind !== 'references')
            continue;
        const from = nodesById.get(edge.fromId);
        const to = nodesById.get(edge.toId);
        if (!from || !to || from.kind !== 'file' || to.kind !== 'file')
            continue;
        const fromGroup = groupOfPath.get(from.path ?? '');
        const toGroup = groupOfPath.get(to.path ?? '');
        if (!fromGroup || !toGroup || fromGroup === toGroup)
            continue;
        const source = draft.get(fromGroup);
        const target = draft.get(toGroup);
        if (!source || !target)
            continue;
        source.dependsOn.set(toGroup, (source.dependsOn.get(toGroup) ?? 0) + edge.weight);
        target.usedBy.set(fromGroup, (target.usedBy.get(fromGroup) ?? 0) + edge.weight);
    }
}
function finish(entry, pathOf) {
    const zones = [...entry.zones.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const exported = [...new Set(entry.publicApi)].sort((a, b) => a.localeCompare(b));
    // Doors can arrive more than once when a route's sites straddle two files in the same
    // folder. The reader wants the route listed once.
    const doors = [];
    const seenDoors = new Set();
    for (const door of entry.doors) {
        if (seenDoors.has(door.name))
            continue;
        seenDoors.add(door.name);
        doors.push(door);
    }
    return {
        id: entry.id,
        path: entry.path,
        name: entry.name,
        fileCount: entry.files.length,
        zone: zones[0]?.[0] ?? 'unknown',
        otherZones: zones.slice(1).map(([zone]) => zone),
        members: entry.files
            .map((file) => baseName(file.path ?? file.name))
            .sort((a, b) => a.localeCompare(b))
            .slice(0, MAX_NAMED),
        doors: doors.slice(0, MAX_NAMED),
        doorCount: doors.length,
        publicApi: exported.length > MAX_NAMED ? [] : exported,
        publicApiCount: exported.length,
        stores: [...entry.stores].sort((a, b) => a.localeCompare(b)),
        services: [...entry.services].sort((a, b) => a.localeCompare(b)),
        dependsOn: toLinks(entry.dependsOn, pathOf),
        usedBy: toLinks(entry.usedBy, pathOf),
    };
}
function toLinks(counts, pathOf) {
    return [...counts.entries()]
        .map(([toId, weight]) => ({ toId, toPath: pathOf.get(toId) ?? toId, weight }))
        .sort((a, b) => b.weight - a.weight || a.toPath.localeCompare(b.toPath))
        .slice(0, MAX_NAMED);
}
// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
function byId(nodes) {
    return new Map(nodes.map((node) => [node.id, node]));
}
function dirPathOf(node) {
    const meta = node.meta;
    return String(meta.dirPath ?? node.path ?? '');
}
function descendants(node) {
    const meta = node.meta;
    return Number(meta.descendantFileCount ?? meta.fileCount ?? 0);
}
function ownFiles(node) {
    const meta = node.meta;
    return Number(meta.fileCount ?? 0);
}
function baseName(path) {
    const cut = path.lastIndexOf('/');
    return cut === -1 ? path : path.slice(cut + 1);
}
//# sourceMappingURL=groups.js.map