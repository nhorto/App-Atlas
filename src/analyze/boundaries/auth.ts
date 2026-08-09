/**
 * @fileoverview The auth boundary — which doors are locked, and by what.
 *
 * SPEC.md 6.6 promotes this to a v1.0 feature, and it is the one place where being
 * wrong is genuinely harmful: telling someone a route is protected when it is not is
 * worse than saying nothing. So every guard carries a confidence, and the only
 * `certain` ones are checks found inside the handler itself.
 *
 * Guards are *found* here and *attached to endpoints* in build.ts, because a
 * middleware matcher in one file can protect a route declared in another.
 *
 * The same walk also reports the mirror image of a guard: a call into an auth library's
 * own sign-in, sign-up or sign-out routine. That is not protection — it is the reason a
 * door has none, and it belongs beside the guards because it is found the same way,
 * from the call rather than from anybody's choice of function name.
 */
import { Node } from 'ts-morph';
import type { CallExpression, ClassDeclaration, SourceFile } from 'ts-morph';
import type { GuardInfo } from '../../model/types.js';
import { authEntryForCall, authProviderForPackage } from './catalog.js';
import type { AuthEntryPoint } from './catalog.js';
import { argAt, dottedName, literalString, looksLikeRouter, objectProp, stringArray } from './ast.js';
import type { BoundaryDetector, DetectorContext } from './types.js';

/** Function names that exist to answer "is this person allowed in?". */
const GUARD_NAMES = new Set([
  'requireAuth',
  'requireUser',
  'requireSession',
  'requireAdmin',
  'requireLogin',
  'ensureAuthenticated',
  'ensureAuth',
  'ensureSignedIn',
  'isAuthenticated',
  'checkAuth',
  'checkPermission',
  'assertAuth',
  'assertUser',
  'withAuth',
  'protectRoute',
  'authenticate',
  'authorize',
  'verifyToken',
  'verifyJwt',
  'verifySession',
  'validateRequest',
  'clerkMiddleware',
  'authMiddleware',
  'getServerAuthSession',
  'getServerSession',
  'ClerkExpressRequireAuth',
  'ClerkExpressWithAuth',
]);

/**
 * Names that are only a guard in context — `auth()` is Clerk or NextAuth v5 when it
 * comes from an auth module, and somebody's unrelated helper otherwise.
 */
const AMBIGUOUS_NAMES = new Set(['auth', 'getAuth', 'getSession', 'getUser', 'currentUser', 'getCurrentUser', 'protect']);

const GUARD_DOTTED = [/\.auth\.getUser$/, /\.auth\.getSession$/, /^passport\.authenticate$/];
const GUARD_CLASS = /^([A-Z]\w*)?(Auth|Jwt|Roles|Permissions)\w*Guard$/;

/**
 * Recognises a guard by the name it is called by. Exported so the route detectors can
 * label the middleware they see in a route's argument list.
 */
export function guardFromName(dotted: string, ctx: DetectorContext): GuardInfo | null {
  const parts = dotted.split('.');
  const last = parts[parts.length - 1];
  const root = parts[0];

  const matched =
    GUARD_NAMES.has(last) ||
    GUARD_CLASS.test(last) ||
    GUARD_DOTTED.some((pattern) => pattern.test(dotted)) ||
    (AMBIGUOUS_NAMES.has(last) && isAuthContext(root, ctx));

  if (!matched) return null;

  return {
    name: dotted,
    how: 'call',
    provider: providerFor(root, ctx),
    path: ctx.ref.relPath,
    line: null,
    confidence: 'certain',
  };
}

/** `auth` is only a guard when it came from somewhere that deals in auth. */
function isAuthContext(root: string, ctx: DetectorContext): boolean {
  const binding = ctx.imports.get(root);
  if (binding) return /auth|session|clerk|supabase|lucia|kinde|workos/i.test(binding.module);
  const local = ctx.locals.get(root);
  if (local?.module) return /auth|clerk|supabase|lucia/i.test(local.module);
  return /auth|session/i.test(ctx.ref.relPath);
}

function providerFor(root: string, ctx: DetectorContext): string {
  return packageProvider(root, ctx) ?? 'custom';
}

/**
 * The auth library a name came out of, or `null` when it did not come out of one.
 *
 * Kept apart from `providerFor` above, whose `custom` fallback means "something checks
 * this and we cannot say what". Here the absence of an answer has to stay an absence:
 * "we could not trace this" must never read as "some auth library".
 */
function packageProvider(root: string, ctx: DetectorContext): string | null {
  const binding = ctx.imports.get(root);
  if (binding?.external) return authProviderForPackage(binding.module);
  const local = ctx.locals.get(root);
  if (local?.module) return authProviderForPackage(local.module);
  return null;
}

// ---------------------------------------------------------------------------
// The other kind of auth call: the one that hands a session out
// ---------------------------------------------------------------------------

/**
 * Auth providers the project actually depends on, cached against the signal set the
 * whole run shares.
 *
 * A detector is only allowed to recognise a library the project declares — an invented
 * box on the map is worse than a missing one — and here the gate does a second job:
 * `x.auth.signOut` is GoTrue's shape, and only worth reading as GoTrue's in a repo that
 * installed Supabase.
 */
const providersByPackages = new WeakMap<Set<string>, Set<string>>();

function declaredAuthProviders(packages: Set<string>): Set<string> {
  const cached = providersByPackages.get(packages);
  if (cached) return cached;
  const found = new Set<string>();
  for (const pkg of packages) {
    const provider = authProviderForPackage(pkg);
    if (provider) found.add(provider);
  }
  providersByPackages.set(packages, found);
  return found;
}

/**
 * The sign-in, sign-up, sign-out or password-reset routine a call names, if it names
 * one and the project depends on the library it belongs to.
 */
function signInEntry(dotted: string, ctx: DetectorContext): AuthEntryPoint | null {
  const declared = declaredAuthProviders(ctx.signals.packages);
  if (declared.size === 0) return null;
  const entry = authEntryForCall(dotted, packageProvider(dotted.split('.')[0], ctx));
  return entry && declared.has(entry.provider) ? entry : null;
}

// ---------------------------------------------------------------------------
// Guards inside handlers
// ---------------------------------------------------------------------------

export const authDetector: BoundaryDetector = {
  id: 'auth',
  enabled: () => true,
  visit(node, ctx) {
    if (!Node.isCallExpression(node)) return;

    const dotted = dottedName(node.getExpression());
    if (!dotted) return;

    const guard = guardFromName(dotted, ctx);
    if (guard) {
      ctx.emit({
        type: 'guard',
        guard: { ...guard, line: node.getStartLineNumber() },
        scope: 'node',
        nodeId: ctx.enclosing(node),
        matchers: [],
        sourceId: ctx.fileId,
      });
      return;
    }

    // The same walk finds the calls that are a guard's mirror image. A handler that
    // calls the auth library's own sign-in cannot require the caller to be signed in
    // already, and reporting that as an unguarded door is how a security list gets a
    // reputation for crying wolf (#40).
    const entry = signInEntry(dotted, ctx);
    if (entry) {
      ctx.emit({
        type: 'sign-in-call',
        provider: entry.provider,
        what: entry.what,
        call: dotted,
        nodeId: ctx.enclosing(node),
        site: ctx.site(node, dotted),
      });
      return;
    }

    // `app.use(requireAuth)` and `app.use('/admin', requireAuth)` protect everything
    // mounted after them, which no per-route inspection would ever notice.
    routerMiddleware(node, dotted, ctx);
  },
};

/**
 * A check handed to a router rather than to a route: `app.use(requireAuth)`.
 *
 * What it protects depends entirely on which router it was written on, and that is not
 * a fact this file has. On the root app it is the whole application; on a sub-router it
 * is whatever prefix that router was mounted under, which is written somewhere else
 * again. So the pattern emitted here is relative, and `routerVar` says what it is
 * relative *to* — the merge layer puts the address in front of it.
 */
function routerMiddleware(call: CallExpression, dotted: string, ctx: DetectorContext): void {
  if (!dotted.endsWith('.use')) return;
  const parts = dotted.split('.');
  const hostVar = parts[parts.length - 2];
  // `queue.use(retryPolicy)` is not a route, and neither is anything else that happens
  // to have a `.use`. Only a name this file built a router from can carry doors.
  if (!hostVar || !looksLikeRouter(hostVar, ctx.locals)) return;

  const args = call.getArguments();
  if (args.length === 0) return;

  const prefix = literalString(args[0]);
  const candidates = prefix ? args.slice(1) : args;

  for (const arg of candidates) {
    const name = dottedName(Node.isCallExpression(arg) ? arg.getExpression() : arg);
    if (!name) continue;
    const guard = guardFromName(name, ctx);
    if (!guard) continue;
    ctx.emit({
      type: 'guard',
      guard: { ...guard, how: 'middleware', line: call.getStartLineNumber(), confidence: 'likely' },
      scope: 'matcher',
      nodeId: null,
      matchers: [prefix ? `${prefix.replace(/\/$/, '')}/:path*` : '/:path*'],
      routerVar: hostVar,
      sourceId: ctx.fileId,
    });
  }
}

// ---------------------------------------------------------------------------
// A check written in the wiring: NestJS module middleware
// ---------------------------------------------------------------------------

/**
 * The two HTTP statuses that mean "I do not accept who you are".
 *
 * Identical in spirit to the rule the Python extractor uses, and for the same reason:
 * this is a fact about what the code does, where a name is only ever a guess about what
 * somebody meant. `AuthMiddleware` is not a check because of the word *Auth* in it; it
 * is a check because it throws a 401 at callers without a token.
 */
const REJECT_STATUS = /\b(401|403|UNAUTHORIZED|FORBIDDEN)\b/;

/** Calls that are a rejection rather than a mention: `res.status(401)`, `c.json(x, 403)`. */
const REJECT_CALLS = new Set(['status', 'sendStatus', 'json', 'send', 'abort', 'createError', 'Response']);

/** The methods a framework calls to ask "may this request proceed?". */
const CHECK_CONTRACTS = new Set(['use', 'canActivate']);

/** The line where this body turns an unauthenticated caller away, if it does. */
function rejectionLine(node: Node): number | null {
  let line: number | null = null;
  node.forEachDescendant((child) => {
    if (line !== null) return;
    if (Node.isThrowStatement(child)) {
      if (REJECT_STATUS.test(child.getText())) line = child.getStartLineNumber();
      return;
    }
    // Plenty of frameworks refuse a caller without throwing anything.
    if (!Node.isCallExpression(child)) return;
    const callee = dottedName(child.getExpression())?.split('.').pop();
    if (!callee || !REJECT_CALLS.has(callee)) return;
    if (REJECT_STATUS.test(child.getText())) line = child.getStartLineNumber();
  });
  return line;
}

export const wiredGuardDetector: BoundaryDetector = {
  id: 'wired-guards',
  enabled: (ctx) => ctx.signals.packages.has('@nestjs/common'),
  visit(node, ctx) {
    if (Node.isClassDeclaration(node)) checkerClass(node, ctx);
    else if (Node.isCallExpression(node)) moduleMiddleware(node, ctx);
  },
};

/**
 * A class that answers a framework's "may this request proceed?" contract by saying no.
 *
 * Deliberately narrow. A module applies a logger with the same call it applies a lock,
 * so the only thing separating them is that one of them refuses somebody — and asking
 * that question of every method of every class would let an unrelated `401` in an error
 * handler make a formatter look like a guard.
 */
function checkerClass(cls: ClassDeclaration, ctx: DetectorContext): void {
  const name = cls.getName();
  if (!name) return;
  for (const method of cls.getMethods()) {
    if (!CHECK_CONTRACTS.has(method.getName())) continue;
    const line = rejectionLine(method);
    if (line === null) continue;
    ctx.emit({
      type: 'auth-checker',
      name,
      guard: {
        name,
        how: 'middleware',
        provider: 'custom',
        path: ctx.ref.relPath,
        // The refusal itself, so the evidence link lands on the line that proves it.
        line,
        confidence: 'likely',
      },
    });
    return;
  }
}

// ---------------------------------------------------------------------------
// A check written as a plain function: the hand-rolled secret comparison
// ---------------------------------------------------------------------------

/**
 * A top-level function that turns a caller away is a check, whatever it is called and
 * whatever framework failed to bless it (#155).
 *
 * The 401 vocabulary above was fenced twice — inside a class, implementing a NestJS
 * contract, in a project depending on Nest — so vercel/commerce's `/api/revalidate`,
 * which compares a query secret against `SHOPIFY_REVALIDATION_SECRET` and refuses on
 * mismatch, sat on the worry list of Vercel's own reference storefront. Every Next.js
 * revalidation webhook, every `CRON_SECRET` cron endpoint, every handler comparing a
 * header against an env var is this shape, and none of them names an auth provider.
 * The Go tier has read behaviour this way from the start; this is the flagship tier
 * catching up. Svelte and Remix keep their own sharper rule (`refusalDetector`), which
 * is gated on those frameworks' own refusal calls — this one steps aside where it runs.
 *
 * Three deliberate narrowings, because the risk here is `checkerClass`'s own warning —
 * an unrelated 401 in an error handler making a formatter look like a guard:
 *
 * - Top-level functions only. Class methods are where response formatters and API
 *   clients live, and the class-shaped checks (NestJS) have their own detector.
 * - A rejection inside a `catch` does not count. A guard refuses a *caller*; a catch
 *   block describes an *upstream failure*, and "the vendor said 401" is not a lock on
 *   our door. (The NestJS rule keeps catch rejections on purpose — `try jwt.verify
 *   catch throw new UnauthorizedException` is that framework's ordinary guard — which
 *   is why this exclusion lives here and not in `rejectionLine`.)
 * - `likely`, never `certain`, for the reason #148 settled: one function's behaviour
 *   standing in for a decision no framework confirmed.
 *
 * The door finds the check through the reference graph — `POST /api/revalidate` calls
 * `revalidate`, one hop, cross-file — which also bounds the claim: only a function a
 * handler actually mentions can ever reach that handler's door.
 *
 * Decided here rather than inherited by accident: commerce writes `NextResponse.json({
 * status: 401 })`, which puts the 401 in the *body* and answers 200 on the wire. It
 * counts. The code refuses the caller and the author locked the door; the response
 * shape is their bug to find, and "nobody is checking who calls this" would be false.
 */
export const functionRefusalDetector: BoundaryDetector = {
  id: 'function-refusals',
  enabled: (ctx) => !ctx.signals.svelteKitRoutesDir && !ctx.signals.remixRoutesDir,
  fileScan(ctx) {
    if (!REJECT_STATUS.test(ctx.sf.getFullText())) return;
    for (const fn of topLevelFunctions(ctx.sf)) {
      const body = fn.node.getBody?.() ?? fn.node;
      const line = rejectionOutsideCatch(body);
      if (line === null) continue;
      ctx.emit({
        type: 'guard',
        guard: {
          name: fn.name,
          how: 'call',
          provider: 'custom',
          path: ctx.ref.relPath,
          // The refusal itself, so the evidence link lands on the line that proves it.
          line,
          confidence: 'likely',
        },
        // Reach is the function itself; build.ts and the reference walk decide which
        // doors that means.
        scope: 'node',
        nodeId: ctx.enclosing(fn.node),
        matchers: [],
        // Found where the check lives, not where anybody calls it — so the reference
        // walk must not credit a mere import (see GuardFinding.definitionSite).
        definitionSite: true,
        sourceId: ctx.fileId,
      });
    }
  },
};

interface TopLevelFn {
  name: string;
  node: Node & { getBody?(): Node | undefined };
}

/** Named function declarations and `const x = () => …` at module scope. */
function topLevelFunctions(sf: SourceFile): TopLevelFn[] {
  const out: TopLevelFn[] = [];
  for (const fn of sf.getFunctions()) {
    const name = fn.getName();
    if (name) out.push({ name, node: fn });
  }
  for (const decl of sf.getVariableDeclarations()) {
    const init = decl.getInitializer();
    if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) {
      out.push({ name: decl.getName(), node: init });
    }
  }
  return out;
}

/** `rejectionLine`, minus anything a catch block says. */
function rejectionOutsideCatch(node: Node): number | null {
  let line: number | null = null;
  node.forEachDescendant((child) => {
    if (line !== null) return;
    if (child.getFirstAncestor((a) => Node.isCatchClause(a))) return;
    if (Node.isThrowStatement(child)) {
      if (REJECT_STATUS.test(child.getText())) line = child.getStartLineNumber();
      return;
    }
    if (!Node.isCallExpression(child)) return;
    const callee = dottedName(child.getExpression())?.split('.').pop();
    if (!callee || !REJECT_CALLS.has(callee)) return;
    if (REJECT_STATUS.test(child.getText())) line = child.getStartLineNumber();
  });
  return line;
}

/**
 * `consumer.apply(AuthMiddleware).forRoutes({ path: 'user', method: RequestMethod.GET })`
 * — the whole of a NestJS application's auth, written in files no controller imports.
 *
 * The addresses are literals here, which makes this the rare case where the wiring says
 * exactly what it covers. The method matters as much as the path: `articles/:slug` is
 * guarded for PUT and DELETE and public for GET, and a rule that read only the path
 * would report the public one as locked.
 */
function moduleMiddleware(call: CallExpression, ctx: DetectorContext): void {
  if (dottedName(call.getExpression())?.split('.').pop() !== 'forRoutes') return;

  // `.apply(X)` is the other half, and it is the call this one hangs off.
  const applied = call.getExpression();
  if (!Node.isPropertyAccessExpression(applied)) return;
  const apply = applied.getExpression();
  if (!Node.isCallExpression(apply) || dottedName(apply.getExpression())?.split('.').pop() !== 'apply') return;

  const names = apply.getArguments().map((arg) => dottedName(arg)).filter((n): n is string => Boolean(n));
  if (names.length === 0) return;

  for (const arg of call.getArguments()) {
    const route = routeSpec(arg);
    if (!route) continue;
    for (const name of names) {
      ctx.emit({
        type: 'path-guard',
        name,
        matcher: route.path,
        method: route.method,
        framework: 'NestJS',
        path: ctx.ref.relPath,
        line: call.getStartLineNumber(),
      });
    }
  }
}

/** One entry of a `forRoutes(...)` list: `'user'`, or `{ path, method }`. */
function routeSpec(arg: Node): { path: string; method: string | null } | null {
  const absolute = (path: string) => (path.startsWith('/') ? path : `/${path}`);
  const bare = literalString(arg);
  if (bare) return { path: absolute(bare), method: null };
  const raw = literalString(objectProp(arg, 'path'));
  if (raw === null) return null;
  const path = absolute(raw);
  // `RequestMethod.GET` — the enum member's name is the method, and `ALL` means every one.
  const method = dottedName(objectProp(arg, 'method'))?.split('.').pop() ?? null;
  return { path, method: !method || method === 'ALL' ? null : method.toUpperCase() };
}

// ---------------------------------------------------------------------------
// Next.js middleware
// ---------------------------------------------------------------------------

const MIDDLEWARE_FILES = new Set(['middleware.ts', 'middleware.js', 'src/middleware.ts', 'src/middleware.js']);

export const middlewareDetector: BoundaryDetector = {
  id: 'next-middleware',
  enabled: (ctx) => MIDDLEWARE_FILES.has(ctx.ref.relPath),
  fileScan(ctx) {
    const guard = middlewareGuard(ctx);
    if (!guard) return;

    // No `config.matcher` means Next.js runs the middleware on every request.
    const matchers = readMatchers(ctx.sf);
    ctx.emit({
      type: 'guard',
      guard,
      scope: 'matcher',
      nodeId: null,
      matchers: matchers.length > 0 ? matchers : ['/:path*'],
      sourceId: ctx.fileId,
    });
  },
};

/**
 * Only middleware that actually checks something counts. Plenty of apps use
 * `middleware.ts` purely for locale redirects, and calling that "auth" would be a lie.
 */
function middlewareGuard(ctx: DetectorContext): GuardInfo | null {
  for (const binding of ctx.imports.values()) {
    if (!binding.external) continue;
    const provider = authProviderForPackage(binding.module);
    if (provider) {
      return {
        name: binding.local,
        how: 'middleware',
        provider,
        path: ctx.ref.relPath,
        line: 1,
        confidence: 'likely',
      };
    }
  }

  let found: GuardInfo | null = null;
  ctx.sf.forEachDescendant((node) => {
    if (found || !Node.isCallExpression(node)) return;
    const dotted = dottedName(node.getExpression());
    if (!dotted) return;
    const guard = guardFromName(dotted, ctx);
    if (guard) found = { ...guard, how: 'middleware', line: node.getStartLineNumber(), confidence: 'likely' };
  });
  return found;
}

function readMatchers(sf: SourceFile): string[] {
  for (const decl of sf.getVariableDeclarations()) {
    if (decl.getName() !== 'config') continue;
    const init = decl.getInitializer();
    if (!init || !Node.isObjectLiteralExpression(init)) continue;
    const prop = init.getProperty('matcher');
    if (!prop || !Node.isPropertyAssignment(prop)) continue;
    return stringArray(prop.getInitializer());
  }
  return [];
}

// ---------------------------------------------------------------------------
// Matching a middleware matcher against a route
// ---------------------------------------------------------------------------

/**
 * Next.js matchers are path-to-regexp patterns, and the common ones use a negative
 * lookahead to mean "everything except". We convert what we can and treat the result
 * as `likely` rather than pretending to be path-to-regexp.
 */
export function matcherMatches(matcher: string, route: string): boolean {
  const compiled = compileMatcher(matcher);
  if (!compiled) return false;
  return compiled.test(route);
}

const matcherCache = new Map<string, RegExp | null>();

function compileMatcher(matcher: string): RegExp | null {
  const cached = matcherCache.get(matcher);
  if (cached !== undefined) return cached;

  let compiled: RegExp | null = null;
  try {
    const source = matcher
      // `/dashboard/:path*` covers `/dashboard` as well as everything under it —
      // getting this wrong would report a protected page as wide open.
      .replace(/\/:\w+\*/g, '(?:/.*)?')
      .replace(/\/:\w+\+/g, '/.*')
      // A named segment on its own matches exactly one path segment.
      .replace(/:\w+/g, '[^/]+')
      // A bare `*` (not part of `.*` or a group quantifier) means the same thing.
      .replace(/(?<![.\])])\*/g, '.*');
    compiled = new RegExp(`^${source}$`);
  } catch {
    compiled = null;
  }

  matcherCache.set(matcher, compiled);
  return compiled;
}

/** True when the matcher is one of the "protect everything except assets" idioms. */
export function isCatchAllMatcher(matcher: string): boolean {
  return matcher.includes('(?!') || matcher === '/:path*' || matcher === '/(.*)';
}

export function argString(call: CallExpression, index: number): string | null {
  return literalString(argAt(call, index));
}
