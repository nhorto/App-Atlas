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

export type BoundaryFinding =
  | EndpointFinding
  | ServiceFinding
  | StoreFinding
  | EnvFinding
  | GuardFinding
  | WebhookFinding;

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
