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
  | 'screen'
  // A port a deployment file says it publishes on the host — the first door on this map
  // that no application code opens. Its own class rather than an `http-route` because
  // it is not a route: it has no method, no path and no handler, and half of them are
  // not even HTTP. Kept out of the auth-coverage count deliberately, and for the same
  // reason `screen` is: a web server publishing port 80 is the point, not a finding,
  // and a headline where most rows are unalarming is a headline people stop reading.
  | 'port'
  // A command a desktop app's own interface calls across its process boundary — a
  // `#[tauri::command]` the webview invokes. A door in every sense that matters to the
  // map (it is how anything reaches the engine), and kept out of the auth-coverage
  // count for the reason `screen` is: the caller is the app's own interface, not a
  // stranger, and "no auth check" on one would be a false alarm.
  | 'ipc'
  // Code that starts with the application and runs on its own — a .NET
  // `BackgroundService`, a hosted service. Not `cron`, because it declared no schedule
  // and inventing one would put a time on the screen nobody wrote; not `queue`, because
  // nothing enqueues to it. Kept out of the auth-coverage count like both of them: a
  // stranger cannot knock on it.
  | 'worker';

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
  /**
   * A framework runs this file itself — a Next.js page or layout, a SvelteKit hook, an
   * Expo screen. Nothing in the repo imports it, and that is the convention working
   * rather than a file nobody uses. Holds the framework's name; absent on every other
   * file, and on any file analyzed before this existed.
   */
  frameworkOwned?: string;
  /**
   * A manifest names this file as a way in — `main`, `bin`, an entry in `exports`, or a
   * script that runs it. Holds the field it was named in, so a reader can go and look.
   */
  declaredEntry?: string;
  /**
   * Import specifiers naming something inside this project that could not be resolved —
   * a path alias like `@/lib/db` whose mapping lives in a config this run never read.
   * Each one is a link between two of the project's own files that is missing from the
   * graph, which is why it is recorded rather than quietly dropped. Absent when there
   * were none, and on any file analyzed before this existed.
   */
  unresolvedImports?: string[];
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
  /** Tables only: the file whose model class declares these columns. */
  declaredBy?: string;
  /**
   * Tables only: the *node* of the model class that declares this table.
   *
   * Set when the schema is the class — Django, SQLAlchemy declarative, Mongoose. There
   * is no second artifact in that case, so the two are one thing wearing two hats and
   * the type explorer draws one card. A Prisma table has no such twin: its schema file
   * and any interface beside it really are two declarations.
   */
  declaredById?: string;
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
  /**
   * How many files the generated name and sentence on this node were written about,
   * when the words layer described a *group* rather than the whole subtree (#94).
   *
   * Absent when nothing was generated, when the description covers everything under the
   * node, or on an atlas written before this existed. Present and smaller than
   * `descendantFileCount` means the words and the count are about different things, and
   * every surface that prints them together has to say so.
   */
  describedFileCount?: number;
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
  /**
   * The runtime or the host sets this one — `NODE_ENV`, `PORT`, `VERCEL_URL`. Nobody
   * puts them in `.env.example`, so counting them as undocumented turns a section
   * meant to say "you forgot to write this down" into noise the reader learns to skip.
   */
  platform: boolean;
  /**
   * A configuration key, not an environment variable (#101): read through .NET's
   * provider stack, documented (or not) by `appsettings*.json` rather than
   * `.env.example`. The distinction is the whole reason the old rule refused to report
   * these at all — a JSON settings key must never appear as a name a deployment sets.
   */
  config?: boolean;
}

/** meta for kind === 'endpoint' */
/**
 * Why a door with no visible check is that way. `worth-a-look` is the *absence* of an
 * explanation, and is the only one of these that belongs in a headline — see
 * `model/exposure.ts` for how each is decided.
 *
 * `auth-mount` covers both halves of the same idea: the address an auth provider is
 * mounted on, and a handler that calls the provider's own sign-in routine. Both are
 * "the door people sign in through", which is what every screen already calls this.
 */
export type OpenKind =
  | 'worth-a-look'
  | 'page'
  | 'auth-mount'
  | 'unreadable'
  | 'generated'
  | 'unlinked'
  | 'declared-public'
  | 'in-test';

export interface OpenVerdict {
  kind: OpenKind;
  /** The fact that decided it, in the reader's words. `null` for `worth-a-look`. */
  because: string | null;
}

/**
 * What an auth library's own entry point does for whoever called it.
 *
 * The distinction that earns a door its explanation is not the method's name but who
 * can be on the other end: somebody signing in, signing up or asking for a password
 * reset has no session yet, and somebody signing out is giving one up.
 */
export type SignInKind = 'sign-in' | 'sign-up' | 'sign-out' | 'password reset';

/**
 * An auth library's own way in or out, found in a door's handler.
 *
 * This is the fact behind "public by design" for a sign-in *action* — a server action
 * or route that calls `supabase.auth.signInWithPassword` cannot require the caller to
 * be signed in already, because signing them in is what it is for. Written onto the
 * door by the analyzer so that `src/model` reads a plain field rather than importing a
 * detector, and so the evidence survives into `atlas.json`.
 *
 * The evidence is always the *call*. The name of the function containing it is a guess
 * about what somebody meant, and this field is never derived from one.
 */
export interface SignInCall {
  /** The auth provider whose API it is: Supabase, NextAuth, Clerk… */
  provider: string;
  /** Which way through the door it is. */
  what: SignInKind;
  /** The call as written, so a reader can open the file and check in ten seconds. */
  call: string;
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
  /**
   * This door's handler calls an auth library's own sign-in, sign-up, sign-out or
   * password-reset routine. Absent on every other door, and on any door analyzed
   * before this existed.
   */
  signInCall?: SignInCall;
  /**
   * Webhooks only: something in the file checks the sender's signature. That check is
   * the lock, which is what takes a webhook out of the auth count — being *called* a
   * webhook does not.
   */
  verified?: boolean;
  /**
   * This door's handler is a file a build wrote, not a file a person did — a Cloudflare
   * Worker whose `main` is `.open-next/worker.js` is a Next.js app on the edge, and the
   * routes it serves are already on the map one by one, graded individually (#123).
   *
   * The door stays: #29 is the bug where a Worker repo was told nothing answers a URL.
   * It is only excused from the auth count, because a catch-all generated at build time
   * has nowhere to put a check and counting it says "a route nobody protects" about an
   * app whose routes are all accounted for.
   */
  generatedEntry?: boolean;
  /**
   * The route was declared in a routing table, away from the code that answers it, and
   * that code was not located — a Django `path('x/', SomeView.as_view())` names a class
   * this reader cannot yet follow.
   *
   * The door stays on the map, because the URL is served and that is a fact. What it
   * must not do is join the auth count: every check such a handler carries is written
   * somewhere this atlas never looked, so "no auth check" would not be a finding but a
   * confession of where it stopped reading. netbox declares all 84 of its routes this
   * way, and counting them said "84 of 84 have no auth check" about an application
   * whose views are behind a permission mixin (#139).
   */
  handlerUnlinked?: boolean;
  /**
   * The code declares this door open on purpose — NestJS's `@UseGuards(PublicEndpointGuard)`,
   * where the guard's `canActivate` is `return true` and the class docstring says it
   * "serves as documentation that the endpoint is intentionally accessible without
   * authentication" (#152).
   *
   * Unchecked *with a reason*, which is the same shelf as a marketing page and the door
   * people sign in through. Counting it as a lock reported twentyhq/twenty's OAuth
   * callbacks as protected; counting it as silence would put twenty-seven deliberate
   * decisions on the worry list. Neither is what the author wrote down.
   */
  declaredPublic?: boolean;
  /**
   * The suite declared this door, not the app (#247). Nobody can knock on it: it exists
   * for the length of a test run, inside a server the harness stood up.
   *
   * Written on the door rather than used to delete it, because the evidence is a file
   * path and a path is the one thing this project will not drop a door over — dub serves
   * a live Stripe webhook from a directory called `test`. So the row stays on the map
   * carrying the reason, where a reader who disagrees can see what we claimed and say so;
   * what it leaves is the sentence about how many doors were judged.
   */
  declaredInTest?: boolean;
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
  /**
   * Catalog rows the code queries — `information_schema.columns`, `sqlite_master`.
   * Kept apart from `tables` because the database describing itself is not the app's
   * data model, and reported as what it is: this app inspects its own schema (#86).
   */
  catalogTables: string[];
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
  /** Files a code generator wrote. Counted apart from docstring coverage (#126). */
  generatedFiles?: number;
  /** Of those, the ones in the test zone — excluded from the auth hedge (#132). */
  unreadTestFiles?: number;
  /** Unchecked, but a file they import could not be read — unknown, not open (#36). */
  unreadableRoutes: number;
  /**
   * Routes declared in a routing table whose handler this atlas never followed (#139).
   *
   * Deliberately not folded into `publicRoutes`: those are unchecked *for a reason we
   * can state*, and these are unchecked because we stopped reading. They come out of
   * the denominator rather than joining the numerator — an unassessed door is not
   * evidence of safety and not evidence of danger.
   */
  unlinkedRoutes?: number;
  /**
   * Routes the test suite declares, which no deployed app answers at (#247).
   *
   * Set aside for the same reason as `unlinkedRoutes` and counted the same way — out of
   * the denominator, not into the numerator — but on a different ground. Those were not
   * judged; these were, and the verdict does not describe the application. Sails' HTTP
   * surface is thirty doors of which twenty-nine are `GET /res_sending_back_a_boolean/1`
   * and friends, so "29 of 30 routes have no auth check" was a true sentence about a
   * program nobody deploys.
   *
   * Counted over every route in the suite, guarded or not, because the denominator is a
   * count of doors and not a count of verdicts: directus stands a mock license server up
   * in `tests/`, and its five routes carry a real check that is still not directus's.
   */
  testRoutes?: number;
  /**
   * Guarded routes whose every guard is below `certain` — a check matched through a
   * pattern, a policy read out of a migration, a filter reached one hop away.
   *
   * The grade is carried faithfully on every card, and the headline used to drop it:
   * a real app whose 21 doors are all behind `likely`-grade RLS policies was told
   * "every one of the 21 routes has an auth check", which reads as proven and is the
   * one direction this tool must never be wrong in (#116).
   */
  likelyOnlyRoutes: number;
  /** Files that could not be parsed at all. Every count above is short by their contents. */
  unreadFiles: number;
  /**
   * Whole languages no analyzer reads, counted at discovery (#171). huginn is 469 Ruby
   * files and read as "18 files, 1 way in" with no hint the application itself was
   * never in view. When these outnumber the files read, every surface hedges — the
   * summary, the archetype and the auth headline must not present a sliver as the app.
   */
  unreadLanguages?: { ext: string; count: number }[];
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
export type Archetype = 'web-app' | 'service' | 'library' | 'pipeline' | 'analysis' | 'unknown';

export interface ArchetypeVerdict {
  archetype: Archetype;
  /** One line in the reader's words — "Something you run", not "pipeline". */
  label: string;
  /** The signals that decided it, so a wrong guess can be argued with. */
  because: string[];
}

/**
 * Whether the last run left anything this one can honestly be compared against.
 *
 * The three values are three different sentences, and collapsing any two of them is how
 * a tool ends up telling somebody their whole app is new:
 *
 *   - `none` — nobody has analyzed this project before. Everything is "new" only in the
 *     sense that everything is all there is.
 *   - `incomparable` — an atlas is on disk, but a different version of App Atlas wrote
 *     it, or it was written for a different directory. Two versions that disagree about
 *     what a route is will disagree about every route.
 *   - `compared` — a real comparison happened, including when it found nothing.
 */
export type BaselineState = 'none' | 'incomparable' | 'compared';

/** How many of something appeared, vanished, or is still there but different. */
export interface ChangeCounts {
  added: number;
  removed: number;
  changed: number;
}

/** One door that arrived, vanished or lost its lock, named the way a reader names it. */
export interface DoorChange {
  id: string;
  /** How the door is read aloud: `POST /api/users`, or its own name if it has no address. */
  name: string;
  endpointKind: EndpointKind;
  /** The code behind this door writes data, so it standing open matters more. */
  writes: boolean;
  /** The first place the door was found, for somebody about to go and look. */
  path: string | null;
  line: number | null;
}

/**
 * The doors that moved, which is the part of any diff worth interrupting somebody for.
 *
 * `newTotal` and `newOpen` are a count and a subset of it on purpose, because that is
 * the shape of the sentence people want: *three new doors appeared, two of them with
 * nothing checking them.*
 */
export interface DoorChanges {
  /** Every door that answers a URL and was not here last run. */
  newTotal: number;
  /** The subset of those with nothing checking them and nothing explaining why. */
  newOpen: DoorChange[];
  /** Doors that had a check last run and have none now. */
  lostCheck: DoorChange[];
  /** Doors that were here last run and are gone. A door that vanished is a real fact. */
  removed: DoorChange[];
}

/**
 * What moved between the previous run and this one — see `model/changes.ts` for how it
 * is worked out and, more importantly, for what "changed" was decided to mean.
 */
export interface AtlasChanges {
  baseline: BaselineState;
  /** Why there was nothing to compare against, in the reader's words. `null` once there was. */
  because: string | null;
  /** When the atlas this was compared against was generated. `null` when there was none. */
  since: string | null;
  /** Every node in the atlas, of every kind. */
  total: ChangeCounts;
  /** The same numbers split by kind, so a screen can badge files without walking the graph. */
  byKind: Partial<Record<NodeKind, ChangeCounts>>;
  doors: DoorChanges;
}

/**
 * What this run was actually able to look at.
 *
 * Two facts, and missing either of them turns a true sentence into a false one. Both
 * exist for the questions phrased as an *absence* — "nothing imports this file" — where
 * the answer is produced by not finding something, and so is indistinguishable from the
 * answer produced by never having looked.
 *
 * `references` is false when `--no-refs` skipped the pass that records who uses what.
 * `wholeRepo` is false when a big repo was narrowed to its main app (#34), which puts
 * every sibling package that might import this app outside the map.
 */
export interface AtlasCoverage {
  /** The symbol-reference pass ran. False when `--no-refs` was passed. */
  references: boolean;
  /** The analyzed directory is the whole repo the user named, not one app inside it. */
  wholeRepo: boolean;
  /**
   * Formats present in the project that import modules and that no analyzer here reads
   * — Vue, Svelte and Astro components — with how many of each there are. Empty for
   * most repos, and its emptiness is the claim: every module in this project was read.
   */
  unreadFormats: { ext: string; count: number }[];
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
  /**
   * How much of the pipeline ran, and how much of the repo was in view. Absent on
   * atlases written before this existed, which means "nobody recorded it" — a third
   * thing again from yes and from no, and the surfaces that read it treat it as
   * unknown rather than assuming the happy answer.
   */
  coverage?: AtlasCoverage;
  /**
   * How many files describe themselves as retired — by the folder they sit in, or by
   * their own opening line (#87). They stay in the graph and out of the prose, and
   * this number is how the page says so instead of quietly shrinking. Absent on
   * atlases written before this existed, which means nobody looked.
   */
  retiredFiles?: number;
  /**
   * What moved since the previous run. Optional because atlases written before this
   * existed are still readable — and because a missing value means "nobody asked",
   * which is a third thing again from "no baseline" and from "nothing changed".
   */
  changes?: AtlasChanges;
  /**
   * The commit the working tree was on when this atlas was written.
   *
   * `generatedAt` already says *when* the analyzer ran, but a reader's real question is
   * whether the code has moved since, and a timestamp cannot answer it: ten minutes is
   * nothing on an untouched repo and three features on one an agent is working in. The
   * commit can be compared, so anything reading this atlas later can tell the difference
   * between old and out of date.
   *
   * Absent whenever that could not be established — not a git repository, an unreadable
   * `.git`, a branch with no commits on it. Absent means nobody could tell, never that
   * nothing has changed, and the surfaces that read it say so in those words.
   */
  vcs?: { commit: string };
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
