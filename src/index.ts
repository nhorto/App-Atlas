/**
 * @fileoverview Programmatic entry point.
 *
 * Anything the CLI can do, a script (or an agent) can do by importing this module.
 * The atlas is deliberately a plain data structure so it stays easy to consume.
 */
export { analyzeProject, computeStats, TOOL_VERSION } from './analyze/index.js';
export type { AnalyzeOptions, AnalyzeResult } from './analyze/index.js';
export { collectAppFacts, enrichAtlas } from './enrich/index.js';
export type { CostEstimate, EnrichOptions, EnrichReport } from './enrich/index.js';
export { selectBackend } from './enrich/backends/index.js';
export { agentCliById } from './enrich/backends/agent-cli.js';
export { describeRun, writeTheWords } from './enrich/session.js';
export { explanationKey, estimateTokens, PROMPT_VERSION } from './enrich/types.js';
export type { CachedExplanation, EnrichBackend, EnrichRequest, EnrichTier } from './enrich/types.js';
export {
  cleanLabel,
  cleanParagraph,
  cleanSentence,
  dropWrongMethods,
  methodsByRoute,
  parseJsonReply,
} from './enrich/validate.js';
export type { Grounded, KnownRoute, MethodsByRoute } from './enrich/validate.js';
export { initConventions } from './init.js';
export { countStaleDocs, isStaleDoc, markStaleDocs, STALE_DOCS_KEY } from './model/staleness.js';
export { describeChanges, diffAtlas } from './model/changes.js';
export type { ChangeReport } from './model/changes.js';
export { AtlasGraph } from './model/graph.js';
export type { LevelView, NodeView, OverviewView } from './model/graph.js';
export { buildGroups } from './model/groups.js';
export { buildBoundaryView } from './model/boundary.js';
export type { BoundaryCard, BoundaryFlow, BoundaryView, BoundaryZone } from './model/boundary.js';
export { classifyArchetype } from './analyze/archetype.js';
export { buildSchemaNodes } from './analyze/schema.js';
export { catalogSchema } from './analyze/sql.js';
export { classifyZone, dominantZone } from './analyze/zones.js';
export { findScopes, findWorkspace } from './analyze/workspace.js';
export type { Scope } from './analyze/workspace.js';
export { renderAtlasMarkdown } from './export/markdown.js';
export { buildTours, tourFor } from './model/tours.js';
export type { Tour, TourStep } from './model/tours.js';
export { buildFlow, listDoors } from './model/flow.js';
export { doorsReaching, parseFrames, traceError } from './model/errortrace.js';
export type {
  DoorReach,
  ErrorFrame,
  ErrorTraceResult,
  PlacedFrame,
  TraceLanguage,
  UnplacedReason,
} from './model/errortrace.js';
export type {
  DoorGroup,
  DoorList,
  DoorSummary,
  FlowExit,
  FlowLimits,
  FlowLink,
  FlowStop,
  FlowView,
} from './model/flow.js';
export { buildTypeView } from './model/typeview.js';
export type { TypeCard, TypeField, TypeLink, TypeView } from './model/typeview.js';
export { authHeadline, classifyOpenDoors, isAuthRelevant } from './model/exposure.js';
export { grammarTier, GRAMMAR_TIER } from './model/tiers.js';
export type { TierNote } from './model/tiers.js';
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
export {
  AtlasSource,
  callMcpTool,
  claimStdout,
  encodeMessage,
  handleMcpMessage,
  isKnownTool,
  LineFramer,
  MCP_TOOLS,
  parseMessage,
  RPC_ERROR,
  startMcpServer,
  SUPPORTED_PROTOCOLS,
} from './mcp/index.js';
export type {
  AtlasApp,
  JsonRpcRequest,
  JsonRpcResponse,
  McpOptions,
  ProtocolStream,
  Resolution,
  ToolDefinition,
  ToolResult,
} from './mcp/index.js';
export { isInteresting, watchProject } from './watch.js';
export { displayPath } from './util/paths.js';
export { ignoreAtlasDirectory } from './util/git.js';
export type { WatchOptions, Watcher } from './watch.js';
export * from './model/types.js';
