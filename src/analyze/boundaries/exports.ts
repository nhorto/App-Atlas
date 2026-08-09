/**
 * @fileoverview The public API surface, for projects whose boundary is made of it.
 *
 * A library has a boundary. It is just not made of routes: nothing knocks on it over a
 * network, and the question its author actually has is *what have I committed to
 * keeping stable?* Public surface versus internal is invisible in most codebases and
 * it is the thing that breaks semver.
 *
 * So an exported name becomes a door of kind `export`, in the same graph as every
 * other door, and every view that already understands doors understands these for
 * free — the boundary picture, the detail panel, the tours, the export. That is the
 * whole reason this lives in the atlas rather than in one screen's rendering code.
 *
 * Only built for projects classified `library`. On an app, every helper a module
 * exports would become a door and the picture would say nothing at all.
 */
import type { AtlasEdge, AtlasNode, EndpointMeta, FunctionMeta, TypeMeta } from '../../model/types.js';
import { INBOUND_ID, makeEdgeId, makeEndpointId } from '../../model/types.js';
import { hashParts } from '../../util/hash.js';
import type { BoundaryGraph } from './build.js';

export interface ExportDoorInput {
  /** Every node built so far — the functions and types are read out of this. */
  nodes: AtlasNode[];
  appId: string;
}

export function buildExportDoors({ nodes, appId }: ExportDoorInput): BoundaryGraph {
  const out: AtlasNode[] = [];
  const edges: AtlasEdge[] = [];

  const doors = nodes.filter(isExported).map((node) => door(node));
  if (doors.length === 0) return { nodes: out, edges };

  // The container may already exist — a library that also reads an env var has one.
  if (!nodes.some((node) => node.id === INBOUND_ID)) {
    out.push({
      id: INBOUND_ID,
      kind: 'zone',
      name: 'Ways in',
      label: null,
      parentId: appId,
      language: null,
      path: null,
      startLine: null,
      endLine: null,
      zone: 'api',
      summary: null,
      summarySource: null,
      docHash: null,
      bodyHash: null,
      hash: hashParts('boundary', INBOUND_ID, String(doors.length)),
      provenance: 'static',
      meta: { direction: 'in', endpointCount: doors.length },
    });
  }

  for (const { node, target } of doors) {
    out.push(node);
    // The door and the thing it opens onto are the same code here, which is what
    // makes the band land in that symbol's own zone rather than in a generic API one.
    edges.push({
      id: makeEdgeId('exposed-by', node.id, target.id),
      kind: 'exposed-by',
      fromId: node.id,
      toId: target.id,
      weight: 1,
      confidence: 'certain',
      provenance: 'static',
      meta: {},
    });
  }

  return { nodes: out, edges };
}

/**
 * Methods are excluded: `save` on an exported class is reached through the class, and
 * listing both would count one commitment twice.
 */
function isExported(node: AtlasNode): boolean {
  // A helper a test file exports is not something anyone imports on purpose.
  // FastAPI's template offered `randomEmail` and `findLastEmail` as part of its public
  // API; psf/requests offered its fixtures. Nobody's semver depends on those (#25).
  if (node.zone === 'test') return false;
  // Nor is a name a code generator emitted. One 42,860-line `schema.gen.ts` supplied
  // 1,895 of its package's 1,938 doors, burying the twenty-odd its authors actually
  // committed to (#126). Semver does not bind what a generator will rewrite tomorrow.
  if (node.meta.generated === true) return false;
  if (node.kind === 'function') {
    const meta = node.meta as unknown as FunctionMeta;
    return meta.isExported === true && meta.isMethod !== true;
  }
  if (node.kind === 'type') {
    const meta = node.meta as unknown as TypeMeta;
    // A database table is not something a consumer imports.
    return meta.isExported === true && meta.typeKind !== 'table';
  }
  return false;
}

function door(target: AtlasNode): { node: AtlasNode; target: AtlasNode } {
  const kind = target.kind === 'function' ? 'function' : String((target.meta as unknown as TypeMeta).typeKind);
  const meta: EndpointMeta = {
    endpointKind: 'export',
    // What a consumer writes to reach it. Not a verb, but it sits where the verb goes
    // and reads correctly on the card: `import · format`.
    method: 'IMPORT',
    route: target.path ? `${target.path}#${target.name}` : target.name,
    framework: kind,
    guards: [],
    // Whether a call mutates anything is not knowable from the signature, and
    // guessing would put a false fact next to a true one.
    writes: false,
    sites: [{ path: target.path ?? '', line: target.startLine ?? 0, nodeId: target.id }],
  };

  return {
    target,
    node: {
      id: makeEndpointId('export', target.id),
      kind: 'endpoint',
      name: target.name,
      label: null,
      parentId: INBOUND_ID,
      language: target.language,
      path: target.path,
      startLine: target.startLine,
      endLine: null,
      zone: target.zone,
      // The symbol's own description is the best answer to "what is this door for",
      // and it is already read from the code rather than generated.
      summary: target.summary,
      summarySource: target.summarySource,
      docHash: null,
      bodyHash: null,
      hash: hashParts('endpoint', 'export', target.id, target.hash),
      provenance: 'static',
      meta: meta as unknown as Record<string, unknown>,
    },
  };
}
