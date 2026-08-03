/**
 * @fileoverview The app shell and its five lenses.
 *
 * Each tab is one question about the same atlas — what gets in (SPEC.md 6.1), what
 * this app is, how the code is organized (6.2), what the data looks like (6.3), who
 * can get in (6.6) — and each says its question in a fixed strip under the tabs. They
 * share one detail panel, because whatever you click the question is the same: what
 * is this?
 *
 * Which one opens first is not fixed. A bare URL lands on the boundary view only when
 * there is a boundary to show; a project with none goes to the map instead, because
 * being dropped on an empty diagram reads as "this tool did not work". An explicit
 * `#hash` always wins over that.
 *
 * The rule this file exists to enforce: the canvas never receives the whole graph —
 * one level of the atlas is on screen at a time, with the connections between the
 * things on screen rolled up into single arrows.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  fetchAiStatus,
  fetchBoundaries,
  fetchInsights,
  fetchLevel,
  fetchNode,
  fetchOverview,
  fetchScopes,
  fetchTours,
  fetchTourFor,
  fetchTypes,
  onAtlasUpdated,
  setScope,
} from './api';
import { layoutLevel, layoutOutsideWorld, MEMBRANE_ID, sizeOf, type Positioned } from './layout';
import {
  ARROW_BUDGET,
  arrowStyle,
  budgetEdges,
  edgeLabel,
  filterLevel,
  LABEL_EVERYTHING_BELOW,
  type ShownLevel,
} from './mapview';
import type {
  AtlasNode,
  AtlasStats,
  BoundaryView,
  EdgeKind,
  InsightsView,
  LevelView,
  NodeView,
  OverviewView,
  ScopeInfo,
  Tour,
  TypeView,
  Zone,
} from './types';
import { AtlasNodeCard, MembraneNode, zoneLabel } from './components/AtlasNodeCard';
import { BoundaryScreen } from './components/BoundaryScreen';
import { DetailPanel } from './components/DetailPanel';
import { FolderTree } from './components/FolderTree';
import { InsightsScreen } from './components/InsightsScreen';
import { MapKey } from './components/MapKey';
import { OverviewScreen } from './components/OverviewScreen';
import { SearchPalette } from './components/SearchPalette';
import { TypeScreen } from './components/TypeScreen';
import { Walkthrough } from './components/Walkthrough';

const nodeTypes = { atlas: AtlasNodeCard, membrane: MembraneNode };

const ZONES: Zone[] = ['ui', 'api', 'logic', 'data', 'config', 'test'];

/**
 * Hidden when the Map first opens.
 *
 * Someone opening the Map is asking *what is my app*, and test code is not part of that
 * answer — it is part of how the app is checked. On this repo `test/fixtures` alone is
 * 175 files against 84 of source, so the default the other way round shows a picture of
 * the tests with the tool somewhere inside it.
 *
 * A map that quietly omits a sixth of the repo is the failure this project exists to
 * avoid, so the key says what it is holding back, with the count, at all times (#91).
 */
const HIDDEN_BY_DEFAULT: Zone[] = ['test'];

type ViewName = 'boundaries' | 'overview' | 'map' | 'types' | 'insights';

// Boundaries stays first: it is the home screen (SPEC.md 6.1) and the thing no other
// tool does. Overview sits beside it for the reader who wants prose before a diagram.
//
// "Data model" and not "Data": the word on its own was claimed three times over — the
// boundary view answers where data *goes*, the map's legend has a Data *zone*, and
// this tab is about the shapes data is *in*. Whoever wanted "the data one" had to
// guess.
const TABS: { view: ViewName; label: string }[] = [
  { view: 'boundaries', label: 'Boundaries' },
  { view: 'overview', label: 'Overview' },
  { view: 'map', label: 'Map' },
  { view: 'types', label: 'Data model' },
  { view: 'insights', label: 'Security' },
];

/**
 * The question each view exists to answer, stated on screen.
 *
 * Two of these views are a canvas of boxes joined by lines, which made them read as
 * variations on one picture rather than as different questions. A label alone did not
 * fix that — "Map" and "Data model" only mean something once you already know what
 * they contain — so every view now says its question in the same place, in the reader's
 * words rather than ours.
 *
 * The Map and the Data model needed more than that (#95). Both old sentences described
 * *structure*, which is true of both and therefore tells nobody which tab their question
 * belongs to. The distinction that does is sharper: **the Map is the code you change;
 * the Data model is the data you keep.** One is files you would open; the other is the
 * records that are still there after the process exits.
 */
const LEDES: Record<ViewName, string> = {
  boundaries: 'What gets into your app, and where it ends up.',
  overview: 'What this app is, and where to start reading.',
  map: 'The code you would open and edit — your real folders and files, and what uses what.',
  types: 'The data your app keeps — the shapes and tables that outlive a single run.',
  insights: 'Who can get in, where your data goes, and what you rely on.',
};

/**
 * The screen next door, named where the confusion happens.
 *
 * A lede that names the other screen does more work than another paragraph about this
 * one, because the reader's problem is never "what is on this screen" — they can see
 * that — it is "which of these two did I want".
 */
const NEIGHBOURS: Partial<Record<ViewName, { lead: string; view: ViewName; name: string }>> = {
  map: { lead: 'For the shapes this code puts data into, see the', view: 'types', name: 'Data model' },
  types: { lead: 'For the files that read and write them, see the', view: 'map', name: 'Map' },
};

export function App() {
  return (
    <ReactFlowProvider>
      <AtlasApp />
    </ReactFlowProvider>
  );
}

function AtlasApp() {
  const initial = useMemo(readHash, []);
  const [view, setView] = useState<ViewName>(initial.view);
  const [overview, setOverview] = useState<OverviewView | null>(null);
  const [boundaries, setBoundaries] = useState<BoundaryView | null>(null);
  const [insights, setInsights] = useState<InsightsView | null>(null);
  const [types, setTypes] = useState<TypeView | null>(null);
  const [tours, setTours] = useState<Tour[]>([]);
  /** Walkthroughs fetched because the reader opened the thing they explain. */
  const [fetchedTours, setFetchedTours] = useState<Tour[]>([]);
  const [panelTourId, setPanelTourId] = useState<string | null>(null);
  const [tourId, setTourId] = useState<string | null>(null);
  const [stepIndex, setStepIndex] = useState(0);
  const [levelId, setLevelId] = useState<string | null>(initial.levelId);
  const [level, setLevel] = useState<LevelView | null>(null);
  /** The level after the zone filter — what is actually on the canvas. */
  const [shown, setShown] = useState<ShownLevel | null>(null);
  const [positions, setPositions] = useState<Map<string, Positioned>>(new Map());
  const [hiddenZones, setHiddenZones] = useState<Set<Zone>>(() => new Set(HIDDEN_BY_DEFAULT));
  const [showAllArrows, setShowAllArrows] = useState(false);
  const [treeOpen, setTreeOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<NodeView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [aiEnabled, setAiEnabled] = useState(false);
  const [revision, setRevision] = useState(0);
  const [justUpdated, setJustUpdated] = useState(false);
  const [scopes, setScopes] = useState<ScopeInfo[]>([]);
  const [scopeId, setScopeId] = useState('');
  const { fitView } = useReactFlow();

  // Latches the moment the landing view is settled, one way or the other. Without it,
  // a watch-mode rebuild — which reloads the overview — would yank someone back to the
  // home view mid-read, and switching app in a monorepo would too.
  const landed = useRef(initial.asked);

  // The URL bar is an input too: pasting a different #view, or the browser's own
  // back/forward, should move the atlas without needing a reload. Our own writes
  // use replaceState, which never fires this event, so there is no loop to guard.
  useEffect(() => {
    const onHashChange = () => {
      const next = readHash();
      setView(next.view);
      if (next.view === 'map' && next.levelId) setLevelId(next.levelId);
      setSelectedId(null);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  // --- which apps there are, in a monorepo ---
  // Asked once, before anything else, because every other request is about one of them.
  useEffect(() => {
    fetchScopes()
      .then((list) => {
        setScopes(list);
        // The server already defaults to the first app, so naming it here costs no
        // extra request — it just stops the switcher showing one app while the page
        // is quietly displaying it under a different name.
        if (list.length > 0) {
          setScope(list[0].id);
          setScopeId(list[0].id);
        }
      })
      .catch(() => setScopes([]));
  }, []);

  /**
   * Switching app is closer to opening a different project than to changing a filter,
   * so everything loaded for the last one is dropped and the map starts at its top
   * level again. Keeping the old breadcrumb would point at folders that do not exist.
   */
  const chooseScope = useCallback((id: string) => {
    setScope(id);
    setScopeId(id);
    setOverview(null);
    setBoundaries(null);
    setInsights(null);
    setTypes(null);
    setLevel(null);
    setLevelId(null);
    setSelectedId(null);
    setTourId(null);
    setLoading(true);
    setRevision((n) => n + 1);
  }, []);

  // --- load the atlas ---
  useEffect(() => {
    Promise.all([fetchOverview(), fetchBoundaries()])
      .then(([overviewData, boundaryData]) => {
        setOverview(overviewData);
        setBoundaries(boundaryData);
        setLevelId((current) => current ?? overviewData.rootId);
        // What kind of project this is decides where a bare URL lands. It cannot be
        // decided any earlier: the archetype is derived from the doors the analyzer
        // found, and this is the request that carries them.
        if (!landed.current) {
          landed.current = true;
          const home = homeViewFor(overviewData.meta.stats);
          if (home !== 'boundaries') {
            setView(home);
            writeHash(home, null);
          }
        }
        setLoading(false);
      })
      .catch((err: Error) => {
        setError(err.message);
        setLoading(false);
      });

    // Whether explain-on-click is offered at all. A failure here just means no button.
    fetchAiStatus()
      .then((status) => setAiEnabled(status.enabled))
      .catch(() => setAiEnabled(false));

    // Tours are pure graph traversal — no model, no cost — so they load with everything
    // else and the offer to walk someone through the app is there from the first screen.
    fetchTours()
      .then(setTours)
      .catch(() => setTours([]));
  }, [revision]);

  // --- follow the code while --watch is running ---
  // Everything already loaded is thrown away rather than merged: the atlas on the
  // server is the truth, and a half-refreshed screen is worse than a second of
  // loading. The view someone is on, and where they had drilled to, are kept.
  useEffect(
    () =>
      onAtlasUpdated(() => {
        setInsights(null);
        setTypes(null);
        setRevision((n) => n + 1);
        setJustUpdated(true);
      }),
    [],
  );

  useEffect(() => {
    if (!justUpdated) return;
    const timer = window.setTimeout(() => setJustUpdated(false), 2600);
    return () => window.clearTimeout(timer);
  }, [justUpdated]);

  // Security facts and the shape of the data are only needed once someone asks.
  useEffect(() => {
    if (view !== 'insights' || insights) return;
    fetchInsights()
      .then(setInsights)
      .catch((err: Error) => setError(err.message));
  }, [view, insights]);

  useEffect(() => {
    if (view !== 'types' || types) return;
    fetchTypes()
      .then(setTypes)
      .catch((err: Error) => setError(err.message));
  }, [view, types]);

  // --- load the current level ---
  useEffect(() => {
    if (view !== 'map' || !levelId) return;
    let cancelled = false;
    setLoading(true);
    fetchLevel(levelId)
      .then((data) => {
        if (!cancelled) setLevel(data);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        // A hash pointing at a level that no longer exists shouldn't be fatal.
        if (overview && levelId !== overview.rootId) {
          setLevelId(overview.rootId);
          return;
        }
        setError(err.message);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [view, levelId, overview, revision]);

  // --- filter it, then lay out what is left ---
  // Separate from the fetch because the filter changes without the level doing so, and
  // elk has to run again when it does: hiding the tests removes boxes, and the arrows
  // that ended in them go too. What is drawn and where it sits are set together, so the
  // canvas can never be handed a node list its positions do not cover.
  useEffect(() => {
    if (view !== 'map' || !level) return;
    let cancelled = false;
    const next = filterLevel(level, hiddenZones);
    setLoading(true);
    layoutLevel(next.nodes, next.edges)
      .then((laid) => {
        if (cancelled) return;
        setShown(next);
        setPositions(layoutOutsideWorld(laid, next.outside));
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [view, level, hiddenZones]);

  // --- load detail for the selection ---
  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    fetchNode(selectedId)
      .then((data) => {
        if (!cancelled) setDetail(data);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [selectedId, revision]);

  // --- and the walkthrough for it, if there is one ---
  // Asked per selection rather than shipped with the rest: a repo with 760 doors has
  // 760 walkthroughs, and the reader wants the one they just opened.
  useEffect(() => {
    if (!selectedId) {
      setPanelTourId(null);
      return;
    }
    let cancelled = false;
    fetchTourFor(selectedId)
      .then((found) => {
        if (cancelled) return;
        setPanelTourId(found?.id ?? null);
        if (found) setFetchedTours((existing) => (existing.some((one) => one.id === found.id) ? existing : [...existing, found]));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [selectedId, revision]);

  // --- frame each level as soon as it is laid out ---
  // Not gated on React Flow's own "nodes measured" signal: these nodes carry explicit
  // width/height from elk, and React Flow never reports pre-sized nodes as measured,
  // so that signal simply never fires. Our own state is the reliable one — positions
  // arrive together with the level. The first call runs a frame after the nodes
  // render; the delayed one covers React Flow syncing its store just after that.
  useEffect(() => {
    if (view !== 'map' || !shown || positions.size === 0) return;
    const options = { padding: 0.2, maxZoom: 1 };
    const frame = requestAnimationFrame(() => void fitView(options));
    const timer = window.setTimeout(() => void fitView({ ...options, duration: 250 }), 150);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [view, shown, positions, fitView]);

  const go = useCallback((next: ViewName, id?: string | null) => {
    setView(next);
    if (next === 'map' && id) setLevelId(id);
    writeHash(next, next === 'map' ? (id ?? null) : null);
  }, []);

  const drill = useCallback(
    (id: string) => {
      setLevelId(id);
      setSelectedId(null);
      setView('map');
      writeHash('map', id);
    },
    [],
  );

  const goUp = useCallback(() => {
    const crumbs = level?.breadcrumb ?? [];
    const parent = crumbs[crumbs.length - 2];
    if (parent) drill(parent.id);
  }, [level, drill]);

  /** Select without moving: what the boundary and security screens want. */
  const select = useCallback((id: string) => {
    if (id) setSelectedId(id);
  }, []);

  /**
   * The same shape, seen on the other screen made of boxes and lines.
   *
   * The pair is what confused the reader in #95, and the cure is being able to follow
   * the link rather than being told about it: a type on the Map is a card on the Data
   * model, and the file that declares it is a box back on the Map.
   */
  const showInDataModel = useCallback((id: string) => {
    setView('types');
    setSelectedId(id);
    writeHash('types', null);
  }, []);

  const toggleZone = useCallback((zone: Zone) => {
    setHiddenZones((hidden) => {
      const next = new Set(hidden);
      if (next.has(zone)) next.delete(zone);
      else next.add(zone);
      return next;
    });
  }, []);

  // --- guided tours (SPEC.md 6.4) ---

  // The five offered on the overview, plus every one fetched because somebody opened
  // the thing it explains. A tour fetched that way has to stay in the list: losing it
  // when the selection changes would end the walk the reader is in the middle of.
  const everyTour = useMemo(() => {
    const byId = new Map(tours.map((one) => [one.id, one]));
    for (const one of fetchedTours) if (!byId.has(one.id)) byId.set(one.id, one);
    return byId;
  }, [tours, fetchedTours]);

  const tour = useMemo(() => (tourId ? (everyTour.get(tourId) ?? null) : null), [everyTour, tourId]);
  const step = tour?.steps[stepIndex] ?? null;

  /** Put the map where the current step is talking about. */
  const showStep = useCallback(
    (target: Tour, next: number) => {
      const at = target.steps[next];
      if (!at) return;
      setView('map');
      if (at.levelId) setLevelId(at.levelId);
      // The panel would cover the drawer and answer a question nobody asked yet.
      setSelectedId(null);
      writeHash('map', at.levelId ?? null);
    },
    [],
  );

  const startTour = useCallback(
    (id: string) => {
      const target = everyTour.get(id);
      if (!target) return;
      setTourId(id);
      setStepIndex(0);
      showStep(target, 0);
    },
    [everyTour, showStep],
  );

  const goToStep = useCallback(
    (next: number) => {
      if (!tour || next < 0 || next >= tour.steps.length) return;
      setStepIndex(next);
      showStep(tour, next);
    },
    [tour, showStep],
  );

  /** Everything the current step wants lit. Overrides the click-neighbours highlight. */
  const tourFocus = useMemo(() => (step ? new Set(step.focusIds) : null), [step]);

  /** Bring a node into view on the map, changing level first if it lives elsewhere. */
  const reveal = useCallback(
    async (id: string) => {
      try {
        const data = await fetchNode(id);
        const parent = data.breadcrumb[data.breadcrumb.length - 2];
        setView('map');
        if (parent) {
          setLevelId(parent.id);
          writeHash('map', parent.id);
        }
        setSelectedId(id);
      } catch {
        /* the node may have vanished between analyses */
      }
    },
    [],
  );

  // --- keyboard ---
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setSearchOpen(true);
        return;
      }
      if (event.key === 'Escape') {
        if (searchOpen) setSearchOpen(false);
        else if (selectedId) setSelectedId(null);
        // Ending the tour is the last thing Escape does, so a detour mid-tour costs
        // one press and not the whole walkthrough.
        else if (tourId) setTourId(null);
        return;
      }
      const typing = (event.target as HTMLElement | null)?.tagName === 'INPUT';
      if (!typing && view === 'map' && (event.key === 'Backspace' || (event.altKey && event.key === 'ArrowLeft'))) {
        event.preventDefault();
        goUp();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goUp, searchOpen, selectedId, tourId, view]);

  /** The selection plus everything one hop away from it. */
  const neighborIds = useMemo(() => {
    if (!shown || !selectedId) return null;
    const ids = new Set<string>([selectedId]);
    for (const edge of shown.edges) {
      if (edge.fromId === selectedId) ids.add(edge.toId);
      if (edge.toId === selectedId) ids.add(edge.fromId);
    }
    return ids;
  }, [shown, selectedId]);

  // A click during a tour wins: following your own thread is the point of being
  // allowed to detour, and "Show me again" puts the step's highlight back.
  const litIds = neighborIds ?? tourFocus;

  const rfNodes: Node[] = useMemo(() => {
    if (!shown) return [];
    const cards: Node[] = shown.nodes.map((node) => {
      const placed = positions.get(node.id);
      const fallback = sizeOf(node);
      return {
        id: node.id,
        type: 'atlas',
        position: { x: placed?.x ?? 0, y: placed?.y ?? 0 },
        data: {
          node,
          dim: litIds ? !litIds.has(node.id) : false,
          focus: node.id === selectedId,
          onDrill: drill,
        },
        selected: node.id === selectedId,
        // elk already sized every card, so tell React Flow the dimensions instead of
        // letting it measure: no hidden-until-measured flash, and edges can route
        // on the first frame.
        width: placed?.width ?? fallback.width,
        height: placed?.height ?? fallback.height,
      } satisfies Node;
    });

    // The outside world: a dashed membrane past the rightmost card, then a ghost
    // card per store/service/endpoint this level talks to. Ghosts keep their real
    // atlas ids, so clicking one opens the same detail panel as the real thing.
    const membrane = positions.get(MEMBRANE_ID);
    if (shown.outside.length > 0 && membrane) {
      cards.push({
        id: MEMBRANE_ID,
        type: 'membrane',
        position: { x: membrane.x, y: membrane.y },
        data: {},
        width: membrane.width,
        height: membrane.height,
        selectable: false,
        draggable: false,
        focusable: false,
      } satisfies Node);

      for (const neighbor of shown.outside) {
        const placed = positions.get(neighbor.node.id);
        if (!placed) continue;
        cards.push({
          id: neighbor.node.id,
          type: 'atlas',
          position: { x: placed.x, y: placed.y },
          data: {
            node: { ...neighbor.node, childCount: 0, drillable: false, outsideIn: 0, outsideOut: 0, preview: [] },
            dim: litIds ? !litIds.has(neighbor.node.id) : false,
            focus: neighbor.node.id === selectedId,
            ghost: true,
            onDrill: drill,
          },
          selected: neighbor.node.id === selectedId,
          width: placed.width,
          height: placed.height,
        } satisfies Node);
      }
    }
    return cards;
  }, [shown, positions, litIds, selectedId, drill]);

  /** The arrows the budget lets through — every one of them when there are few. */
  const arrows = useMemo(
    () => (shown ? budgetEdges(shown.edges, selectedId, showAllArrows) : []),
    [shown, selectedId, showAllArrows],
  );

  const rfEdges: Edge[] = useMemo(() => {
    if (!shown) return [];
    // A level small enough to read gets every label without being asked. Above that they
    // arrive on click, because a hundred of them is not a legible picture either.
    const labelAll = arrows.length <= LABEL_EVERYTHING_BELOW;

    /** One arrow, styled and pointed by what it actually stands for (#90). */
    const draw = (
      id: string,
      fromId: string,
      toId: string,
      weight: number,
      kinds: EdgeKind[] | undefined,
      lit: boolean,
      dashed: boolean,
    ): Edge => {
      const arrow = arrowStyle(kinds);
      const colour = lit ? arrow.strokeLit : arrow.stroke;
      const opacity = selectedId ? (lit ? 0.95 : 0.06) : dashed ? 0.45 : 0.32;
      const width = Math.min(5, 1 + Math.log2(weight + 1));
      const head = { type: MarkerType.ArrowClosed, width: 14, height: 14, color: colour };
      return {
        id,
        source: fromId,
        target: toId,
        label: lit || labelAll ? edgeLabel(kinds, weight) : undefined,
        labelBgStyle: { fill: '#f4f1e9' },
        labelStyle: { fontSize: 11, fill: '#5f594b' },
        style: {
          stroke: colour,
          strokeWidth: lit ? Math.max(1.6, width) : width,
          ...(dashed ? { strokeDasharray: '7 5' } : {}),
          opacity,
        },
        // The head sits at the end the data arrives at, which for a read is the code.
        // React Flow's marker is defined `auto-start-reverse`, so a start marker points
        // back down the line rather than along it.
        ...(arrow.head === 'start' || arrow.head === 'both' ? { markerStart: head } : {}),
        ...(arrow.head === 'end' || arrow.head === 'both' ? { markerEnd: head } : {}),
      } satisfies Edge;
    };

    const drawn: Edge[] = arrows.map((edge) =>
      draw(
        edge.id,
        edge.fromId,
        edge.toId,
        edge.weight,
        edge.kinds,
        selectedId === edge.fromId || selectedId === edge.toId,
        false,
      ),
    );

    // Flows across the membrane. Dashed where the internal edges are solid: the
    // difference between "these two files talk" and "this one leaves the building".
    for (const neighbor of shown.outside) {
      for (const flow of neighbor.flows) {
        drawn.push(
          draw(
            `membrane:${flow.out ? 'out' : 'in'}:${flow.insideId}->${neighbor.node.id}`,
            flow.out ? flow.insideId : neighbor.node.id,
            flow.out ? neighbor.node.id : flow.insideId,
            flow.weight,
            flow.kinds,
            selectedId === flow.insideId || selectedId === neighbor.node.id,
            true,
          ),
        );
      }
    }
    return drawn;
  }, [shown, arrows, selectedId]);

  if (error) {
    return (
      <div className="fatal">
        <h1>App Atlas couldn't load the map</h1>
        <p>{error}</p>
        <p className="muted">Is the analyzer still running? Try reloading in a moment.</p>
      </div>
    );
  }

  const crumbs = level?.breadcrumb ?? [];
  const quiet = quietViews(overview?.meta.stats);
  const neighbour = NEIGHBOURS[view];
  const legendZones = zonesPresent(overview, shown);

  // The overview page already answers "what is this app?" at full width. Showing the
  // same numbers again in the side panel is just the page twice.
  const showPanel = Boolean(detail) || view !== 'overview';

  return (
    <div className={showPanel ? 'app' : 'app is-wide'}>
      <header className="topbar">
        <span className="brand">
          <span className="brand-mark" aria-hidden="true">✦</span>
          App Atlas
        </span>
        <nav className="tabs" aria-label="Views">
          {TABS.map((tab) => (
            <button
              key={tab.view}
              className={[
                'tab',
                tab.view === view ? 'is-current' : '',
                quiet.has(tab.view) && tab.view !== view ? 'is-quiet' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              title={quiet.has(tab.view) ? `${LEDES[tab.view]} Nothing found in this project.` : LEDES[tab.view]}
              onClick={() => go(tab.view, levelId)}
            >
              {tab.label}
            </button>
          ))}
        </nav>

        {scopes.length > 1 ? (
          <label className="scope-picker">
            <span className="scope-label">App</span>
            <select
              value={scopeId}
              onChange={(event) => chooseScope(event.target.value)}
              aria-label="Which app in this workspace"
            >
              {scopes.map((scope) => (
                <option key={scope.id} value={scope.id}>
                  {scope.name}
                  {scope.kind === 'library' ? ' (shared)' : ''}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        <span className="topbar-title">{overview?.meta.name ?? ''}</span>

        <div className="topbar-right">
          {justUpdated ? <span className="live-badge">code changed · updated</span> : null}
          {/* The count describes the canvas, so it moves with the filter and says it is
              moving. A number that stayed at 238 while 6 boxes were held back would be
              the one thing #91 said was not available: silently disagreeing with the
              picture beside it. */}
          {view === 'map' && level && level.totalChildren > 0 ? (
            <span className="topbar-count" title={itemCountTitle(level, shown)}>
              {shown && shown.hiddenTotal > 0
                ? `${shown.nodes.length} of ${level.totalChildren} items`
                : `${level.totalChildren} ${level.totalChildren === 1 ? 'item' : 'items'}`}
              {level.truncated ? ' (showing first 400)' : ''}
            </span>
          ) : null}
          <button className="btn-ghost" onClick={() => setSearchOpen(true)}>
            Search <kbd>Ctrl</kbd>
            <kbd>K</kbd>
          </button>
        </div>
      </header>

      <p className="view-lede">
        {LEDES[view]}
        {neighbour ? (
          <span className="lede-neighbour">
            {' '}
            {neighbour.lead}{' '}
            <button className="lede-link" onClick={() => go(neighbour.view, levelId)}>
              {neighbour.name}
            </button>
            .
          </span>
        ) : null}
      </p>

      <main className={view === 'map' ? 'canvas' : 'canvas canvas-page'}>
        {view === 'boundaries' ? (
          boundaries ? (
            <BoundaryScreen
              view={boundaries}
              selectedId={selectedId}
              summary={overview?.app?.summary ?? null}
              summarySource={overview?.app?.summarySource ?? null}
              archetype={overview?.meta.archetype ?? null}
              onSelect={select}
              onOpenInsights={() => go('insights')}
              onOpenMap={() => go('map', levelId)}
            />
          ) : (
            <div className="loading">Reading the boundaries…</div>
          )
        ) : null}

        {view === 'overview' ? (
          overview ? (
            <OverviewScreen
              view={overview}
              tours={tours}
              onDrill={drill}
              onReveal={reveal}
              onStartTour={startTour}
              onOpenBoundaries={() => go('boundaries')}
            />
          ) : (
            <div className="loading">Reading your app…</div>
          )
        ) : null}

        {view === 'types' ? (
          types ? (
            <TypeScreen view={types} selectedId={selectedId} onSelect={select} />
          ) : (
            <div className="loading">Reading the shape of your data…</div>
          )
        ) : null}

        {view === 'insights' ? (
          insights ? (
            <InsightsScreen insights={insights} onReveal={select} />
          ) : (
            <div className="loading">Checking every door…</div>
          )
        ) : null}

        {view === 'map' ? (
          <>
            {/* The path you drilled, drawn on the map it describes. It used to live in
                the top chrome, where it read as decoration and nobody found it — where
                you are belongs on the picture, not in the corner of the frame. */}
            <div className="map-topline">
              {crumbs.length > 0 ? (
                <nav className="map-crumbs" aria-label="Where you are in the map">
                  {crumbs.map((crumb: AtlasNode, index) => (
                    <span key={crumb.id}>
                      {index > 0 ? <span className="crumb-sep">›</span> : null}
                      <button
                        className={index === crumbs.length - 1 ? 'crumb is-current' : 'crumb'}
                        // The real name, never the generated one: a breadcrumb is an
                        // address, and an address you cannot search for is not one (#94).
                        onClick={() => drill(crumb.id)}
                      >
                        {crumb.name}
                      </button>
                    </span>
                  ))}
                </nav>
              ) : null}
              {/* The other half of "I think we kind of need both" (#94): the grouped,
                  named boxes answer what the parts are; this answers where they are. */}
              <button
                className={treeOpen ? 'map-tree-toggle is-on' : 'map-tree-toggle'}
                onClick={() => setTreeOpen((open) => !open)}
                aria-pressed={treeOpen}
              >
                {treeOpen ? 'Hide folders' : 'Folders'}
              </button>
            </div>
            {loading ? <div className="loading">Drawing the map…</div> : null}
            {!loading && shown && shown.nodes.length === 0 ? (
              <div className="loading">
                {shown.hiddenTotal > 0
                  ? `Everything here is hidden by the filter — ${shown.hiddenTotal} ${
                      shown.hiddenTotal === 1 ? 'box' : 'boxes'
                    }.`
                  : 'Nothing inside this one.'}
              </div>
            ) : null}

            {treeOpen && overview ? (
              <FolderTree
                // Keyed on the revision so a watch-mode rebuild reloads the tree
                // instead of leaving folders that no longer exist on screen.
                key={revision}
                rootId={overview.rootId}
                levelId={levelId}
                onDrill={drill}
                onReveal={reveal}
                onClose={() => setTreeOpen(false)}
              />
            ) : null}

            <ReactFlow
              nodes={rfNodes}
              edges={rfEdges}
              nodeTypes={nodeTypes}
              nodesDraggable={false}
              nodesConnectable={false}
              elementsSelectable
              // In this app a double-click means "go inside", so it must not also zoom —
              // and d3-zoom's own dblclick handler would otherwise swallow the event.
              zoomOnDoubleClick={false}
              proOptions={{ hideAttribution: false }}
              minZoom={0.05}
              maxZoom={2.5}
              onNodeClick={(_, node) => setSelectedId(node.id)}
              onNodeDoubleClick={(_, node) => {
                const data = node.data as { node: { drillable: boolean } };
                if (data.node.drillable) drill(node.id);
              }}
              onPaneClick={() => setSelectedId(null)}
            >
              <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="#d9d2bf" />
              <Controls showInteractive={false} />
              <MiniMap
                pannable
                zoomable
                nodeColor={(node) =>
                  zoneColor(((node.data as { node?: { zone?: Zone } }).node?.zone ?? 'unknown') as Zone)
                }
                maskColor="rgba(244,241,233,0.78)"
              />
            </ReactFlow>

            <MapKey
              zones={legendZones}
              hiddenZones={hiddenZones}
              hidden={shown?.hidden ?? []}
              onToggleZone={toggleZone}
              arrowsShown={arrows.length}
              arrowsTotal={shown?.edges.length ?? 0}
              showAllArrows={showAllArrows}
              onToggleArrows={() => setShowAllArrows((all) => !all)}
            />

            <div className="hint">
              Click to inspect · Press › or double-click to look inside · Backspace to go back
            </div>
          </>
        ) : null}

        {/* Anchored inside the canvas, not the window: the drawer belongs to the map it
            is narrating and must never lie across the detail panel. */}
        {tour ? (
          <Walkthrough
            tour={tour}
            index={stepIndex}
            onStep={goToStep}
            onShowAgain={() => showStep(tour, stepIndex)}
            onClose={() => setTourId(null)}
          />
        ) : null}
      </main>

      {showPanel ? (
        <DetailPanel
          detail={detail}
          overview={overview}
          view={view}
          aiEnabled={aiEnabled}
          tour={panelTourId ? (everyTour.get(panelTourId) ?? null) : null}
          onReveal={reveal}
          onDrill={drill}
          onStartTour={startTour}
          onShowInDataModel={showInDataModel}
          onClose={() => setSelectedId(null)}
        />
      ) : null}

      <SearchPalette open={searchOpen} onClose={() => setSearchOpen(false)} onPick={reveal} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// The URL is the address of a place in the atlas, so links to one keep working.
// ---------------------------------------------------------------------------

/**
 * `asked` separates "someone opened #boundaries" from "someone opened the app". Only
 * the second one may be overruled by the archetype, because a link to a view is a
 * request and a bare URL is not.
 */
function readHash(): { view: ViewName; levelId: string | null; asked: boolean } {
  const raw = decodeURIComponent(window.location.hash.replace(/^#/, ''));
  if (!raw) return { view: 'boundaries', levelId: null, asked: false };
  if (raw === 'boundaries') return { view: 'boundaries', levelId: null, asked: true };
  if (raw === 'overview') return { view: 'overview', levelId: null, asked: true };
  // The hash stayed `types` when the tab became "Data model": links in exported
  // ATLAS.md files and anything anyone has shared still point here.
  if (raw === 'types') return { view: 'types', levelId: null, asked: true };
  if (raw === 'insights') return { view: 'insights', levelId: null, asked: true };
  if (raw === 'map') return { view: 'map', levelId: null, asked: true };
  if (raw.startsWith('map/')) return { view: 'map', levelId: raw.slice(4), asked: true };
  // Links made by M1 were a bare node id and still mean "show me this on the map".
  return { view: 'map', levelId: raw, asked: true };
}

/**
 * Where a bare URL lands.
 *
 * The question is not "which archetype is this" but "is there a boundary worth
 * showing" — and it is asked with the very predicate that dims the tab, so the landing
 * page and the tab bar can never disagree. The archetype has already done its work by
 * this point: it decided what counts as a door, which is why a library with exports
 * has a boundary at all, and that boundary is the most interesting thing about it.
 *
 * A project with nothing on that screen goes to the Map instead. Being dropped on an
 * empty diagram reads as "this tool did not work", which is the whole reason any of
 * this exists.
 */
function homeViewFor(stats: AtlasStats | undefined): ViewName {
  return quietViews(stats).has('boundaries') ? 'map' : 'boundaries';
}

/**
 * Tabs whose view has nothing in it for this project.
 *
 * Read off the counts rather than off the archetype on purpose: a misclassified
 * project still gets an honest tab bar this way, and the two facts stay independent —
 * the archetype decides where you land, the counts decide what is worth shouting
 * about. Nothing is ever hidden. "You have no doors" is a useful answer; it just
 * should not be the loudest thing on screen for a project that was never going to
 * have any.
 */
function quietViews(stats: AtlasStats | undefined): Set<ViewName> {
  const quiet = new Set<ViewName>();
  if (!stats) return quiet;
  if (stats.endpoints === 0 && stats.services === 0 && stats.stores === 0) quiet.add('boundaries');
  if (stats.routes === 0 && stats.externalServices === 0 && stats.envVars === 0) quiet.add('insights');
  if (stats.types === 0) quiet.add('types');
  return quiet;
}

/**
 * The zones this project actually has, in the fixed order the colour language uses.
 *
 * The old legend printed all six whether or not the repo had any of them, so a project
 * with no `api` zone still got an API dot — inviting the reader to go looking for
 * something that is not there. Counted app-wide rather than per level, because the key
 * describes the colours of the whole map; the union with what is on screen covers the
 * kinds of node that are not files and so are not in the file census.
 */
function zonesPresent(overview: OverviewView | null, shown: ShownLevel | null): Zone[] {
  const present = new Set<Zone>();
  for (const [zone, count] of Object.entries(overview?.zoneCounts ?? {})) {
    if (count > 0) present.add(zone as Zone);
  }
  for (const node of shown?.nodes ?? []) present.add(node.zone);
  for (const entry of shown?.hidden ?? []) present.add(entry.zone);
  return ZONES.filter((zone) => present.has(zone));
}

/** What the item count means when a filter is on, spelled out rather than implied. */
function itemCountTitle(level: LevelView, shown: ShownLevel | null): string {
  if (!shown || shown.hiddenTotal === 0) return `Everything at this level of the map`;
  const parts = shown.hidden.map((entry) => `${entry.count} ${zoneLabel(entry.zone).toLowerCase()}`);
  return `${shown.nodes.length} of ${level.totalChildren} boxes are drawn — the filter is holding back ${parts.join(', ')}.`;
}

function writeHash(view: ViewName, levelId: string | null): void {
  const hash = view === 'map' && levelId ? `map/${encodeURIComponent(levelId)}` : view;
  window.history.replaceState(null, '', `#${hash}`);
}

function zoneColor(zone: Zone): string {
  switch (zone) {
    case 'ui':
      return '#6a55c4';
    case 'api':
      return '#2d7ea3';
    case 'logic':
      return '#c4881c';
    case 'data':
      return '#37845a';
    case 'config':
      return '#857c68';
    case 'test':
      return '#b04f7c';
    default:
      return '#a49c8a';
  }
}
