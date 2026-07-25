/**
 * @fileoverview The Atlas data model.
 *
 * Deliberately language-agnostic: every language plugin emits these same nodes and
 * edges, so the UI, the exporters and (later) the AI enricher never need to know
 * whether a fact came from TypeScript, Python or anything else.
 *
 * See SPEC.md section 5.4.
 */

/** Every kind of thing an atlas can contain. */
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

/** Every kind of relationship between two nodes. */
export type EdgeKind =
  | 'contains'
  | 'imports'
  | 'references'
  | 'reads-from'
  | 'writes-to'
  | 'exposed-by'
  | 'protected-by';

/**
 * Where a piece of information came from. This drives the three trust tiers in the
 * UI: `static` facts cannot be wrong, `docs` are deterministic but human-authored
 * claims, `ai` is generated.
 */
export type Provenance = 'static' | 'docs' | 'ai';

/** How much we trust a derived edge. Reference edges are pragmatic, not sound. */
export type Confidence = 'certain' | 'likely' | 'possible';

/** Coarse architectural role, derived from path and file conventions. */
export type Zone = 'ui' | 'api' | 'logic' | 'data' | 'config' | 'test' | 'unknown';

/** Which rung of the explanation ladder produced `summary`. */
export type SummarySource = 'docs' | 'ai' | null;

/** Free-form per-kind detail. Stored as JSON; see the *Meta interfaces below. */
export type NodeMeta = Record<string, unknown>;

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

/** meta for kind === 'file' */
export interface FileMeta {
  ext: string;
  loc: number;
  externalImports: string[];
  exportedNames: string[];
  functionCount: number;
  typeCount: number;
}

/** meta for kind === 'function' */
export interface FunctionMeta {
  signature: string;
  params: ParamInfo[];
  returnType: string;
  isAsync: boolean;
  isExported: boolean;
  isMethod: boolean;
  ownerName?: string;
  loc: number;
}

/** meta for kind === 'type' */
export interface TypeMeta {
  typeKind: 'interface' | 'type-alias' | 'enum' | 'class';
  fields: FieldInfo[];
  isExported: boolean;
  extends: string[];
}

/** meta for kind === 'module' */
export interface ModuleMeta {
  dirPath: string;
  fileCount: number;
  descendantFileCount: number;
  collapsedFrom?: string[];
}

export interface AtlasNode {
  /** Stable, human-readable id, e.g. `file:src/auth/login.ts`. */
  id: string;
  kind: NodeKind;
  /** Identifier as written in the code (or folder/file name). */
  name: string;
  /** Plain-English label. Filled by the AI enricher in M3; null until then. */
  label: string | null;
  parentId: string | null;
  language: string | null;
  /** Repo-relative POSIX path (file path, or directory path for modules). */
  path: string | null;
  startLine: number | null;
  endLine: number | null;
  zone: Zone;
  /** The displayed explanation, from the highest available rung of the ladder. */
  summary: string | null;
  summarySource: SummarySource;
  /** Hash of the docstring alone — lets us detect stale docs (body changed, doc didn't). */
  docHash: string | null;
  /** Hash of the implementation alone. */
  bodyHash: string | null;
  /** Hash of the whole node's content; drives incremental re-analysis and the AI cache. */
  hash: string;
  provenance: Provenance;
  meta: NodeMeta;
}

export interface AtlasEdge {
  id: string;
  kind: EdgeKind;
  fromId: string;
  toId: string;
  /** Number of distinct code paths this edge aggregates. */
  weight: number;
  confidence: Confidence;
  provenance: Provenance;
  meta: NodeMeta;
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
  /** Bumped when the on-disk shape changes incompatibly. */
  formatVersion: number;
  toolVersion: string;
  /** Absolute path of the analyzed project root. */
  root: string;
  /** Display name of the app (from package.json name, else folder name). */
  name: string;
  generatedAt: string;
  durationMs: number;
  languages: string[];
  frameworks: string[];
  stats: AtlasStats;
  /** Non-fatal problems worth surfacing in the UI. */
  warnings: string[];
}

export interface Atlas {
  meta: AtlasMeta;
  nodes: AtlasNode[];
  edges: AtlasEdge[];
}

export const FORMAT_VERSION = 1;

/** Node kinds a user can drill into on the canvas. */
export const CONTAINER_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>(['app', 'module', 'file', 'type']);

export function makeAppId(name: string): string {
  return `app:${name}`;
}

export function makeModuleId(dirPath: string): string {
  return `module:${dirPath === '' ? '.' : dirPath}`;
}

export function makeFileId(relPath: string): string {
  return `file:${relPath}`;
}

export function makeFunctionId(relPath: string, name: string, disambiguator = ''): string {
  return `func:${relPath}#${name}${disambiguator}`;
}

export function makeTypeId(relPath: string, name: string, disambiguator = ''): string {
  return `type:${relPath}#${name}${disambiguator}`;
}

export function makeEdgeId(kind: EdgeKind, fromId: string, toId: string): string {
  return `${kind}|${fromId}|${toId}`;
}
