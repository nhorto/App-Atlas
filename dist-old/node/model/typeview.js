import { classifyColumn, looksLikeRelation } from './personal.js';
const MAX_CARDS = 60;
const MAX_FIELDS = 12;
export function buildTypeView(graph, limit = MAX_CARDS) {
    const all = mergeDeclaredTables(graph.nodesOfKind('type'));
    const usage = new Map();
    for (const node of all) {
        const byZone = new Map();
        let total = 0;
        for (const edge of graph.edgesTo(node.id)) {
            if (edge.kind !== 'references')
                continue;
            const from = graph.getNodeById(edge.fromId);
            if (!from || from.id === node.id)
                continue;
            total += edge.weight;
            byZone.set(from.zone, (byZone.get(from.zone) ?? 0) + edge.weight);
        }
        usage.set(node.id, { total, byZone });
    }
    const chosen = chooseCards(all, usage, limit);
    const onScreen = new Set(chosen.map((node) => node.id));
    const links = buildLinks(graph, chosen, onScreen);
    // Built from every type in the atlas, not just the ones that earned a card: a relation
    // pointing at a shape too minor to draw is still a relation and still not a column.
    const typeNames = new Set(all.map((node) => node.name.toLowerCase()));
    const outgoingByCard = new Map();
    for (const link of links) {
        const list = outgoingByCard.get(link.fromId);
        if (list)
            list.push(link);
        else
            outgoingByCard.set(link.fromId, [link]);
    }
    const cards = chosen.map((node) => toCard(node, usage.get(node.id), outgoingByCard.get(node.id) ?? [], typeNames));
    return {
        cards,
        links,
        total: all.length,
        tables: cards.filter((card) => card.typeKind === 'table').length,
    };
}
/**
 * One card for a table whose schema *is* a class in this repo (item 41).
 *
 * A Django model is not a table plus a class; it is a table, written as a class. The
 * atlas holds two nodes for it all the same — the queries produce an observed table, the
 * file produces the class — and `joinOrmModelsToTables` has already proved they are the
 * same thing by copying one's columns onto the other. Drawing both put every one of
 * healthchecks' thirteen models on the canvas twice, with identical field lists, and
 * spent thirteen of sixty card slots saying everything once more.
 *
 * The class node survives, because it is the one the rest of the atlas points at: it
 * carries the references, the usage count and the position in the folder tree. It
 * inherits the table's badge and provider, so nothing about "this is a table" is lost.
 *
 * Prisma is deliberately untouched. Its schema file and a TypeScript interface of the
 * same name are two real declarations that can disagree, and the dashed "same name only"
 * link between them is the right way to say so.
 */
function mergeDeclaredTables(all) {
    const byId = new Map(all.map((node) => [node.id, node]));
    /** Model node id → the table node it turned out to be. */
    const promoted = new Map();
    for (const node of all) {
        const meta = node.meta;
        if (meta.typeKind !== 'table' || !meta.declaredById)
            continue;
        const model = byId.get(meta.declaredById);
        if (!model || model.id === node.id)
            continue;
        // Two tables naming one class is the ambiguous case `joinOrmModelsToTables` refuses
        // elsewhere, and it would be no better resolved here.
        if (promoted.has(model.id))
            continue;
        promoted.set(model.id, node);
    }
    if (promoted.size === 0)
        return all;
    const absorbed = new Set([...promoted.values()].map((node) => node.id));
    return all
        .filter((node) => !absorbed.has(node.id))
        .map((node) => {
        const table = promoted.get(node.id);
        if (!table)
            return node;
        const meta = node.meta;
        const tableMeta = table.meta;
        return {
            ...node,
            // The table's name, not the class's. They are the same word in Django, and in
            // SQLAlchemy they are not: `class Invoice` with `__tablename__ = "invoices"` is
            // a table called `invoices`, and that is the name someone will look for in a
            // database. Everything else comes from the class, which is the node the rest of
            // the atlas points at.
            name: table.name,
            meta: {
                ...meta,
                typeKind: 'table',
                provider: tableMeta.provider,
                rls: tableMeta.rls,
                // The columns are the class's own, read from the declaration, so nothing here
                // is unknowable.
                observed: false,
            },
        };
    });
}
/**
 * Which shapes earn a card. Tables first — a database table is the most concrete thing
 * in an app and the reason anyone opens this view — then whatever the rest of the code
 * actually leans on. An unexported type nobody references is real, but it is not what
 * someone came here to look at.
 */
function chooseCards(all, usage, limit) {
    const score = (node) => {
        const meta = node.meta;
        let value = usage.get(node.id)?.total ?? 0;
        if (meta.typeKind === 'table')
            value += 1000;
        if (meta.isExported)
            value += 12;
        if (meta.fields.length > 0)
            value += 4;
        if (node.zone === 'test')
            value -= 40;
        return value;
    };
    return [...all]
        .filter((node) => {
        const meta = node.meta;
        if (meta.typeKind === 'table')
            return true;
        // A private type nobody mentions is noise on a canvas this size.
        return meta.isExported || (usage.get(node.id)?.total ?? 0) > 0;
    })
        .sort((a, b) => score(b) - score(a) || a.name.localeCompare(b.name))
        .slice(0, limit);
}
function buildLinks(graph, chosen, onScreen) {
    const links = [];
    const seen = new Set();
    for (const node of chosen) {
        for (const edge of graph.edgesFrom(node.id)) {
            if (edge.kind !== 'references' || !onScreen.has(edge.toId) || edge.toId === node.id)
                continue;
            const id = `${node.id}->${edge.toId}`;
            if (seen.has(id))
                continue;
            seen.add(id);
            links.push({
                id,
                fromId: node.id,
                toId: edge.toId,
                fields: [...(edge.meta.fields ?? [])],
                basis: 'declared',
            });
        }
    }
    // A table and a type that share a name are usually the same idea wearing two hats.
    // Saying so is useful; pretending the compiler said so is not, hence a separate basis.
    const codeByName = new Map();
    for (const node of chosen) {
        if (node.meta.typeKind === 'table')
            continue;
        const key = node.name.toLowerCase();
        if (!codeByName.has(key))
            codeByName.set(key, node);
    }
    for (const node of chosen) {
        if (node.meta.typeKind !== 'table')
            continue;
        const twin = codeByName.get(node.name.toLowerCase());
        if (!twin)
            continue;
        const id = `${twin.id}~${node.id}`;
        if (seen.has(id) || seen.has(`${twin.id}->${node.id}`) || seen.has(`${node.id}->${twin.id}`))
            continue;
        seen.add(id);
        links.push({ id, fromId: twin.id, toId: node.id, fields: [], basis: 'name' });
    }
    return links;
}
function toCard(node, usage, outgoing, typeNames) {
    const meta = node.meta;
    const all = meta.fields ?? [];
    const shown = all.slice(0, MAX_FIELDS);
    return {
        id: node.id,
        name: node.name,
        typeKind: meta.typeKind,
        path: node.path,
        startLine: node.startLine,
        zone: node.zone,
        // Restricted to tables. A code type with an `email` field is telling the same story,
        // but marking every shape in the project turns the mark into wallpaper — and the
        // question this answers is about where data is *kept*.
        fields: shown.map((field) => toField(field, outgoing, meta.typeKind === 'table', typeNames)),
        hiddenFields: all.length - shown.length,
        summary: node.summary,
        summarySource: node.summarySource,
        usage: usage?.total ?? 0,
        usageByZone: [...(usage?.byZone ?? new Map())]
            .map(([zone, count]) => ({ zone, count }))
            .sort((a, b) => b.count - a.count),
        aliasOf: typeof node.meta.aliasOf === 'string' ? node.meta.aliasOf : null,
        provider: meta.provider ?? null,
    };
}
function toField(field, outgoing, isTable, typeNames) {
    const link = outgoing.find((candidate) => candidate.fields.includes(field.name));
    const personal = isTable && !looksLikeRelation(field.type, typeNames) ? classifyColumn(field.name) : null;
    return {
        name: field.name,
        type: field.type,
        optional: field.optional,
        isId: field.isId,
        isUnique: field.isUnique,
        linkTo: link?.toId ?? null,
        ...(personal ? { personal } : {}),
    };
}
//# sourceMappingURL=typeview.js.map