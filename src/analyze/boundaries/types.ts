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
  operation: 'read' | 'write';
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
  | RouterBuildFinding;

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
