/**
 * @fileoverview The app shell and its three lenses.
 *
 * The boundary view is the home screen (SPEC.md 6.1): what comes in, what your app is
 * made of, where data goes. The architecture map (6.2) is the drill-down, and the
 * security page (6.6) is the list of answers the map implies. All three share one
 * detail panel, because whatever you click the question is the same: what is this?
 *
 * The rule this file exists to enforce: the canvas never receives the whole graph —
 * one level of the atlas is on screen at a time, with the connections between the
 * things on screen rolled up into single arrows.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
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
  fetchTypes,
  onAtlasUpdated,
  setScope,
} from './api';
import { layoutLevel, sizeOf, type Positioned } from './layout';
import type {
  AtlasNode,
  BoundaryView,
  InsightsView,
  LevelView,
  NodeView,
  OverviewView,
  ScopeInfo,
  Tour,
  TypeView,
  Zone,
} from './types';
import { AtlasNodeCard, zoneLabel } from './components/AtlasNodeCard';
import { BoundaryScreen } from './components/BoundaryScreen';
import { DetailPanel } from './components/DetailPanel';
import { InsightsScreen } from './components/InsightsScreen';
import { OverviewScreen } from './components/OverviewScreen';
import { SearchPalette } from './components/SearchPalette';
import { TypeScreen } from './components/TypeScreen';
import { Walkthrough } from './components/Walkthrough';

const nodeTypes = { atlas: AtlasNodeCard };

const ZONES: Zone[] = ['ui', 'api', 'logic', 'data', 'config', 'test'];

type ViewName = 'boundaries' | 'overview' | 'map' | 'types' | 'insights';

// Boundaries stays first: it is the home screen (SPEC.md 6.1) and the thing no other
// tool does. Overview sits beside it for the reader who wants prose before a diagram.
const TABS: { view: ViewName; label: string }[] = [
  { view: 'boundaries', label: 'Boundaries' },
  { view: 'overview', label: 'Overview' },
  { view: 'map', label: 'Map' },
  { view: 'types', label: 'Data' },
  { view: 'insights', label: 'Security' },
];

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
  const [tourId, setTourId] = useState<string | null>(null);
  const [stepIndex, setStepIndex] = useState(0);
  const [levelId, setLevelId] = useState<string | null>(initial.levelId);
  const [level, setLevel] = useState<LevelView | null>(null);
  const [positions, setPositions] = useState<Map<string, Positioned>>(new Map());
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

  // --- load and lay out the current level ---
  useEffect(() => {
    if (view !== 'map' || !levelId) return;
    let cancelled = false;
    setLoading(true);
    fetchLevel(levelId)
      .then(async (data) => {
        const laid = await layoutLevel(data.nodes, data.edges);
        if (cancelled) return;
        setLevel(data);
        setPositions(laid);
        setLoading(false);
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

  // --- frame each level as soon as it is laid out ---
  // Not gated on React Flow's own "nodes measured" signal: these nodes carry explicit
  // width/height from elk, and React Flow never reports pre-sized nodes as measured,
  // so that signal simply never fires. Our own state is the reliable one — positions
  // arrive together with the level. The first call runs a frame after the nodes
  // render; the delayed one covers React Flow syncing its store just after that.
  useEffect(() => {
    if (view !== 'map' || !level || positions.size === 0) return;
    const options = { padding: 0.2, maxZoom: 1 };
    const frame = requestAnimationFrame(() => void fitView(options));
    const timer = window.setTimeout(() => void fitView({ ...options, duration: 250 }), 150);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [view, level, positions, fitView]);

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

  // --- guided tours (SPEC.md 6.4) ---

  const tour = useMemo(() => tours.find((one) => one.id === tourId) ?? null, [tours, tourId]);
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
      const target = tours.find((one) => one.id === id);
      if (!target) return;
      setTourId(id);
      setStepIndex(0);
      showStep(target, 0);
    },
    [tours, showStep],
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
    if (!level || !selectedId) return null;
    const ids = new Set<string>([selectedId]);
    for (const edge of level.edges) {
      if (edge.fromId === selectedId) ids.add(edge.toId);
      if (edge.toId === selectedId) ids.add(edge.fromId);
    }
    return ids;
  }, [level, selectedId]);

  // A click during a tour wins: following your own thread is the point of being
  // allowed to detour, and "Show me again" puts the step's highlight back.
  const litIds = neighborIds ?? tourFocus;

  const rfNodes: Node[] = useMemo(() => {
    if (!level) return [];
    return level.nodes.map((node) => {
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
  }, [level, positions, litIds, selectedId, drill]);

  const rfEdges: Edge[] = useMemo(() => {
    if (!level) return [];
    return level.edges.map((edge) => {
      const touchesSelection = selectedId === edge.fromId || selectedId === edge.toId;
      const opacity = selectedId ? (touchesSelection ? 0.95 : 0.06) : 0.32;
      const width = Math.min(5, 1 + Math.log2(edge.weight + 1));
      return {
        id: edge.id,
        source: edge.fromId,
        target: edge.toId,
        label: touchesSelection && edge.weight > 1 ? String(edge.weight) : undefined,
        labelBgStyle: { fill: '#f4f1e9' },
        labelStyle: { fontSize: 11, fill: '#5f594b' },
        style: {
          stroke: touchesSelection ? '#4a4436' : '#a89f8b',
          strokeWidth: touchesSelection ? Math.max(1.6, width) : width,
          opacity,
        },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: 14,
          height: 14,
          color: touchesSelection ? '#4a4436' : '#a89f8b',
        },
      } satisfies Edge;
    });
  }, [level, selectedId]);

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
              className={tab.view === view ? 'tab is-current' : 'tab'}
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

        {view === 'map' ? (
          <nav className="crumbs" aria-label="Breadcrumb">
            {crumbs.map((crumb: AtlasNode, index) => (
              <span key={crumb.id}>
                {index > 0 ? <span className="crumb-sep">›</span> : null}
                <button
                  className={index === crumbs.length - 1 ? 'crumb is-current' : 'crumb'}
                  onClick={() => drill(crumb.id)}
                >
                  {crumb.label ?? crumb.name}
                </button>
              </span>
            ))}
          </nav>
        ) : (
          <span className="topbar-title">{overview?.meta.name ?? ''}</span>
        )}

        <div className="topbar-right">
          {justUpdated ? <span className="live-badge">code changed · updated</span> : null}
          {view === 'map' && level && level.totalChildren > 0 ? (
            <span className="topbar-count">
              {level.totalChildren} {level.totalChildren === 1 ? 'item' : 'items'}
              {level.truncated ? ' (showing first 400)' : ''}
            </span>
          ) : null}
          <button className="btn-ghost" onClick={() => setSearchOpen(true)}>
            Search <kbd>Ctrl</kbd>
            <kbd>K</kbd>
          </button>
        </div>
      </header>

      <main className={view === 'map' ? 'canvas' : 'canvas canvas-page'}>
        {view === 'boundaries' ? (
          boundaries ? (
            <BoundaryScreen
              view={boundaries}
              selectedId={selectedId}
              summary={overview?.app?.summary ?? null}
              summarySource={overview?.app?.summarySource ?? null}
              onSelect={select}
              onOpenInsights={() => go('insights')}
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
            {loading ? <div className="loading">Drawing the map…</div> : null}
            {!loading && level && level.nodes.length === 0 ? (
              <div className="loading">Nothing inside this one.</div>
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

            <div className="legend">
              {ZONES.map((zone) => (
                <span key={zone} className="legend-item">
                  <span className={`dot zone-${zone}`} />
                  {zoneLabel(zone)}
                </span>
              ))}
            </div>

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
          aiEnabled={aiEnabled}
          tour={detail ? (tours.find((one) => one.id === `tour:${detail.node.id}`) ?? null) : null}
          onReveal={reveal}
          onDrill={drill}
          onStartTour={startTour}
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

function readHash(): { view: ViewName; levelId: string | null } {
  const raw = decodeURIComponent(window.location.hash.replace(/^#/, ''));
  if (!raw || raw === 'boundaries') return { view: 'boundaries', levelId: null };
  if (raw === 'overview') return { view: 'overview', levelId: null };
  if (raw === 'types') return { view: 'types', levelId: null };
  if (raw === 'insights') return { view: 'insights', levelId: null };
  if (raw === 'map') return { view: 'map', levelId: null };
  if (raw.startsWith('map/')) return { view: 'map', levelId: raw.slice(4) };
  // Links made by M1 were a bare node id and still mean "show me this on the map".
  return { view: 'map', levelId: raw };
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
