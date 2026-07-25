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
 */
import { Node } from 'ts-morph';
import type { CallExpression, SourceFile } from 'ts-morph';
import type { GuardInfo } from '../../model/types.js';
import { authProviderForPackage } from './catalog.js';
import { argAt, dottedName, literalString, stringArray } from './ast.js';
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
  const binding = ctx.imports.get(root);
  if (binding?.external) return authProviderForPackage(binding.module) ?? 'custom';
  const local = ctx.locals.get(root);
  if (local?.module) return authProviderForPackage(local.module) ?? 'custom';
  return 'custom';
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

    // `app.use(requireAuth)` and `app.use('/admin', requireAuth)` protect everything
    // mounted after them, which no per-route inspection would ever notice.
    expressGlobalGuard(node, dotted, ctx);
  },
};

function expressGlobalGuard(call: CallExpression, dotted: string, ctx: DetectorContext): void {
  if (!dotted.endsWith('.use')) return;
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
      sourceId: ctx.fileId,
    });
  }
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
