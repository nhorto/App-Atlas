/**
 * @fileoverview What a boundary detector produces, and what it is given to work with.
 *
 * Detectors never build atlas nodes. They report *findings* — "this line opens a POST
 * route at /api/users", "this line writes to the `orders` table" — and `build.ts`
 * merges the findings into nodes and edges afterwards. That split is what lets three
 * detectors independently notice the same Stripe usage without producing three Stripe
 * boxes on the map.
 */
import type { Node, SourceFile } from 'ts-morph';
import type {
  CodeSite,
  EndpointKind,
  GuardInfo,
  ServiceCategory,
  StoreKind,
} from '../../model/types.js';
import type { ProjectInfo, SourceFileRef } from '../project.js';
import type { ProjectSignals } from '../signals.js';

/** A door into the app. */
export interface EndpointFinding {
  type: 'endpoint';
  endpointKind: EndpointKind;
  /** Identity of the door, unique across the app: `POST /api/users`, `queue emails`. */
  key: string;
  /** What to call it on screen. */
  name: string;
  method: string | null;
  route: string | null;
  framework: string;
  /** The handler writes data somewhere. Raises the stakes of an unprotected door. */
  writes: boolean;
  guards: GuardInfo[];
  site: CodeSite;
  /** The atlas node that answers this door. */
  handlerId: string | null;
  /**
   * Type names the handler's signature mentions that this file could not resolve. A
   * FastAPI dependency alias is normally one of them and is declared a file away, so
   * `build.ts` matches these against the `auth-alias` findings.
   */
  paramTypes?: string[];
  /**
   * The router variable this door is registered on — `locked` in `@locked.post(…)`.
   * Whatever dependencies that router carries reach this route and no other.
   */
  routerVar?: string | null;
  /**
   * The class the handler is a method of, when it is one. A class-based view injects
   * the class's dependencies into every route on it, so the check can be three classes
   * up the hierarchy and in another file.
   */
  handlerOwner?: string | null;
}

/** A third party the app talks to. */
export interface ServiceFinding {
  type: 'service';
  name: string;
  category: ServiceCategory;
  package: string | null;
  host: string | null;
  external: boolean;
  /** The call sends data out rather than only fetching. */
  writes: boolean;
  site: CodeSite;
}

/** A read or a write against somewhere data lives. */
export interface StoreFinding {
  type: 'store';
  /** Identity of the store, so every Prisma call lands on one box. */
  key: string;
  name: string;
  client: string;
  storeKind: StoreKind;
  table: string | null;
  /**
   * `null` when the code plainly touches this store but which way the data moved is not
   * on the page — `cur.execute(sql)` with the query built elsewhere. The site is still
   * evidence; it is only the arrow that is missing, and inventing one would put a write
   * on a screen somebody reads to find out what writes.
   */
  operation: 'read' | 'write' | null;
  /**
   * The call proves a database was used but never names the client — a literal `SELECT`
   * handed to a `.execute()` reached through the project's own helper module. Folded
   * into the named store at merge time when the project has exactly one; on its own it
   * would be a second box for the same database.
   */
  generic?: boolean;
  site: CodeSite;
}

/** One read of one environment variable. */
export interface EnvFinding {
  type: 'env';
  name: string;
  site: CodeSite;
}

/**
 * Something that checks who is calling.
 *
 * `scope` says how far it reaches: `node` guards one handler, `file` guards everything
 * declared in the file, `matcher` guards every route matching a pattern (Next.js
 * middleware). Resolving scope to actual endpoints happens in `build.ts`, once every
 * endpoint in the project is known.
 */
export interface GuardFinding {
  type: 'guard';
  guard: GuardInfo;
  scope: 'node' | 'file' | 'matcher';
  /** Set when scope is `node`. */
  nodeId: string | null;
  /** Set when scope is `matcher`: Next.js-style path patterns. */
  matchers: string[];
  /** The atlas node that implements the check, for the `protected-by` edge. */
  sourceId: string;
}

/**
 * Evidence that this file handles a webhook: a signature being verified. Promotes
 * whatever route the file declares from "route" to "webhook".
 */
export interface WebhookFinding {
  type: 'webhook';
  provider: string;
  site: CodeSite;
}

/**
 * A configured SDK client this file builds and hands to the rest of the app.
 *
 * On its own it says only that the app integrates something. Its real job is to be
 * the other half of a `wrapper-call`: `lib/stripe.ts` is where `new Stripe(...)` is
 * written, and every actual charge is written somewhere else.
 */
export interface ClientExportFinding {
  type: 'client-export';
  /** The name the module exports it under. */
  exportName: string;
  /** The package the client came from: `stripe`, `resend`, `openai`. */
  package: string;
  site: CodeSite;
}

/**
 * A call on a name that came from this repo's own code, so whatever is on the other
 * end of it is a file away. Recorded as a question rather than an answer; `build.ts`
 * resolves it against the `client-export` findings once every file has been read.
 */
export interface WrapperCallFinding {
  type: 'wrapper-call';
  /** The name as the exporting module declared it, so an alias still matches. */
  exportName: string;
  /** The specifier as written: `@/lib/stripe`, `./stripe`. */
  module: string;
  /** The whole dotted call, for deciding whether data is being sent. */
  dotted: string;
  site: CodeSite;
}

/**
 * A function that turns unauthenticated callers away — it raises or returns a 401 or
 * a 403. Naming it in a route's dependency list is how a whole family of Python
 * frameworks spells "you must be signed in".
 *
 * Reported by the file that *defines* it; the routes that depend on it are elsewhere,
 * so the two are matched in `build.ts`.
 */
export interface AuthCheckerFinding {
  type: 'auth-checker';
  /** The function's name, which is what a dependency list will say. */
  name: string;
  guard: GuardInfo;
}

/**
 * A name that stands in for a dependency: `CurrentUser = Annotated[User,
 * Depends(get_current_user)]`. A route that types a parameter with it is checked, and
 * contains no check you could point at.
 *
 * Whether the dependency is really a *check* is not decided here — that depends on
 * what `get_current_user` does, which is another file's business.
 */
export interface AuthAliasFinding {
  type: 'auth-alias';
  /** The alias as written, which is what a handler's signature will say. */
  name: string;
  /** Every function handed to a `Depends(...)` inside it. */
  depends: string[];
  /**
   * For a class: what it inherits from, by name. A controller three levels down from
   * the class that declares the check says nothing about a caller anywhere in its own
   * file, and the chain is the only thing that connects them.
   */
  bases?: string[];
  path: string;
  line: number;
}

/**
 * This file builds its router by calling `routerName`. If that name turns out to be a
 * router that carries a check — `router = UserAPIRouter(prefix="/recipes")` — then
 * every route the file declares sits behind it, and not one of them says so.
 */
export interface RouterBuildFinding {
  type: 'router-build';
  /** What built it: `APIRouter`, `UserAPIRouter`. */
  routerName: string;
  /** The variable it was bound to, which is what a route decorator names. */
  varName: string;
  path: string;
  line: number;
  /** A `prefix=` was passed, whether or not we could read what it said. */
  hasPrefix?: boolean;
  /** The prefix, when it was written as a literal. */
  prefix?: string | null;
  /** The prefix, when it was written as a name we might resolve elsewhere. */
  prefixName?: string | null;
  /**
   * Names handed to a `dependencies=[Depends(…)]` on the constructor. Whether any of
   * them is a *check* is another file's fact, so they are carried as written.
   */
  dependencies?: string[];
}

/**
 * One router hung off another: `api_router.include_router(items.router, prefix="/x")`,
 * `app.use('/api', usersRouter)`.
 *
 * The route decorator in `items.py` says `/{id}`; this finding is the only record that
 * the address a customer types is `/api/v1/items/{id}`. Nothing in the file that
 * declares the route mentions the mount, so no per-file pass can ever see it.
 */
export interface RouterMountFinding {
  type: 'router-mount';
  /** Where the mount is written. */
  path: string;
  /** The variable being mounted *onto* — the parent in the chain. */
  hostVar: string;
  /**
   * The file owning the mounted router, as the importing file spelled it: slashes, no
   * extension, no `__init__`/`index`. Null when the import could not be followed.
   *
   * Not a repo-relative path on purpose. A Python module name is relative to whichever
   * directory the app is started from, which nothing in the repo records, so the merge
   * layer matches on the tail — `app/api/routes/items` finds
   * `backend/app/api/routes/items.py`.
   */
  childModule: string | null;
  /**
   * The variable the mounted router is bound to in its own file, or null when the
   * import gave no name to match on — `export default router`. Null resolves only if
   * that file declares exactly one router.
   */
  childVar: string | null;
  hasPrefix: boolean;
  prefix: string | null;
  prefixName: string | null;
  /**
   * Whether this mount's prefix *replaces* the child's own rather than sitting in front
   * of it. Flask works that way — `register_blueprint(bp, url_prefix="/api")` discards
   * the `url_prefix` the blueprint was built with — where FastAPI concatenates. Getting
   * this backwards prints an address with a segment in it twice.
   */
  overridesPrefix?: boolean;
  /**
   * Names handed to a `dependencies=[Depends(…)]` on the mount itself. A check written
   * here guards every route under it and appears in none of their files — which is how
   * a large FastAPI service normally locks its API.
   */
  dependencies?: string[];
  line: number;
}

/**
 * A check attached to a router or an app rather than to any one route on it:
 * `APIRouter(dependencies=[Depends(get_current_user)])`, or an ASGI middleware added
 * with `app.add_middleware(AuthMiddleware)`.
 *
 * Recorded against the variable it was attached to, because that variable is the root
 * of a subtree: everything mounted under it is behind the check, and nothing outside it
 * is. Whether the name really checks anything is decided in the merge, against the
 * checkers the project defines — a middleware that gzips is attached exactly the same
 * way as one that turns strangers away.
 */
export interface RouterGuardFinding {
  type: 'router-guard';
  /** The variable it was attached to: `api_router`, `app`. */
  varName: string;
  path: string;
  /** The names it hands off to. */
  names: string[];
  /** How it was attached, which is what the reader is shown. */
  how: 'config' | 'middleware';
  line: number;
}

/**
 * A name bound to something that looks like a URL path: `API_V1_STR = "/api/v1"`.
 *
 * Only useful for turning a `prefix=SOME_NAME` back into an address, so only names
 * whose value starts with `/` are worth carrying.
 */
export interface PathConstantFinding {
  type: 'path-constant';
  name: string;
  value: string;
  path: string;
  line: number;
}

/**
 * A prefix the framework applies to every route it serves, declared once and nowhere
 * near any of them: NestJS's `app.setGlobalPrefix('api')`.
 *
 * Not a mount — there is no parent router to hang anything off — so it is carried
 * separately and applied to every door that framework opened.
 */
export interface GlobalPrefixFinding {
  type: 'global-prefix';
  /** Only doors this framework opened are affected. */
  framework: string;
  prefix: string;
  path: string;
  line: number;
}

export type BoundaryFinding =
  | EndpointFinding
  | ServiceFinding
  | StoreFinding
  | EnvFinding
  | GuardFinding
  | WebhookFinding
  | ClientExportFinding
  | WrapperCallFinding
  | AuthCheckerFinding
  | AuthAliasFinding
  | RouterBuildFinding
  | RouterMountFinding
  | RouterGuardFinding
  | PathConstantFinding
  | GlobalPrefixFinding;

/** One import statement, flattened to the name it introduced. */
export interface ImportBinding {
  local: string;
  /** Bare package name (`@scope/pkg`) or the relative specifier as written. */
  module: string;
  /** The exported name, `default`, or `*`. */
  imported: string;
  external: boolean;
}

/** A local name bound to the result of a call or a constructor. */
export interface LocalBinding {
  local: string;
  /** `PrismaClient`, `drizzle`, `createClient`, `express`… */
  callee: string;
  /** The package the callee came from, when it was imported. */
  module: string | null;
  isNew: boolean;
}

export interface DetectorContext {
  ref: SourceFileRef;
  sf: SourceFile;
  /** Atlas id of the file being analyzed. */
  fileId: string;
  project: ProjectInfo;
  signals: ProjectSignals;
  /** Local name → what it was imported from. */
  imports: Map<string, ImportBinding>;
  /** Every module specifier this file imports, bare names only. */
  packages: Set<string>;
  /** Local name → the call or constructor it was assigned. */
  locals: Map<string, LocalBinding>;
  /** The atlas node (usually a function) a syntax node sits inside. */
  enclosing(node: Node): string;
  site(node: Node, snippet?: string): CodeSite;
  emit(finding: BoundaryFinding): void;
}

/**
 * A detector looks at one file. `fileScan` runs once per file (path conventions,
 * exported names); `visit` runs for every syntax node, so it must be cheap and bail
 * early on anything it does not recognise.
 */
export interface BoundaryDetector {
  id: string;
  /** Skip the whole detector when the project cannot possibly use it. */
  enabled(ctx: DetectorContext): boolean;
  fileScan?(ctx: DetectorContext): void;
  visit?(node: Node, ctx: DetectorContext): void;
}
