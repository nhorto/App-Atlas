/**
 * @fileoverview The type explorer — dbdiagram for your code (SPEC.md 6.3).
 *
 * The one view where the picture is the data rather than the architecture: named
 * shapes, their fields, and lines drawn out of the row that actually holds the
 * reference. Database tables sit here too, in the same picture as the code's own
 * types, because for the person this tool is for they are the same question — "what
 * does my app know about?" — asked twice.
 *
 * Two kinds of line, and the difference is on screen: a solid line is something the
 * code or the schema states outright, a dashed one is only a shared name.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import { layoutTypes, sizeOfTypeCard, type Positioned } from '../layout';
import type { TypeCard, TypeView } from '../types';
import { zoneLabel } from './AtlasNodeCard';

const KIND_WORDS: Record<TypeCard['typeKind'], string> = {
  interface: 'interface',
  'type-alias': 'type',
  enum: 'enum',
  class: 'class',
  table: 'table',
};

export interface TypeCardData extends Record<string, unknown> {
  card: TypeCard;
  dim: boolean;
}

const nodeTypes = { typecard: TypeCardNode };

export function TypeScreen({
  view,
  selectedId,
  onSelect,
}: {
  view: TypeView;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const [positions, setPositions] = useState<Map<string, Positioned>>(new Map());
  // Bumped when a layout lands. Remounting React Flow on this key makes its one
  // initial fitView run against the laid-out cards — fitting the pre-layout pile at
  // (0,0) and then moving every card out from under the viewport was the old bug.
  const [layoutRev, setLayoutRev] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void layoutTypes(view.cards, view.links).then((laid) => {
      if (cancelled) return;
      setPositions(laid);
      setLayoutRev((n) => n + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [view]);

  /** The selection plus whatever it is linked to. */
  const lit = useMemo(() => {
    if (!selectedId || !view.cards.some((card) => card.id === selectedId)) return null;
    const ids = new Set([selectedId]);
    for (const link of view.links) {
      if (link.fromId === selectedId) ids.add(link.toId);
      if (link.toId === selectedId) ids.add(link.fromId);
    }
    return ids;
  }, [selectedId, view]);

  const nodes: Node[] = useMemo(
    () =>
      view.cards.map((card) => {
        const placed = positions.get(card.id);
        const fallback = sizeOfTypeCard(card);
        return {
          id: card.id,
          type: 'typecard',
          position: { x: placed?.x ?? 0, y: placed?.y ?? 0 },
          data: { card, dim: lit ? !lit.has(card.id) : false },
          selected: card.id === selectedId,
          // Sized through `style` rather than the width/height props: a line that
          // starts at one field row needs React Flow to have measured that row's
          // handle, so the card is left to report its own size.
          style: { width: placed?.width ?? fallback.width, height: placed?.height ?? fallback.height },
        } satisfies Node;
      }),
    [view, positions, lit, selectedId],
  );

  const edges: Edge[] = useMemo(
    () =>
      view.links.map((link) => {
        const touches = selectedId === link.fromId || selectedId === link.toId;
        const guess = link.basis === 'name';
        return {
          id: link.id,
          source: link.fromId,
          target: link.toId,
          // Field lines leave the row they belong to; a whole-card link leaves the card.
          sourceHandle: link.fields[0] ? `f:${link.fields[0]}` : 'out',
          targetHandle: 'in',
          label: touches && link.fields.length > 0 ? link.fields.join(', ') : undefined,
          labelBgStyle: { fill: '#f4f1e9' },
          labelStyle: { fontSize: 11, fill: '#5f594b' },
          style: {
            stroke: guess ? '#8b74d8' : touches ? '#4a4436' : '#a89f8b',
            strokeWidth: touches ? 2 : 1.4,
            strokeDasharray: guess ? '5 4' : undefined,
            opacity: lit && !touches ? 0.12 : 0.75,
          },
          markerEnd: guess
            ? undefined
            : { type: MarkerType.ArrowClosed, width: 13, height: 13, color: touches ? '#4a4436' : '#a89f8b' },
        } satisfies Edge;
      }),
    [view, selectedId, lit],
  );

  if (view.cards.length === 0) {
    return (
      <div className="page">
        <div className="overview-page">
          <div className="page-head">
            <h1>Your data</h1>
            <p className="page-sub">The shapes your app moves around, and how they connect.</p>
          </div>
          <div className="overview-lede is-empty">
            <p>
              No types or database tables were found. This view fills up on its own as your code declares
              interfaces and types — or the moment a <code>schema.prisma</code> appears.
            </p>
          </div>
        </div>
      </div>
    );
  }

  const hidden = view.total - view.cards.length;

  return (
    <div className="type-screen">
      <div className="type-head">
        <div>
          <h1>Your data</h1>
          <p className="page-sub">
            {countOf(view.cards.length, 'shape')}
            {view.tables > 0 ? ` · ${countOf(view.tables, 'database table')}` : ''}
            {hidden > 0 ? ` · showing the ${view.cards.length} most used of ${view.total}` : ''}
          </p>
        </div>
        <div className="type-legend">
          <span className="type-legend-item">
            <span className="legend-line legend-declared" /> declared in the code
          </span>
          <span className="type-legend-item">
            <span className="legend-line legend-guess" /> same name only
          </span>
        </div>
      </div>

      <div className="type-canvas">
        {positions.size === 0 ? (
          <div className="loading">Laying the shapes out…</div>
        ) : (
        <ReactFlowProvider>
          <ReactFlow
            key={layoutRev}
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable
            fitView
            // A floor on the opening zoom: sixty cards framed to fit is a grey mosaic,
            // and the first thing this view has to be is readable. Zooming out further
            // is one gesture away for anyone who wants the whole shape at once.
            fitViewOptions={{ padding: 0.18, minZoom: 0.34, maxZoom: 1 }}
            minZoom={0.1}
            maxZoom={2.5}
            onNodeClick={(_, node) => onSelect(node.id)}
          >
            <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="#d9d2bf" />
            <Controls showInteractive={false} />
          </ReactFlow>
        </ReactFlowProvider>
        )}
      </div>
    </div>
  );
}

function TypeCardNode({ data, selected }: NodeProps) {
  const { card, dim } = data as unknown as TypeCardData;
  const classes = [
    'tcard',
    `tcard-${card.typeKind}`,
    `zone-${card.zone}`,
    dim ? 'is-dim' : '',
    selected ? 'is-selected' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={classes} title={card.path ?? card.name}>
      <Handle type="target" position={Position.Left} id="in" className="handle" />
      <Handle type="source" position={Position.Right} id="out" className="handle" />

      <div className="tcard-head">
        <span className="tcard-name">{card.name}</span>
        <span className="tcard-kind">{KIND_WORDS[card.typeKind]}</span>
      </div>

      {card.aliasOf ? <div className="tcard-alias">{card.aliasOf}</div> : null}

      {card.fields.length > 0 ? (
        <ul className="tcard-fields">
          {card.fields.map((field) => (
            <li key={field.name} className={field.linkTo ? 'is-link' : undefined}>
              <span className="tfield-name">
                {field.isId ? <span className="tfield-key" title="primary key">⚿</span> : null}
                {field.name}
                {field.optional ? '?' : ''}
              </span>
              <span className="tfield-type">{field.type}</span>
              {field.linkTo ? (
                <Handle type="source" position={Position.Right} id={`f:${field.name}`} className="handle handle-row" />
              ) : null}
            </li>
          ))}
          {card.hiddenFields > 0 ? <li className="tfield-more">+{card.hiddenFields} more</li> : null}
        </ul>
      ) : null}

      {card.usage > 0 ? (
        <div className="tcard-usage">
          used in {card.usage} {card.usage === 1 ? 'place' : 'places'}
          {card.usageByZone.length > 0
            ? ` · ${card.usageByZone
                .slice(0, 3)
                .map((entry) => `${entry.count} ${zoneLabel(entry.zone)}`)
                .join(', ')}`
            : ''}
        </div>
      ) : null}
    </div>
  );
}

function countOf(value: number, noun: string): string {
  return `${value} ${value === 1 ? noun : `${noun}s`}`;
}
