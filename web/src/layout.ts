/**
 * @fileoverview Deterministic layout.
 *
 * elkjs' layered algorithm, left to right. Same atlas in, same picture out, every
 * time — spatial memory is a feature (SPEC.md principle 4), so nothing here may
 * depend on randomness, timing, or previous positions.
 */
import ELK from 'elkjs/lib/elk.bundled.js';
import type { LevelEdge, LevelNode, TypeCard, TypeLink } from './types';

const elk = new ELK();

export interface Positioned {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

const LAYOUT_OPTIONS: Record<string, string> = {
  'elk.algorithm': 'layered',
  'elk.direction': 'RIGHT',
  'elk.layered.spacing.nodeNodeBetweenLayers': '110',
  'elk.spacing.nodeNode': '36',
  'elk.spacing.edgeNode': '28',
  'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
  'elk.layered.cycleBreaking.strategy': 'GREEDY',
  'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
  'elk.edgeRouting': 'POLYLINE',
  'elk.padding': '[top=40,left=40,bottom=40,right=40]',
};

/** Card size for a node, chosen so text never has to shrink to fit. */
export function sizeOf(node: LevelNode): { width: number; height: number } {
  const nameWidth = Math.min(360, Math.max(190, node.name.length * 8.4 + 72));
  switch (node.kind) {
    case 'module': {
      const previewRows = Math.min(node.preview.length, 4);
      return { width: Math.max(nameWidth, 230), height: 74 + previewRows * 17 };
    }
    case 'file':
      return { width: Math.max(nameWidth, 210), height: 72 };
    case 'type': {
      const fields = (node.meta.fields as unknown[] | undefined)?.length ?? 0;
      // Six field rows at most, plus a row for the "+N more" line when it appears.
      const rows = Math.min(fields, 6) + (fields > 6 ? 1 : 0);
      return { width: Math.max(nameWidth, 220), height: 68 + rows * 18 };
    }
    case 'function':
      return { width: Math.max(nameWidth, 240), height: 66 };
    case 'endpoint':
      // Routes carry a method chip and a protection badge, so they need the room.
      return { width: Math.max(nameWidth, 250), height: 76 };
    case 'service':
    case 'store':
      return { width: Math.max(nameWidth, 220), height: 74 };
    case 'zone':
      return { width: Math.max(nameWidth, 230), height: 76 };
    default:
      return { width: nameWidth, height: 70 };
  }
}

/** Row-for-row card size, so a field's outgoing line starts level with its row. */
export function sizeOfTypeCard(card: TypeCard): { width: number; height: number } {
  const longest = card.fields.reduce(
    (max, field) => Math.max(max, field.name.length + Math.min(field.type.length, 22) + 3),
    card.name.length + 8,
  );
  const observedNote = card.typeKind === 'table' && card.fields.length === 0;
  const rows = card.fields.length + (card.hiddenFields > 0 ? 1 : 0) + (card.aliasOf ? 1 : 0) + (observedNote ? 1 : 0);
  return {
    width: Math.min(340, Math.max(observedNote ? 260 : 210, longest * 7.1 + 34)),
    height: 46 + rows * 21 + (card.usage > 0 ? 22 : 8),
  };
}

/**
 * The type explorer's layout. Same algorithm as the map — a schema is a graph like any
 * other — but the cards are taller and the lines carry field names, so it gets more
 * room between layers than the map does.
 */
export async function layoutTypes(cards: TypeCard[], links: TypeLink[]): Promise<Map<string, Positioned>> {
  if (cards.length === 0) return new Map();

  const graph = {
    id: 'root',
    layoutOptions: {
      ...LAYOUT_OPTIONS,
      'elk.layered.spacing.nodeNodeBetweenLayers': '140',
      'elk.spacing.nodeNode': '44',
    },
    children: cards.map((card) => ({ id: card.id, ...sizeOfTypeCard(card) })),
    edges: links.map((link) => ({ id: link.id, sources: [link.fromId], targets: [link.toId] })),
  };

  const result = (await elk.layout(graph)) as {
    children?: { id: string; x?: number; y?: number; width?: number; height?: number }[];
  };

  const positions = new Map<string, Positioned>();
  for (const child of result.children ?? []) {
    positions.set(child.id, {
      id: child.id,
      x: child.x ?? 0,
      y: child.y ?? 0,
      width: child.width ?? 240,
      height: child.height ?? 120,
    });
  }
  return positions;
}

export async function layoutLevel(nodes: LevelNode[], edges: LevelEdge[]): Promise<Map<string, Positioned>> {
  if (nodes.length === 0) return new Map();

  const graph = {
    id: 'root',
    layoutOptions: LAYOUT_OPTIONS,
    children: nodes.map((node) => {
      const { width, height } = sizeOf(node);
      return { id: node.id, width, height };
    }),
    // Self-loops and duplicates confuse elk; the API already removes both.
    edges: edges.map((edge) => ({
      id: edge.id,
      sources: [edge.fromId],
      targets: [edge.toId],
    })),
  };

  const result = (await elk.layout(graph)) as {
    children?: { id: string; x?: number; y?: number; width?: number; height?: number }[];
  };

  const positions = new Map<string, Positioned>();
  for (const child of result.children ?? []) {
    positions.set(child.id, {
      id: child.id,
      x: child.x ?? 0,
      y: child.y ?? 0,
      width: child.width ?? 200,
      height: child.height ?? 70,
    });
  }
  return positions;
}
