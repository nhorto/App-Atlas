/**
 * @fileoverview Programmatic entry point.
 *
 * Anything the CLI can do, a script (or an agent) can do by importing this module.
 * The atlas is deliberately a plain data structure so it stays easy to consume.
 */
export { analyzeProject, TOOL_VERSION } from './analyze/index.js';
export type { AnalyzeOptions, AnalyzeResult } from './analyze/index.js';
export { AtlasGraph } from './model/graph.js';
export type { LevelView, NodeView, OverviewView } from './model/graph.js';
export { buildBoundaryView } from './model/boundary.js';
export type { BoundaryCard, BoundaryFlow, BoundaryView, BoundaryZone } from './model/boundary.js';
export { buildInsights } from './model/insights.js';
export type { InsightsView, Protection, RouteInsight, ServiceInsight, StoreInsight } from './model/insights.js';
export { AtlasStore, atlasDbPath, atlasJsonPath, loadAtlas, persistAtlas } from './model/store.js';
export { startServer } from './server/index.js';
export type { ServerHandle } from './server/index.js';
export * from './model/types.js';
