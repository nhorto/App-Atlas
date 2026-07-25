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
import type { AtlasEdge, AtlasNode, FieldInfo } from '../model/types.js';
import { makeEdgeId, makeFileId, makeTypeId } from '../model/types.js';
import { hashParts } from '../util/hash.js';
import type { PrismaSignal, SchemaModel } from './signals.js';

export interface SchemaResult {
  nodes: AtlasNode[];
  edges: AtlasEdge[];
  /** The schema file, so the orchestrator can hang it in the folder tree. */
  filePath: string | null;
}

export function buildSchemaNodes(signal: PrismaSignal | null): SchemaResult {
  if (!signal || signal.tables.length === 0) return { nodes: [], edges: [], filePath: null };

  const fileId = makeFileId(signal.path);
  const nodes: AtlasNode[] = [fileNode(fileId, signal)];
  const edges: AtlasEdge[] = [];

  const idOf = new Map<string, string>();
  for (const table of signal.tables) idOf.set(table.name, makeTypeId(signal.path, table.name));

  for (const table of signal.tables) {
    nodes.push(tableNode(idOf.get(table.name)!, fileId, table, signal));

    for (const field of table.fields) {
      const targetId = field.relationTo ? idOf.get(field.relationTo) : undefined;
      if (!targetId || targetId === idOf.get(table.name)) continue;
      const id = makeEdgeId('references', idOf.get(table.name)!, targetId);
      const existing = edges.find((edge) => edge.id === id);
      if (existing) {
        existing.weight++;
        existing.meta.fields = [...new Set([...(existing.meta.fields as string[]), field.name])];
        continue;
      }
      edges.push({
        id,
        kind: 'references',
        fromId: idOf.get(table.name)!,
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

function fileNode(id: string, signal: PrismaSignal): AtlasNode {
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

function tableNode(id: string, fileId: string, table: SchemaModel, signal: PrismaSignal): AtlasNode {
  const fields: FieldInfo[] = table.fields.map((field) => ({
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
