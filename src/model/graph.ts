/**
 * @fileoverview In-memory query layer over an atlas.
 *
 * The canvas must never receive the whole graph (SPEC.md principle 2), so every
 * question the UI asks is answered as a *slice*: the children of one container plus
 * the edges rolled up to that level. Rolling up means an import from
 * `src/auth/login.ts` to `src/db/client.ts` shows as one arrow between the `auth` and
 * `db` boxes when you are looking at that level — with a weight telling you how many
 * real code paths it stands for.
 */
import type { Atlas, AtlasEdge, AtlasMeta, AtlasNode, EdgeKind } from './types.js';
import { CONTAINER_KINDS } from './types.js';

export interface LevelNode extends AtlasNode {
  childCount: number;
  drillable: boolean;
  /** Connections to things outside the level currently on screen. */
  outsideIn: number;
  outsideOut: number;
  /** A few of the names inside, so a closed box still says what it holds. */
  preview: string[];
}

export interface LevelEdge {
  id: string;
  fromId: string;
  toId: string;
  weight: number;
  kinds: EdgeKind[];
}

export interface LevelView {
  levelId: string;
  self: AtlasNode | null;
  breadcrumb: AtlasNode[];
  nodes: LevelNode[];
  edges: LevelEdge[];
  truncated: boolean;
  totalChildren: number;
}

export interface NeighborLink {
  edge: AtlasEdge;
  other: AtlasNode;
  direction: 'in' | 'out';
}

export interface NodeView {
  node: AtlasNode;
  breadcrumb: AtlasNode[];
  children: AtlasNode[];
  incoming: NeighborLink[];
  outgoing: NeighborLink[];
  incomingTotal: number;
  outgoingTotal: number;
}

export interface OverviewView {
  meta: AtlasMeta;
  rootId: string;
  topLevel: LevelNode[];
  busiestFiles: { node: AtlasNode; connections: number }[];
  zoneCounts: Record<string, number>;
}

const MAX_LEVEL_NODES = 400;
const MAX_NEIGHBORS = 60;

export class AtlasGraph {
  readonly meta: AtlasMeta;
  readonly rootId: string;
  private readonly nodes = new Map<string, AtlasNode>();
  private readonly children = new Map<string, AtlasNode[]>();
  private readonly relations: AtlasEdge[] = [];
  private readonly incoming = new Map<string, AtlasEdge[]>();
  private readonly outgoing = new Map<string, AtlasEdge[]>();
  private readonly pathCache = new Map<string, string[]>();

  constructor(atlas: Atlas) {
    this.meta = atlas.meta;
    for (const node of atlas.nodes) this.nodes.set(node.id, node);

    for (const node of atlas.nodes) {
      if (!node.parentId) continue;
      const list = this.children.get(node.parentId);
      if (list) list.push(node);
      else this.children.set(node.parentId, [node]);
    }

    for (const edge of atlas.edges) {
      if (edge.kind === 'contains') continue;
      this.relations.push(edge);
      pushTo(this.outgoing, edge.fromId, edge);
      pushTo(this.incoming, edge.toId, edge);
    }

    const app = atlas.nodes.find((n) => n.kind === 'app');
    this.rootId = app?.id ?? atlas.nodes[0]?.id ?? '';
  }

  static fromAtlas(atlas: Atlas): AtlasGraph {
    return new AtlasGraph(atlas);
  }

  getNodeById(id: string): AtlasNode | undefined {
    return this.nodes.get(id);
  }

  /** Every node of one kind, in id order. The boundary and insight views live off this. */
  nodesOfKind(kind: AtlasNode['kind']): AtlasNode[] {
    const out: AtlasNode[] = [];
    for (const node of this.nodes.values()) {
      if (node.kind === kind) out.push(node);
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }

  edgesFrom(id: string): AtlasEdge[] {
    return this.outgoing.get(id) ?? [];
  }

  edgesTo(id: string): AtlasEdge[] {
    return this.incoming.get(id) ?? [];
  }

  /** Root-first chain of ancestors, ending with the node itself. */
  private pathTo(id: string): string[] {
    const cached = this.pathCache.get(id);
    if (cached) return cached;
    const chain: string[] = [];
    const seen = new Set<string>();
    let current: AtlasNode | undefined = this.nodes.get(id);
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      chain.unshift(current.id);
      current = current.parentId ? this.nodes.get(current.parentId) : undefined;
    }
    this.pathCache.set(id, chain);
    return chain;
  }

  /** The child of `levelId` that contains `nodeId` (or `nodeId` itself). */
  private ancestorAtLevel(nodeId: string, levelId: string): string | undefined {
    const chain = this.pathTo(nodeId);
    const index = chain.indexOf(levelId);
    if (index === -1) return undefined;
    return chain[index + 1];
  }

  breadcrumb(id: string): AtlasNode[] {
    return this.pathTo(id)
      .map((nodeId) => this.nodes.get(nodeId))
      .filter((n): n is AtlasNode => Boolean(n));
  }

  childrenOf(id: string): AtlasNode[] {
    return this.children.get(id) ?? [];
  }

  /** One screen's worth of graph: the children of `levelId` and the edges between them. */
  getLevel(levelId: string): LevelView {
    const self = this.nodes.get(levelId) ?? null;
    const all = this.childrenOf(levelId);
    const sorted = [...all].sort(compareForDisplay);
    const truncated = sorted.length > MAX_LEVEL_NODES;
    const visible = truncated ? sorted.slice(0, MAX_LEVEL_NODES) : sorted;
    const visibleIds = new Set(visible.map((n) => n.id));

    const aggregated = new Map<string, LevelEdge>();
    const outsideIn = new Map<string, number>();
    const outsideOut = new Map<string, number>();

    for (const edge of this.relations) {
      const from = this.ancestorAtLevel(edge.fromId, levelId);
      const to = this.ancestorAtLevel(edge.toId, levelId);
      if (from && to) {
        if (from === to) continue;
        if (!visibleIds.has(from) || !visibleIds.has(to)) continue;
        const id = `${from}->${to}`;
        const existing = aggregated.get(id);
        if (existing) {
          existing.weight += edge.weight;
          if (!existing.kinds.includes(edge.kind)) existing.kinds.push(edge.kind);
        } else {
          aggregated.set(id, { id, fromId: from, toId: to, weight: edge.weight, kinds: [edge.kind] });
        }
      } else if (from && visibleIds.has(from)) {
        outsideOut.set(from, (outsideOut.get(from) ?? 0) + edge.weight);
      } else if (to && visibleIds.has(to)) {
        outsideIn.set(to, (outsideIn.get(to) ?? 0) + edge.weight);
      }
    }

    const nodes: LevelNode[] = visible.map((node) => {
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
      truncated,
      totalChildren: all.length,
    };
  }

  /** Everything the detail panel needs about one node. */
  getNode(id: string): NodeView | null {
    const node = this.nodes.get(id);
    if (!node) return null;

    const outgoingAll = this.outgoing.get(id) ?? [];
    const incomingAll = this.incoming.get(id) ?? [];

    const toLink = (edge: AtlasEdge, direction: 'in' | 'out'): NeighborLink | null => {
      const otherId = direction === 'out' ? edge.toId : edge.fromId;
      const other = this.nodes.get(otherId);
      if (!other) return null;
      return { edge, other, direction };
    };

    const outgoing = outgoingAll
      .slice()
      .sort((a, b) => b.weight - a.weight)
      .slice(0, MAX_NEIGHBORS)
      .map((e) => toLink(e, 'out'))
      .filter((l): l is NeighborLink => Boolean(l));

    const incoming = incomingAll
      .slice()
      .sort((a, b) => b.weight - a.weight)
      .slice(0, MAX_NEIGHBORS)
      .map((e) => toLink(e, 'in'))
      .filter((l): l is NeighborLink => Boolean(l));

    return {
      node,
      breadcrumb: this.breadcrumb(id),
      children: [...this.childrenOf(id)].sort(compareForDisplay).slice(0, 300),
      incoming,
      outgoing,
      incomingTotal: incomingAll.length,
      outgoingTotal: outgoingAll.length,
    };
  }

  /** The landing view: headline numbers plus the top-level shape of the app. */
  getOverview(): OverviewView {
    const topLevel = this.getLevel(this.rootId).nodes;

    const connectionCount = new Map<string, number>();
    for (const edge of this.relations) {
      for (const endpoint of [edge.fromId, edge.toId]) {
        const fileId = this.nearestOfKind(endpoint, 'file');
        if (fileId) connectionCount.set(fileId, (connectionCount.get(fileId) ?? 0) + edge.weight);
      }
    }

    const busiestFiles = [...connectionCount.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([nodeId, connections]) => ({ node: this.nodes.get(nodeId)!, connections }))
      .filter((entry) => Boolean(entry.node));

    const zoneCounts: Record<string, number> = {};
    for (const node of this.nodes.values()) {
      if (node.kind !== 'file') continue;
      zoneCounts[node.zone] = (zoneCounts[node.zone] ?? 0) + 1;
    }

    return { meta: this.meta, rootId: this.rootId, topLevel, busiestFiles, zoneCounts };
  }

  /** Walks up from a node until it finds an ancestor of the requested kind. */
  private nearestOfKind(id: string, kind: AtlasNode['kind']): string | undefined {
    const chain = this.pathTo(id);
    for (let i = chain.length - 1; i >= 0; i--) {
      if (this.nodes.get(chain[i])?.kind === kind) return chain[i];
    }
    return undefined;
  }

  search(query: string, limit = 30): AtlasNode[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const scored: { node: AtlasNode; score: number }[] = [];
    for (const node of this.nodes.values()) {
      const name = node.name.toLowerCase();
      const nodePath = (node.path ?? '').toLowerCase();
      let score = 0;
      if (name === q) score = 100;
      else if (name.startsWith(q)) score = 80;
      else if (name.includes(q)) score = 60;
      else if (nodePath.includes(q)) score = 30;
      if (score === 0) continue;
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

function pushTo(map: Map<string, AtlasEdge[]>, key: string, edge: AtlasEdge): void {
  const list = map.get(key);
  if (list) list.push(edge);
  else map.set(key, [edge]);
}

const KIND_ORDER: Record<string, number> = {
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

function compareForDisplay(a: AtlasNode, b: AtlasNode): number {
  const byKind = (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9);
  if (byKind !== 0) return byKind;
  return a.name.localeCompare(b.name);
}

function kindBoost(kind: AtlasNode['kind']): number {
  if (kind === 'module') return 8;
  if (kind === 'file') return 6;
  if (kind === 'type') return 4;
  return 0;
}
