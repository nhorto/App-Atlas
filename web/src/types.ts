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
  | 'file-read'
  | 'screen';

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
  /** The runtime or host sets it — `NODE_ENV`, `PORT`, `VERCEL_URL`. */
  platform?: boolean;
}

export interface EndpointMeta {
  endpointKind: EndpointKind;
  method: string | null;
  route: string | null;
  framework: string;
  guards: GuardInfo[];
  writes: boolean;
  sites: CodeSite[];
  /**
   * When nothing checks this door, what explains it. Written by the analyzer so every
   * screen badges the same route the same way. Absent on atlases written before this
   * existed, which the UI treats exactly like `worth-a-look`.
   */
  open?: OpenVerdict;
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
  /** Database tables only. */
  isId?: boolean;
  isUnique?: boolean;
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

/** One flow crossing the app's boundary at this level. */
export interface OutsideFlow {
  insideId: string;
  weight: number;
  /** True when the inside node calls out; false when the outside world calls in. */
  out: boolean;
}

/** A store, service or endpoint this level talks to, drawn beyond the boundary line. */
export interface OutsideNeighbor {
  node: AtlasNode;
  flows: OutsideFlow[];
  total: number;
}

export interface LevelView {
  levelId: string;
  self: AtlasNode | null;
  breadcrumb: AtlasNode[];
  nodes: LevelNode[];
  edges: LevelEdge[];
  outside: OutsideNeighbor[];
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
  /** The types this node names — the shapes of the data it works with. */
  typesUsed: AtlasNode[];
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
  /** Unchecked with nothing explaining it — the number worth interrupting for. */
  unprotectedRoutes: number;
  /** Unchecked for a reason: a page, or the door people sign in through. */
  publicRoutes: number;
  /** Unchecked, but a file they import could not be read. Unknown, not open. */
  unreadableRoutes: number;
  /** Files that could not be parsed at all. */
  unreadFiles: number;
  services: number;
  externalServices: number;
  stores: number;
  envVars: number;
}

/** What kind of project this is — a different question from which framework it uses. */
export type Archetype = 'web-app' | 'service' | 'library' | 'pipeline' | 'analysis' | 'unknown';

export interface ArchetypeVerdict {
  archetype: Archetype;
  label: string;
  because: string[];
}

// --- what changed since the last run (issue #41) ---

/**
 * Whether the last run left anything this one could honestly be compared against.
 * `none` is a first analysis, `incomparable` is an atlas from a different version of the
 * tool or a different directory, and neither of them means "nothing changed".
 */
export type BaselineState = 'none' | 'incomparable' | 'compared';

export interface ChangeCounts {
  added: number;
  removed: number;
  changed: number;
}

/** One door that arrived, vanished or lost its lock. */
export interface DoorChange {
  id: string;
  /** `POST /api/users`, or the door's own name when it has no address. */
  name: string;
  endpointKind: EndpointKind;
  writes: boolean;
  path: string | null;
  line: number | null;
}

export interface AtlasChanges {
  baseline: BaselineState;
  because: string | null;
  since: string | null;
  total: ChangeCounts;
  byKind: Partial<Record<NodeKind, ChangeCounts>>;
  doors: {
    newTotal: number;
    newOpen: DoorChange[];
    lostCheck: DoorChange[];
    removed: DoorChange[];
  };
}

/** One sentence about the week, plus the doors it is about. */
export interface ChangeNote {
  text: string;
  doors: DoorChange[];
}

/**
 * The sentences, written by the model layer rather than by this page — the command line
 * and this screen must never phrase the same week differently.
 */
export interface ChangeReport {
  tone: 'ok' | 'warn' | 'muted';
  headline: ChangeNote;
  lines: ChangeNote[];
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
  /** Absent on atlases analyzed before archetypes existed; treat as `unknown`. */
  archetype?: ArchetypeVerdict;
  stats: AtlasStats;
  /** Absent on atlases analyzed before this existed; that is not "nothing changed". */
  changes?: AtlasChanges;
  warnings: string[];
}

/** One file nothing else in the app imports. See src/model/unimported.ts. */
export interface UnimportedFile {
  id: string;
  path: string;
  zone: Zone;
  loc: number;
  exportedNames: string[];
  summary: string | null;
  summarySource: SummarySource;
}

/**
 * The files nothing imports, or the reason there is no answer.
 *
 * `answered: false` with an empty list and `answered: true` with an empty list are
 * opposite facts about a repo, and the screen must never render them the same way.
 */
export interface UnimportedView {
  answered: boolean;
  because: string | null;
  /** The sentence, written by the model layer. Lower case; add the capital and stop. */
  headline: string | null;
  files: UnimportedFile[];
  total: number;
  considered: number;
  caveats: string[];
}

export interface OverviewView {
  meta: AtlasMeta;
  rootId: string;
  app: AtlasNode | null;
  topLevel: LevelNode[];
  whereToLookFirst: { node: AtlasNode; imports: number }[];
  zoneCounts: Record<string, number>;
  changes: ChangeReport | null;
  unimported: UnimportedView;
}

// --- the words layer (SPEC.md 5.5) ---

/** Whether explain-on-click is available at all; `--no-ai` turns it off. */
export interface AiStatus {
  enabled: boolean;
}

/** One app inside a workspace. Absent entirely for an ordinary single-app repo. */
export interface ScopeInfo {
  id: string;
  name: string;
  dir: string;
  kind: 'app' | 'library';
}

export interface ExplainResult {
  text: string;
  /** Which backend wrote it. Absent when the answer came from the cache. */
  backend?: string;
  cached: boolean;
}

// --- type explorer (SPEC.md 6.3) ---

export type TypeKind = 'interface' | 'type-alias' | 'enum' | 'class' | 'table';

export interface TypeField extends FieldInfo {
  /** The card this row points at, when that card is on screen. */
  linkTo: string | null;
}

export interface TypeCard {
  id: string;
  name: string;
  typeKind: TypeKind;
  path: string | null;
  startLine: number | null;
  zone: Zone;
  fields: TypeField[];
  hiddenFields: number;
  summary: string | null;
  summarySource: SummarySource;
  usage: number;
  usageByZone: { zone: Zone; count: number }[];
  aliasOf: string | null;
  provider: string | null;
}

export interface TypeLink {
  id: string;
  fromId: string;
  toId: string;
  fields: string[];
  /** `declared` is a fact from the code or the schema; `name` is only a name match. */
  basis: 'declared' | 'name';
}

export interface TypeView {
  cards: TypeCard[];
  links: TypeLink[];
  total: number;
  tables: number;
}

// --- guided tours (SPEC.md 6.4) ---

export interface TourStep {
  id: string;
  title: string;
  /** Compiler facts in plain English. Never generated. */
  body: string;
  /** The node's own description, when it has one. */
  quote: string | null;
  quoteSource: SummarySource;
  focusIds: string[];
  levelId: string | null;
  codeId: string | null;
  tone?: 'warn';
}

export interface Tour {
  id: string;
  title: string;
  subtitle: string;
  kind: 'welcome' | 'flow';
  steps: TourStep[];
}

export interface SourceSlice {
  path: string;
  startLine: number;
  endLine: number;
  code: string;
  truncated: boolean;
}

// --- boundary view (SPEC.md 6.1) ---

export interface BoundaryCard {
  id: string;
  name: string;
  detail: string;
  count: number;
  memberIds: string[];
  /** Present only on group cards — the nodes the card stands for, named. */
  members?: { id: string; name: string }[];
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

/** What the three columns are called for this kind of project. Geometry never changes; words do. */
export interface BoundaryCaptions {
  inputs: string;
  app: string;
  outputs: string;
}

export interface BoundaryView {
  appName: string;
  archetype?: Archetype;
  captions: BoundaryCaptions;
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
  /** When nothing checks this door, what explains it. `null` when something does. */
  open: OpenVerdict | null;
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

/** One table and what the migrations say protects its rows. `rls: null` is unknown, not "off". */
export interface TableProtectionInsight {
  id: string;
  name: string;
  declared: boolean;
  rls: {
    enabled: boolean;
    policyCount: number;
    commands: string[];
  } | null;
  path: string | null;
  line: number | null;
}

/**
 * Why a door with no visible check is that way. `worth-a-look` is the absence of an
 * explanation, which is the only one of these that belongs in a headline.
 */
export type OpenKind = 'worth-a-look' | 'page' | 'auth-mount' | 'unreadable';

export interface OpenVerdict {
  kind: OpenKind;
  because: string | null;
}

export interface InsightsView {
  auth: {
    total: number;
    protectedCount: number;
    likelyCount: number;
    openCount: number;
    publicCount: number;
    unreadableCount: number;
    unread: { path: string; because: string }[];
    routes: RouteInsight[];
  };
  services: ServiceInsight[];
  stores: StoreInsight[];
  tables: {
    total: number;
    unprotected: number;
    locked: number;
    unknown: number;
    list: TableProtectionInsight[];
  };
  env: {
    exampleFile: string | null;
    total: number;
    undocumented: EnvVarInfo[];
    vars: EnvVarInfo[];
  };
}
