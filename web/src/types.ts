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
  topLevel: LevelNode[];
  busiestFiles: { node: AtlasNode; connections: number }[];
  zoneCounts: Record<string, number>;
}
