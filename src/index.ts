/**
 * @fileoverview Programmatic entry point.
 *
 * Anything the CLI can do, a script (or an agent) can do by importing this module.
 * The atlas is deliberately a plain data structure so it stays easy to consume.
 */
export { analyzeProject, computeStats, TOOL_VERSION } from './analyze/index.js';
export type { AnalyzeOptions, AnalyzeResult } from './analyze/index.js';
export { enrichAtlas } from './enrich/index.js';
export type { CostEstimate, EnrichOptions, EnrichReport } from './enrich/index.js';
export { selectBackend } from './enrich/backends/index.js';
export { describeRun, writeTheWords } from './enrich/session.js';
export { explanationKey, estimateTokens, PROMPT_VERSION } from './enrich/types.js';
export type { CachedExplanation, EnrichBackend, EnrichRequest, EnrichTier } from './enrich/types.js';
export { cleanLabel, cleanParagraph, cleanSentence, parseJsonReply } from './enrich/validate.js';
export { initConventions } from './init.js';
export { countStaleDocs, isStaleDoc, markStaleDocs, STALE_DOCS_KEY } from './model/staleness.js';
export { AtlasGraph } from './model/graph.js';
export type { LevelView, NodeView, OverviewView } from './model/graph.js';
export { buildBoundaryView } from './model/boundary.js';
export type { BoundaryCard, BoundaryFlow, BoundaryView, BoundaryZone } from './model/boundary.js';
export { classifyArchetype } from './analyze/archetype.js';
export { buildSchemaNodes } from './analyze/schema.js';
export { classifyZone, dominantZone } from './analyze/zones.js';
export { findScopes } from './analyze/workspace.js';
export type { Scope } from './analyze/workspace.js';
export { renderAtlasMarkdown } from './export/markdown.js';
export { buildTours, tourFor } from './model/tours.js';
export type { Tour, TourStep } from './model/tours.js';
export { buildTypeView } from './model/typeview.js';
export type { TypeCard, TypeField, TypeLink, TypeView } from './model/typeview.js';
export { authHeadline, classifyOpenDoors, isAuthRelevant } from './model/exposure.js';
export { buildInsights } from './model/insights.js';
export type { InsightsView, Protection, RouteInsight, ServiceInsight, StoreInsight } from './model/insights.js';
export {
  AtlasStore,
  atlasDbPath,
  atlasJsonPath,
  loadAtlas,
  persistAtlas,
  readScopes,
  scopesPath,
  writeScopes,
} from './model/store.js';
export type { ScopeRecord } from './model/store.js';
export { startServer } from './server/index.js';
export type { ServerHandle } from './server/index.js';
export { isInteresting, watchProject } from './watch.js';
export type { WatchOptions, Watcher } from './watch.js';
export * from './model/types.js';
