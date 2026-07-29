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

/** The kinds of door data can come in through. See SPEC.md section 5.3. */
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
  // A name another codebase can import. For a library this is the whole boundary —
  // an exported function is a door, just one reached through the module system
  // rather than over a network. Deliberately kept out of the auth-coverage count:
  // an export is not a route, and badging one "unprotected" would be a false alarm
  // in the one place this tool must never cry wolf.
  | 'export'
  // A screen in a file-routed native/web app (Expo Router, React Navigation file
  // routes). A way a *person* gets in, not a network door — deliberately kept out of
  // the auth-coverage count so it never dilutes the routes a stranger can reach.
  | 'screen';

/** What a third party does for you — drives the grouping in the boundary view. */
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

/** What sort of thing the data is being kept in. */
export type StoreKind = 'sql' | 'nosql' | 'kv' | 'blob' | 'filesystem' | 'unknown';

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
  /** Database tables only: the primary key. */
  isId?: boolean;
  /** Database tables only: declared unique. */
  isUnique?: boolean;
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

/**
 * meta for kind === 'type'
 *
 * `table` is a database table read out of a schema file rather than a shape declared
 * in code. It is the same node kind on purpose: a table is a named thing with typed
 * fields, which is exactly what the type explorer draws, and keeping it here means
 * every view that already understands types understands tables for free.
 */
export interface TypeMeta {
  typeKind: 'interface' | 'type-alias' | 'enum' | 'class' | 'table';
  fields: FieldInfo[];
  isExported: boolean;
  extends: string[];
  /** Tables only: `postgresql`, `mysql`, `sqlite`… */
  provider?: string;
  /** Tables only: named in queries but declared nowhere, so the columns are unknown. */
  observed?: boolean;
  /**
   * Tables from SQL migrations only: row-level security, as the migrations state it.
   * Absent means the migrations said nothing — which is *unknown*, not "off"; a table
   * created in a dashboard may well be protected by policies we never saw.
   */
  rls?: TableRlsInfo;
}

/** What the migrations say protects a table's rows. */
export interface TableRlsInfo {
  enabled: boolean;
  policies: TablePolicyInfo[];
}

export interface TablePolicyInfo {
  name: string;
  /** `select` | `insert` | `update` | `delete` | `all`. */
  command: string;
  path: string;
  line: number;
}

/** meta for kind === 'module' */
export interface ModuleMeta {
  dirPath: string;
  fileCount: number;
  descendantFileCount: number;
  collapsedFrom?: string[];
}

/** One place in the code where a boundary was observed. */
export interface CodeSite {
  path: string;
  line: number;
  /** The atlas node (usually a function) the site sits inside. */
  nodeId: string | null;
  /** The expression as written, trimmed — the evidence for the finding. */
  snippet?: string;
}

/** Something that stands between the outside world and a handler. */
export interface GuardInfo {
  /** What was found, as written: `clerkMiddleware`, `getServerSession`, `requireUser`. */
  name: string;
  how: 'middleware' | 'call' | 'decorator' | 'procedure' | 'config';
  /** Clerk, NextAuth, Supabase, Auth0, Lucia, Better Auth — or `custom`. */
  provider: string;
  path: string | null;
  line: number | null;
  /**
   * `certain` when the check sits in the handler itself; `likely` when it was found
   * in the same file, or via a middleware matcher we had to approximate. Claiming a
   * route is protected when it is not would be the worst thing this tool could do,
   * so the difference is carried all the way to the badge.
   */
  confidence: Confidence;
}

/** One environment variable and everywhere it is read. */
export interface EnvVarInfo {
  name: string;
  sites: CodeSite[];
  /** Present in `.env.example` (or `.env.sample`/`.env.template`). */
  documented: boolean;
  /** The name looks like a credential rather than a setting. */
  secret: boolean;
}

/** meta for kind === 'endpoint' */
/**
 * Why a door with no visible check is that way. `worth-a-look` is the *absence* of an
 * explanation, and is the only one of these that belongs in a headline — see
 * `model/exposure.ts` for how each is decided.
 */
export type OpenKind = 'worth-a-look' | 'page' | 'auth-mount' | 'unreadable';

export interface OpenVerdict {
  kind: OpenKind;
  /** The fact that decided it, in the reader's words. `null` for `worth-a-look`. */
  because: string | null;
}

export interface EndpointMeta {
  endpointKind: EndpointKind;
  /** GET/POST/… where the boundary has a verb. */
  method: string | null;
  /** URL path, cron expression, queue name — whatever names this door. */
  route: string | null;
  /** Which framework's convention found it. */
  framework: string;
  /** What protects it. Empty means nothing was found — that is the badge. */
  guards: GuardInfo[];
  /** This door leads to code that writes data, so leaving it open matters more. */
  writes: boolean;
  sites: CodeSite[];
  /**
   * When nothing checks this door, what explains it — see `model/exposure.ts`. Written
   * once by the analyzer so the node card, its group and the security screen cannot
   * disagree about the same route. Absent when something *does* check it.
   */
  open?: OpenVerdict;
  /** Cron expression, when a scheduler is what knocks. */
  schedule?: string;
  /** Only on the single `env` endpoint. */
  vars?: EnvVarInfo[];
  /** Which example file the variables were checked against, if any. */
  envExample?: string | null;
}

/** meta for kind === 'service' */
export interface ServiceMeta {
  category: ServiceCategory;
  /** Packages imported and hostnames called — why we believe this is in use. */
  packages: string[];
  hosts: string[];
  sites: CodeSite[];
  /** False for services that never leave the machine. */
  external: boolean;
}

/** meta for kind === 'store' */
export interface StoreMeta {
  storeKind: StoreKind;
  /** Prisma, Drizzle, Supabase, pg, the filesystem… */
  client: string;
  /** Tables/collections/buckets touched, where they could be read statically. */
  tables: string[];
  reads: number;
  writes: number;
  sites: CodeSite[];
}

/** meta for kind === 'zone' (the two boundary containers) */
export interface BoundaryGroupMeta {
  direction: 'in' | 'out';
  endpointCount: number;
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
  /**
   * Per-kind detail. Two keys are load-bearing: `symbols` on an `imports` edge (what
   * was imported) and `fields` on a `references` edge between two types (which
   * properties made the link — the type explorer draws its lines from these).
   */
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
  /** Nodes whose docstring describes code that has since changed. */
  staleDocs: number;
  /** Nodes of any kind whose description was generated rather than read from the code. */
  aiSummaries: number;
  /** The file-level subset, so it can be compared against `documentedFiles`. */
  aiFiles: number;
  /** Every inbound door, of every kind. */
  endpoints: number;
  /** The subset that answers a URL — the ones auth coverage is measured over. */
  routes: number;
  /**
   * Doors with no check found *and* nothing that explains why — the number this tool
   * exists to surface. Pages, the auth provider's own mount point and routes behind
   * an unreadable file are counted separately, because a headline that includes them
   * is one people learn to scroll past (#24).
   */
  unprotectedRoutes: number;
  /** Unchecked, with a reason: a page the browser renders, or the sign-in door. */
  publicRoutes: number;
  /** Unchecked, but a file they import could not be read — unknown, not open (#36). */
  unreadableRoutes: number;
  /** Files that could not be parsed at all. Every count above is short by their contents. */
  unreadFiles: number;
  services: number;
  externalServices: number;
  stores: number;
  envVars: number;
}

/**
 * What kind of thing a repo is, which is a different question from which framework it
 * uses. Two Python repos can both be FastAPI and one of them still be a library.
 *
 * `unknown` is a real answer and not a failure: a repo with no doors and nothing
 * exported is a legitimate thing to be, and guessing at it would put the first lie in
 * the map.
 */
export type Archetype = 'web-app' | 'service' | 'library' | 'pipeline' | 'unknown';

export interface ArchetypeVerdict {
  archetype: Archetype;
  /** One line in the reader's words — "Something you run", not "pipeline". */
  label: string;
  /** The signals that decided it, so a wrong guess can be argued with. */
  because: string[];
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
  /**
   * What kind of project this is, and why. Optional because atlases written before
   * this existed are still readable — a missing verdict means "nobody asked yet",
   * which the UI treats exactly like `unknown`.
   */
  archetype?: ArchetypeVerdict;
  stats: AtlasStats;
  /**
   * How the run divided its work: files restored from the cache versus files actually
   * read. Absent on atlases written before M5.
   */
  incremental?: { reused: number; analyzed: number };
  /** Non-fatal problems worth surfacing in the UI. */
  warnings: string[];
}

export interface Atlas {
  meta: AtlasMeta;
  nodes: AtlasNode[];
  edges: AtlasEdge[];
}

export const FORMAT_VERSION = 3;

/** Node kinds a user can drill into on the canvas. */
export const CONTAINER_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>([
  'app',
  'zone',
  'module',
  'file',
  'type',
]);

/** The two containers every boundary node hangs off. */
export const INBOUND_ID = 'zone:inbound';
export const OUTBOUND_ID = 'zone:outbound';

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

/** `key` must already identify the door uniquely (e.g. `POST /api/users`). */
export function makeEndpointId(kind: EndpointKind, key: string): string {
  return `endpoint:${kind}:${key}`;
}

export function makeServiceId(name: string): string {
  return `service:${name.toLowerCase()}`;
}

export function makeStoreId(key: string): string {
  return `store:${key.toLowerCase()}`;
}
