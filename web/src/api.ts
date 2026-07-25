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
  SourceSlice,
  Tour,
  TypeView,
} from './types';

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { accept: 'application/json' } });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Request failed: ${res.status}`);
  }
  return (await res.json()) as T;
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
