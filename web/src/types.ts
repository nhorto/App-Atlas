/**
 * @fileoverview Wire types.
 *
 * A mirror of the server's atlas model (src/model/types.ts) plus the view shapes the
 * API returns. Kept as a separate copy so the web build stays independent of the Node
 * build; if you change one, change both.
 */

export type NodeKind =
  | 'app'
  | 'zone'
  | 'module'
  | 'file'
  | 'function'
  | 'type'
  | 'endpoint'
  | 'service'
  | 'store';

export type EdgeKind =
  | 'contains'
  | 'imports'
  | 'references'
  | 'reads-from'
  | 'writes-to'
  | 'exposed-by'
  | 'protected-by';

export type Provenance = 'static' | 'docs' | 'ai';
export type Confidence = 'certain' | 'likely' | 'possible';
export type Zone = 'ui' | 'api' | 'logic' | 'data' | 'config' | 'test' | 'unknown';
export type SummarySource = 'docs' | 'ai' | null;

export type EndpointKind =
  | 'http-route'
  | 'server-action'
  | 'webhook'
  | 'cron'
  | 'queue'
  | 'realtime'
  | 'cli'
  | 'env'
  | 'file-read';

export type ServiceCategory =
  | 'payments'
  | 'ai'
  | 'email'
  | 'sms'
  | 'auth'
  | 'storage'
  | 'analytics'
  | 'search'
  | 'monitoring'
  | 'queue'
  | 'other';

export type StoreKind = 'sql' | 'nosql' | 'kv' | 'blob' | 'filesystem' | 'unknown';

export interface CodeSite {
  path: string;
  line: number;
  nodeId: string | null;
  snippet?: string;
}

export interface GuardInfo {
  name: string;
  how: 'middleware' | 'call' | 'decorator' | 'procedure' | 'config';
  provider: string;
  path: string | null;
  line: number | null;
  confidence: Confidence;
}

export interface EnvVarInfo {
  name: string;
  sites: CodeSite[];
  documented: boolean;
  secret: boolean;
}

export interface EndpointMeta {
  endpointKind: EndpointKind;
  method: string | null;
  route: string | null;
  framework: string;
  guards: GuardInfo[];
  writes: boolean;
  sites: CodeSite[];
  schedule?: string;
  vars?: EnvVarInfo[];
  envExample?: string | null;
}

export interface ServiceMeta {
  category: ServiceCategory;
  packages: string[];
  hosts: string[];
  sites: CodeSite[];
  external: boolean;
}

export interface StoreMeta {
  storeKind: StoreKind;
  client: string;
  tables: string[];
  reads: number;
  writes: number;
  sites: CodeSite[];
}

export interface ParamInfo {
  name: string;
  type: string;
  optional: boolean;
  rest?: boolean;
}

export interface FieldInfo {
  name: string;
  type: string;
  optional: boolean;
}

export interface AtlasNode {
  id: string;
  kind: NodeKind;
  name: string;
  label: string | null;
  parentId: string | null;
  language: string | null;
  path: string | null;
  startLine: number | null;
  endLine: number | null;
  zone: Zone;
  summary: string | null;
  summarySource: SummarySource;
  docHash: string | null;
  bodyHash: string | null;
  hash: string;
  provenance: Provenance;
  meta: Record<string, unknown>;
}

export interface AtlasEdge {
  id: string;
  kind: EdgeKind;
  fromId: string;
  toId: string;
  weight: number;
  confidence: Confidence;
  provenance: Provenance;
  meta: Record<string, unknown>;
}

export interface LevelNode extends AtlasNode {
  childCount: number;
  drillable: boolean;
  outsideIn: number;
  outsideOut: number;
  preview: string[];
}

export interface LevelEdge {
  id: string;
  fromId: string;
  toId: string;
  weight: number;
  kinds: EdgeKind[];
}

export interface LevelView {
  levelId: string;
  self: AtlasNode | null;
  breadcrumb: AtlasNode[];
  nodes: LevelNode[];
  edges: LevelEdge[];
  truncated: boolean;
  totalChildren: number;
}

export interface NeighborLink {
  edge: AtlasEdge;
  other: AtlasNode;
  direction: 'in' | 'out';
}

export interface NodeView {
  node: AtlasNode;
  breadcrumb: AtlasNode[];
  children: AtlasNode[];
  incoming: NeighborLink[];
  outgoing: NeighborLink[];
  incomingTotal: number;
  outgoingTotal: number;
}

export interface AtlasStats {
  files: number;
  functions: number;
  types: number;
  modules: number;
  imports: number;
  references: number;
  linesOfCode: number;
  documentedFiles: number;
  documentedFunctions: number;
  staleDocs: number;
  aiSummaries: number;
  aiFiles: number;
  endpoints: number;
  routes: number;
  unprotectedRoutes: number;
  services: number;
  externalServices: number;
  stores: number;
  envVars: number;
}

export interface AtlasMeta {
  formatVersion: number;
  toolVersion: string;
  root: string;
  name: string;
  generatedAt: string;
  durationMs: number;
  languages: string[];
  frameworks: string[];
  stats: AtlasStats;
  warnings: string[];
}

export interface OverviewView {
  meta: AtlasMeta;
  rootId: string;
  app: AtlasNode | null;
  topLevel: LevelNode[];
  busiestFiles: { node: AtlasNode; connections: number }[];
  zoneCounts: Record<string, number>;
}

// --- the words layer (SPEC.md 5.5) ---

/** Whether explain-on-click is available at all; `--no-ai` turns it off. */
export interface AiStatus {
  enabled: boolean;
}

export interface ExplainResult {
  text: string;
  /** Which backend wrote it. Absent when the answer came from the cache. */
  backend?: string;
  cached: boolean;
}

// --- boundary view (SPEC.md 6.1) ---

export interface BoundaryCard {
  id: string;
  name: string;
  detail: string;
  count: number;
  memberIds: string[];
  nodeId: string | null;
  family: string;
  openCount?: number;
}

export interface BoundaryZone {
  zone: Zone;
  label: string;
  files: number;
}

export interface BoundaryFlow {
  fromId: string;
  toId: string;
  weight: number;
}

export interface BoundaryView {
  appName: string;
  inputs: BoundaryCard[];
  zones: BoundaryZone[];
  outputs: BoundaryCard[];
  flows: BoundaryFlow[];
  summary: {
    endpoints: number;
    openRoutes: number;
    externalServices: number;
    stores: number;
    envVars: number;
  };
}

// --- security badges (SPEC.md 6.6) ---

export type Protection = 'protected' | 'likely' | 'open';

export interface RouteInsight {
  id: string;
  name: string;
  method: string | null;
  route: string | null;
  endpointKind: EndpointKind;
  framework: string;
  writes: boolean;
  protection: Protection;
  guards: GuardInfo[];
  sites: CodeSite[];
}

export interface ServiceInsight {
  id: string;
  name: string;
  category: string;
  evidence: string[];
  callSites: number;
  sends: boolean;
  sites: CodeSite[];
}

export interface StoreInsight {
  id: string;
  name: string;
  client: string;
  storeKind: string;
  tables: string[];
  reads: number;
  writes: number;
}

export interface InsightsView {
  auth: {
    total: number;
    protectedCount: number;
    likelyCount: number;
    openCount: number;
    routes: RouteInsight[];
  };
  services: ServiceInsight[];
  stores: StoreInsight[];
  env: {
    exampleFile: string | null;
    total: number;
    undocumented: EnvVarInfo[];
    vars: EnvVarInfo[];
  };
}
