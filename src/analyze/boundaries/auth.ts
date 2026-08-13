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
import type { CallExpression, ClassDeclaration, ObjectLiteralExpression, SourceFile } from 'ts-morph';
import type { GuardInfo } from '../../model/types.js';
import { authEntryForCall, authProviderForPackage } from './catalog.js';
import type { AuthEntryPoint } from './catalog.js';
import { argAt, dottedName, literalString, looksLikeRouter, objectProp, permitsEverything, stringArray } from './ast.js';
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
  // `connect-ensure-login` exports this name, and NodeBB puts it in front of every one of
  // its admin routes. Exact names rather than an `ensure`/`check` prefix on purpose:
  // `checkRequired` sits in the same NodeBB argument list and validates a request body.
  'ensureLoggedIn',
  'checkPrivileges',
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
 * A guard's name with the app's own suffix on the end (#204).
 *
 * `GUARD_NAMES` matches whole names, and real applications name middleware after what it
 * guards. Ghost declares 218 of its 261 admin routes as
 * `router.get('/posts', mw.authAdminApi, …)`, where `authAdminApi` is
 * `[auth.authenticate.authenticateAdminApi, auth.authorize.authorizeAdminApi, …]` — a
 * genuine check, invisible to an exact-match set, on one of the largest Express
 * applications there is. `authenticateAdminApi` and `authorizeAdminApi` miss for the
 * same reason.
 *
 * **The boundary is the whole rule.** A suffix has to start with a capital or an
 * underscore, so `auth` matches `authAdminApi` and not `author` — and Ghost is a blogging
 * platform, so `authorExists`, `authorImage` and `authorFacebook` are all in it. Reading
 * one of those as a lock is exactly the failure this file opens by warning about, and
 * anchoring on the word boundary is what stops it.
 *
 * Weaker than an exact match, and it says so: a name that *begins* like a check is good
 * evidence and not the same as a name that *is* one.
 */
const GUARD_PREFIX = new RegExp(`^(${[...GUARD_NAMES, 'auth'].join('|')})[A-Z_]\\w*$`);

/**
 * The other end of that boundary: a tail naming the thing routes hang off (#225).
 *
 * `app.use('/auth', authRouter)` mounts a router, and the prefix rule above reads
 * `authRouter` as a check — so directus reported `POST /auth/logout`, `POST
 * /auth/refresh` and both halves of its password reset as locked, by a "check" that is
 * the router those five doors are declared on. The doors that most need to read as open
 * were the ones wearing a lock.
 *
 * Narrow on purpose, and only ever applied to a *prefix* match — an exact `GUARD_NAMES`
 * hit is a whole name and needs no help. Scanning directus, Ghost and NodeBB for every
 * identifier the prefix rule accepts turns up one family that ends this way, and it is
 * this one; nothing anybody would name a check ends in `Router` or `Routes`.
 *
 * It is not the whole answer, because the general case is not a suffix question:
 * `authService`, `authProvider`, `authUrl` and `auth_data` are all in that same scan and
 * no list of nouns ever finishes. What settles those is evidence rather than spelling —
 * see `routersMountedHere` in the merge, which withdraws a name the project turns out to
 * mount a real router under. This rule covers the case that evidence cannot reach,
 * where the router is a local the mount reader could not resolve.
 */
const NAMES_A_ROUTER = /(Router|Routers|Routes)$/;

/**
 * Recognises a guard by the name it is called by. Exported so the route detectors can
 * label the middleware they see in a route's argument list.
 */
export function guardFromName(dotted: string, ctx: DetectorContext): GuardInfo | null {
  const parts = dotted.split('.');
  const last = parts[parts.length - 1];
  const root = parts[0];

  const exact =
    GUARD_NAMES.has(last) ||
    GUARD_CLASS.test(last) ||
    GUARD_DOTTED.some((pattern) => pattern.test(dotted)) ||
    (AMBIGUOUS_NAMES.has(last) && isAuthContext(root, ctx));

  if (!exact && (!GUARD_PREFIX.test(last) || NAMES_A_ROUTER.test(last))) return null;

  return {
    name: dotted,
    how: 'call',
    provider: providerFor(root, ctx),
    path: ctx.ref.relPath,
    line: null,
    confidence: exact ? 'certain' : 'likely',
  };
}

/**
 * Cookie names that are somebody's session, as opposed to somebody's preference.
 *
 * Read the *cookie's* name and never the handler's: `logout` as a function name proves
 * nothing (#147's rule), and deleting `theme` is not signing out. Anchored on the whole
 * name with the usual host-prefix and dot/underscore-namespaced spellings allowed, so
 * `__Secure-session`, `next-auth.session-token` and `sid` all count and `sidebar` does
 * not.
 */
const SESSION_COOKIE = /^(__(secure|host)-)?([a-z0-9]+[._-])*(jwt|sid|session|sessionid|token|auth|access[_-]?token|refresh[_-]?token)([._-][a-z0-9]+)*$/i;

/**
 * `cookies.delete('jwt')` / `res.clearCookie('session')` — signing out with no library
 * to name (#186).
 *
 * Two spellings, each a framework's own: SvelteKit and Hono hand the handler a cookies
 * object with `.delete(name)`, and Express answers with `res.clearCookie(name)`. The
 * receiver has to look like the thing the framework handed over, because `.delete` on
 * its own is the most overloaded method name in the language — a Map, a Set, a
 * repository and an S3 client all have one.
 *
 * Returns the call as written, for the sentence `becauseSignIn` builds out of it.
 */
function cookieSignOut(dotted: string, node: CallExpression): string | null {
  const parts = dotted.split('.');
  const method = parts[parts.length - 1];
  const receiver = parts.slice(0, -1).join('.');
  const isCookieDelete = method === 'delete' && /(^|\.)cookies$/i.test(receiver);
  const isClearCookie = method === 'clearCookie' && receiver !== '';
  if (!isCookieDelete && !isClearCookie) return null;

  const name = literalString(argAt(node, 0));
  if (!name || !SESSION_COOKIE.test(name)) return null;
  return `${dotted}('${name}')`;
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

    // …and the same door for an app that rolls its own session (#186). Every sign-out
    // recognised above is a named call into an auth library; a SvelteKit or Express app
    // that issues its own cookie has no library to call, and the sign-out *is*
    // `cookies.delete('jwt')`. sveltejs/realworld's logout action was the single entry
    // on that repo's worry list — a reader who opens the only finding, sees a logout,
    // and concludes the list is decoration is #116 happening in one click.
    const signOut = cookieSignOut(dotted, node);
    if (signOut) {
      ctx.emit({
        type: 'sign-in-call',
        // "the app's own sign-out routine" — because that is precisely what makes this
        // case different from every other entry in `becauseSignIn`: there is no library
        // whose name could go here.
        provider: 'the app',
        what: 'sign-out',
        call: signOut,
        nodeId: ctx.enclosing(node),
        site: ctx.site(node, signOut),
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
      coversFrom: { path: ctx.ref.relPath, line: call.getStartLineNumber() },
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
    else if (Node.isObjectLiteralExpression(node)) globalGuard(node, ctx);
  },
};

/**
 * `{ provide: APP_GUARD, useClass: AuthGuard }` — the guard the whole application
 * stands behind, wired in one line no controller imports (#172).
 *
 * This is Nest's own way of saying "every route, unless it opts out": a guard provided
 * under the `APP_GUARD` token runs for the entire application, whichever module
 * declares it. immich locks all 270 of its routes this way — the per-route
 * `@Authenticated()` decorators set metadata the global `AuthGuard` *reads*, and apply
 * no guard of their own — so a reader that only knows `@UseGuards` reported the most
 * methodically guarded server this dogfooding effort has met as `269 of 270 routes
 * unprotected`. The largest false alarm to date, and #116's warning at 25× the scale
 * it was written for.
 *
 * A catch-all matcher at `likely`, because "wired in a module, reaches everything" is
 * exactly what that grade means — the wiring proves reach, and the class body proves it
 * decides something (the #152 rule keeps an always-true sentinel from counting; a class
 * we cannot resolve stays a guard, same direction as there). Which individual routes
 * opt out via metadata (`@Authenticated({ public: true })`) is a custom decorator's
 * runtime contract and is not claimed: blanket-likely is the truth to the precision we
 * can read.
 *
 * `useClass` and `useExisting` only. A `useFactory` guard is real and is not read —
 * there is no class name to show a reader, and inventing one would be worse than the
 * headline hedging on `likely`.
 */
function globalGuard(obj: ObjectLiteralExpression, ctx: DetectorContext): void {
  const provide = obj.getProperty('provide');
  if (!Node.isPropertyAssignment(provide)) return;
  if (provide.getInitializer()?.getText() !== 'APP_GUARD') return;
  const impl = obj.getProperty('useClass') ?? obj.getProperty('useExisting');
  if (!Node.isPropertyAssignment(impl)) return;
  const value = impl.getInitializer();
  const name = value ? dottedName(value) : null;
  if (!value || !name) return;
  if (permitsEverything(value)) return;
  ctx.emit({
    type: 'guard',
    guard: {
      name,
      how: 'config',
      provider: guardFromName(name, ctx)?.provider ?? 'custom',
      path: ctx.ref.relPath,
      line: obj.getStartLineNumber(),
      confidence: 'likely',
    },
    scope: 'matcher',
    nodeId: null,
    matchers: ['/:path*'],
    routerVar: null,
    sourceId: ctx.fileId,
  });
}

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
          name: guardName(fn.name),
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

/**
 * What to call the check when the function holding it has no name worth reading (#190).
 *
 * In Go this reads well — `ArticleDelete` tells a reader which handler does its own
 * checking. In a Next.js route file the exported handler's name *is* the HTTP verb,
 * because the framework requires it, so the security screen said `POST /api/rename` is
 * protected by **POST**. True, correctly graded, and useless: an evidence column a
 * reader cannot verify is how the whole column stops being read.
 *
 * The site link does the pointing either way; only the label changes.
 */
function guardName(fnName: string): string {
  return HTTP_HANDLER_NAMES.has(fnName) ? 'a 401 in the handler' : fnName;
}

/** The names Next.js, Remix and friends *require* of a route handler. */
const HTTP_HANDLER_NAMES = new Set([
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
  'handler',
  'default',
]);

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
