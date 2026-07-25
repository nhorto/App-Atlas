/**
 * @fileoverview Tiny API client for the local atlas server.
 */
import type { AtlasNode, BoundaryView, InsightsView, LevelView, NodeView, OverviewView } from './types';

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

export function fetchLevel(id?: string): Promise<LevelView> {
  return get<LevelView>(id ? `/api/level?id=${encodeURIComponent(id)}` : '/api/level');
}

export function fetchNode(id: string): Promise<NodeView> {
  return get<NodeView>(`/api/node?id=${encodeURIComponent(id)}`);
}

export async function search(query: string): Promise<AtlasNode[]> {
  const { results } = await get<{ results: AtlasNode[] }>(`/api/search?q=${encodeURIComponent(query)}`);
  return results;
}
