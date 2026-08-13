/**
 * @fileoverview Findings in, atlas nodes and edges out.
 *
 * Detectors report what they saw, file by file, with no idea what any other file
 * contains. This is where those reports become the app's boundary: forty Stripe call
 * sites collapse into one Stripe box, a middleware matcher in `middleware.ts` reaches
 * across the project to lock a route declared somewhere else, and everything hangs
 * off two containers so the architecture map stays walkable.
 *
 * The rule this file exists to enforce: a route is only reported as protected when
 * something actually protects it, and how sure we are travels with the claim.
 */
import type {
  AtlasEdge,
  AtlasNode,
  CodeSite,
  Confidence,
  EndpointKind,
  EndpointMeta,
  EnvVarInfo,
  GuardInfo,
  ServiceCategory,
  ServiceMeta,
  StoreKind,
  StoreMeta,
  Zone,
} from '../../model/types.js';
import {
  INBOUND_ID,
  OUTBOUND_ID,
  makeEdgeId,
  makeEndpointId,
  makeFileId,
  makeServiceId,
  makeStoreId,
  makeTypeId,
} from '../../model/types.js';
import { catalogSchema } from '../sql.js';
import { isParked } from '../retired.js';
import { hashParts } from '../../util/hash.js';
import { isWorker } from '../wrangler.js';
import { classifyZone } from '../zones.js';
import { isCatchAllMatcher, matcherMatches } from './auth.js';
import { answersTo, composeRoutePrefixes, moduleOf, mountGraph, routerKey as moduleRouterKey } from './mounts.js';
import {
  guardThroughHops,
  reachableGuards,
  servicesThroughPyWrappers,
  servicesThroughUrlHelpers,
  servicesThroughWrappers,
} from './reach.js';
import type { ReachedGuard } from './reach.js';
import type {
  ArgPosition,
  AuthAliasFinding,
  AuthCheckerFinding,
  BoundaryFinding,
  EndpointFinding,
  GuardFinding,
  HandlerBlindFinding,
  HandlerDecoratorFinding,
  HelperRouteCallFinding,
  RouteHelperFinding,
  RouterBuildFinding,
  PathGuardFinding,
  RouterGuardFinding,
  RouterHandoffFinding,
  RouterMountFinding,
  StoreFinding,
} from './types.js';
import type { ProjectSignals } from '../signals.js';
import { appendAll } from '../../util/append.js';

export interface BoundaryGraph {
  nodes: AtlasNode[];
  edges: AtlasEdge[];
}

export interface BuildInput {
  findings: BoundaryFinding[];
  appId: string;
  signals: ProjectSignals;
  /** Every file node id that exists, so we never point an edge at a ghost. */
  knownNodeIds: Set<string>;
  /**
   * The `references` edges the language plugins resolved: who mentions whom. Used to
   * follow a check from the helper it is written in to the handler that runs it.
   */
  references?: AtlasEdge[];
  /** Atlas id → display name, so a hop can be named rather than numbered. */
  nodeNames?: Map<string, string>;
}

/** Names that look like a credential rather than a setting. */
const SECRET_PATTERN = /(secret|token|key|password|passwd|credential|private|dsn|auth|salt|signature|webhook)/i;

/**
 * Prefixes a build tool inlines into the client bundle on purpose. A variable named
 * this way is shipped to every browser that loads the app, so whatever else it is, it
 * is not a secret — `NEXT_PUBLIC_SUPABASE_ANON_KEY` matches SECRET_PATTERN on "key"
 * but is published by design.
 *
 * Badging those as secrets is not a harmless over-warning: a list where most rows are
 * false teaches the reader to skim past the one row that is real.
 */
const PUBLIC_ENV_PREFIX =
  /^(NEXT_PUBLIC_|EXPO_PUBLIC_|VITE_|REACT_APP_|GATSBY_|NUXT_PUBLIC_|VUE_APP_|STORYBOOK_|PUBLIC_)/;

/** Whether a variable name should be treated as holding a credential. */
function isSecretName(name: string): boolean {
  if (PUBLIC_ENV_PREFIX.test(name)) return false;
  // A connection string is a credential by construction (#101), whatever the database
  // is called — the name pattern below matches words, and `ConnectionStrings:Shop`
  // contains none of them.
  if (/^ConnectionStrings(:|$)/i.test(name)) return true;
  return SECRET_PATTERN.test(name);
}

/**
 * Variables the runtime or the host sets, which no `.env.example` would ever list.
 *
 * On taxonomy, `NODE_ENV` was **100% of the "undocumented" signal** — the section read
 * "1 variable is read by the code and missing from .env.example", and the one variable
 * was the one nobody is supposed to write down. A list where the only row is a false
 * positive teaches the reader that the whole section is noise, which costs more than
 * the section was ever worth.
 */
const PLATFORM_ENV = new Set([
  'NODE_ENV',
  'PORT',
  'HOST',
  'HOSTNAME',
  'CI',
  'TZ',
  'PWD',
  'HOME',
  'PATH',
  'PYTHONPATH',
  'NEXT_RUNTIME',
  'NETLIFY',
  'RENDER',
  'DYNO',
  'K_SERVICE',
  'AWS_REGION',
  'AWS_EXECUTION_ENV',
  // GitHub Actions injects these; `GITHUB_` as a prefix is *not* safe — see below.
  'GITHUB_ACTIONS',
  'GITHUB_SHA',
  'GITHUB_REF',
  'GITHUB_REF_NAME',
  'GITHUB_RUN_ID',
  'GITHUB_WORKSPACE',
  'GITHUB_REPOSITORY',
]);

/** Host-injected families, where the whole prefix belongs to the platform. */
const PLATFORM_ENV_PREFIX = /^(VERCEL_|NEXT_PUBLIC_VERCEL_|CF_PAGES|FLY_|RAILWAY_|RENDER_|AWS_LAMBDA_)/;

/**
 * Whether the runtime sets this one, rather than the reader forgetting to write it down.
 *
 * A name that looks like a credential is never excused, whatever prefix it wears.
 * `GITHUB_` looked like a safe family — GitHub Actions injects a dozen of them — until
 * it swallowed taxonomy's `GITHUB_CLIENT_SECRET` and `GITHUB_ACCESS_TOKEN`, which are
 * the app's own OAuth credentials and the single most important rows on the screen.
 * Quietly excusing a secret is a far worse error than the noisy `NODE_ENV` row this
 * rule exists to remove, so the secret test wins outright.
 */
function isPlatformName(name: string): boolean {
  if (isSecretName(name)) return false;
  return PLATFORM_ENV.has(name) || PLATFORM_ENV_PREFIX.test(name);
}

/**
 * Whether a finding describes the app someone ships, rather than the code that tests
 * it (#25).
 *
 * A test's outbound calls go to `example.com`; its database is a fixture; its exported
 * helpers are not anybody's public API. `psf/requests` was reporting four outside
 * companies, all four of them from `tests/`.
 *
 * Doors are deliberately exempt. `classifyZone` decides by path, and dub ships a real
 * Stripe webhook at `app/api/stripe/integration/webhook/test/route.ts` — a URL whose
 * last segment happens to be the word "test". Dropping a real door because of a folder
 * name is a far worse error than listing a fixture, so the heuristic is only allowed
 * to remove things that are not doors. (A library's exported names *are* filtered,
 * but they never pass through here — see `exports.ts`.)
 *
 * Router wiring is filtered even though doors are not, because a test that assembles
 * the app its own way is not a second address the route answers at — it is the same
 * route, mounted twice, and letting the harness vote turns a known address into an
 * unknown one. midday's MCP door is mounted at `/mcp` in the app and at `/mcp` under a
 * different parent in `__tests__`, and reconciling those two produced `…/`.
 */
function describesTheApp(): (finding: BoundaryFinding) => boolean {
  const zones = new Map<string, Zone>();
  const isTest = (path: string): boolean => {
    let zone = zones.get(path);
    if (zone === undefined) {
      zone = classifyZone(path);
      zones.set(path, zone);
    }
    return zone === 'test';
  };

  return (finding) => {
    if (isParked(pathOf(finding))) return false;
    switch (finding.type) {
      case 'service':
      case 'store':
      // The halves of a two-file answer are filtered here too, or the filter is one a
      // service can walk around: pair a `url-through` in a fixture with a `url-sink`
      // beside it and the company comes out the other side, after this ran. Found by
      // regenerating this repo's own map, where `test/fixtures/updatecheck` turned into
      // an outside host App Atlas was said to call.
      case 'url-sink':
      case 'url-through':
      case 'wrapper-call':
      case 'client-export':
        return !isTest(finding.site.path);
      case 'router-build':
      case 'router-mount':
      case 'router-handoff':
      case 'router-guard':
      case 'path-constant':
      case 'global-prefix':
        return !isTest(finding.path);
      // What a test file wires describes the test, not the app — the rule the router
      // family already lives by. Latent for guards until #172: a node-scoped guard
      // only reaches doors through same-file grouping or handler identity, which no
      // spec shares with an app door, but a catch-all APP_GUARD finding originates
      // anywhere and reaches everything — so the standard NestJS pattern of mocking
      // one in Test.createTestingModule would have locked the whole scope from a file
      // whose entire point is not being the application (#180).
      case 'guard':
        return !isTest(finding.guard.path ?? '');
      case 'path-guard':
        return !isTest(finding.path);
      default:
        return true;
    }
  };
}

/**
 * Whether the code that declared this door is the app's test suite rather than the app
 * (#247).
 *
 * The rule above exempts doors from its filter, and that exemption was right and
 * incomplete. Right, because a door must never be dropped for where its file sits —
 * dub serves `POST /api/stripe/integration/webhook/test`, a live endpoint Stripe posts
 * to, from `app/(ee)/api/stripe/integration/webhook/test/route.ts`, and "test" there is
 * Stripe's *test mode*. Incomplete, because the guards and the router wiring around a
 * test-declared door are filtered while the door itself survives, so sails reported
 * `GET /res_sending_back_a_boolean/1` beside its real routes, with nothing checking it.
 * Twenty-nine of its thirty doors were that, and all twenty-nine were the whole of the
 * screen that exists to find open ones.
 *
 * So this decides a *fact written on the door*, never whether the door exists. It is the
 * same set-aside #132 made for an unreadable file — a check for a production route does
 * not live in a fixture — arriving at the doors, which were left behind.
 *
 * The address is the whole of the difference, and the question is asked of it in exactly
 * the words it was asked of the path: **would this address, read as a path, be a test
 * file?** dub's is `/api/stripe/integration/webhook/test`, which reads as one, so the
 * word that made the file look like a test is a URL somebody types and is evidence about
 * nothing. Sails' is `/res_redirect/1`, which does not, so `test/` there is a location on
 * disk. That symmetry is what makes this safe for a framework whose filename *is* its
 * address — Remix's `routes/api.test.ts` serves `/api/test` and answers the question the
 * same way, with no knowledge of Remix anywhere in here.
 *
 * `classifyZone` is asked both times rather than a word list being restated, for the
 * reason `compose.ts` gives: a reader should be able to guess why, and there is only one
 * place to change it. The extension is fixed at `.ts` because the question is about the
 * directory words, which every language table in `zones.ts` spells the same way.
 */
function declaredInTest(finding: EndpointFinding): boolean {
  if (classifyZone(finding.site.path) !== 'test') return false;
  const route = finding.route;
  if (route === null || route === '') return true;
  return classifyZone(`${route}/x.ts`) !== 'test';
}

function pathOf(finding: BoundaryFinding): string {
  if ('site' in finding && finding.site) return finding.site.path;
  if ('path' in finding && typeof finding.path === 'string') return finding.path;
  return '';
}

export function buildBoundaryGraph(raw: BuildInput): BoundaryGraph {
  const nodes: AtlasNode[] = [];
  const edges: AtlasEdge[] = [];

  // Before anything is merged: a door's identity is its address, and half the address
  // lives in the file that mounted its router rather than the file that declared it.
  // Helper-registered doors are expanded first so they go through that composition on
  // exactly the same terms as a route somebody wrote out longhand — the prefix, the
  // ellipsis when it cannot be read, and the ordering of the checks around it.
  const declared = raw.findings.filter(describesTheApp());
  const shipped = composeRoutePrefixes([...declared, ...helperRoutes(declared)]);

  // A call made through a wrapper module is a real call to a real company; it just
  // took two files to say so. Resolved before anything is merged, so those sites land
  // on the same box as the direct ones rather than a second one beside it.
  const input: BuildInput = {
    ...raw,
    findings: [
      ...shipped,
      ...servicesThroughWrappers(shipped),
      ...servicesThroughUrlHelpers(shipped),
      ...servicesThroughPyWrappers(shipped),
    ],
  };

  const endpoints = collectEndpoints(input);
  const checkers = input.findings.filter((f): f is AuthCheckerFinding => f.type === 'auth-checker');
  const decorated = input.findings.filter((f): f is HandlerDecoratorFinding => f.type === 'handler-decorator');
  const decoratorGuards = handlerDecoratorGuards(decorated, checkers);
  // Which decorated functions the reference walk may carry a check *up* from.
  //
  // Not the ones some routing table already names. A Django views file is full of views
  // that mention each other — `login` redirects to `profile`, and `profile` carries
  // `@login_required` — and one hop of that put a check on healthchecks' login page,
  // its signup page and its admin login: #147 with a different accent, a door the
  // reader is told is locked and is not.
  //
  // A function *nothing* routes is the other case, and the useful one. `checks()`
  // answers `/api/v1/checks/` by returning `get_checks(request)` or
  // `create_check(request)`, both decorated, neither an address of its own — so the
  // check reaches the door, and the trail on screen names the helper it came through.
  //
  // And never a class. A check on a class travels by *inheritance* and by nothing else,
  // which `checkInherited` follows through the bases; a reference edge between two
  // classes is "mentions", and mentioning a locked view is exactly what an open login
  // page does. Left in, `class SecureView(LoginRequiredMixin)` walked to the billing
  // view that inherits it, then on to the login page that names the billing view, and
  // reported the front door locked — #147 for the third time, so the rule is written
  // here rather than discovered again.
  const routed = new Set<string>();
  for (const endpoint of endpoints.values()) for (const id of endpoint.handlerIds) routed.add(id);
  const guards = [
    ...input.findings.filter((f): f is GuardFinding => f.type === 'guard'),
    ...decoratorGuards.filter(
      (guard) => guard.nodeId !== null && !routed.has(guard.nodeId) && !guard.nodeId.startsWith('type:'),
    ),
  ];
  applyWebhookPromotion(endpoints, input.findings);
  applyHandlerWrites(endpoints, input.findings);
  applyGuards(
    endpoints,
    guards,
    reachableGuards(guards, input.references ?? [], input.nodeNames ?? new Map()),
    input.findings.filter((f): f is RouterBuildFinding => f.type === 'router-build'),
    input.findings.filter((f): f is RouterMountFinding => f.type === 'router-mount'),
    input.findings.filter((f): f is RouterHandoffFinding => f.type === 'router-handoff'),
  );
  applyHandlerDecorators(endpoints, decoratorGuards);
  applyDependencyGuards(
    endpoints,
    checkers,
    input.findings.filter((f): f is AuthAliasFinding => f.type === 'auth-alias'),
    input.findings.filter((f): f is RouterBuildFinding => f.type === 'router-build'),
    input.findings.filter((f): f is RouterMountFinding => f.type === 'router-mount'),
    input.findings.filter((f): f is RouterGuardFinding => f.type === 'router-guard'),
    input.findings.filter((f): f is PathGuardFinding => f.type === 'path-guard'),
  );
  // Last, and after every source of a check has had its say: a door left with nothing
  // whose handler told us its lock is written elsewhere goes back to saying so.
  applyHandlerBlindness(
    endpoints,
    input.findings.filter((f): f is HandlerBlindFinding => f.type === 'handler-blind'),
  );

  nameCommandLineDoors(endpoints, input);

  const envEndpoint = collectEnv(input);
  if (envEndpoint) endpoints.set(envEndpoint.id, envEndpoint);

  const services = collectServices(input);
  const stores = collectStores(input);

  if (endpoints.size > 0) nodes.push(container(INBOUND_ID, 'Ways in', 'in', endpoints.size, input.appId));
  if (services.size + stores.size > 0) {
    nodes.push(container(OUTBOUND_ID, 'Where data goes', 'out', services.size + stores.size, input.appId));
  }

  for (const endpoint of endpoints.values()) {
    nodes.push(endpointNode(endpoint));
    addEdges(edges, endpointEdges(endpoint, input.knownNodeIds));
  }
  for (const service of services.values()) {
    nodes.push(serviceNode(service));
    addEdges(edges, flowEdges(service.id, service.meta.sites, service.writes, input.knownNodeIds));
  }
  // Every table a schema file declares already has a proper card, columns and all.
  // Queries naming a declared table still count: their edges are pointed at the
  // declared card, so "used in N places" stays true instead of resetting to zero the
  // day a migration finally writes the table down.
  const declaredTableIds = new Map<string, string>();
  const prisma = input.signals.prisma;
  if (prisma) for (const model of prisma.models) declaredTableIds.set(model.toLowerCase(), makeTypeId(prisma.path, model));
  for (const table of input.signals.sqlSchema?.tables ?? []) {
    if (!declaredTableIds.has(table.name.toLowerCase())) {
      declaredTableIds.set(table.name.toLowerCase(), makeTypeId(table.path, table.name));
    }
  }

  for (const store of stores.values()) {
    nodes.push(storeNode(store));
    addEdges(edges, storeEdges(store, input.knownNodeIds));

    // Tables the code names in its queries — `.from('cellar_bottles')`, an INSERT —
    // are the user's actual data even when no schema file is in the repo, which for
    // a Supabase app is the normal case. Each becomes a shape the data view can
    // draw. Columns are unknowable from here, so the card says so instead of lying.
    if (store.meta.storeKind !== 'sql' && store.meta.storeKind !== 'nosql') continue;
    for (const [table, sites] of store.tableSites) {
      const declaredId = declaredTableIds.get(table.toLowerCase());
      const tableId = declaredId ?? makeTypeId(store.id, table);
      if (!declaredId) nodes.push(observedTableNode(store, table, sites));
      addEdges(
        edges,
        flowEdges(tableId, sites, false, input.knownNodeIds).map((edge) => ({
          ...edge,
          kind: 'references' as const,
        })),
      );
    }
  }

  return { nodes, edges };
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

interface MergedEndpoint {
  id: string;
  kind: EndpointKind;
  name: string;
  meta: EndpointMeta;
  /** Atlas nodes that answer this door. */
  handlerIds: Set<string>;
  /**
   * The subset of `handlerIds` that is really the scope a registration was written in
   * (#255). Kept rather than filtered out at the door: it is still the right end for an
   * `exposed-by` edge and the right parent for a synthesized handler, and it is still
   * where the door's code lives. It is only useless for one question — whether a check
   * found nearby covers this door — and {@link handlersProper} is what asks that one.
   */
  scopeIds: Set<string>;
  /** Unresolved type names from the handler's signature; see `EndpointFinding`. */
  paramTypes: Set<string>;
  /** One `routerKey` for each place this door is registered. */
  routers: Set<string>;
  /** The classes whose methods answer this door, for class-based views. */
  owners: Set<string>;
}

/**
 * Identifies a router by the variable it was assigned to, not just the file it lives
 * in: one module holding a locked router and an open one beside it is ordinary, and
 * claiming the open one is locked is the worse of the two possible mistakes.
 *
 * Written with an explicit escape rather than a literal NUL byte — the byte makes the
 * whole source file read as binary, and `grep` then says nothing about a thousand
 * lines of it.
 */
function routerKey(path: string, varName: string): string {
  return `${path}\0${varName}`;
}

/**
 * The same router as the mount graph spells it — by the module another file would
 * import, rather than by the file on disk. A route knows which file it was written in;
 * a mount only ever knows the module name it imported.
 */
function byModule(key: string): string {
  const cut = key.indexOf('\0');
  return moduleRouterKey(moduleOf(key.slice(0, cut)), key.slice(cut + 1));
}

/** How each language starts a file from a shell. */
const RUNNERS: Record<string, string> = {
  py: 'python',
  mjs: 'node',
  cjs: 'node',
  js: 'node',
  ts: 'node',
  sh: 'sh',
  rb: 'ruby',
};

/**
 * Gives a command-line door the command somebody types (#88).
 *
 * An HTTP door reads `POST /api/users` — the address, then the file that answers at it.
 * A CLI door read `scripts/_audit/census.py — scripts/_audit/census.py`: the same string
 * twice, once for a name it never had. On the repo that turned this up, 103 of 105 ways
 * in were that line, and a section that says nothing a hundred times is a section a
 * reader learns to skip.
 *
 * A manifest that names the command wins outright — `[project.scripts] estimate =
 * "pkg.cli:main"` means the thing you type is `estimate`, and the path is an
 * implementation detail. Otherwise the command is the interpreter and the path, which
 * is a fact and is also exactly what a person would type. Nothing is invented: a file
 * whose extension has no known runner keeps its path and the renderer prints it once.
 */
function nameCommandLineDoors(endpoints: Map<string, MergedEndpoint>, input: BuildInput): void {
  const entries = input.signals.entryPoints ?? [];
  for (const endpoint of endpoints.values()) {
    if (endpoint.meta.endpointKind !== 'cli' || endpoint.meta.route) continue;
    const path = endpoint.meta.sites[0]?.path;
    if (!path) continue;

    const declared = entries.find((entry) => entry.command && entry.path === path);
    if (declared?.command) {
      endpoint.meta.route = declared.command;
      continue;
    }
    const runner = RUNNERS[path.split('.').pop()?.toLowerCase() ?? ''];
    if (runner) endpoint.meta.route = `${runner} ${path}`;
  }
}

function collectEndpoints(input: BuildInput): Map<string, MergedEndpoint> {
  const merged = new Map<string, MergedEndpoint>();

  const add = (finding: EndpointFinding) => {
    const id = makeEndpointId(finding.endpointKind, finding.key);
    const existing = merged.get(id);
    if (existing) {
      // One declaration outside the suite is the whole answer: an address the app serves
      // and a test re-declares is served, and a fact that says otherwise would take a
      // real door off the count. The flag only survives while every site agrees.
      if (!declaredInTest(finding)) delete existing.meta.declaredInTest;
      existing.meta.sites.push(finding.site);
      existing.meta.writes = existing.meta.writes || finding.writes;
      for (const guard of finding.guards) existing.meta.guards.push(guard);
      if (finding.handlerId) {
        existing.handlerIds.add(finding.handlerId);
        if (finding.handlerIsScope) existing.scopeIds.add(finding.handlerId);
      }
      // The class file read the timer and the registration did not; whichever arrived
      // first, the door keeps the schedule somebody actually wrote down.
      if (finding.schedule && !existing.meta.schedule) existing.meta.schedule = finding.schedule;
      for (const name of finding.paramTypes ?? []) existing.paramTypes.add(name);
      if (finding.routerVar) existing.routers.add(routerKey(finding.site.path, finding.routerVar));
      if (finding.handlerOwner) existing.owners.add(finding.handlerOwner);
      return;
    }
    merged.set(id, {
      id,
      kind: finding.endpointKind,
      name: finding.name,
      meta: {
        endpointKind: finding.endpointKind,
        method: finding.method,
        route: finding.route,
        framework: finding.framework,
        guards: [...finding.guards],
        writes: finding.writes,
        ...(finding.schedule ? { schedule: finding.schedule } : {}),
        ...(finding.generatedEntry ? { generatedEntry: true } : {}),
        ...(finding.handlerUnlinked ? { handlerUnlinked: true } : {}),
        ...(finding.declaredPublic ? { declaredPublic: true } : {}),
        ...(declaredInTest(finding) ? { declaredInTest: true } : {}),
        sites: [finding.site],
      },
      handlerIds: new Set(finding.handlerId ? [finding.handlerId] : []),
      scopeIds: new Set(finding.handlerId && finding.handlerIsScope ? [finding.handlerId] : []),
      paramTypes: new Set(finding.paramTypes ?? []),
      routers: new Set(finding.routerVar ? [routerKey(finding.site.path, finding.routerVar)] : []),
      owners: new Set(finding.handlerOwner ? [finding.handlerOwner] : []),
    });
  };

  for (const finding of input.findings) {
    if (finding.type === 'endpoint') add(finding);
  }

  // Crons declared in `vercel.json` never appear in the source at all. When one points
  // at a route we already found, the two are the same door — the schedule is simply
  // the reason it gets knocked on, so fold it in rather than listing it twice.
  for (const cron of input.signals.crons) {
    const site: CodeSite = {
      path: cron.source,
      line: 1,
      nodeId: null,
      snippet: `${cron.schedule} → ${cron.route}`,
    };
    const target = [...merged.values()].find(
      (endpoint) => endpoint.kind === 'http-route' && endpoint.meta.route === cron.route,
    );
    if (target) {
      target.kind = 'cron';
      target.meta.endpointKind = 'cron';
      target.meta.method = 'CRON';
      target.meta.framework = 'Vercel Cron';
      target.meta.schedule = cron.schedule;
      target.meta.writes = true;
      target.name = `${cron.route}`;
      target.meta.sites.push(site);
      continue;
    }
    add({
      type: 'endpoint',
      endpointKind: 'cron',
      key: `cron ${cron.schedule} ${cron.route}`,
      name: `${cron.route}`,
      method: 'CRON',
      route: cron.route,
      framework: 'Vercel Cron',
      writes: true,
      guards: [],
      site,
      handlerId: null,
    });
  }

  addPostgrestDoors(input, add);
  addWorkerDoors(input, add);
  addPublishedPortDoors(input, add);

  return merged;
}

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** An argument's position resolved against the list a caller actually wrote. */
function argAtPosition<T>(position: ArgPosition, list: T[]): T | undefined {
  return position.from === 'start' ? list[position.index] : list[list.length - 1 - position.index];
}

/**
 * The doors a repo declares through a helper of its own (#229).
 *
 * Whether `setupPageRoute` registers routes is a fact from the file that defines it, and
 * whether `/login` is an address is a fact from the 334 files that call it, so this is
 * the only place both are known. Same division as `mount-method`.
 *
 * ## The middleware is deliberately not read as a check
 *
 * The obvious next step — forward the helper's middleware list onto the doors it opens —
 * is the one thing here that would make the map worse. NodeBB builds every list in
 * `setupPageRoute` and `setupApiRoute` starting with `middleware.authenticateRequest`,
 * and that function ends:
 *
 *   if (!res.headersSent) auth.setAuthVars(req);
 *   return !res.headersSent;
 *
 * — it returns *true* for an anonymous caller and calls `next()`. It parses a session; it
 * does not refuse anyone. It is also on `/login` and `/register`, which is the proof:
 * a check that stands on the door handing out sessions is not a lock. Claiming it would
 * put a confident green tick on all 300-odd doors of a forum whose entire public side is
 * readable by anybody, and `authenticateRequest` matches `GUARD_PREFIX` on its name
 * alone, so nothing downstream would have caught it.
 *
 * So these doors arrive with no checks and read as "not examined", which is what the tool
 * says everywhere else it has not established an answer. An address that is right with an
 * auth column that is blank is worth having; the same address wearing a lock that is not
 * there is the failure this file exists to prevent.
 *
 * An earlier version of this comment claimed the rule cost NodeBB's 61 admin pages a real
 * lock, because `setupAdminPageRoute` injects `middleware.admin.isAdminPage`. Reading the
 * body says otherwise:
 *
 *   middleware.isAdminPage = function (req, res, next) {
 *       res.locals.isAdminPage = true;
 *       next();
 *   };
 *
 * It sets a flag. NodeBB's real admin gate is a path matcher in `src/routes/index.js`,
 * `router.all('(/+admin|/+admin/*?)', …, middleware.admin.checkPrivileges)`, which is a
 * shape this file already reads. So the withdrawal costs nothing there — and the claim
 * that it did was made from a *name*, which is the mistake the whole rule is about.
 * See `test/routehelper.test.js`, which records this as a decision rather than an oversight.
 */
function helperRoutes(findings: BoundaryFinding[]): EndpointFinding[] {
  const doors: EndpointFinding[] = [];
  const add = (finding: EndpointFinding) => void doors.push(finding);
  const helpers = new Map<string, RouteHelperFinding>();
  const calls: HelperRouteCallFinding[] = [];
  /** Variables this repo builds a router in, so a fragment can be told from an address. */
  const built = new Set<string>();
  for (const finding of findings) {
    if (finding.type === 'router-build') built.add(`${finding.path}\0${finding.varName}`);
  }
  for (const finding of findings) {
    // Keyed on the last segment: the definition knows it as `setupPageRoute`, and a
    // caller may have written `helpers.setupPageRoute` or destructured the name out.
    if (finding.type === 'route-helper') helpers.set(finding.name, finding);
    else if (finding.type === 'helper-route-call') calls.push(finding);
  }
  if (helpers.size === 0) return doors;

  for (const call of calls) {
    const helper = helpers.get(call.callee.split('.').pop() ?? call.callee);
    if (!helper) continue;

    const route = argAtPosition(helper.pathArg, call.args);
    if (!route || !route.startsWith('/')) continue;

    const verb =
      'literal' in helper.verb ? helper.verb.literal : (argAtPosition(helper.verb.at, call.args) ?? null);
    // A door whose verb the caller computed is a door we cannot name. `ANY` would be a
    // guess printed as a fact, and skipping loses less than that costs.
    if (!verb) continue;
    const method = verb.toLowerCase() === 'all' ? 'ANY' : verb.toUpperCase();

    const routerVar = argAtPosition(helper.router, call.names) ?? null;
    const handler = helper.handler ? (argAtPosition(helper.handler, call.names) ?? null) : null;

    for (const template of helper.templates) {
      const full = template.replace('{}', route);
      add({
        type: 'endpoint',
        endpointKind: 'http-route',
        key: `${method} ${full}`,
        name: `${method} ${full}`,
        method,
        route: full,
        framework: call.framework,
        writes: WRITE_METHODS.has(method),
        // Only what the *caller* wrote in the argument list — see `helperGuards`. The
        // list the helper injects into every door it opens is still refused, for the
        // reason above; this is the one written beside this door by the person who
        // declared it, and is the same evidence as a plain `router.get('/x', check, h)`.
        guards: call.guards,
        site: {
          path: call.path,
          line: call.line,
          nodeId: call.nodeId,
          snippet: `${call.callee}(…, '${route}', …${handler ? ` ${handler}` : ''})`,
        },
        handlerId: null,
        routerVar,
        // A router this file built with `express.Router()` is a router somebody else
        // mounts, so its fragment is not its address until that mount has been read —
        // and `/:cid` on its own is not a door, it is four different doors wearing one
        // name. #151's rule, arriving through a helper. A router the file was *handed*
        // is the other case: `setupPageRoute(app, '/login', …)` is already whole, and
        // putting an ellipsis in front of it would describe a prefix that is usually
        // empty.
        ...(helper.headUnread
          ? { prefixUnread: true }
          : routerVar && built.has(`${call.path}\0${routerVar}`)
            ? { prefixFromCaller: true }
            : {}),
      });
    }
  }

  return doors;
}

/**
 * Doors that infrastructure declares, rather than code (#45).
 *
 * A published container port is a listening socket with no handler anywhere in this
 * repo. There is no auth check to look for because there is nothing of ours in front of
 * it — which is exactly why `ports: - "5432:5432"` on a database is worth a reader's
 * eye and why no amount of reading the application would ever surface it.
 *
 * Three things this deliberately does not do.
 *
 * It does not join the auth coverage count. `port` is not in `AUTH_RELEVANT`, so these
 * never reach the "N of M routes have no auth check" sentence, and that is a decision
 * rather than an oversight: a web server publishing port 80 is the *point*, and every
 * repo with a Compose file in it would otherwise gain a handful of rows saying "nothing
 * checks this" about ports that nothing is supposed to check. `model/exposure.ts` exists
 * because a number whose rows are mostly unalarming is a number people stop reading.
 *
 * It does not merge the files. Each declaration is reported against the file that made
 * it, because which Compose files somebody runs together is not written down anywhere in
 * the repo — see `readComposePorts`.
 *
 * And it does not say a port is open. The name it writes has the *file* as its subject,
 * so what the reader is told is what was actually read: this file says it publishes
 * this port. Whether anyone runs the file, and whether a firewall lets anybody reach the
 * machine, are not facts this repo contains.
 */
function addPublishedPortDoors(input: BuildInput, add: (finding: EndpointFinding) => void): void {
  for (const port of input.signals.publishedPorts) {
    add({
      type: 'endpoint',
      endpointKind: 'port',
      key: `port ${port.configPath} ${port.target} ${port.raw}`,
      name: publishedPortDoorName(port),
      method: port.protocol.toUpperCase(),
      // Not a URL and not a path. `route` is the field every other surface prints as an
      // address, and `0.0.0.0:5432` in that column reads as something a browser could
      // open — so the whole address lives in the name, in words, instead.
      route: null,
      framework: port.declaredBy,
      // Nothing is claimed about what the container does with the data it is handed.
      // The image is somebody else's build and this repo does not contain it.
      writes: false,
      guards: [],
      site: { path: port.configPath, line: port.line, nodeId: null, snippet: port.raw },
      // No code in this repo answers this port, so there is nothing to hang it off.
      handlerId: null,
    });
  }
}

/**
 * The sentence a reader is shown for an infrastructure door, and the deliverable of #45
 * as much as the parsing is.
 *
 * The subject is the file, always: *"compose.override.yml publishes 5432 on every
 * interface → db"*. What we read was a file in a repo, not a socket on a server, and a
 * name with no subject at all ("port 5432 open") is read as the second. Nobody is told
 * a port is open on their machine; they are told what their own deployment file says.
 *
 * Where it is bound is spelled out in both directions on purpose. "on every interface"
 * and "on 127.0.0.1 only" are different facts with very different consequences, and
 * leaving the common case unsaid would make its absence carry the meaning — which is
 * how a reader ends up assuming the safer one.
 */
function publishedPortDoorName(port: {
  configPath: string;
  target: string;
  bindAddress: string | null;
  hostPort: string | null;
  hostPortVar: string | null;
  containerPort: string;
  protocol: 'tcp' | 'udp';
}): string {
  const udp = port.protocol === 'udp' ? '/udp' : '';
  const where = bindPhrase(port.bindAddress);

  let what: string;
  if (port.hostPort) what = `${port.hostPort}${udp} ${where}`;
  else if (port.hostPortVar) what = `the port ${port.hostPortVar} is set to, ${where}`;
  // No host port at all: Docker picks a free one when the stack starts, so there is no
  // number to print and printing the container's would be printing the wrong one.
  else what = `port ${port.containerPort}${udp} inside the container, on a host port Docker picks${
    port.bindAddress ? `, ${where}` : ''
  }`;

  return `${port.configPath} publishes ${what} → ${port.target}`;
}

function bindPhrase(bind: string | null): string {
  if (bind === null) return 'on every interface';
  if (bind.startsWith('$')) return `on the address ${bind.slice(1)} is set to`;
  return `on ${bind} only`;
}

/** Directories a build writes into, and nobody writes a request handler in by hand. */
const BUILT_ENTRY = /(^|\/)\.?(open-next|svelte-kit|vercel|next|nuxt|output|dist|build)\//;

/**
 * Whether a Worker's entry is something a build produced rather than something a person
 * wrote (#123).
 *
 * `wrangler.jsonc` with `main: ".open-next/worker.js"` is a Next.js app deployed to the
 * edge, not a hand-written Worker: the adapter re-serves routes the framework detectors
 * have already found and graded one by one. The door stays on the map — #29 is the bug
 * where a Worker repo was told in writing that nothing answers a URL, and that must not
 * come back — but it stops counting as a route nobody protects, because a catch-all
 * generated at build time cannot carry a check and its contents are already graded
 * individually. See `classifyOpenDoors`.
 *
 * The test is deliberately the entry path and nothing else. The tempting rule — "exempt
 * the catch-all when the repo has other routes" — is wrong, and dogfooding proved it:
 * a repo with two real Workers (`main: "src/worker.ts"`) and no other doors reported
 * `2 of 2 routes have no auth check`, which was **true**. Excusing those would have
 * hidden two genuinely open doors on the edge. A hand-written entry is a real door
 * however few of them there are; a generated one never was.
 */
function isBuiltAdapter(main: string): boolean {
  return BUILT_ENTRY.test(main.replace(/\\/g, '/'));
}

/**
 * A Cloudflare Worker answers requests on the open internet, and nothing in the repo
 * calls it — the platform does, which is why only `wrangler.toml` knows it exists.
 * Without this the archetype would state, in writing, that an app deployed to the edge
 * has no network surface.
 *
 * A Worker has no route table: one script answers every path on its domain, so the
 * door is the script rather than a URL pattern, and `/*` is the honest way to draw it.
 * Pages deploys are deliberately not doors — they answer URLs too, but with static
 * files, and no code in this repo runs on the request.
 */
function addWorkerDoors(input: BuildInput, add: (finding: EndpointFinding) => void): void {
  for (const worker of input.signals.workers) {
    if (!isWorker(worker)) continue;
    // `declaredEntry` is what the config says; `entry` is null until someone has run
    // a build. The door is real either way — the handler is only hung off the file
    // when there is a file to hang it off.
    const main = worker.declaredEntry as string;
    const label = worker.name ?? main;

    add({
      type: 'endpoint',
      endpointKind: 'http-route',
      key: `worker ${worker.configPath}`,
      name: `ANY /* (${label})`,
      method: 'ANY',
      route: '/*',
      framework: 'Cloudflare Workers',
      writes: true,
      guards: [],
      generatedEntry: isBuiltAdapter(main),
      site: {
        path: worker.configPath,
        line: 1,
        nodeId: null,
        snippet: `main = "${main}"`,
      },
      // The entry file is the handler, so the door hangs off real code and the map can
      // walk from it into whatever the Worker calls.
      handlerId: worker.entry && input.knownNodeIds.has(`file:${worker.entry}`) ? `file:${worker.entry}` : null,
    });

    for (const schedule of worker.crons) {
      add({
        type: 'endpoint',
        endpointKind: 'cron',
        key: `worker-cron ${worker.configPath} ${schedule}`,
        name: `${schedule} (${label})`,
        method: 'CRON',
        route: null,
        framework: 'Cloudflare Workers',
        writes: true,
        guards: [],
        site: {
          path: worker.configPath,
          line: 1,
          nodeId: null,
          snippet: `crons = ["${schedule}"]`,
        },
        handlerId: worker.entry && input.knownNodeIds.has(`file:${worker.entry}`) ? `file:${worker.entry}` : null,
      });
    }
  }
}

/** The HTTP verbs PostgREST puts on every table it exposes. */
const POSTGREST_VERBS: { method: string; writes: boolean }[] = [
  { method: 'GET', writes: false },
  { method: 'POST', writes: true },
  { method: 'PATCH', writes: true },
  { method: 'DELETE', writes: true },
];

/**
 * Supabase's quietest door: it publishes a REST endpoint for every table in the
 * database, so a migration file is not only a description of where data is kept — it
 * is a description of a public API surface. Nothing in the repo calls these routes,
 * which is exactly why they are easy to forget and why they turn up in the data-leak
 * stories this tool exists to prevent.
 *
 * The lock is RLS, and it is readable from the same migrations: a table with row level
 * security enabled is guarded, a table without it is open to anyone holding the anon
 * key — which ships to the browser. The guard is only ever `likely`, because a policy
 * that exists is not necessarily a policy that is correct, and this is the last place
 * in the tool that should round up.
 */
function addPostgrestDoors(input: BuildInput, add: (finding: EndpointFinding) => void): void {
  const schema = input.signals.sqlSchema;
  if (!schema) return;

  // Only Supabase fronts Postgres with PostgREST. A repo that keeps plain SQL
  // migrations under `migrations/` has no such surface, and inventing one would be a
  // false claim about an app's attack surface — worse than saying nothing.
  const isSupabase =
    schema.files.some((file) => file.startsWith('supabase/')) ||
    input.signals.packages.has('@supabase/supabase-js');
  if (!isSupabase) return;

  for (const table of schema.tables) {
    // `storage.objects` and friends belong to Supabase, not to this repo.
    if (table.name.includes('.') && !table.name.startsWith('public.')) continue;
    const bare = table.name.replace(/^public\./, '');

    const site: CodeSite = {
      path: table.path,
      line: 1,
      nodeId: null,
      snippet: table.rlsEnabled
        ? `${bare} · row level security enabled`
        : `${bare} · no row level security`,
    };

    const guards: GuardInfo[] = table.rlsEnabled
      ? [
          {
            name:
              table.policies.length > 0
                ? `RLS · ${plural(table.policies.length, 'policy', 'policies')}`
                : 'RLS · no policy, so nothing is allowed through',
            how: 'config',
            provider: 'Supabase',
            path: table.path,
            line: table.policies[0]?.line ?? null,
            confidence: 'likely',
          },
        ]
      : [];

    for (const verb of POSTGREST_VERBS) {
      add({
        type: 'endpoint',
        endpointKind: 'http-route',
        key: `postgrest ${verb.method} ${bare}`,
        name: `${verb.method} /rest/v1/${bare}`,
        method: verb.method,
        route: `/rest/v1/${bare}`,
        framework: 'Supabase PostgREST',
        writes: verb.writes,
        guards: [...guards],
        site,
        handlerId: null,
      });
    }
  }
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * A door "writes" if the code behind it does, not only if its verb suggests it might.
 *
 * The verb is a decent guess for an API route and no guess at all for a page, which
 * every framework reports as a read. A Next.js server component that inserts a row on
 * render is a door someone should look at, and until this ran it was indistinguishable
 * from a static marketing page — which is precisely the door the "it is only a page"
 * rule is allowed to excuse (#24).
 *
 * Only ever sets the flag, never clears it: a POST route stays a writer whether or not
 * we could see which table it touches.
 */
function applyHandlerWrites(endpoints: Map<string, MergedEndpoint>, findings: BoundaryFinding[]): void {
  const writers = new Set<string>();
  for (const finding of findings) {
    if (finding.type !== 'store' || finding.operation !== 'write') continue;
    if (finding.site.nodeId) writers.add(finding.site.nodeId);
  }
  if (writers.size === 0) return;

  for (const endpoint of endpoints.values()) {
    if (endpoint.meta.writes) continue;
    for (const handlerId of endpoint.handlerIds) {
      if (!writers.has(handlerId)) continue;
      endpoint.meta.writes = true;
      break;
    }
  }
}

/**
 * A file that verifies a signature is handling a webhook, whatever its route is
 * called. Promoting it matters because a webhook is never "unprotected" in the same
 * sense as a public route — the signature *is* the lock.
 */
function applyWebhookPromotion(endpoints: Map<string, MergedEndpoint>, findings: BoundaryFinding[]): void {
  const verifiedFiles = new Map<string, string>();
  for (const finding of findings) {
    if (finding.type === 'webhook') verifiedFiles.set(finding.site.path, finding.provider);
  }

  for (const endpoint of endpoints.values()) {
    if (endpoint.kind !== 'http-route') continue;
    const route = endpoint.meta.route ?? '';
    const byPath = /webhook|\/hooks?(\/|$)/i.test(route);
    const provider = endpoint.meta.sites
      .map((site) => verifiedFiles.get(site.path))
      .find((value): value is string => Boolean(value));

    if (!provider && !byPath) continue;
    endpoint.kind = 'webhook';
    endpoint.meta.endpointKind = 'webhook';
    if (provider) {
      endpoint.meta.verified = true;
      endpoint.meta.guards.push({
        name: `${provider} signature check`,
        how: 'call',
        provider,
        path: endpoint.meta.sites[0]?.path ?? null,
        line: null,
        confidence: 'certain',
      });
    }
  }
}

/**
 * Attaches guards found elsewhere in the project.
 *
 * The precision rule: a check inside one handler says nothing about the handler next
 * to it, so a function-scoped guard only counts when it is *that* handler's. When we
 * never resolved a precise handler (a page component, say), a guard anywhere in the
 * file counts — but only as `likely`.
 *
 * `reached` carries the same idea one file further out: a handler that calls a helper
 * which does the checking is protected, and saying otherwise about the best-guarded
 * routes in a repo is the most expensive mistake this tool can make.
 */
function applyGuards(
  endpoints: Map<string, MergedEndpoint>,
  guards: GuardFinding[],
  reached: Map<string, ReachedGuard[]>,
  builds: RouterBuildFinding[],
  mounts: RouterMountFinding[],
  handoffs: RouterHandoffFinding[],
): void {
  const byFile = new Map<string, GuardFinding[]>();
  const matchers: GuardFinding[] = [];

  const mountedAt = mountGraph(builds, mounts);
  const isTheRouter = routersMountedHere(mountedAt);

  for (const guard of guards) {
    if (guard.scope === 'matcher') {
      if (!isTheRouter(guard)) matchers.push(guard);
      continue;
    }
    const file = guard.guard.path;
    if (!file) continue;
    const list = byFile.get(file);
    if (list) list.push(guard);
    else byFile.set(file, [guard]);
  }

  const above = registeredAboveTheGate(mountedAt, builds, handoffs);

  for (const endpoint of endpoints.values()) {
    const route = endpoint.meta.route;
    const addressable = typeof route === 'string' && route.startsWith('/');
    // A pattern needs an address to match against, so a door whose address could not
    // be resolved is out of reach of `/admin/:path*` — honestly, since we cannot say
    // it lives under /admin. A *catch-all* is the one exception (#172): it covers a
    // door whatever its address turns out to be, which is precisely what a NestJS
    // APP_GUARD means, and immich's 46 unresolved-prefix routes are exactly as
    // behind its global AuthGuard as the 224 readable ones. HTTP routes only —
    // a server action or an IPC channel is not what a route middleware serves.
    const covers = (guard: GuardFinding): boolean =>
      addressable
        ? guard.matchers.some((matcher) => matcherMatches(matcher, route as string) || isCatchAllMatcher(matcher))
        : endpoint.kind === 'http-route' && guard.matchers.some(isCatchAllMatcher);

    // Asked once, and answered for the whole endpoint rather than for one of the ways
    // its check reaches it. `app.use(requireAuth)` in the file that also *defines*
    // `requireAuth` arrives twice — as a matcher covering every address, and as a check
    // written in this door's own file — and suppressing only the first leaves the door
    // reported as guarded by the second, which is the same false green through a
    // different rule.
    //
    // Only registrations that reach this door get a say. One check is commonly applied
    // twice — globally at the top of the file and again on a sub-path further down —
    // and asking the second one where a door outside its prefix sits gives an answer
    // about a registration that never covered it. Keyed by name, that answer then
    // silenced the *global* registration as well, which turns a door's real check off
    // by way of a line it has nothing to do with.
    const gated = new Set<string>();
    for (const guard of matchers) {
      if (guard.coversFrom && covers(guard) && above(endpoint, guard)) gated.add(head(guard.guard.name));
    }

    for (const site of endpoint.meta.sites) {
      for (const guard of byFile.get(site.path) ?? []) {
        if (gated.has(head(guard.guard.name))) continue;
        const reach = guardConfidence(endpoint, guard);
        if (!reach) continue;
        // Two questions, and only one of them was being asked. `guardConfidence` answers
        // *does this check cover this route* — certain when the check is written on the
        // handler the router named. The detector's own grade answers *is this a check at
        // all*, and the Go tier deliberately says `likely`, because a function that
        // writes a 401 is one function's behaviour standing in for a decision no
        // framework confirmed.
        //
        // Overwriting the second with the first made weak evidence certain by being
        // pointed at the right route, and Gin's `POST /login` — which answers a wrong
        // *password* with a 401 — came out certainly protected (#147). A framework's own
        // vocabulary is unaffected: `[Authorize]` and a NextAuth decorator arrive
        // `certain` and stay it.
        pushGuard(endpoint, { ...guard.guard, confidence: weaker(guard.guard.confidence, reach) });
      }
    }

    // The walk starts at the handler, so it has to *be* the handler (#255). From a
    // registration scope it starts at everything the scope calls, which in mastodon's
    // `startServer` is the entire streaming server — and none of it is a hop this door
    // takes. There is no confidence gate on this path either, so a wrong start attaches
    // a check outright rather than merely over-grading one.
    for (const handlerId of handlersProper(endpoint)) {
      for (const hop of reached.get(handlerId) ?? []) {
        const through = guardThroughHops(hop);
        if (gated.has(head(through.name))) continue;
        pushGuard(endpoint, through);
      }
    }

    for (const guard of matchers) {
      if (gated.has(head(guard.guard.name))) continue;
      if (!covers(guard)) continue;
      // Named like a check, read to be none. It reached this door, so the door records
      // what stood in front of it — and records it somewhere no count can mistake for a
      // lock (#237).
      if (guard.parsesOnly) {
        if (!endpoint.meta.declaredInTest) endpoint.meta.identityOnly ??= guard.guard.name;
        continue;
      }
      pushGuard(endpoint, { ...guard.guard, confidence: 'likely' });
    }
  }
}

/**
 * Decorators on handlers, turned into checks written on a node.
 *
 * Django is the reason this exists: it keeps the address in `urls.py` and the lock in
 * `views.py`, and neither file mentions the other's half. Eighty-one of healthchecks'
 * views carry `@login_required` in plain sight, and every door in the app read "not
 * examined" because nothing joined the two.
 *
 * A decorator this tool knows by name arrives with its verdict already attached. Any
 * other name has to earn it the same way a `Depends(...)` does — by being defined in
 * this project as something that turns callers away with a 401 — so `@authorize` counts
 * and `@csrf_exempt`, `@require_POST` and `@cors` do not.
 */
function handlerDecoratorGuards(
  decorators: HandlerDecoratorFinding[],
  checkers: AuthCheckerFinding[],
): GuardFinding[] {
  if (decorators.length === 0) return [];
  const byName = new Map(checkers.map((checker) => [checker.name, checker.guard]));
  const out: GuardFinding[] = [];
  for (const decorator of decorators) {
    const guard = decorator.guard ?? byName.get(decorator.name);
    if (!guard) continue;
    out.push({
      type: 'guard',
      guard,
      scope: 'node',
      nodeId: decorator.nodeId,
      matchers: [],
      sourceId: decorator.nodeId,
    });
  }
  return out;
}

/**
 * The decorator on the handler the routing table named — the direct hit.
 *
 * `applyGuards` matches a node-scoped check against the endpoints declared in the same
 * *file*, which is exactly wrong for Django: the door is written in `urls.py` and the
 * decorator in `views.py`. The reference walk covers the case where the check is a call
 * or two below the handler; this covers the case where it is on the handler itself.
 */
/**
 * The door whose handler was found and whose lock still is not here.
 *
 * Following `urls.py` to a DRF `ModelViewSet` is progress right up to the moment the
 * class turns out to say nothing about permissions — because DRF's answer to that is
 * `DEFAULT_PERMISSION_CLASSES` in settings, and a reader who has not read settings
 * knows nothing. So the door keeps the honest blank it had before anyone followed the
 * link, and the reason names the file to open.
 *
 * Only when the merge ended with no check at all. A ViewSet mounted behind a guarded
 * router has a lock this reader *did* see, and re-blinding it would throw away a fact.
 */
function applyHandlerBlindness(endpoints: Map<string, MergedEndpoint>, blind: HandlerBlindFinding[]): void {
  if (blind.length === 0) return;
  const byNode = new Map(blind.map((finding) => [finding.nodeId, finding]));
  for (const endpoint of endpoints.values()) {
    if (endpoint.meta.guards.length > 0) continue;
    const found = [...endpoint.handlerIds].map((id) => byNode.get(id)).find(Boolean);
    if (!found) continue;
    endpoint.meta.handlerUnlinked = true;
    // The handler *was* followed here, so the stock sentence about not following it
    // would send a reader looking for a link that already exists. Say which file
    // actually holds the answer instead.
    endpoint.meta.handlerUnlinkedWhy = found.why;
  }
}

function applyHandlerDecorators(endpoints: Map<string, MergedEndpoint>, guards: GuardFinding[]): void {
  if (guards.length === 0) return;
  const byNode = new Map<string, GuardInfo[]>();
  for (const guard of guards) {
    if (!guard.nodeId) continue;
    const list = byNode.get(guard.nodeId);
    if (list) list.push(guard.guard);
    else byNode.set(guard.nodeId, [guard.guard]);
  }
  for (const endpoint of endpoints.values()) {
    // A decorator is written on one function, and "this door's function" is the only
    // reading under which that means anything (#255).
    for (const handlerId of handlersProper(endpoint)) {
      for (const guard of byNode.get(handlerId) ?? []) pushGuard(endpoint, guard);
    }
  }
}

/**
 * Express middleware runs for the routes registered *after* it and for no others.
 * Registration order is not a detail there — it is the entire mechanism — so
 * `app.use(requireAuth)` says nothing about the lines above it, and the two things
 * every application puts above its gate are a health check and a webhook whose
 * signature is its lock (#201).
 *
 * Three positions are readable, and all three are read:
 *
 *   - a route written on the guarded router in the file that writes the gate, ordered
 *     by its own line;
 *   - a router *mounted* onto the guarded one in that file, ordered by the **mount's**
 *     line. `app.use('/webhooks', webhooks)` above the gate puts every route in
 *     `webhooks.js` above it, and nothing in that file mentions the check — which is
 *     the half that matters, since the file being wrong is not the file you would look
 *     in.
 *   - the guarded router *handed to another module as an argument* in that file, ordered
 *     by the **call's** line (#206). `require('./public')(app)` above the gate registers
 *     every route in `public.js` above the gate, and CommonJS Express is largely written
 *     this way. Nothing here is a mount, so the mount graph has no edge to follow.
 *
 * Only the first hop out of the guarded file is followed, and everything else keeps its
 * guard. That asymmetry is deliberate, and it is the correction the first attempt at
 * this needed: an app that registers every route from another file would otherwise go
 * to "no auth check found" on all of them, and a reader who sees every door red
 * discounts the column entirely — spending the same trust an over-claim spends, across
 * a whole application rather than one door. Under-claiming one door is recoverable;
 * under-claiming all of them is not.
 */
function registeredAboveTheGate(
  mountedAt: Map<string, RouterMountFinding[]>,
  builds: RouterBuildFinding[],
  handoffs: RouterHandoffFinding[],
): (endpoint: MergedEndpoint, guard: GuardFinding) => boolean {
  const builtAt = new Set(builds.map((build) => moduleRouterKey(moduleOf(build.path), build.varName)));

  return (endpoint, guard) => {
    const gate = guard.coversFrom;
    const host = guard.routerVar;
    if (!gate || !host) return false;

    // Written on the guarded router itself, in the file that writes the gate. Matched by
    // the router variable and not just the file: one module holding a locked router and
    // an open one beside it is ordinary, and the line numbers of the second say nothing
    // about the first.
    if (endpoint.routers.has(routerKey(gate.path, host))) {
      const site = endpoint.meta.sites.find((entry) => entry.path === gate.path);
      if (site && site.line !== null) return site.line < gate.line;
    }

    for (const key of endpoint.routers) {
      for (const mount of mountedAt.get(byModule(key)) ?? []) {
        if (mount.path !== gate.path || mount.hostVar !== host) continue;
        return mount.line < gate.line;
      }
    }

    for (const key of endpoint.routers) {
      const owned = byModule(key);
      // A router this module *built* is its own, whatever else the module was handed.
      // `const router = express.Router()` in a file that also takes an `app` parameter
      // is two routers, and only a mount says where the first one ended up.
      if (builtAt.has(owned)) continue;
      const where = owned.slice(0, owned.indexOf('\0'));
      const handed = handoffs.filter(
        (handoff) =>
          handoff.path === gate.path &&
          handoff.hostVar === host &&
          gate.line >= handoff.scope.from &&
          gate.line <= handoff.scope.to &&
          answersTo(where, handoff.targetModule),
      );
      // Any of them, not all. A module handed the app twice — once above the gate and
      // once below it — registers its routes twice, and Express answers with the *first*
      // registration it matches. So the copy above the gate is the one a stranger
      // reaches, and the earliest readable position is the one that decides the door.
      if (handed.some((handoff) => handoff.line < gate.line)) return true;
    }
    return false;
  };
}

/**
 * The argument was the router, so it was never the check (#225).
 *
 * `app.use('/auth', authRouter)` mounts a router. The auth reader sees the same call,
 * sees a name that begins `auth` followed by a capital, and offers `authRouter` as a
 * check — which is how directus came to report `POST /auth/logout` and both halves of
 * its password reset as locked, by a "check" that is the router those doors live on.
 * The prefix rule that matches it is the one Ghost needs for `authAdminApi` (#221), so
 * the answer is not a narrower name pattern: `authRouter`, `authRoutes`, `authService`
 * and `authProvider` are all in the corpus and no list of suffixes ends.
 *
 * The evidence is that the project *builds a router* in the module this argument names.
 * A mount finding alone does not say so — every internally-imported identifier handed to
 * `.use` gets one, middleware included — but a mount that survives `mountGraph` does,
 * because resolution requires a `router-build` in the target. So the question asked here
 * is the one that can be answered from facts: did this exact argument, at this exact
 * call, turn out to be a router somebody built?
 *
 * Matched on file, line and the argument's written name, so the mixed call keeps its
 * check: `app.use('/admin', requireAuth, adminRouter)` mounts one argument and guards
 * with the other, and only the mounted name is withdrawn.
 */
function routersMountedHere(mountedAt: Map<string, RouterMountFinding[]>): (guard: GuardFinding) => boolean {
  const resolved = new Set<string>();
  for (const list of mountedAt.values()) {
    for (const mount of list) {
      if (mount.childName) resolved.add(`${mount.path}\0${mount.line}\0${mount.childName}`);
    }
  }
  if (resolved.size === 0) return () => false;

  return (guard) => {
    const at = guard.coversFrom;
    return at !== undefined && resolved.has(`${at.path}\0${at.line}\0${guard.guard.name}`);
  };
}

/**
 * A guard named after the route it was reached by — `requireUserId →
 * redirect('/login')` — is the same check as the bare `requireUserId` beside it, which
 * is why the dedup in `pushGuard` compares heads. Anything deciding whether two guards
 * are one check has to ask the question the same way.
 */
function head(name: string): string {
  return name.split(' → ')[0];
}

/**
 * A Python route declares its auth in its signature, through a name defined somewhere
 * else: `def read_items(current_user: CurrentUser)`. Three facts have to meet before
 * that is a check, and no single file can see more than one of them —
 *
 *   1. `get_current_user` raises a 403 at strangers, so it is a check;
 *   2. `CurrentUser` is an alias for `Depends(get_current_user)`;
 *   3. this handler types a parameter `CurrentUser`.
 *
 * Which is why FastAPI's own project template read as twenty-one wide-open routes: the
 * signature is the only place the lock appears, and it appears there by reference.
 */
function applyDependencyGuards(
  endpoints: Map<string, MergedEndpoint>,
  checkers: AuthCheckerFinding[],
  aliases: AuthAliasFinding[],
  routers: RouterBuildFinding[],
  mounts: RouterMountFinding[],
  attached: RouterGuardFinding[],
  byPath: PathGuardFinding[],
): void {
  if (checkers.length === 0) return;
  const byName = new Map(checkers.map((checker) => [checker.name, checker.guard]));

  // An alias inherits the check it stands for, and says so, because a reader looking
  // for `get_current_user` will not find one in their route file.
  //
  // Unless the name is declared more than once. Two classes in a repo sharing a name is
  // ordinary — a v1/v2 split writes `UsersController` twice — and promoting either
  // attributes one team's lock to the other's door (#162). `checkInherited` below has
  // held this rule all along; it only works when every class *says* it exists, which is
  // why the detectors now declare the guardless ones too. When neither speaks, the door
  // under-claims, which is the side of the trade this tool lives on.
  const declaredTimes = new Map<string, number>();
  for (const alias of aliases) declaredTimes.set(alias.name, (declaredTimes.get(alias.name) ?? 0) + 1);
  for (const alias of aliases) {
    if (byName.has(alias.name)) continue;
    if ((declaredTimes.get(alias.name) ?? 0) > 1) continue;
    const target = alias.depends.find((name) => byName.has(name));
    if (!target) continue;
    const inherited = byName.get(target) as GuardInfo;
    byName.set(alias.name, { ...inherited, name: `${alias.name} → ${alias.binds ?? 'Depends'}(${target})` });
  }

  // A router that carries a check guards the routes registered on *it* — matched by
  // the variable, because one file having a locked router and an open one beside it
  // is ordinary, and claiming the open one is locked would be the worse error.
  const byRouter = new Map<string, GuardInfo>();
  for (const build of routers) {
    const guard = byName.get(build.routerName);
    if (guard) byRouter.set(routerKey(build.path, build.varName), { ...guard, how: 'config' });
  }

  // A check with a switch on it says nothing about a whole group — see
  // `AuthCheckerFinding.switched`. Withheld here and nowhere else: the same function
  // written straight onto a handler is still that handler's check.
  const switched = new Set(checkers.filter((checker) => checker.switched).map((checker) => checker.name));
  const behind = routersBehindACheck(routers, mounts, attached, byName, switched);
  const inherited = checkInherited(aliases, byName);
  // Only the wiring that names something the project turns callers away with. A module
  // applies a logger with the same two calls it applies a lock.
  const wired = byPath.filter((entry) => entry.matcher && byName.has(entry.name.split('.').pop() ?? entry.name));

  for (const endpoint of endpoints.values()) {
    for (const name of endpoint.paramTypes) {
      const guard = byName.get(name);
      if (guard) pushGuard(endpoint, guard);
    }
    for (const key of endpoint.routers) {
      const guard = byRouter.get(key);
      if (guard) pushGuard(endpoint, guard);
      const behindTheMount = behind.get(byModule(key));
      if (behindTheMount) pushGuard(endpoint, behindTheMount);
    }
    const route = endpoint.meta.route;
    for (const entry of route ? wired : []) {
      // The method is half the claim. `articles/:slug` is guarded for PUT and DELETE and
      // wide open for GET, and all three are written on consecutive lines.
      if (entry.method && entry.method !== endpoint.meta.method) continue;
      if (!matcherMatches(entry.matcher, route as string)) continue;
      const guard = byName.get(entry.name.split('.').pop() ?? entry.name) as GuardInfo;
      pushGuard(endpoint, { ...guard, how: 'middleware', confidence: 'likely' });
    }

    for (const owner of endpoint.owners) {
      const guard = inherited(
        owner,
        endpoint.meta.sites.map((site) => site.path),
      );
      // Never `certain`, however certain the declaration was. A check written on a class
      // this file does not name reaches here through the framework's own inheritance
      // rules, and a subclass that declares guards of its own replaces them rather than
      // adding to them — so the chain is strong evidence and not a proof.
      if (guard) pushGuard(endpoint, { ...guard, how: 'config', confidence: 'likely' });
    }
  }
}

/**
 * The check a controller inherits: `class AdminBackupController(BaseAdminController)`,
 * and three classes up, `user: PrivateUser = Depends(get_current_user)`.
 *
 * A class-based view injects the class's dependencies into every route declared on it,
 * so a file of eleven handlers can be entirely guarded and mention a caller nowhere.
 * mealie writes a hundred and thirty of its routes that way.
 *
 * Exactly one declaration of a name or nothing: two classes in a repo sharing a name is
 * ordinary, and following either would be attributing one team's lock to another's door.
 *
 * With one exception that is not an exception (#162): the class that owns a route is
 * declared in the route's own file, so *that* hop is never ambiguous — the alias whose
 * name and file both match is the class, whatever its namesakes elsewhere are wearing.
 * Resolving it file-locally is what lets a guarded `ApiController` keep its lock while
 * its guardless namesake in another file gets nothing, instead of the tie silencing
 * both. The walk up the *bases* stays name-global and unique-or-nothing, because
 * `extends BaseController` really is just a name from here.
 */
function checkInherited(
  aliases: AuthAliasFinding[],
  byName: Map<string, GuardInfo>,
): (className: string, sitePaths: string[]) => GuardInfo | null {
  const declared = new Map<string, AuthAliasFinding[]>();
  const atFile = new Map<string, AuthAliasFinding>();
  for (const alias of aliases) {
    atFile.set(`${alias.path}#${alias.name}`, alias);
    if (!alias.bases) continue;
    const list = declared.get(alias.name);
    if (list) list.push(alias);
    else declared.set(alias.name, [alias]);
  }

  const answers = new Map<string, GuardInfo | null>();
  const walk = (name: string, seen: Set<string>): GuardInfo | null => {
    const done = answers.get(name);
    if (done !== undefined) return done;
    if (seen.has(name)) return null;
    seen.add(name);

    let found = byName.get(name) ?? null;
    if (!found) {
      const only = declared.get(name);
      if (only?.length === 1) {
        for (const base of only[0].bases ?? []) {
          found = walk(base, seen);
          if (found) break;
        }
      }
    }

    seen.delete(name);
    answers.set(name, found);
    return found;
  };

  const fromAlias = (alias: AuthAliasFinding): GuardInfo | null => {
    const target = alias.depends.find((name) => byName.has(name));
    if (target) return byName.get(target) as GuardInfo;
    for (const base of alias.bases ?? []) {
      const found = walk(base, new Set([alias.name]));
      if (found) return found;
    }
    return null;
  };

  return (className: string, sitePaths: string[]) => {
    for (const sitePath of sitePaths) {
      const local = atFile.get(`${sitePath}#${className}`);
      if (local) return fromAlias(local);
    }
    return walk(className, new Set());
  };
}

/**
 * The check written on the mount, not on the route: `api_router.include_router(rest,
 * dependencies=[Depends(get_current_user)])`, and the ASGI middleware that does the
 * same job for a whole application.
 *
 * Netflix's `dispatch` locks a hundred and sixty-three of its two hundred routes on one
 * line of `api.py`, and not one of the files those routes live in mentions it — so the
 * whole API read as wide open. This is the third spelling of the same idea, after a
 * route's own dependencies and a router built with them, and it is the one a large
 * Python service reaches for, because it is the only one that cannot be forgotten on a
 * new file.
 *
 * The rule for inheriting a check down the tree is the strict one: a router is behind a
 * check when it is mounted somewhere *and every mount of it* is behind one. A router
 * that also answers at a second, open address is not protected, and saying otherwise
 * about the routes somebody deliberately left open is the most expensive thing this
 * tool could say.
 */
function routersBehindACheck(
  builds: RouterBuildFinding[],
  mounts: RouterMountFinding[],
  attached: RouterGuardFinding[],
  byName: Map<string, GuardInfo>,
  switched: Set<string>,
): Map<string, GuardInfo> {
  if (mounts.length === 0 && attached.length === 0) return new Map();

  // Everything this function decides is a claim about a *group* — one answer covering
  // every door mounted under a router — so a check whose refusal its caller switches on
  // and off is no evidence here, however plainly it rejects when it is switched on.
  const readable = (names: string[] | undefined): string[] | undefined =>
    switched.size === 0 ? names : names?.filter((name) => !switched.has(name.split('.').pop() ?? name));

  // What a router carries in its own right: the dependencies it was built with, and
  // any middleware added to it. Both are names until they are looked up here.
  const own = new Map<string, GuardInfo>();
  /**
   * Every check attached to a router, with the line it was attached on — because for a
   * framework that copies middleware into a group as `Group()` runs, "what does this
   * router carry" has no answer until you say *when*.
   */
  const timeline = new Map<string, { line: number; guard: GuardInfo }[]>();
  const claim = (
    path: string,
    varName: string,
    names: string[] | undefined,
    how: 'config' | 'middleware',
    line: number,
  ) => {
    const key = routerKey(moduleOf(path), varName);
    const guard = firstCheck(readable(names), byName);
    if (!guard) return;
    const entry = { ...guard, how };
    if (!own.has(key)) own.set(key, entry);
    const list = timeline.get(key);
    if (list) list.push({ line, guard: entry });
    else timeline.set(key, [{ line, guard: entry }]);
  };
  for (const build of builds) claim(build.path, build.varName, build.dependencies, 'config', build.line);
  for (const guard of attached) claim(guard.path, guard.varName, guard.names, guard.how, guard.line);

  const mountedAt = mountGraph(builds, mounts);
  const answers = new Map<string, GuardInfo | null>();

  /** What this router carried by then, or everything it carries when the question is not asked. */
  const carried = (key: string, asOf: number | null): GuardInfo | null => {
    if (asOf === null) return own.get(key) ?? null;
    let best: { line: number; guard: GuardInfo } | null = null;
    for (const entry of timeline.get(key) ?? []) {
      if (entry.line >= asOf) continue;
      if (!best || entry.line > best.line) best = entry;
    }
    return best?.guard ?? null;
  };

  const guardFor = (key: string, seen: Set<string>, asOf: number | null): GuardInfo | null => {
    // The answer depends on when it was asked, so the memo has to remember that too.
    const memo = `${key}\0${asOf ?? ''}`;
    const done = answers.get(memo);
    if (done !== undefined) return done;
    // A router mounted on itself, round however long a loop, tells us nothing.
    if (seen.has(memo)) return null;
    seen.add(memo);

    let found = carried(key, asOf);
    if (!found) {
      const parents = mountedAt.get(key) ?? [];
      // A router nobody mounts is a root: whatever it carries is all it has.
      if (parents.length > 0) {
        const guards = parents.map((mount) => {
          const onTheMount = firstCheck(readable(mount.dependencies), byName);
          // Written in the wiring, not in the handler — which is what `config` says,
          // and the difference a reader needs when they go looking for it.
          if (onTheMount) return { ...onTheMount, how: 'config' as const };
          // A group made by this line inherits the host as the host stood on this line.
          // Anything else asks the host what it carries, full stop, which is what every
          // framework that wraps rather than copies actually does.
          return guardFor(
            routerKey(moduleOf(mount.path), mount.hostVar),
            seen,
            mount.inheritsInOrder === true ? mount.line : asOf,
          );
        });
        found = guards.every((guard) => guard !== null) ? guards[0] : null;
      }
    }

    seen.delete(memo);
    answers.set(memo, found);
    return found;
  };

  const out = new Map<string, GuardInfo>();
  for (const build of builds) {
    const key = routerKey(moduleOf(build.path), build.varName);
    const guard = guardFor(key, new Set(), null);
    if (guard) out.set(key, { ...guard, confidence: 'likely' });
  }
  return out;
}

/** The first of these names the project knows to be a check, if any of them is. */
function firstCheck(names: string[] | undefined, byName: Map<string, GuardInfo>): GuardInfo | null {
  for (const name of names ?? []) {
    const guard = byName.get(name.split('.').pop() ?? name);
    if (guard) return guard;
  }
  return null;
}

/**
 * The lower of two grades, because a claim is as strong as its weakest half.
 *
 * Being certain a check *reaches* a route says nothing about whether it is a check, and
 * a door only reads as proven when both hold. Rounding up here is #116's mistake in the
 * place a reader is least able to catch it — inside a green sentence.
 */
const CONFIDENCE_RANK: Record<Confidence, number> = { possible: 0, likely: 1, certain: 2 };

function weaker(a: Confidence, b: Confidence): Confidence {
  return CONFIDENCE_RANK[a] <= CONFIDENCE_RANK[b] ? a : b;
}

/**
 * The handler ids that are actually this door's handler (#255).
 *
 * Three rules below reason from "the check is written on the node that answers this
 * door", and every one of them is wrong about a node that merely *contains the line
 * where the door was registered*. Mastodon's `startServer` is 1,317 lines holding four
 * `app.get`s, the WebSocket handler and `authorizeListAccess`; the guard's node and all
 * four doors' nodes are that one function, so the checks matched and `/metrics` was
 * reported locked by a routine that authorizes access to a timeline list.
 *
 * This is the same mistake `guardConfidence` documents at file granularity, one level
 * in — "the handler is the whole file" became "the handler is this whole function" — and
 * it is worth saying why the obvious discriminator is not the one used. *Sharing* an id
 * between doors looks like the tell and is not: gin-realworld's `ArticleUpdate` is one
 * Go function serving `/api/articles/:slug` and `/api/articles/:slug/`, doing its own
 * checking, and it is shared and correct. What separates the two cases is not how many
 * doors point at the node but whether the node was ever the handler, which is knowable
 * where the id is made and nowhere afterwards.
 */
function handlersProper(endpoint: MergedEndpoint): Set<string> {
  if (endpoint.scopeIds.size === 0) return endpoint.handlerIds;
  return new Set([...endpoint.handlerIds].filter((id) => !endpoint.scopeIds.has(id)));
}

function guardConfidence(endpoint: MergedEndpoint, guard: GuardFinding): Confidence | null {
  if (guard.nodeId && handlersProper(endpoint).has(guard.nodeId)) return 'certain';
  // A module-scope check runs for everything the file declares.
  if (guard.nodeId?.startsWith('file:')) return 'likely';
  // We only pinned the handler down as far as its file, so anything in that file may
  // well guard it.
  //
  // The size check is the whole of the rule. "We could not find the handler at all" is a
  // different statement from "the handler is the whole file", and `[].every(…)` is true,
  // so the two used to give the same answer — which is how `mux.Handle("/debug/vars",
  // expvar.Handler())` came to be reported as protected by a middleware standing in front
  // of the route on the line above it.
  //
  // Deliberately the full set and not `handlersProper`. A door registered at module scope
  // has a scope id, and that scope id is its file — which is exactly the case this rule
  // was written for. Narrowing here would empty the set, `[].every(…)` would be true
  // again, and the size check above would be back to guarding nothing.
  if (endpoint.handlerIds.size > 0 && [...endpoint.handlerIds].every((id) => id.startsWith('file:'))) {
    return 'likely';
  }
  return null;
}

function pushGuard(endpoint: MergedEndpoint, guard: GuardInfo): void {
  // A door the suite declared takes no check from anywhere (#250).
  //
  // directus's five mock-license-server routes came out wearing `authenticate`, sourced
  // to `api/src/app.ts:328` — the shipped application's own `app.use`, reported as the
  // lock on a Fastify service that exists for the length of an e2e run and that directus
  // does not deploy. A catch-all covers a door whatever its address turns out to be
  // (#172), and "whatever its address turns out to be" quietly included the addresses of
  // a different program.
  //
  // It is a blanket refusal rather than a rule about catch-alls, because the suite's own
  // checks are already gone: #25 filters a guard by the file it was registered in, so
  // anything still able to reach a test-declared door was written in application code.
  // The application does not stand in front of a server the harness started. "Not
  // examined" is then the true answer, and it is the answer this door gets.
  //
  // Here rather than at the nine call sites for the reason `openDoors.ts` gives about
  // `Record<OpenKind, …>`: a rule you have to remember in nine places is one that comes
  // back. The reverse direction — a check registered by the suite reaching an
  // application door — needs nothing, and that is measured rather than assumed: zero
  // across nine repositories, and a constructed repro does not fire either, because a
  // `.use` matcher carries its *registration* site as its path and #25 already drops it.
  if (endpoint.meta.declaredInTest) return;

  // Two guards pointing at one line of one file are one check, whatever each of them
  // decided to call it. A controller that declares `@UseGuards(SessionGuard)` reaches
  // this twice — once as the decorator, once as the chain that inherits it — and
  // listing the same lock twice on a security screen reads as two locks.
  //
  // Same name from two files is also one check (#155): `requireAuth` seen where its
  // 401 lives and again where `admin.use(requireAuth)` wires it is one function with
  // two kinds of evidence. On a single door, two genuinely different checks sharing a
  // name is a curiosity; the same check counted twice is a miscount every time.
  // A chain counts as its first hop. `guardThroughHops` names a reached check after the
  // route it was reached by — `requireUserId → redirect('/login')` — and the same
  // function seen directly is plainly `requireUserId`. Comparing the whole string makes
  // those two different checks and lists one lock twice, which is the same miscount the
  // paragraph above is about, wearing the evidence as a suffix.
  const already = endpoint.meta.guards.find(
    (g) =>
      head(g.name) === head(guard.name) ||
      (g.path !== null && g.path === guard.path && g.line !== null && g.line === guard.line),
  );
  if (already) {
    if (already.confidence === 'likely' && guard.confidence === 'certain') already.confidence = 'certain';
    // Keep the one that shows its working, evidence link and all. A name with a chain on
    // it was found where the refusal lives and says how the route reaches it; a bare one
    // says only that something with that name ran, and its line is the call site rather
    // than the check. Sending a reader to the wrong one of those two files is the whole
    // cost of getting this wrong.
    if (!already.name.includes(' → ') && guard.name.includes(' → ')) {
      already.name = guard.name;
      already.path = guard.path;
      already.line = guard.line;
      already.how = guard.how;
      already.provider = guard.provider;
    }
    return;
  }
  endpoint.meta.guards.push(guard);
}

// ---------------------------------------------------------------------------
// Environment variables
// ---------------------------------------------------------------------------

/**
 * The env bundle isn't served by a web framework, so its `framework` says which runtime
 * reads the config — named after where the reads actually are. Calling a pure-Python
 * project's config "Node" was just wrong, and a pure-Rust project's the same.
 */
function envRuntime(sites: CodeSite[]): string {
  const byExtension = new Map<string, number>();
  for (const site of sites) {
    const runtime = /\.pyi?$/.test(site.path) ? 'Python' : /\.go$/.test(site.path) ? 'Go' : /\.rs$/.test(site.path) ? 'Rust' : /\.cs$/.test(site.path) ? '.NET' : 'Node';
    byExtension.set(runtime, (byExtension.get(runtime) ?? 0) + 1);
  }
  let best = 'Node';
  let bestCount = 0;
  for (const [runtime, count] of byExtension) {
    if (count > bestCount) {
      best = runtime;
      bestCount = count;
    }
  }
  return bestCount > sites.length / 2 ? best : 'Node';
}

/**
 * Every env read in the project becomes one door, not one per variable — otherwise a
 * normal app buries its twelve real entry points under forty config boxes. The
 * variables themselves live in the node's metadata and drive the secrets badge.
 */
function collectEnv(input: BuildInput): MergedEndpoint | null {
  const byName = new Map<string, { sites: CodeSite[]; config: boolean }>();
  for (const finding of input.findings) {
    if (finding.type !== 'env') continue;
    const entry = byName.get(finding.name);
    if (entry) {
      entry.sites.push(finding.site);
      entry.config = entry.config || Boolean(finding.config);
    } else byName.set(finding.name, { sites: [finding.site], config: Boolean(finding.config) });
  }
  if (byName.size === 0) return null;

  const vars: EnvVarInfo[] = [...byName.entries()]
    .map(([name, { sites, config }]) => ({
      name,
      sites: sites.sort(compareSites),
      // A configuration key is documented by the settings files, an environment
      // variable by `.env.example` — the same question, asked of the file that could
      // actually answer it (#101).
      documented: config ? input.signals.appsettingsKeys.has(name) : input.signals.envExample.has(name),
      secret: isSecretName(name),
      platform: isPlatformName(name),
      ...(config ? { config: true } : {}),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const sites = vars.flatMap((v) => v.sites);
  return {
    id: makeEndpointId('env', 'config'),
    kind: 'env',
    name: 'Environment & config',
    meta: {
      endpointKind: 'env',
      method: 'ENV',
      route: null,
      framework: envRuntime(sites),
      guards: [],
      writes: false,
      sites,
      vars,
      // The file each kind of key was checked against, so "undocumented" is always a
      // claim about a file the reader can open.
      envExample:
        [
          input.signals.envExamplePath,
          ...(vars.some((v) => v.config) ? input.signals.appsettingsPaths : []),
        ]
          .filter(Boolean)
          .join(', ') || null,
    },
    handlerIds: new Set(sites.map((site) => makeFileId(site.path))),
    scopeIds: new Set(),
    paramTypes: new Set(),
    routers: new Set(),
    owners: new Set(),
  };
}

// ---------------------------------------------------------------------------
// Services and stores
// ---------------------------------------------------------------------------

interface MergedService {
  id: string;
  name: string;
  meta: ServiceMeta;
  writes: boolean;
}

function collectServices(input: BuildInput): Map<string, MergedService> {
  const merged = new Map<string, MergedService>();

  for (const finding of input.findings) {
    if (finding.type !== 'service') continue;
    const id = makeServiceId(finding.name);
    const existing = merged.get(id);
    if (existing) {
      existing.meta.sites.push(finding.site);
      existing.writes = existing.writes || finding.writes;
      if (finding.package && !existing.meta.packages.includes(finding.package)) {
        existing.meta.packages.push(finding.package);
      }
      if (finding.host && !existing.meta.hosts.includes(finding.host)) existing.meta.hosts.push(finding.host);
      // A catalogued category beats the `other` a bare hostname gets.
      if (existing.meta.category === 'other' && finding.category !== 'other') {
        existing.meta.category = finding.category;
      }
      continue;
    }
    merged.set(id, {
      id,
      name: finding.name,
      writes: finding.writes,
      meta: {
        category: finding.category,
        packages: finding.package ? [finding.package] : [],
        hosts: finding.host ? [finding.host] : [],
        sites: [finding.site],
        external: finding.external,
      },
    });
  }

  return merged;
}

interface MergedStore {
  id: string;
  name: string;
  /** True while nothing has named the client — see `nameTheAnonymousDatabase`. */
  generic?: boolean;
  meta: StoreMeta;
  /** Kept apart so a function that only reads never gets a "writes to" arrow. */
  readSites: CodeSite[];
  writeSites: CodeSite[];
  /** Which call sites named which table, so each table can become a shape of its own. */
  tableSites: Map<string, CodeSite[]>;
}

/**
 * What a Cloudflare binding is, in the vocabulary the rest of the map already uses.
 * Queue producers are left out on purpose: a queue you write into is somewhere data
 * goes, not somewhere it is kept, and calling it a store would put it on the wrong
 * half of the picture.
 */
const BINDING_STORES: Record<string, { client: string; storeKind: StoreKind }> = {
  d1: { client: 'Cloudflare D1', storeKind: 'sql' },
  kv: { client: 'Cloudflare KV', storeKind: 'kv' },
  r2: { client: 'Cloudflare R2', storeKind: 'blob' },
  'durable-object': { client: 'Durable Objects', storeKind: 'kv' },
  hyperdrive: { client: 'Cloudflare Hyperdrive', storeKind: 'sql' },
  vectorize: { client: 'Cloudflare Vectorize', storeKind: 'nosql' },
};

/**
 * Databases a Worker is bound to, read out of its config (#29).
 *
 * Nothing in the code says which database `env.DB` is — the platform injects it, and
 * the config is the only place its name and kind are written down. Without this the
 * map offered mirrorquiz a nameless "Database", and the words layer, asked to describe
 * a nameless database, confidently called it Postgres. It is D1.
 *
 * Reads and writes stay at zero because none were observed: this is a declaration, not
 * a call site, and the evidence shown is the config line itself. An ORM store found in
 * the code is deliberately left as its own box rather than folded into this one —
 * guessing that the app's one Drizzle client points at the app's one D1 database would
 * be right most of the time, and the times it is wrong it would print a false sentence
 * about where a customer's data lives.
 */
function addWorkerBindings(input: BuildInput, merged: Map<string, MergedStore>): void {
  for (const worker of input.signals.workers) {
    if (!isWorker(worker)) continue;
    for (const binding of worker.bindings) {
      const shape = BINDING_STORES[binding.kind];
      if (!shape) continue;
      const id = makeStoreId(`cloudflare:${binding.kind}:${binding.target ?? binding.id ?? binding.name}`);
      if (merged.has(id)) continue;
      const site: CodeSite = {
        path: worker.configPath,
        line: 1,
        nodeId: null,
        // What the code sees on `env`, and what the dashboard calls it — the two ways
        // a reader might go looking for this thing.
        snippet: `env.${binding.name} → ${binding.target ?? binding.id ?? shape.client}`,
      };
      merged.set(id, {
        id,
        // The name in the dashboard when the config gives one, else the name the code
        // sees on `env` — both are things a reader can search for.
        name: binding.target ?? binding.name,
        readSites: [],
        writeSites: [],
        tableSites: new Map(),
        meta: {
          storeKind: shape.storeKind,
          client: shape.client,
          tables: [],
          catalogTables: [],
          reads: 0,
          writes: 0,
          sites: [site],
        },
      });
    }
  }
}

function collectStores(input: BuildInput): Map<string, MergedStore> {
  const merged = new Map<string, MergedStore>();

  // The other half of #104's pairing. A `DbSet` declaration is a project-wide fact and
  // a query on `_db.Orders` is a per-file one; the detector reads one file at a time,
  // so the two meet here, where every file already has.
  const declaredTables = new Set<string>();
  for (const finding of input.findings) {
    if (finding.type === 'store' && finding.declares && finding.table) declaredTables.add(finding.table);
  }
  const resolveTable = (finding: StoreFinding): StoreFinding | null => {
    if (finding.table || !finding.tableReceiver) return finding.requiresTable && !finding.table ? null : finding;
    for (const segment of finding.tableReceiver.split('.').reverse()) {
      if (declaredTables.has(segment.trim())) return { ...finding, table: segment.trim() };
    }
    // An ambiguous verb on a receiver that turned out not to be a table is LINQ over
    // somebody's list; an unambiguous one is still a database call whose table this
    // project never named on the line.
    return finding.requiresTable ? null : finding;
  };

  const noteTable = (store: MergedStore, table: string | null, site: CodeSite) => {
    if (!table) return;
    // The database's own catalog is not the app's data model (#86). The read is real
    // and stays counted — it is the *table* that does not belong beside `estimates`,
    // so it moves to a list of its own rather than disappearing.
    const catalog = catalogSchema(table);
    if (catalog) {
      if (!store.meta.catalogTables.some((known) => known.toLowerCase() === table.toLowerCase())) {
        store.meta.catalogTables.push(table);
      }
      return;
    }
    // `session.get(Item, id)` names the model and the migration beside it names the
    // table, so one table arrives spelled two ways. SQL identifiers do not distinguish
    // them either, and counting both turns two tables into four.
    const seen = store.meta.tables.find((known) => known.toLowerCase() === table.toLowerCase());
    if (!seen) store.meta.tables.push(table);
    const name = seen ?? table;
    const sites = store.tableSites.get(name);
    if (sites) sites.push(site);
    else store.tableSites.set(name, [site]);
  };

  for (const raw of input.findings) {
    if (raw.type !== 'store') continue;
    const finding = resolveTable(raw);
    if (!finding) continue;
    const id = makeStoreId(finding.key);
    const existing = merged.get(id);
    if (existing) {
      existing.meta.sites.push(finding.site);
      if (finding.operation === 'read') {
        existing.meta.reads++;
        existing.readSites.push(finding.site);
      } else if (finding.operation === 'write') {
        existing.meta.writes++;
        existing.writeSites.push(finding.site);
      }
      noteTable(existing, finding.table, finding.site);
      nameTheClient(existing, finding);
      continue;
    }
    const store: MergedStore = {
      id,
      name: finding.name,
      generic: finding.generic,
      readSites: finding.operation === 'read' ? [finding.site] : [],
      writeSites: finding.operation === 'write' ? [finding.site] : [],
      tableSites: new Map(),
      meta: {
        storeKind: finding.storeKind,
        client: finding.client,
        tables: [],
        catalogTables: [],
        reads: finding.operation === 'read' ? 1 : 0,
        writes: finding.operation === 'write' ? 1 : 0,
        sites: [finding.site],
      },
    };
    noteTable(store, finding.table, finding.site);
    merged.set(id, store);
  }

  nameTheAnonymousDatabase(merged);
  addWorkerBindings(input, merged);

  // A Prisma schema lists every table, including ones no code has touched yet.
  const prisma = merged.get(makeStoreId('prisma'));
  if (prisma && input.signals.prisma) {
    for (const model of input.signals.prisma.models) {
      if (!prisma.meta.tables.includes(model)) prisma.meta.tables.push(model);
    }
  }

  for (const store of merged.values()) {
    store.meta.tables.sort();
    store.meta.catalogTables.sort();
  }
  return merged;
}

/**
 * Keeps a store's client honest when more than one thing writes to it.
 *
 * One disk, two languages: naming only whichever file was read first puts "Node fs" on
 * a box whose evidence is a hundred lines of Python. A placeholder never wins — a
 * finding that could not name its client yields to one that could.
 */
function nameTheClient(store: MergedStore, finding: StoreFinding): void {
  if (finding.generic) return;
  if (store.generic) {
    store.generic = false;
    store.name = finding.name;
    store.meta.client = finding.client;
    return;
  }
  const named = store.meta.client.split(' and ');
  if (named.includes(finding.client) || named.length >= 3) return;
  store.meta.client = [...named, finding.client].join(' and ');
}

/**
 * Gives the queries whose client we never saw the name of the one we did.
 *
 * A repo of scripts opens its connection in a helper module and imports the helper, so
 * the file with `pymysql.connect` and the twenty files with `SELECT` in them are not the
 * same file — and a per-file detector can only ever see one of them. Left apart they are
 * two boxes for one database, which reads as an app with two databases.
 *
 * Exactly one candidate or nothing: with two named SQL stores in the repo, which one
 * those queries went to is a guess, and the honest answer is a box that says only
 * "Database".
 */
function nameTheAnonymousDatabase(merged: Map<string, MergedStore>): void {
  const anonymous = [...merged.values()].filter((store) => store.generic);
  if (anonymous.length === 0) return;
  const named = [...merged.values()].filter((store) => !store.generic && store.meta.storeKind === 'sql');
  if (named.length !== 1) return;

  const target = named[0];
  for (const store of anonymous) {
    if (store.meta.storeKind !== 'sql') continue;
    appendAll(target.meta.sites, store.meta.sites);
    target.meta.reads += store.meta.reads;
    target.meta.writes += store.meta.writes;
    appendAll(target.readSites, store.readSites);
    appendAll(target.writeSites, store.writeSites);
    for (const table of store.meta.tables) {
      if (!target.meta.tables.includes(table)) target.meta.tables.push(table);
    }
    for (const table of store.meta.catalogTables) {
      if (!target.meta.catalogTables.includes(table)) target.meta.catalogTables.push(table);
    }
    for (const [table, sites] of store.tableSites) {
      const existing = target.tableSites.get(table);
      if (existing) appendAll(existing, sites);
      else target.tableSites.set(table, sites);
    }
    merged.delete(store.id);
  }
}

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

function container(id: string, name: string, direction: 'in' | 'out', count: number, appId: string): AtlasNode {
  return {
    id,
    kind: 'zone',
    name,
    label: null,
    parentId: appId,
    language: null,
    path: null,
    startLine: null,
    endLine: null,
    zone: direction === 'in' ? 'api' : 'data',
    summary: null,
    summarySource: null,
    docHash: null,
    bodyHash: null,
    hash: hashParts('boundary', id, String(count)),
    provenance: 'static',
    meta: { direction, endpointCount: count },
  };
}

const ENDPOINT_ZONES: Record<EndpointKind, Zone> = {
  'http-route': 'api',
  'server-action': 'api',
  webhook: 'api',
  cron: 'api',
  queue: 'api',
  worker: 'api',
  realtime: 'api',
  ipc: 'api',
  cli: 'config',
  env: 'config',
  'file-read': 'data',
  // Never reached through this table — an export door takes the zone of the symbol it
  // opens onto, which is the whole point of it. Present so the map stays total.
  export: 'logic',
  // A screen is the interface, so it colours as UI rather than as a network door.
  screen: 'ui',
  // A published port is a network surface, so it sits with the other network doors —
  // even though the fact came out of a config file rather than out of code.
  port: 'api',
};

function endpointNode(endpoint: MergedEndpoint): AtlasNode {
  const first = endpoint.meta.sites[0];
  return {
    id: endpoint.id,
    kind: 'endpoint',
    name: endpoint.name,
    label: null,
    parentId: INBOUND_ID,
    language: null,
    path: first?.path ?? null,
    startLine: first?.line ?? null,
    endLine: null,
    zone: ENDPOINT_ZONES[endpoint.kind] ?? 'api',
    summary: null,
    summarySource: null,
    docHash: null,
    bodyHash: null,
    hash: hashParts('endpoint', endpoint.id, String(endpoint.meta.sites.length)),
    provenance: 'static',
    meta: { ...endpoint.meta } as unknown as Record<string, unknown>,
  };
}

function serviceNode(service: MergedService): AtlasNode {
  return {
    id: service.id,
    kind: 'service',
    name: service.name,
    label: null,
    parentId: OUTBOUND_ID,
    language: null,
    path: null,
    startLine: null,
    endLine: null,
    zone: 'api',
    summary: null,
    summarySource: null,
    docHash: null,
    bodyHash: null,
    hash: hashParts('service', service.id, String(service.meta.sites.length)),
    provenance: 'static',
    meta: { ...service.meta } as unknown as Record<string, unknown>,
  };
}

const STORE_ZONES: Record<StoreKind, Zone> = {
  sql: 'data',
  nosql: 'data',
  kv: 'data',
  blob: 'data',
  filesystem: 'data',
  unknown: 'data',
};

/**
 * A table the code queries by name, with no schema file to read columns from. It
 * hangs under its store, so drilling into the database shows what lives there.
 */
function observedTableNode(store: MergedStore, table: string, sites: CodeSite[]): AtlasNode {
  const first = sites[0];
  return {
    id: makeTypeId(store.id, table),
    kind: 'type',
    name: table,
    label: null,
    parentId: store.id,
    language: null,
    path: first?.path ?? null,
    startLine: first?.line ?? null,
    endLine: null,
    zone: 'data',
    summary: null,
    summarySource: null,
    docHash: null,
    bodyHash: null,
    hash: hashParts('observed-table', store.id, table, String(sites.length)),
    provenance: 'static',
    meta: {
      typeKind: 'table',
      fields: [],
      isExported: true,
      extends: [],
      provider: store.meta.client,
      /** Named in queries, never declared — the card explains its missing columns. */
      observed: true,
    },
  };
}

function storeNode(store: MergedStore): AtlasNode {
  return {
    id: store.id,
    kind: 'store',
    name: store.name,
    label: null,
    parentId: OUTBOUND_ID,
    language: null,
    path: null,
    startLine: null,
    endLine: null,
    zone: STORE_ZONES[store.meta.storeKind],
    summary: null,
    summarySource: null,
    docHash: null,
    bodyHash: null,
    hash: hashParts('store', store.id, String(store.meta.sites.length)),
    provenance: 'static',
    meta: { ...store.meta } as unknown as Record<string, unknown>,
  };
}

// ---------------------------------------------------------------------------
// Edges
// ---------------------------------------------------------------------------

interface EdgeInput {
  kind: AtlasEdge['kind'];
  fromId: string;
  toId: string;
  weight: number;
  confidence: Confidence;
  meta?: Record<string, unknown>;
}

function endpointEdges(endpoint: MergedEndpoint, known: Set<string>): EdgeInput[] {
  const out: EdgeInput[] = [];

  for (const handlerId of endpoint.handlerIds) {
    if (!known.has(handlerId)) continue;
    out.push({
      kind: 'exposed-by',
      fromId: endpoint.id,
      toId: handlerId,
      weight: 1,
      confidence: 'certain',
    });
  }

  // Two guards can live in the same file — a platform default plus an auth call
  // inside the handler — and an edge id is (kind, from, to), so they must merge
  // into one edge rather than crash the unique index.
  const byGuardFile = new Map<string, EdgeInput>();
  for (const guard of endpoint.meta.guards) {
    if (!guard.path) continue;
    const guardId = makeFileId(guard.path);
    if (!known.has(guardId) || guardId === endpoint.id) continue;
    const existing = byGuardFile.get(guardId);
    if (existing) {
      existing.weight++;
      if (guard.confidence === 'certain') existing.confidence = 'certain';
      continue;
    }
    byGuardFile.set(guardId, {
      kind: 'protected-by',
      fromId: endpoint.id,
      toId: guardId,
      weight: 1,
      confidence: guard.confidence,
      meta: { guard: guard.name, provider: guard.provider },
    });
  }
  out.push(...byGuardFile.values());

  return out;
}

function flowEdges(targetId: string, sites: CodeSite[], writes: boolean, known: Set<string>): EdgeInput[] {
  const counts = new Map<string, number>();
  for (const site of sites) {
    const from = site.nodeId ?? makeFileId(site.path);
    if (!known.has(from)) continue;
    counts.set(from, (counts.get(from) ?? 0) + 1);
  }
  return [...counts.entries()].map(([fromId, weight]) => ({
    kind: writes ? ('writes-to' as const) : ('reads-from' as const),
    fromId,
    toId: targetId,
    weight,
    confidence: 'likely' as Confidence,
  }));
}

/**
 * A store gets both kinds of edge, because the difference is the interesting part —
 * but each call site only produces the one it actually performed.
 */
function storeEdges(store: MergedStore, known: Set<string>): EdgeInput[] {
  return [
    ...flowEdges(store.id, store.readSites, false, known),
    ...flowEdges(store.id, store.writeSites, true, known),
  ];
}

function addEdges(edges: AtlasEdge[], inputs: EdgeInput[]): void {
  for (const input of inputs) {
    edges.push({
      id: makeEdgeId(input.kind, input.fromId, input.toId),
      kind: input.kind,
      fromId: input.fromId,
      toId: input.toId,
      weight: input.weight,
      confidence: input.confidence,
      provenance: 'static',
      meta: input.meta ?? {},
    });
  }
}

function compareSites(a: CodeSite, b: CodeSite): number {
  return a.path.localeCompare(b.path) || a.line - b.line;
}

export { SECRET_PATTERN };
