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
 *
 * The column headings and the headline's first count come from the archetype, so the
 * same picture reads as doors for an app, a public API for a library and an I/O
 * diagram for a script. When a project has no boundary at all this screen says so in
 * words and points at the map, rather than drawing an empty frame.
 */
import { Fragment, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { Archetype, ArchetypeVerdict, BoundaryCard, BoundaryView, SummarySource } from '../types';
import { TrustLabel } from './Trust';

interface Props {
  view: BoundaryView;
  selectedId: string | null;
  /** The app's one-paragraph description, when there is one. */
  summary: string | null;
  summarySource: SummarySource;
  /** What kind of project this is — what an empty diagram needs in order to explain itself. */
  archetype: ArchetypeVerdict | null;
  onSelect: (id: string) => void;
  onOpenInsights: () => void;
  onOpenMap: () => void;
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
/** Room above the three columns for the headings that say what each one is. */
const CAPTION_H = 26;

const MIN_BAND = 3;
const MAX_BAND = 26;

/**
 * How far the picture may shrink to fit its pane before we stop and let it scroll
 * instead. The whole point of this screen is to be read at a glance, and a diagram
 * squeezed past about two-thirds stops being readable — better a scrollbar than a
 * wall of unreadable labels.
 */
const MIN_SCALE = 0.62;

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function BoundaryScreen({
  view,
  selectedId,
  summary,
  summarySource,
  archetype,
  onSelect,
  onOpenInsights,
  onOpenMap,
}: Props) {
  const [hovered, setHovered] = useState<string | null>(null);
  /** Which group card is showing its members. One at a time; they overlap. */
  const [expanded, setExpanded] = useState<string | null>(null);
  const layout = useMemo(() => computeLayout(view), [view]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const scale = useFitScale(scrollRef, layout.width);

  const active = hovered ?? selectedId;

  // An empty diagram of doors is the worst thing this screen can show: it looks like
  // the analyzer failed on a project that simply has no doors. Say which it was.
  if (view.inputs.length === 0 && view.outputs.length === 0) {
    return <NoBoundary appName={view.appName} archetype={archetype} onOpenMap={onOpenMap} />;
  }

  return (
    <div className="boundary">
      <Headline view={view} onOpenInsights={onOpenInsights} />

      <div className="boundary-scroll" ref={scrollRef}>
        {/* The stage keeps its natural pixel geometry and is scaled as a whole; this
            wrapper reserves the scaled size so centring and scrolling stay honest. */}
        <div className="boundary-fit" style={{ width: layout.width * scale, height: layout.height * scale }}>
          <div
            className="boundary-stage"
            style={{ width: layout.width, height: layout.height, transform: `scale(${scale})` }}
          >
          <svg className="boundary-bands" width={layout.width} height={layout.height} aria-hidden="true">
            {layout.bands.map((band) => (
              <path
                key={band.id}
                d={band.d}
                className={`band band-${band.tone}${bandIsActive(band, active) ? ' is-lit' : active ? ' is-dim' : ''}`}
              />
            ))}
          </svg>

          {layout.captions.map((caption) => (
            <div key={caption.text} className="boundary-caption" style={boxStyle(caption.box)}>
              {caption.text}
            </div>
          ))}

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
              <Fragment key={card.id}>
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
                // A card that *is* a node opens it. A card standing for fourteen pages
                // used to open one of the fourteen, chosen by nothing — so it now opens
                // the list instead, and the reader picks (#30).
                onClick={() => (card.nodeId ? onSelect(card.nodeId) : setExpanded(expanded === card.id ? null : card.id))}
                // The label the assistive tree reads. Composed here rather than left to
                // the concatenation of four nested spans, which produced a run-on with
                // no pause between the name, the count and the warning.
                aria-label={cardLabel(card)}
                aria-expanded={card.nodeId ? undefined : expanded === card.id}
              >
                {/* Decoration only — the card's name says the same thing in words, and
                    without this a screen reader opens every card with "⇥" or "◉". */}
                <span className="bcard-glyph" aria-hidden="true">
                  {glyphFor(card.family)}
                </span>
                <span className="bcard-body">
                  <span className="bcard-name">{card.name}</span>
                  <span className="bcard-detail">{card.detail}</span>
                </span>
                {card.openCount ? (
                  <span className="bcard-warn" title={`${card.openCount} with no auth check found`}>
                    {card.openCount} open
                  </span>
                ) : null}
                {card.nodeId ? null : <span className="bcard-more" aria-hidden="true">▾</span>}
              </button>
              {expanded === card.id && card.members ? (
                <ul
                  className={`bcard-members bcard-members-${isInput ? 'in' : 'out'}`}
                  style={{ left: box.x, top: box.y + box.h + 6, width: box.w }}
                >
                  {card.members.map((member) => (
                    <li key={member.id}>
                      <button
                        className={`bmember${selectedId === member.id ? ' is-selected' : ''}`}
                        onClick={() => onSelect(member.id)}
                      >
                        {member.name}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
              </Fragment>
            );
          })}
          </div>
        </div>
      </div>

      {/* The paragraph SPEC.md 6.1 asks for: what goes in, what happens, what comes
          out, in prose, directly under the picture that shows the same thing. */}
      {summary ? (
        <section className="boundary-prose">
          <TrustLabel kind={summarySource === 'docs' ? 'docs' : 'ai'} />
          <p>{summary}</p>
        </section>
      ) : null}

      <p className="boundary-foot">
        Band thickness is the number of code paths. Everything here comes from the compiler — click any card to see
        the exact lines.
      </p>
    </div>
  );
}

/**
 * Shrinks the diagram to whatever pane it has been given.
 *
 * The layout is computed in fixed pixels because the geometry — column widths, band
 * curves — has to agree with itself. Fitting is therefore a display concern: measure
 * the pane, scale the finished picture. Never magnifies past its natural size, and
 * never shrinks past MIN_SCALE; past that the pane scrolls instead.
 */
function useFitScale(ref: React.RefObject<HTMLDivElement | null>, naturalWidth: number): number {
  const [scale, setScale] = useState(1);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || naturalWidth <= 0) return;

    const measure = () => {
      const available = el.clientWidth;
      if (available <= 0) return;
      const next = Math.min(1, Math.max(MIN_SCALE, available / naturalWidth));
      // Shrinking can retract the scrollbar, which widens the pane, which would ask
      // for a larger scale that brings the scrollbar back. Ignoring hairline changes
      // settles that loop instead of letting it flicker.
      setScale((current) => (Math.abs(current - next) > 0.005 ? next : current));
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    // The observer catches the pane changing under a still window — a side panel
    // opening. The window event is the belt to that braces: some embedded browsers
    // throttle observer delivery when the tab is not painting.
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [ref, naturalWidth]);

  return scale;
}

/**
 * What this screen says when the project has no boundary at all.
 *
 * The honest version of "nothing found" names what kind of project this is, shows the
 * signals that led there so a wrong verdict can be argued with, and sends the reader
 * to the view that does have their answer. A blank diagram would say none of that.
 */
function NoBoundary({
  appName,
  archetype,
  onOpenMap,
}: {
  appName: string;
  archetype: ArchetypeVerdict | null;
  onOpenMap: () => void;
}) {
  const kind = archetype?.archetype ?? 'unknown';
  return (
    <div className="page">
      <div className="overview-page">
        <div className="page-head">
          <h1>{appName} has no boundary to draw</h1>
        </div>
        <div className="overview-lede is-empty">
          <p>{EMPTY_BOUNDARY[kind]}</p>
        </div>
        {archetype && archetype.because.length > 0 ? (
          <p className="page-sub" style={{ marginTop: 18 }}>
            {archetype.label} — {archetype.because.join(' · ')}
          </p>
        ) : null}
        <p style={{ marginTop: 22 }}>
          <button className="pill" onClick={onOpenMap}>
            Open the Map instead →
          </button>
        </p>
      </div>
    </div>
  );
}

/**
 * One sentence per kind of project, saying what was concluded rather than what was
 * missing. Each one has to be true of a project with genuinely nothing on this screen.
 */
const EMPTY_BOUNDARY: Record<string, string> = {
  library:
    'This is code other code imports, and nothing in it is exported — so there is no public surface to draw and nothing outside can reach in. The Map shows what is here.',
  pipeline:
    'This is something you run rather than something that listens, so there are no doors for a stranger to knock on. What it reads and writes as it runs will appear here as more of that is detected.',
  service:
    'No inbound routes, outbound calls or data stores were found. If this project does have them, the analyzer may not recognise its framework yet — that is worth reporting.',
  'web-app':
    'No inbound routes, outbound calls or data stores were found. If this project does have them, the analyzer may not recognise its framework yet — that is worth reporting.',
  unknown:
    'Nothing in this project answers a URL, reads a database, or calls another company. That may be exactly right, or it may mean the analyzer does not recognise the framework in use — the Map shows what it did find.',
};

/**
 * The counts, in the vocabulary of the kind of project this is.
 *
 * "3 ways in · 0 services out · 0 data stores" is a true sentence about a library and
 * a useless one: it answers a question nobody asked and pads it with two zeroes. The
 * first number is the one the archetype renames; the rest drop out when they are zero,
 * which every project benefits from.
 */
function Headline({ view, onOpenInsights }: { view: BoundaryView; onOpenInsights: () => void }) {
  const { summary } = view;
  const parts = [inboundPhrase(view.archetype, summary.endpoints)];
  if (summary.externalServices > 0) {
    parts.push(`${summary.externalServices} ${summary.externalServices === 1 ? 'service' : 'services'} out`);
  }
  if (summary.stores > 0) {
    parts.push(`${summary.stores} ${summary.stores === 1 ? 'data store' : 'data stores'}`);
  }

  return (
    <div className="boundary-head">
      <h1>
        {parts.map((part, index) => (
          <span key={part}>
            {index > 0 ? <span className="sep">·</span> : null}
            {part}
          </span>
        ))}
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

function inboundPhrase(archetype: Archetype | undefined, count: number): string {
  switch (archetype) {
    case 'library':
      return `${count} ${count === 1 ? 'name' : 'names'} in its public API`;
    case 'pipeline':
      return `${count} ${count === 1 ? 'input' : 'inputs'}`;
    default:
      return `${count} ${count === 1 ? 'way' : 'ways'} in`;
  }
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
  /** Column headings, which are the one part of this picture the archetype changes. */
  captions: { text: string; box: Box }[];
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
  const height = contentH + PAD * 2 + CAPTION_H;

  // Everything below the caption row is centred in what is left, so adding the
  // captions moves the picture down rather than squashing it.
  const top = CAPTION_H;
  const centre = (columnH: number) => top + (height - top - columnH) / 2;

  stack(boxes, view.inputs.map((c) => c.id), xIn, COL_W, CARD_H, CARD_GAP, centre(inputsH));
  stack(boxes, view.outputs.map((c) => c.id), xOut, COL_W, CARD_H, CARD_GAP, centre(outputsH));

  const appBox: Box = { x: xApp, y: centre(appH), w: APP_W, h: appH };
  stack(
    boxes,
    view.zones.map((z) => `zone:${z.zone}`),
    xZone,
    APP_W - APP_PAD * 2,
    ZONE_H,
    ZONE_GAP,
    appBox.y + APP_HEAD,
  );

  const captions: Layout['captions'] = [
    { text: view.captions.inputs, box: { x: xIn, y: PAD / 2, w: COL_W, h: CAPTION_H } },
    { text: view.captions.app, box: { x: xApp, y: PAD / 2, w: APP_W, h: CAPTION_H } },
    { text: view.captions.outputs, box: { x: xOut, y: PAD / 2, w: COL_W, h: CAPTION_H } },
  ];

  return { width, height, boxes, appBox, captions, bands: computeBands(view, boxes) };
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

/**
 * What a screen reader announces for a card.
 *
 * The visible text is four nested spans, which the accessible-name calculation
 * concatenates into a run-on with no pause between the name, the count and the
 * warning — "API routes 12 routes 3 open" as one breath. Saying it in a sentence
 * costs nothing and is the only version anybody can act on.
 */
function cardLabel(card: BoundaryCard): string {
  const parts = [card.name, card.detail];
  if (card.openCount) parts.push(`${card.openCount} with no auth check found`);
  // The detail line already says how many; repeating it reads as two different counts.
  if (!card.nodeId && card.members) parts.push('opens the list');
  return parts.join('. ');
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
  screens: '▢',
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
