/**
 * @fileoverview Tiny API client for the local atlas server.
 */
import type {
  AiStatus,
  AtlasNode,
  BoundaryView,
  ExplainResult,
  InsightsView,
  LevelView,
  NodeView,
  OverviewView,
  ScopeInfo,
  SourceSlice,
  Tour,
  TypeView,
} from './types';

/**
 * Which app in a workspace every request is about.
 *
 * A module-level value rather than a parameter threaded through twelve call sites: the
 * scope is a property of the whole screen, and every request that crossed while it was
 * changing would be answering the wrong question anyway.
 */
let currentScope = '';

export function setScope(id: string): void {
  currentScope = id;
}

async function get<T>(path: string): Promise<T> {
  const url = currentScope ? `${path}${path.includes('?') ? '&' : '?'}scope=${encodeURIComponent(currentScope)}` : path;
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Request failed: ${res.status}`);
  }
  return (await res.json()) as T;
}

/** The apps in this workspace. Empty for an ordinary repo, which hides the switcher. */
export async function fetchScopes(): Promise<ScopeInfo[]> {
  const { scopes } = await get<{ scopes: ScopeInfo[] }>('/api/scopes');
  return scopes;
}

export function fetchOverview(): Promise<OverviewView> {
  return get<OverviewView>('/api/overview');
}

export function fetchBoundaries(): Promise<BoundaryView> {
  return get<BoundaryView>('/api/boundaries');
}

export function fetchInsights(): Promise<InsightsView> {
  return get<InsightsView>('/api/insights');
}

export function fetchTypes(): Promise<TypeView> {
  return get<TypeView>('/api/types');
}

export async function fetchTours(): Promise<Tour[]> {
  const { tours } = await get<{ tours: Tour[] }>('/api/tours');
  return tours;
}

/** The code behind one walkthrough step, read from disk when the step is reached. */
export function fetchSource(id: string): Promise<SourceSlice> {
  return get<SourceSlice>(`/api/source?id=${encodeURIComponent(id)}`);
}

export function fetchLevel(id?: string): Promise<LevelView> {
  return get<LevelView>(id ? `/api/level?id=${encodeURIComponent(id)}` : '/api/level');
}

export function fetchNode(id: string): Promise<NodeView> {
  return get<NodeView>(`/api/node?id=${encodeURIComponent(id)}`);
}

export function fetchAiStatus(): Promise<AiStatus> {
  return get<AiStatus>('/api/ai');
}

/**
 * Generates a description for one thing, on demand. Slow by web standards — it may
 * start an agent CLI — so callers show a pending state rather than a spinner blocking
 * the panel.
 */
export function explainNode(id: string): Promise<ExplainResult> {
  return get<ExplainResult>(`/api/explain?id=${encodeURIComponent(id)}`);
}

export async function search(query: string): Promise<AtlasNode[]> {
  const { results } = await get<{ results: AtlasNode[] }>(`/api/search?q=${encodeURIComponent(query)}`);
  return results;
}

/**
 * Listens for "the code changed" while `--watch` is running.
 *
 * EventSource reconnects on its own, so restarting the CLI reconnects the page without
 * anyone reloading it. When nothing is watching, the stream simply stays quiet.
 */
export function onAtlasUpdated(handler: () => void): () => void {
  const source = new EventSource('/api/events');
  source.addEventListener('atlas', handler);
  return () => source.close();
}
