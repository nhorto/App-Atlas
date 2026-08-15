/**
 * @fileoverview Database tables as atlas nodes.
 *
 * The project that inspired this one was a database visualizer, and the reason it
 * worked is that a table is the most concrete thing in an app: it has a name, it has
 * columns, and it is unambiguously *there*. A schema file states all of that outright,
 * so nothing here is inferred — the tables, their columns and the relations between
 * them are read the way a docstring is read.
 *
 * They become `type` nodes with `typeKind: 'table'` rather than a new node kind, so
 * every view that already draws a shape with fields draws these too (SPEC.md 6.3).
 */
import path from 'node:path';
import { makeEdgeId, makeFileId, makeTypeId } from '../model/types.js';
import { hashParts } from '../util/hash.js';
export function buildSchemaNodes(signal) {
    if (!signal || signal.tables.length === 0)
        return { nodes: [], edges: [], filePath: null };
    const fileId = makeFileId(signal.path);
    const nodes = [fileNode(fileId, signal)];
    const edges = [];
    const idOf = new Map();
    for (const table of signal.tables)
        idOf.set(table.name, makeTypeId(signal.path, table.name));
    for (const table of signal.tables) {
        nodes.push(tableNode(idOf.get(table.name), fileId, table, signal));
        for (const field of table.fields) {
            const targetId = field.relationTo ? idOf.get(field.relationTo) : undefined;
            if (!targetId || targetId === idOf.get(table.name))
                continue;
            const id = makeEdgeId('references', idOf.get(table.name), targetId);
            const existing = edges.find((edge) => edge.id === id);
            if (existing) {
                existing.weight++;
                existing.meta.fields = [...new Set([...existing.meta.fields, field.name])];
                continue;
            }
            edges.push({
                id,
                kind: 'references',
                fromId: idOf.get(table.name),
                toId: targetId,
                weight: 1,
                // The schema says so. This is as certain as a fact in this tool gets.
                confidence: 'certain',
                provenance: 'static',
                meta: { fields: [field.name] },
            });
        }
    }
    return { nodes, edges, filePath: signal.path };
}
function fileNode(id, signal) {
    return {
        id,
        kind: 'file',
        name: path.posix.basename(signal.path),
        label: null,
        parentId: null, // the orchestrator hangs it off the folder tree like any other file
        language: 'prisma',
        path: signal.path,
        startLine: 1,
        endLine: signal.lineCount,
        zone: 'data',
        summary: null,
        summarySource: null,
        docHash: null,
        bodyHash: null,
        hash: hashParts('schema', signal.provider, ...signal.models),
        provenance: 'static',
        meta: {
            ext: '.prisma',
            loc: signal.lineCount,
            externalImports: [],
            exportedNames: signal.models,
            functionCount: 0,
            typeCount: signal.tables.length,
            provider: signal.provider,
        },
    };
}
function tableNode(id, fileId, table, signal) {
    const fields = table.fields.map((field) => ({
        name: field.name,
        type: field.type,
        optional: field.optional,
        isId: field.isId || undefined,
        isUnique: field.isUnique || undefined,
    }));
    const shape = table.fields.map((field) => `${field.name}:${field.type}`).join(',');
    return {
        id,
        kind: 'type',
        name: table.name,
        label: null,
        parentId: fileId,
        language: 'prisma',
        path: signal.path,
        startLine: table.line,
        endLine: table.endLine,
        zone: 'data',
        summary: table.doc,
        summarySource: table.doc ? 'docs' : null,
        docHash: table.doc ? hashParts(table.doc) : null,
        bodyHash: hashParts(shape),
        hash: hashParts(table.name, shape),
        provenance: table.doc ? 'docs' : 'static',
        meta: {
            typeKind: 'table',
            fields,
            isExported: true,
            extends: [],
            provider: signal.provider,
        },
    };
}
/**
 * SQL-declared tables become the same nodes Prisma tables become. When both sources
 * declare a table, Prisma wins — `prisma/migrations` is generated *from*
 * `schema.prisma`, so the SQL copy is an echo, not a second opinion.
 */
export function buildSqlSchemaNodes(signal, prisma) {
    const prismaNames = new Set((prisma?.models ?? []).map((model) => model.toLowerCase()));
    const tables = (signal?.tables ?? []).filter((table) => !prismaNames.has(table.name.toLowerCase()));
    if (tables.length === 0)
        return { nodes: [], edges: [], filePaths: [] };
    const nodes = [];
    const edges = [];
    const idOf = new Map();
    for (const table of tables)
        idOf.set(table.name.toLowerCase(), makeTypeId(table.path, table.name));
    // A foreign key may point at a Prisma-declared table; the edge should land on it.
    if (prisma)
        for (const model of prisma.models)
            idOf.set(model.toLowerCase(), makeTypeId(prisma.path, model));
    // One file node per migration that created a table, so every table has a real
    // file:line behind it and somewhere to live in the folder tree.
    const byFile = new Map();
    for (const table of tables) {
        const list = byFile.get(table.path);
        if (list)
            list.push(table);
        else
            byFile.set(table.path, [table]);
    }
    for (const [filePath, declared] of byFile)
        nodes.push(sqlFileNode(filePath, declared));
    for (const table of tables) {
        const fromId = idOf.get(table.name.toLowerCase());
        nodes.push(sqlTableNode(fromId, table));
        for (const field of table.fields) {
            const targetId = field.relationTo ? idOf.get(field.relationTo.toLowerCase()) : undefined;
            if (!targetId || targetId === fromId)
                continue;
            const id = makeEdgeId('references', fromId, targetId);
            const existing = edges.find((edge) => edge.id === id);
            if (existing) {
                existing.weight++;
                existing.meta.fields = [...new Set([...existing.meta.fields, field.name])];
                continue;
            }
            edges.push({
                id,
                kind: 'references',
                fromId,
                toId: targetId,
                weight: 1,
                // A foreign key constraint. The database enforces it; we merely report it.
                confidence: 'certain',
                provenance: 'static',
                meta: { fields: [field.name] },
            });
        }
    }
    return { nodes, edges, filePaths: [...byFile.keys()] };
}
function sqlFileNode(filePath, declared) {
    const id = makeFileId(filePath);
    const endLine = Math.max(...declared.map((table) => table.endLine));
    return {
        id,
        kind: 'file',
        name: path.posix.basename(filePath),
        label: null,
        parentId: null, // the orchestrator hangs it off the folder tree like any other file
        language: 'sql',
        path: filePath,
        startLine: 1,
        endLine,
        zone: 'data',
        summary: null,
        summarySource: null,
        docHash: null,
        bodyHash: null,
        hash: hashParts('sql-schema', filePath, ...declared.map((table) => table.name)),
        provenance: 'static',
        meta: {
            ext: '.sql',
            loc: endLine,
            externalImports: [],
            exportedNames: declared.map((table) => table.name),
            functionCount: 0,
            typeCount: declared.length,
            provider: 'postgresql',
        },
    };
}
function sqlTableNode(id, table) {
    const fields = table.fields.map((field) => ({
        name: field.name,
        type: field.type,
        optional: field.optional,
        isId: field.isId || undefined,
        isUnique: field.isUnique || undefined,
    }));
    const shape = table.fields.map((field) => `${field.name}:${field.type}`).join(',');
    const rlsShape = `${table.rlsEnabled}:${table.policies.map((p) => p.name).join(',')}`;
    return {
        id,
        kind: 'type',
        name: table.name,
        label: null,
        parentId: makeFileId(table.path),
        language: 'sql',
        path: table.path,
        startLine: table.line,
        endLine: table.endLine,
        zone: 'data',
        summary: table.doc,
        summarySource: table.doc ? 'docs' : null,
        docHash: table.doc ? hashParts(table.doc) : null,
        bodyHash: hashParts(shape),
        hash: hashParts(table.name, shape, rlsShape),
        provenance: table.doc ? 'docs' : 'static',
        meta: {
            typeKind: 'table',
            fields,
            isExported: true,
            extends: [],
            provider: 'postgresql',
            rls: { enabled: table.rlsEnabled, policies: table.policies },
        },
    };
}
//# sourceMappingURL=schema.js.map