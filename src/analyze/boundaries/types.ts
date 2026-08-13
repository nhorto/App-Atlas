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
  SignInKind,
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
  /**
   * How often it runs, when the code declared it — `every 5 minutes` read off a
   * `PeriodicTimer`. Never set when the interval is configuration: "runs continuously"
   * is true and "every 5 minutes" would be invented.
   */
  schedule?: string;
  /** The handler is a build output rather than source somebody wrote — see EndpointMeta. */
  generatedEntry?: boolean;
  /** The handler was named in a routing table but never located — see EndpointMeta. */
  handlerUnlinked?: boolean;
  /** The code says in as many words that this door is open on purpose — see EndpointMeta. */
  declaredPublic?: boolean;
  /**
   * The route was registered on a router that arrived as a function parameter whose
   * type is definitionally a sub-group (`*gin.RouterGroup`), so its prefix was decided
   * by the caller (#151). Only consulted when prefix composition has already failed:
   * a composed address always wins, and a route this flag turns unresolved was already
   * showing a fragment — `POST ""` — as its whole name.
   */
  prefixFromCaller?: boolean;
  site: CodeSite;
  /** The atlas node that answers this door. */
  handlerId: string | null;
  /**
   * Where the handler's code sits when it is a lambda the source never named (#99):
   * `app.MapGet("/x", () => …)`. A lambda is not a definition, so `handlerId` can only
   * say "the method that registered it" — which, in a file registering twenty routes,
   * is the same 200-line method for all twenty. The language plugin turns this span
   * into a function node named after the door, and repoints `handlerId` at it.
   */
  handlerSpan?: { startIndex: number; endIndex: number; line: number; endLine: number };
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
  /**
   * This finding is the *declaration* of its table — a `DbSet<Order> Orders` property —
   * rather than a use of it. The declarations are what `table-receiver` pairing (#104)
   * resolves against, and marking them beats inferring them from a null operation,
   * which a SQL statement whose direction was unreadable also has.
   */
  declares?: boolean;
  /**
   * The dotted receiver the call was written on — `_db.Orders` — when `table` is null
   * because the file that declares the tables is a different file. Matched against the
   * project's declared tables once every file has been read (#104): the same deferred
   * pairing `reach.ts` does, so it survives incremental runs, because both halves are
   * findings that persist in the slice cache.
   */
  tableReceiver?: string;
  /**
   * The finding is evidence only if `tableReceiver` resolves to a declared table.
   * `Where`, `Select` and `Add` are LINQ before they are Entity Framework: written on a
   * DbSet they are a query, written on a list they are nothing, and which one they are
   * is exactly what the pairing decides. Unresolved, the finding is dropped — never
   * kept with a null table, because that would count somebody's list as a database.
   */
  requiresTable?: boolean;
  site: CodeSite;
}

/** One read of one environment variable. */
export interface EnvFinding {
  type: 'env';
  name: string;
  /**
   * The read went through a configuration stack rather than the environment (#101) —
   * `builder.Configuration["Stripe:Key"]`, where the value may come from
   * appsettings.json, user secrets, a vault, or the environment last. The key is a
   * setting this app requires either way; the flag is what keeps it from being
   * presented as an environment variable no deployment has ever set, and what says
   * which file — settings or `.env.example` — documents it.
   */
  config?: boolean;
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
  /**
   * The router variable a matcher was written on, when it was written on one.
   *
   * `app.use(requireAuth)` and `admin.use(requireAuth)` are the same line and mean
   * different things: the first is the whole application, the second is one prefix. The
   * matcher a router-scoped check produces is relative to wherever that router is
   * mounted, and the mount is in another file — so the pattern here is a fragment until
   * the merge layer puts the address in front of it.
   */
  routerVar?: string | null;
  /**
   * Where the check was registered, for the frameworks that only run it for what comes
   * after it. Express is the whole of it: `app.use(requireAuth)` covers the routes
   * written below that line and none of the ones above, and the two things every
   * application puts above its gate are a health check and an unauthenticated webhook
   * (#201).
   *
   * Set by the Express-family `.use` reader alone. A NestJS `APP_GUARD` covers what its
   * module serves however the file is ordered, so it leaves this unset and is never
   * asked the question.
   */
  coversFrom?: { path: string; line: number };
  /**
   * The guard was found where the check is *defined*, not where somebody calls it
   * (#155). The reference walk must not carry it through a `file:` node, because for a
   * definition-site guard the file-level reference that survives every edit is the
   * import — and "this file imports a rejecting function" is exactly what remains
   * after the wiring is deleted, which is the lost-check case the diff exists to
   * catch. Call-site guards keep the file hop: `export const GET = withTeam(…)` wires
   * its check in a module-scope call, and that reference disappears with the wiring.
   */
  definitionSite?: boolean;
  /** The atlas node that implements the check, for the `protected-by` edge. */
  sourceId: string;
}

/**
 * A file of this project that wraps somebody's HTTP client (item 42).
 *
 * healthchecks writes `hc/lib/curl.py`, whose own docstring calls it a "requests-like
 * interface for PycURL", and then makes all 282 of its outgoing requests through it.
 * Nothing outside that file imports an HTTP library at all, so a reader of any single
 * call site sees `curl.post(...)` and no library — and the boundary view said the app
 * talks to one company, email, for a product whose entire purpose is notifying eleven
 * others.
 */
export interface HttpWrapperFinding {
  type: 'http-wrapper';
  /** The file doing the wrapping. */
  path: string;
  /** The request-making names it exposes: `get`, `post`, `request`. */
  names: string[];
}

/**
 * A call to a module of this project that looks like a request, with an address.
 *
 * Reported without deciding whether the module is an HTTP client, because that is a
 * fact about the other file. `build.ts` pairs it with the `http-wrapper` that answers
 * to the same path; unpaired, it says nothing at all.
 */
export interface WrapperUrlCallFinding {
  type: 'wrapper-url-call';
  /** The imported module, resolved to a file in this project. */
  modulePath: string;
  /** The function called on it. */
  name: string;
  url: string;
  writes: boolean;
  site: CodeSite;
}

/**
 * A decorator written on a function that some routing table elsewhere names (#44).
 *
 * Django keeps the address in `urls.py` and the lock in `views.py`, and neither file
 * mentions the other's half: `path("checks/", views.checks)` says nothing about
 * `@login_required`, and `@login_required` says nothing about an address. Every other
 * detector in this file can answer from one file; this one cannot, so it reports the
 * half it can see and `build.ts` joins them by the handler's node id.
 *
 * `guard` is filled only for decorators this tool knows by name. Anything else travels
 * as a bare name and becomes a check only if the project defines something by that name
 * that turns callers away with a 401 — the same test a FastAPI dependency has to pass.
 */
export interface HandlerDecoratorFinding {
  type: 'handler-decorator';
  /** The atlas node of the decorated function. */
  nodeId: string;
  /** The decorator's last segment: `login_required`, `authorize`. */
  name: string;
  guard: GuardInfo | null;
}

/**
 * A handler whose auth is configured somewhere this reader has not read (#178).
 *
 * The counterpart of the finding above, and it exists because linking a door to its
 * handler is only worth doing if the silence that follows can be trusted. A DRF view
 * with no `permission_classes` is not an open door: DRF has a project-wide
 * `DEFAULT_PERMISSION_CLASSES` and the class simply did not override it. Following the
 * URLconf to that class and then reporting "no auth check we can see" would turn a
 * blind spot into a claim about the application — the one error this screen cannot
 * afford.
 *
 * Only heeded when the door ends the merge with no check from any other source, so a
 * ViewSet locked by its router or its mount keeps the lock it earned.
 */
export interface HandlerBlindFinding {
  type: 'handler-blind';
  /** The atlas node of the handler — a class, for every case this covers so far. */
  nodeId: string;
  /** Shown to the reader in place of a verdict. */
  why: string;
}

/**
 * A call into an auth library's own sign-in, sign-up, sign-out or password-reset
 * routine.
 *
 * The opposite of a guard, and reported for the opposite reason. A handler that hands
 * out sessions cannot demand one first, so this is the fact that *explains* an
 * unchecked door — see `model/exposure.ts`, which decides what to do with it.
 *
 * Recorded against the node the call sits in rather than against any door, because the
 * detector reading one file has no idea which doors that function answers. Whether the
 * function turns out to be a handler is settled later, once every endpoint is known.
 */
export interface SignInCallFinding {
  type: 'sign-in-call';
  /** The auth provider whose API it is: Supabase, NextAuth, Clerk… */
  provider: string;
  what: SignInKind;
  /** The call as written, so a reader can go to the line and check. */
  call: string;
  /** The atlas node the call sits in — a function, when it is inside one. */
  nodeId: string;
  site: CodeSite;
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
 * A function that hands one of its parameters to an HTTP call (#89).
 *
 * Half an answer on its own — it says a request goes out through here and nothing
 * about where. The call site holds the other half, and `reach.ts` pairs them.
 */
export interface UrlSinkFinding {
  type: 'url-sink';
  /** The name the module exports it under, so an alias at the call site still matches. */
  exportName: string;
  /** Which parameter reaches the call. */
  paramIndex: number;
  /** Whether the request sends data rather than only reading. */
  writes: boolean;
  site: CodeSite;
}

/**
 * A call into this repo's own code carrying a URL we could resolve to a constant.
 *
 * Deliberately not a service on its own. A URL passed to `writeFileSync` is licence
 * metadata being copied into a notices file, not a company this app talks to, and the
 * difference between the two is whether the function on the other end makes a request.
 */
export interface UrlThroughFinding {
  type: 'url-through';
  exportName: string;
  /** The specifier as written: `./net.mjs`, `@/lib/http`. */
  module: string;
  argIndex: number;
  /** The resolved URL, in full — the host is taken from it after pairing. */
  url: string;
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
   * What the language spells the binding with, for showing a reader where to look:
   * `Depends` in Python, `UseGuards` on a NestJS class. Defaults to `Depends`.
   */
  binds?: string;
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
   * Where the mounted router lives, as the importing file spelled it: slashes, no
   * extension, no `__init__`/`index`. Null when the import could not be followed.
   *
   * A **file** in Python and TypeScript, and a **directory** in Go, where an import names
   * a package and every `.go` file in that folder is the package. The merge layer tries
   * both readings, file first, so this field cannot promise which one it holds.
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
  /**
   * The argument as *this* file wrote it — `authRouter` in `app.use('/auth', authRouter)`
   * — where `childVar` is the name its own file gave it. Null when the mount names no
   * identifier at all (`require('./users')`).
   *
   * Kept because one `.use` call is read by two detectors, and only one of them can be
   * right about any given argument: `app.use('/auth', authRouter)` is a mount, and the
   * auth reader sees a name beginning `auth` and offers it as a check. Telling those
   * apart needs the argument's own name, and the merge layer is where the second half of
   * the evidence — whether that module builds a router — arrives.
   */
  childName?: string | null;
  hasPrefix: boolean;
  prefix: string | null;
  prefixName: string | null;
  /**
   * The method the mount was written with, for emitters that have one. `use` and `route`
   * always count; anything else counts only if the project declares it as a mount method
   * — see {@link MountMethodFinding}. Absent on emitters where the question does not
   * arise, and absent means "already known to be a mount".
   */
  method?: string;
  /**
   * Whether a `prefixName` that resolves to nothing means *no prefix* rather than *a
   * prefix we could not read*.
   *
   * `app.use(x, router)` is two different statements depending on what `x` is, and
   * JavaScript does not say which: a string is a path, a function is middleware. So the
   * name is carried on the chance that the repo declares it as a path constant, and when
   * it does not, the mount goes back to being an unprefixed one. Without this, every
   * `app.use(sentry.errorHandler, …)` would put an unreadable segment into an address
   * that is currently correct.
   */
  prefixOnlyIfNamed?: boolean;
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
 * A check attached to addresses rather than to routes or to a router variable:
 * NestJS's `consumer.apply(AuthMiddleware).forRoutes({ path: 'articles/feed', method:
 * RequestMethod.GET })`.
 *
 * The whole of the wiring is in a module file. The controller declaring the route
 * imports nothing from it, mentions no caller, and reads as wide open — which is how a
 * real NestJS application had all twenty-one of its doors reported unprotected while
 * eleven of them were behind a JWT check.
 *
 * The name is carried as written. Whether it checks anything is decided in the merge
 * against what the project's classes actually do, because a module applies a logger the
 * same way it applies a lock.
 */
export interface PathGuardFinding {
  type: 'path-guard';
  /** The name of the thing doing the checking, resolved in the merge. */
  name: string;
  /** The address it covers, as written — before any prefix the framework adds. */
  matcher: string;
  /**
   * The one HTTP method it covers, or null for all of them. `forRoutes` takes a list,
   * and `{path: 'articles/:slug', method: DELETE}` beside a public `GET` on the same
   * address is ordinary — so each entry is its own finding rather than a set of paths
   * sharing one method.
   */
  method: string | null;
  /** Only doors this framework opened are affected, since the prefix is the framework's. */
  framework: string;
  path: string;
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
  | SignInCallFinding
  | WebhookFinding
  | ClientExportFinding
  | WrapperCallFinding
  | UrlSinkFinding
  | UrlThroughFinding
  | AuthCheckerFinding
  | AuthAliasFinding
  | RouterBuildFinding
  | RouterMountFinding
  | RouterGuardFinding
  | HandlerDecoratorFinding
  | HandlerBlindFinding
  | HttpWrapperFinding
  | WrapperUrlCallFinding
  | PathGuardFinding
  | PathConstantFinding
  | MountMethodFinding
  | GlobalPrefixFinding;

/**
 * A method an app assigns onto its own router that forwards to `use` — a mount wearing
 * somebody's own name (#204).
 *
 * Ghost's `core/shared/express.js` writes:
 *
 *   app.lazyUse = function lazyUse(mountPath, requireFn) {
 *       app.use(mountPath, lazyLoad(() => requireFn()));
 *   };
 *
 * Seven calls to it carry every API mount in the repo, and without this the routes under
 * them are reported at an address two segments short of the one they answer at.
 *
 * Recognised by what the body does — it passes its own first parameter to `use` as the
 * path — and never by the name. A whitelist that grew to include `lazyUse` would mount
 * whatever anybody happened to call `lazyUse`, which is how a route gets handed an
 * address nobody serves it at.
 */
export interface MountMethodFinding {
  type: 'mount-method';
  /** The method name, as called elsewhere: `lazyUse`. */
  name: string;
  path: string;
  line: number;
}

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
