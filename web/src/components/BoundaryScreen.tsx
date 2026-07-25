/**
 * @fileoverview The boundary view — the home screen (SPEC.md 6.1).
 *
 * Inputs on the left, your app in the middle broken into zones, outputs on the right,
 * with bands between them whose thickness is the number of code paths. Left→right
 * beats a ring: it reads in the direction of causality and it keeps working past ten
 * endpoints, which a ring does not.
 *
 * The bands are SVG; the cards are ordinary HTML sitting on top of them. That way a
 * card is a real button with real text, and the ribbon behind it is just geometry.
 */
import { useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import type { BoundaryView } from '../types';

interface Props {
  view: BoundaryView;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onOpenInsights: () => void;
}

const PAD = 28;
const COL_W = 232;
const APP_W = 268;
const GAP = 116;
const CARD_H = 66;
const CARD_GAP = 14;
const ZONE_H = 46;
const ZONE_GAP = 8;
const APP_PAD = 18;
const APP_HEAD = 34;

const MIN_BAND = 3;
const MAX_BAND = 26;

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function BoundaryScreen({ view, selectedId, onSelect, onOpenInsights }: Props) {
  const [hovered, setHovered] = useState<string | null>(null);
  const layout = useMemo(() => computeLayout(view), [view]);

  const active = hovered ?? selectedId;

  return (
    <div className="boundary">
      <Headline view={view} onOpenInsights={onOpenInsights} />

      <div className="boundary-scroll">
        <div className="boundary-stage" style={{ width: layout.width, height: layout.height }}>
          <svg className="boundary-bands" width={layout.width} height={layout.height} aria-hidden="true">
            {layout.bands.map((band) => (
              <path
                key={band.id}
                d={band.d}
                className={`band band-${band.tone}${bandIsActive(band, active) ? ' is-lit' : active ? ' is-dim' : ''}`}
              />
            ))}
          </svg>

          <div className="boundary-appbox" style={boxStyle(layout.appBox)}>
            <div className="boundary-appname">{view.appName}</div>
          </div>

          {view.zones.map((zone) => {
            const box = layout.boxes.get(`zone:${zone.zone}`);
            if (!box) return null;
            return (
              <div key={zone.zone} className={`bzone zone-${zone.zone}`} style={boxStyle(box)}>
                <span className="bzone-name">{zone.label}</span>
                <span className="bzone-count">{zone.files}</span>
              </div>
            );
          })}

          {[...view.inputs, ...view.outputs].map((card) => {
            const box = layout.boxes.get(card.id);
            if (!box) return null;
            const isInput = view.inputs.includes(card);
            return (
              <button
                key={card.id}
                className={[
                  'bcard',
                  `bcard-${isInput ? 'in' : 'out'}`,
                  `family-${card.family}`,
                  selectedId && card.memberIds.includes(selectedId) ? 'is-selected' : '',
                  active && !touches(layout, card.id, active) ? 'is-dim' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                style={boxStyle(box)}
                onMouseEnter={() => setHovered(card.id)}
                onMouseLeave={() => setHovered(null)}
                onClick={() => onSelect(card.nodeId ?? card.memberIds[0] ?? '')}
              >
                <span className="bcard-glyph">{glyphFor(card.family)}</span>
                <span className="bcard-body">
                  <span className="bcard-name">{card.name}</span>
                  <span className="bcard-detail">{card.detail}</span>
                </span>
                {card.openCount ? (
                  <span className="bcard-warn" title={`${card.openCount} with no auth check found`}>
                    {card.openCount} open
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      </div>

      <p className="boundary-foot">
        Band thickness is the number of code paths. Everything here comes from the compiler — click any card to see
        the exact lines.
      </p>
    </div>
  );
}

function Headline({ view, onOpenInsights }: { view: BoundaryView; onOpenInsights: () => void }) {
  const { summary } = view;
  return (
    <div className="boundary-head">
      <h1>
        {summary.endpoints} {summary.endpoints === 1 ? 'way' : 'ways'} in
        <span className="sep">·</span>
        {summary.externalServices} {summary.externalServices === 1 ? 'service' : 'services'} out
        <span className="sep">·</span>
        {summary.stores} {summary.stores === 1 ? 'data store' : 'data stores'}
      </h1>
      {summary.openRoutes > 0 ? (
        <button className="pill pill-warn" onClick={onOpenInsights}>
          {summary.openRoutes} {summary.openRoutes === 1 ? 'route has' : 'routes have'} no auth check →
        </button>
      ) : (
        <button className="pill" onClick={onOpenInsights}>
          Security details →
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

interface Band {
  id: string;
  d: string;
  fromId: string;
  toId: string;
  tone: 'in' | 'out';
}

interface Layout {
  width: number;
  height: number;
  boxes: Map<string, Box>;
  appBox: Box;
  bands: Band[];
}

function computeLayout(view: BoundaryView): Layout {
  const boxes = new Map<string, Box>();

  const inputsH = columnHeight(view.inputs.length, CARD_H, CARD_GAP);
  const outputsH = columnHeight(view.outputs.length, CARD_H, CARD_GAP);
  const zonesH = columnHeight(view.zones.length, ZONE_H, ZONE_GAP);
  const appH = zonesH + APP_HEAD + APP_PAD;
  const contentH = Math.max(inputsH, outputsH, appH, 180);

  const xIn = PAD;
  const xApp = xIn + COL_W + GAP;
  const xZone = xApp + APP_PAD;
  const xOut = xApp + APP_W + GAP;
  const width = xOut + COL_W + PAD;
  const height = contentH + PAD * 2;

  stack(boxes, view.inputs.map((c) => c.id), xIn, COL_W, CARD_H, CARD_GAP, (height - inputsH) / 2);
  stack(boxes, view.outputs.map((c) => c.id), xOut, COL_W, CARD_H, CARD_GAP, (height - outputsH) / 2);

  const appBox: Box = { x: xApp, y: (height - appH) / 2, w: APP_W, h: appH };
  stack(
    boxes,
    view.zones.map((z) => `zone:${z.zone}`),
    xZone,
    APP_W - APP_PAD * 2,
    ZONE_H,
    ZONE_GAP,
    appBox.y + APP_HEAD,
  );

  return { width, height, boxes, appBox, bands: computeBands(view, boxes) };
}

function columnHeight(count: number, itemH: number, gap: number): number {
  return count === 0 ? 0 : count * itemH + (count - 1) * gap;
}

/** Stacks a column of equal-height boxes downwards from `top`. */
function stack(
  boxes: Map<string, Box>,
  ids: string[],
  x: number,
  w: number,
  h: number,
  gap: number,
  top: number,
): void {
  let y = top;
  for (const id of ids) {
    boxes.set(id, { x, y, w, h });
    y += h + gap;
  }
}

function computeBands(view: BoundaryView, boxes: Map<string, Box>): Band[] {
  const max = Math.max(1, ...view.flows.map((flow) => flow.weight));

  // Bands leave and arrive stacked in the order the flows were listed, so a thick
  // band never sits on top of a thin one.
  const usedOut = new Map<string, number>();
  const usedIn = new Map<string, number>();
  const totalOut = new Map<string, number>();
  const totalIn = new Map<string, number>();

  for (const flow of view.flows) {
    const t = thickness(flow.weight, max);
    totalOut.set(flow.fromId, (totalOut.get(flow.fromId) ?? 0) + t);
    totalIn.set(flow.toId, (totalIn.get(flow.toId) ?? 0) + t);
  }

  const bands: Band[] = [];
  for (const flow of view.flows) {
    const from = boxes.get(flow.fromId);
    const to = boxes.get(flow.toId);
    if (!from || !to) continue;

    const t = thickness(flow.weight, max);
    const outUsed = usedOut.get(flow.fromId) ?? 0;
    const inUsed = usedIn.get(flow.toId) ?? 0;
    const y1 = from.y + from.h / 2 - (totalOut.get(flow.fromId) ?? 0) / 2 + outUsed + t / 2;
    const y2 = to.y + to.h / 2 - (totalIn.get(flow.toId) ?? 0) / 2 + inUsed + t / 2;
    usedOut.set(flow.fromId, outUsed + t);
    usedIn.set(flow.toId, inUsed + t);

    bands.push({
      id: `${flow.fromId}->${flow.toId}`,
      d: ribbon(from.x + from.w, y1, to.x, y2, t),
      fromId: flow.fromId,
      toId: flow.toId,
      tone: flow.fromId.startsWith('zone:') ? 'out' : 'in',
    });
  }
  return bands;
}

function thickness(weight: number, max: number): number {
  return MIN_BAND + (MAX_BAND - MIN_BAND) * Math.sqrt(weight / max);
}

/** A closed cubic ribbon: top edge out, bottom edge back. */
function ribbon(x1: number, y1: number, x2: number, y2: number, t: number): string {
  const half = t / 2;
  const cx = (x1 + x2) / 2;
  return [
    `M ${x1} ${y1 - half}`,
    `C ${cx} ${y1 - half}, ${cx} ${y2 - half}, ${x2} ${y2 - half}`,
    `L ${x2} ${y2 + half}`,
    `C ${cx} ${y2 + half}, ${cx} ${y1 + half}, ${x1} ${y1 + half}`,
    'Z',
  ].join(' ');
}

function bandIsActive(band: Band, active: string | null): boolean {
  return active !== null && (band.fromId === active || band.toId === active);
}

/** Is this card on either end of a band that touches the active one? */
function touches(layout: Layout, cardId: string, active: string): boolean {
  if (cardId === active) return true;
  for (const band of layout.bands) {
    if (band.fromId === active && band.toId === cardId) return true;
    if (band.toId === active && band.fromId === cardId) return true;
  }
  return false;
}

function boxStyle(box: Box): CSSProperties {
  return { left: box.x, top: box.y, width: box.w, height: box.h };
}

/**
 * Deliberately drawn from Geometric Shapes and the handful of arrows and dingbats
 * that every system font actually ships. An exotic codepoint renders as a tofu box on
 * someone's machine, and a box says nothing.
 */
const GLYPHS: Record<string, string> = {
  pages: '□',
  routes: '⇥',
  actions: '⚡',
  webhooks: '⇄',
  cron: '◷',
  queue: '≡',
  realtime: '↻',
  cli: '›',
  env: '⚙',
  files: '▤',
  store: '◉',
  payments: '◆',
  ai: '✦',
  email: '✉',
  sms: '◐',
  auth: '◈',
  storage: '▤',
  analytics: '◔',
  search: '○',
  monitoring: '◑',
};

function glyphFor(family: string): string {
  return GLYPHS[family] ?? '◇';
}
