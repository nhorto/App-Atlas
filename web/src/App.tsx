/**
 * @fileoverview The architecture map (SPEC.md 6.2).
 *
 * One level of the atlas is on screen at a time: the children of the current
 * container, laid out deterministically, with the connections between them rolled up
 * into single arrows. Click selects and lights up the neighbourhood; double-click
 * goes inside; the breadcrumb goes back out.
 *
 * The rule this file exists to enforce: the canvas never receives the whole graph.
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
  useNodesInitialized,
  useReactFlow,
  type Edge,
  type Node,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { fetchLevel, fetchNode, fetchOverview } from './api';
import { layoutLevel, sizeOf, type Positioned } from './layout';
import type { AtlasNode, LevelView, NodeView, OverviewView, Zone } from './types';
import { AtlasNodeCard, zoneLabel } from './components/AtlasNodeCard';
import { DetailPanel } from './components/DetailPanel';
import { SearchPalette } from './components/SearchPalette';

const nodeTypes = { atlas: AtlasNodeCard };

const ZONES: Zone[] = ['ui', 'api', 'logic', 'data', 'config', 'test'];

export function App() {
  return (
    <ReactFlowProvider>
      <AtlasApp />
    </ReactFlowProvider>
  );
}

function AtlasApp() {
  const [overview, setOverview] = useState<OverviewView | null>(null);
  const [levelId, setLevelId] = useState<string | null>(null);
  const [level, setLevel] = useState<LevelView | null>(null);
  const [positions, setPositions] = useState<Map<string, Positioned>>(new Map());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<NodeView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const { fitView } = useReactFlow();
  const nodesInitialized = useNodesInitialized();

  // --- load the atlas ---
  useEffect(() => {
    fetchOverview()
      .then((data) => {
        setOverview(data);
        // The URL hash names the level, so a spot in the map can be linked to.
        const fromUrl = decodeURIComponent(window.location.hash.replace(/^#/, ''));
        setLevelId(fromUrl || data.rootId);
      })
      .catch((err: Error) => {
        setError(err.message);
        setLoading(false);
      });
  }, []);

  // --- load and lay out the current level ---
  useEffect(() => {
    if (!levelId) return;
    let cancelled = false;
    setLoading(true);
    fetchLevel(levelId)
      .then(async (view) => {
        const laid = await layoutLevel(view.nodes, view.edges);
        if (cancelled) return;
        setLevel(view);
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
  }, [levelId, overview]);

  // --- load detail for the selection ---
  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    fetchNode(selectedId)
      .then((view) => {
        if (!cancelled) setDetail(view);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  // --- frame each level once React Flow has measured it ---
  // Fitting too early frames the *previous* level's nodes, so wait for React Flow to
  // report the current ones as measured. The delayed second call covers the frame
  // where measurement finishes just after this effect runs.
  useEffect(() => {
    if (!nodesInitialized || !level) return;
    const options = { padding: 0.2, maxZoom: 1 };
    void fitView(options);
    const timer = window.setTimeout(() => void fitView({ ...options, duration: 250 }), 120);
    return () => window.clearTimeout(timer);
  }, [nodesInitialized, level, fitView]);

  const drill = useCallback((id: string) => {
    setLevelId(id);
    setSelectedId(null);
    window.history.replaceState(null, '', `#${encodeURIComponent(id)}`);
  }, []);

  const goUp = useCallback(() => {
    const crumbs = level?.breadcrumb ?? [];
    const parent = crumbs[crumbs.length - 2];
    if (parent) drill(parent.id);
  }, [level, drill]);

  /** Bring any node into view, changing level first if it lives somewhere else. */
  const reveal = useCallback(
    async (id: string) => {
      try {
        const view = await fetchNode(id);
        const parent = view.breadcrumb[view.breadcrumb.length - 2];
        if (parent && parent.id !== levelId) setLevelId(parent.id);
        setSelectedId(id);
      } catch {
        /* the node may have vanished between analyses */
      }
    },
    [levelId],
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
        else setSelectedId(null);
        return;
      }
      const typing = (event.target as HTMLElement | null)?.tagName === 'INPUT';
      if (!typing && (event.key === 'Backspace' || (event.altKey && event.key === 'ArrowLeft'))) {
        event.preventDefault();
        goUp();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goUp, searchOpen]);

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
          dim: neighborIds ? !neighborIds.has(node.id) : false,
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
  }, [level, positions, neighborIds, selectedId, drill]);

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
        labelBgStyle: { fill: '#ffffff' },
        labelStyle: { fontSize: 11, fill: '#475569' },
        style: {
          stroke: touchesSelection ? '#334155' : '#94a3b8',
          strokeWidth: touchesSelection ? Math.max(1.6, width) : width,
          opacity,
        },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: 14,
          height: 14,
          color: touchesSelection ? '#334155' : '#94a3b8',
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

  return (
    <div className="app">
      <header className="topbar">
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

        <div className="topbar-right">
          {level && level.totalChildren > 0 ? (
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

      <main className="canvas">
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
          <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="#dbe1ea" />
          <Controls showInteractive={false} />
          <MiniMap
            pannable
            zoomable
            nodeColor={(node) => zoneColor(((node.data as { node?: { zone?: Zone } }).node?.zone ?? 'unknown') as Zone)}
            maskColor="rgba(241,245,249,0.75)"
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

        <div className="hint">Click to inspect · Press › or double-click to look inside · Backspace to go back</div>
      </main>

      <DetailPanel
        detail={detail}
        overview={overview}
        onReveal={reveal}
        onDrill={drill}
        onClose={() => setSelectedId(null)}
      />

      <SearchPalette open={searchOpen} onClose={() => setSearchOpen(false)} onPick={reveal} />
    </div>
  );
}

function zoneColor(zone: Zone): string {
  switch (zone) {
    case 'ui':
      return '#7c5cff';
    case 'api':
      return '#0ea5e9';
    case 'logic':
      return '#f59e0b';
    case 'data':
      return '#10b981';
    case 'config':
      return '#64748b';
    case 'test':
      return '#ec4899';
    default:
      return '#94a3b8';
  }
}
