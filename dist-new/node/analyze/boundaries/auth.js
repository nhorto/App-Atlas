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
import { authEntryForCall, authProviderForPackage } from './catalog.js';
import path from 'node:path';
import { toPosix } from '../../util/paths.js';
import { alwaysContinues, argAt, dottedName, enclosingFunctionOf, functionBehind, literalString, looksLikeRouter, objectProp, permitsEverything, stringArray, } from './ast.js';
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
export function guardFromName(dotted, ctx, node) {
    const exact = guardSpelling(dotted, ctx);
    // A name that spells out nothing is not the end of the question. The function behind it
    // may turn a caller away in so many words, and reading that is the difference between a
    // lock this tool recognises and one it has read the code for (#261).
    if (exact === null)
        return node ? refusalBehindTheName(dotted, ctx, node) : null;
    // Everything above this line is spelling, and the file says so at the top. If the
    // function the name stands for is in this project and every way out of it hands
    // control on, the spelling was wrong and the name is withdrawn (#237).
    //
    // Asked here because this is the one place a name becomes a claim — five call sites
    // reach it and all five carry the same risk. It only ever *removes*: a body that
    // cannot be found, or cannot be decided, leaves the answer exactly as it was.
    if (node && readsIdentityWithoutRefusing(node))
        return null;
    return {
        name: dotted,
        how: 'call',
        provider: providerFor(dotted.split('.')[0], ctx),
        path: ctx.ref.relPath,
        line: null,
        confidence: exact ? 'certain' : 'likely',
    };
}
/**
 * Where to point at a check that was found in a registration — the argument list, the
 * `.use`, the decorator.
 *
 * Every one of those sites used to overwrite the line unconditionally, and that was
 * right while every guard came back carrying `path: ctx.ref.relPath` and no line: the
 * registration was the only site anybody had, so pointing there was pointing at the only
 * evidence there was.
 *
 * `refusalBehindTheName` breaks that, because the evidence it found is a refusal in
 * another file. Overwriting its line while keeping its path produces a link to whatever
 * happens to sit on line 126 of `middlewares.js` — a citation that is worse than none,
 * because it looks checkable and is wrong. So a guard that brought its own site keeps it,
 * and only a guard that brought none is given the registration's (#261).
 */
export function guardAt(guard, line) {
    return guard.line === null ? { ...guard, line } : guard;
}
/**
 * Whether the *name* is a guard's, before anything has been read. `true` for a whole
 * name, `false` for one that merely begins like one, `null` for neither.
 */
function guardSpelling(dotted, ctx) {
    const parts = dotted.split('.');
    const last = parts[parts.length - 1];
    const root = parts[0];
    const exact = GUARD_NAMES.has(last) ||
        GUARD_CLASS.test(last) ||
        GUARD_DOTTED.some((pattern) => pattern.test(dotted)) ||
        (AMBIGUOUS_NAMES.has(last) && isAuthContext(root, ctx));
    if (exact)
        return true;
    if (!GUARD_PREFIX.test(last) || NAMES_A_ROUTER.test(last))
        return null;
    return false;
}
function readsIdentityWithoutRefusing(node) {
    const body = functionBehind(node);
    return body !== null && alwaysContinues(body);
}
/**
 * The check whose name says nothing, found by reading what it does instead (#261).
 *
 * Everything above this point is spelling, and the top of this file explains why that is
 * the safe way round. But spelling has a floor, and #256 found it: parse-server puts
 * `Middlewares.handleParseHeaders` in the argument list of `POST /files/:filename` and
 * `DELETE /files/*filepath`, and those two doors report no check at all. The name begins
 * with `handle`. No list of nouns was ever going to catch it — `GUARD_NAMES` is thirty
 * entries and adding a thirty-first is the move this file has already refused twice,
 * because middleware is named after *what it does to the request*, not after guarding.
 *
 * So the road `readsIdentityWithoutRefusing` opened runs both ways. That rule opens the
 * function behind a name to *withdraw* a lock the spelling earned; this one opens the
 * same function to grant a lock the spelling missed. The asymmetry was the whole of #261.
 *
 * ## Why one hop, and not zero
 *
 * `handleParseHeaders` contains no 401 and no 403. It calls `invalidRequest(req, res)`
 * nine times, and *that* function, 750 lines down the same file, is the refusal:
 *
 * ```js
 * function invalidRequest(req, res) { res.status(403); res.end('{"error":"unauthorized"}'); }
 * ```
 *
 * A body read alone reaches nothing here, which is what the first attempt at this issue
 * measured. One hop is where it stops, for the reason `functionRefusalDetector` gives
 * about its own reach: a claim that follows calls forever eventually finds a 401 in
 * something's error formatter and puts it on a door nobody checks.
 *
 * ## Whose refusal it is
 *
 * `own` on both scans is the hard half, and it is not a tidiness measure. cjsauth's
 * `createSessionFromToken` is a middleware *factory* — the 401 sits in the function it
 * returns — and `forEachDescendant` walks straight into it, so an unfiltered read grants
 * a lock from a function that has never turned anybody away. That mistake breaks four
 * tests, two of them deliberate under-claims this project argued itself into. A refusal
 * one function further down belongs to whatever this one produced, not to this one.
 *
 * Same reason the hop resolves the callee rather than trusting the call: `next()` and
 * `res.status(401)` are both calls in the body, and only a function this project declares
 * gets read (see `ownRefusal`).
 *
 * `likely`, never `certain` — #148. And the site is the refusal itself, in the file that
 * holds it, so the evidence link lands on the line that proves the claim rather than on
 * the argument list that merely names it.
 */
function refusalBehindTheName(dotted, ctx, node) {
    // A name this file got from a package resolves into `node_modules`, where `ownRefusal`
    // declines to read anyway — so answer that from the import table rather than paying for
    // the symbol lookup first. Most of what sits in a registration is `bodyParser.json`,
    // `express.static`, `cors()`, and this is what keeps reading the rest affordable.
    if (ctx.imports.get(dotted.split('.')[0])?.external)
        return null;
    const fn = functionBehind(node);
    if (fn === null)
        return null;
    const refusal = ownRefusal(fn) ?? refusalOneCallAway(fn) ?? refusalInWhatItBuilds(fn, node);
    if (refusal === null)
        return null;
    return {
        name: dotted,
        how: 'call',
        // The body is the evidence. No library blessed this, so naming one would be a guess.
        provider: 'custom',
        path: toPosix(path.relative(ctx.project.root, refusal.file)),
        line: refusal.line,
        confidence: 'likely',
    };
}
/**
 * The refusal inside what a factory *builds* — but only where the registration built it.
 *
 * #261 pinned both of its scans to a function's own statements so that a middleware
 * factory could not lend its product's lock to a bare name, and that rule stands: a
 * reference to `createSessionFromToken` proves nothing about any door.
 *
 * `auth()` is not that. The parentheses are in the registration, so the function this
 * returns *is* the middleware standing on that route — outline writes
 *
 * ```ts
 * router.post("documents.list", rateLimiter(…), auth(), pagination(), handler);
 * ```
 *
 * on 185 of its 226 routes, and every one of them reported no check at all. Reading the
 * product of a call somebody wrote is a different claim from reading a nested function of
 * a name somebody mentioned, and the parentheses are what tell them apart.
 *
 * Narrow deliberately: one returned function, from this factory's own body, and the same
 * two refusal tests applied to it — no deeper than a middleware written out in full would
 * have been read. A factory returning a factory is not followed.
 */
function refusalInWhatItBuilds(fn, node) {
    // Was it called here? `auth()` in an argument list arrives as the *expression* of a
    // call, and a bare `auth` does not. Nothing else distinguishes them, and everything
    // downstream depends on the difference.
    const parent = node.getParent();
    if (!parent || !Node.isCallExpression(parent) || parent.getExpression() !== node)
        return null;
    const built = returnedFunctionOf(fn);
    return built === null ? null : (ownRefusal(built) ?? refusalOneCallAway(built));
}
/** The function a factory hands back, if its own body hands back exactly one. */
function returnedFunctionOf(fn) {
    const body = fn.getBody?.();
    if (!body)
        return null;
    let found = null;
    body.forEachDescendant((child) => {
        if (found !== null)
            return;
        if (!Node.isReturnStatement(child) || enclosingFunctionOf(child) !== fn)
            return;
        const value = child.getExpression();
        if (value && (Node.isArrowFunction(value) || Node.isFunctionExpression(value)))
            found = value;
    });
    return found;
}
/**
 * This function's own refusal, if it has one.
 *
 * Two gates before the walk, and both are about not reading code this project did not
 * write. A dependency's internals are the catalog's business, and `.d.ts` files carry no
 * bodies to read — scanning either would cost a regex over megabytes to learn nothing.
 *
 * Memoised on both, because this runs on every middleware name in every registration in
 * the repo and the same functions come back over and over: parse-server names
 * `promiseEnforceMasterKeyAccess` at 47 call sites and Ghost has one file of middleware
 * that most of its 261 admin routes reach. Un-memoised it cost a fifth of the analysis.
 */
const fileMightRefuse = new WeakMap();
const ownRefusals = new WeakMap();
function ownRefusal(fn) {
    const remembered = ownRefusals.get(fn);
    if (remembered !== undefined)
        return remembered;
    const sf = fn.getSourceFile();
    let readable = fileMightRefuse.get(sf);
    if (readable === undefined) {
        readable =
            !sf.isDeclarationFile() &&
                !/[\\/]node_modules[\\/]/.test(sf.getFilePath()) &&
                REJECT_STATUS.test(sf.getFullText());
        fileMightRefuse.set(sf, readable);
    }
    const line = readable ? rejectionOutsideCatch(fn, fn) : null;
    const refusal = line === null ? null : { file: sf.getFilePath(), line };
    ownRefusals.set(fn, refusal);
    return refusal;
}
/**
 * The refusal in something this function calls — one hop, and no further.
 *
 * Bounded three ways, because `guardFromName` runs on every middleware name in every
 * registration in the repo and a name that resolves to a two-hundred-line function must
 * not cost two hundred symbol lookups to find out it is not a check:
 *
 * - Only calls this function makes itself. A call inside a nested function is that
 *   function's business, for the reason `own` exists at all.
 * - Only a bare name. `res.status(...)`, `Promise.resolve()` and `req.get(...)` are most
 *   of the calls in any body and none of them can resolve to a function this project
 *   declares, so resolving them buys nothing. parse-server's refusal is
 *   `invalidRequest(req, res)` — a name this module declares, which is the whole shape
 *   being looked for.
 * - A budget, which is a floor under the worst case rather than a considered number.
 */
function refusalOneCallAway(fn) {
    let found = null;
    let budget = 40;
    fn.forEachDescendant((child) => {
        if (found !== null || budget <= 0)
            return;
        if (!Node.isCallExpression(child) || enclosingFunctionOf(child) !== fn)
            return;
        const callee = child.getExpression();
        if (!Node.isIdentifier(callee))
            return;
        budget -= 1;
        const called = functionBehind(callee);
        if (called === null || called === fn)
            return;
        found = ownRefusal(called);
    });
    return found;
}
/**
 * A middleware named like a check, which establishes who is calling and then lets them
 * through — the fact that replaces the lock this used to report (#237).
 *
 * Withdrawing directus's `authenticate` is right and, on its own, is 241 doors going
 * from a false green to an undifferentiated red. `exposure.ts` opens by saying why that
 * is its own kind of failure: a number people learn to scroll past is worse than no
 * number. The door is genuinely unrefused and stays in the count — but it stops being
 * silent about *what was there*, which is the one thing a reader needs to know to go
 * look in the right place. The refusal, if there is one, is further in.
 */
export function identityParserName(dotted, ctx, node) {
    return guardSpelling(dotted, ctx) !== null && readsIdentityWithoutRefusing(node) ? dotted : null;
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
function cookieSignOut(dotted, node) {
    const parts = dotted.split('.');
    const method = parts[parts.length - 1];
    const receiver = parts.slice(0, -1).join('.');
    const isCookieDelete = method === 'delete' && /(^|\.)cookies$/i.test(receiver);
    const isClearCookie = method === 'clearCookie' && receiver !== '';
    if (!isCookieDelete && !isClearCookie)
        return null;
    const name = literalString(argAt(node, 0));
    if (!name || !SESSION_COOKIE.test(name))
        return null;
    return `${dotted}('${name}')`;
}
/** `auth` is only a guard when it came from somewhere that deals in auth. */
function isAuthContext(root, ctx) {
    const binding = ctx.imports.get(root);
    if (binding)
        return /auth|session|clerk|supabase|lucia|kinde|workos/i.test(binding.module);
    const local = ctx.locals.get(root);
    if (local?.module)
        return /auth|clerk|supabase|lucia/i.test(local.module);
    return /auth|session/i.test(ctx.ref.relPath);
}
function providerFor(root, ctx) {
    return packageProvider(root, ctx) ?? 'custom';
}
/**
 * The auth library a name came out of, or `null` when it did not come out of one.
 *
 * Kept apart from `providerFor` above, whose `custom` fallback means "something checks
 * this and we cannot say what". Here the absence of an answer has to stay an absence:
 * "we could not trace this" must never read as "some auth library".
 */
function packageProvider(root, ctx) {
    const binding = ctx.imports.get(root);
    if (binding?.external)
        return authProviderForPackage(binding.module);
    const local = ctx.locals.get(root);
    if (local?.module)
        return authProviderForPackage(local.module);
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
const providersByPackages = new WeakMap();
function declaredAuthProviders(packages) {
    const cached = providersByPackages.get(packages);
    if (cached)
        return cached;
    const found = new Set();
    for (const pkg of packages) {
        const provider = authProviderForPackage(pkg);
        if (provider)
            found.add(provider);
    }
    providersByPackages.set(packages, found);
    return found;
}
/**
 * The sign-in, sign-up, sign-out or password-reset routine a call names, if it names
 * one and the project depends on the library it belongs to.
 */
function signInEntry(dotted, ctx) {
    const declared = declaredAuthProviders(ctx.signals.packages);
    if (declared.size === 0)
        return null;
    const entry = authEntryForCall(dotted, packageProvider(dotted.split('.')[0], ctx));
    return entry && declared.has(entry.provider) ? entry : null;
}
// ---------------------------------------------------------------------------
// Guards inside handlers
// ---------------------------------------------------------------------------
export const authDetector = {
    id: 'auth',
    enabled: () => true,
    visit(node, ctx) {
        if (!Node.isCallExpression(node))
            return;
        const dotted = dottedName(node.getExpression());
        if (!dotted)
            return;
        const guard = guardFromName(dotted, ctx, node.getExpression());
        if (guard) {
            ctx.emit({
                type: 'guard',
                guard: guardAt(guard, node.getStartLineNumber()),
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
function routerMiddleware(call, dotted, ctx) {
    if (!dotted.endsWith('.use'))
        return;
    const parts = dotted.split('.');
    const hostVar = parts[parts.length - 2];
    // `queue.use(retryPolicy)` is not a route, and neither is anything else that happens
    // to have a `.use`. Only a name this file built a router from can carry doors.
    if (!hostVar || !looksLikeRouter(hostVar, ctx.locals))
        return;
    const args = call.getArguments();
    if (args.length === 0)
        return;
    const prefix = literalString(args[0]);
    const candidates = prefix ? args.slice(1) : args;
    for (const arg of candidates) {
        const name = dottedName(Node.isCallExpression(arg) ? arg.getExpression() : arg);
        if (!name)
            continue;
        const target = Node.isCallExpression(arg) ? arg.getExpression() : arg;
        const guard = guardFromName(name, ctx, target);
        const matchers = [prefix ? `${prefix.replace(/\/$/, '')}/:path*` : '/:path*'];
        if (!guard) {
            // Named like a check and demonstrably not one. It reached every door this
            // registration covers, so those doors are told what stood in front of them rather
            // than nothing at all (#237).
            const parser = identityParserName(name, ctx, target);
            if (parser) {
                ctx.emit({
                    type: 'guard',
                    guard: {
                        name: parser,
                        how: 'middleware',
                        provider: 'custom',
                        path: ctx.ref.relPath,
                        line: call.getStartLineNumber(),
                        confidence: 'likely',
                    },
                    scope: 'matcher',
                    nodeId: null,
                    matchers,
                    routerVar: hostVar,
                    coversFrom: { path: ctx.ref.relPath, line: call.getStartLineNumber() },
                    parsesOnly: true,
                    sourceId: ctx.fileId,
                });
            }
            continue;
        }
        ctx.emit({
            type: 'guard',
            guard: { ...guardAt(guard, call.getStartLineNumber()), how: 'middleware', confidence: 'likely' },
            scope: 'matcher',
            nodeId: null,
            matchers,
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
/**
 * A refusal written as a type rather than a status code (#265).
 *
 * Two applications refuse this way and neither writes a number where the reader looks:
 *
 * ```ts
 * throw AuthenticationError("Authentication required");        // outline
 * reject(new AuthenticationError('Missing access token'));     // mastodon
 * ```
 *
 * The original filing said the answer was only worth having if the mapping to a status
 * turned out to be findable, because otherwise the evidence is a class *name* — and a
 * name is what this file spends its first hundred lines warning about. It is findable, in
 * both, and both are one hop from the raise:
 *
 * ```ts
 * export function AuthenticationError(message = "Authentication required", …) {
 *   return httpErrors(401, message, { … });                    // outline/server/errors.ts:10
 * }
 *
 * export class AuthenticationError extends Error {             // mastodon/streaming/errors.js:37
 *   constructor(message) { super(message); this.status = 401; }
 * }
 * ```
 *
 * So the question asked is the one the code can answer — *does the thing being raised
 * carry a 401 or a 403* — and never *is it called something authentication-shaped*.
 * `RequestError` sits in the same mastodon file, is spelled the same way, and sets
 * `this.status = 400`; it is not a refusal and this declines it for the only reason that
 * holds up.
 *
 * One hop, no further, for the reason `functionRefusalDetector` bounds its own reach:
 * following a chain until a 401 turns up eventually finds one in an error formatter.
 * Project code only — a status inside a dependency's own error classes says nothing
 * about this door.
 */
function raisesARefusingType(raise) {
    const thrown = raisedValue(raise);
    if (thrown === null)
        return false;
    const target = Node.isNewExpression(thrown) || Node.isCallExpression(thrown) ? thrown.getExpression() : thrown;
    if (!Node.isIdentifier(target) && !Node.isPropertyAccessExpression(target))
        return false;
    for (const declaration of declarationsOf(target)) {
        const sf = declaration.getSourceFile();
        if (sf.isDeclarationFile() || /[\\/]node_modules[\\/]/.test(sf.getFilePath()))
            continue;
        // The declaration's own text, not a walk: a class constructor assigning
        // `this.status = 401` and a function returning `httpErrors(401, …)` are both right
        // here, and anything deeper is the chain this deliberately does not follow.
        if (REJECT_STATUS.test(declaration.getText()))
            return true;
    }
    return false;
}
/** What a `throw` throws, or what a rejection-shaped call was handed. */
function raisedValue(raise) {
    if (Node.isThrowStatement(raise))
        return raise.getExpression() ?? null;
    if (!Node.isCallExpression(raise))
        return null;
    const [first] = raise.getArguments();
    return first ?? null;
}
/** Every declaration a name resolves to, following an import to what it names. */
function declarationsOf(node) {
    const symbol = node.getSymbol();
    if (!symbol)
        return [];
    let aliased;
    try {
        aliased = symbol.getAliasedSymbol();
    }
    catch {
        aliased = undefined;
    }
    return (aliased ?? symbol).getDeclarations() ?? [];
}
/** The line where this body turns an unauthenticated caller away, if it does. */
function rejectionLine(node) {
    let line = null;
    node.forEachDescendant((child) => {
        if (line !== null)
            return;
        if (Node.isThrowStatement(child)) {
            if (REJECT_STATUS.test(child.getText()))
                line = child.getStartLineNumber();
            return;
        }
        // Plenty of frameworks refuse a caller without throwing anything.
        if (!Node.isCallExpression(child))
            return;
        const callee = dottedName(child.getExpression())?.split('.').pop();
        if (!callee || !REJECT_CALLS.has(callee))
            return;
        if (REJECT_STATUS.test(child.getText()))
            line = child.getStartLineNumber();
    });
    return line;
}
export const wiredGuardDetector = {
    id: 'wired-guards',
    enabled: (ctx) => ctx.signals.packages.has('@nestjs/common'),
    visit(node, ctx) {
        if (Node.isClassDeclaration(node))
            checkerClass(node, ctx);
        else if (Node.isCallExpression(node))
            moduleMiddleware(node, ctx);
        else if (Node.isObjectLiteralExpression(node))
            globalGuard(node, ctx);
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
function globalGuard(obj, ctx) {
    const provide = obj.getProperty('provide');
    if (!Node.isPropertyAssignment(provide))
        return;
    if (provide.getInitializer()?.getText() !== 'APP_GUARD')
        return;
    const impl = obj.getProperty('useClass') ?? obj.getProperty('useExisting');
    if (!Node.isPropertyAssignment(impl))
        return;
    const value = impl.getInitializer();
    const name = value ? dottedName(value) : null;
    if (!value || !name)
        return;
    if (permitsEverything(value))
        return;
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
function checkerClass(cls, ctx) {
    const name = cls.getName();
    if (!name)
        return;
    for (const method of cls.getMethods()) {
        if (!CHECK_CONTRACTS.has(method.getName()))
            continue;
        const line = rejectionLine(method);
        if (line === null)
            continue;
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
export const functionRefusalDetector = {
    id: 'function-refusals',
    enabled: (ctx) => !ctx.signals.svelteKitRoutesDir && !ctx.signals.remixRoutesDir,
    fileScan(ctx) {
        if (!REJECT_STATUS.test(ctx.sf.getFullText()))
            return;
        for (const fn of topLevelFunctions(ctx.sf)) {
            const body = fn.node.getBody?.() ?? fn.node;
            const line = rejectionOutsideCatch(body);
            if (line === null)
                continue;
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
function guardName(fnName) {
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
/** Named function declarations and `const x = () => …` at module scope. */
function topLevelFunctions(sf) {
    const out = [];
    for (const fn of sf.getFunctions()) {
        const name = fn.getName();
        if (name)
            out.push({ name, node: fn });
    }
    for (const decl of sf.getVariableDeclarations()) {
        const init = decl.getInitializer();
        if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) {
            out.push({ name: decl.getName(), node: init });
        }
    }
    return out;
}
/**
 * `rejectionLine`, minus anything a catch block says.
 *
 * `own`, when given, narrows the walk to that function's own statements — a refusal in a
 * function nested inside it is that function's, not this one's. `functionRefusalDetector`
 * leaves it off because it already scans every top-level function separately, so a nested
 * refusal would be found again on its own terms; `refusalBehindTheName` needs it, because
 * a middleware factory is exactly a function whose product refuses (#261).
 */
function rejectionOutsideCatch(node, own) {
    let line = null;
    node.forEachDescendant((child) => {
        if (line !== null)
            return;
        if (own && enclosingFunctionOf(child) !== own)
            return;
        if (child.getFirstAncestor((a) => Node.isCatchClause(a)))
            return;
        if (Node.isThrowStatement(child)) {
            if (REJECT_STATUS.test(child.getText()) || raisesARefusingType(child))
                line = child.getStartLineNumber();
            return;
        }
        if (!Node.isCallExpression(child))
            return;
        const callee = dottedName(child.getExpression())?.split('.').pop();
        if (!callee || !REJECT_CALLS.has(callee))
            return;
        if (REJECT_STATUS.test(child.getText()) || raisesARefusingType(child))
            line = child.getStartLineNumber();
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
function moduleMiddleware(call, ctx) {
    if (dottedName(call.getExpression())?.split('.').pop() !== 'forRoutes')
        return;
    // `.apply(X)` is the other half, and it is the call this one hangs off.
    const applied = call.getExpression();
    if (!Node.isPropertyAccessExpression(applied))
        return;
    const apply = applied.getExpression();
    if (!Node.isCallExpression(apply) || dottedName(apply.getExpression())?.split('.').pop() !== 'apply')
        return;
    const names = apply.getArguments().map((arg) => dottedName(arg)).filter((n) => Boolean(n));
    if (names.length === 0)
        return;
    for (const arg of call.getArguments()) {
        const route = routeSpec(arg);
        if (!route)
            continue;
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
function routeSpec(arg) {
    const absolute = (path) => (path.startsWith('/') ? path : `/${path}`);
    const bare = literalString(arg);
    if (bare)
        return { path: absolute(bare), method: null };
    const raw = literalString(objectProp(arg, 'path'));
    if (raw === null)
        return null;
    const path = absolute(raw);
    // `RequestMethod.GET` — the enum member's name is the method, and `ALL` means every one.
    const method = dottedName(objectProp(arg, 'method'))?.split('.').pop() ?? null;
    return { path, method: !method || method === 'ALL' ? null : method.toUpperCase() };
}
// ---------------------------------------------------------------------------
// Next.js middleware
// ---------------------------------------------------------------------------
const MIDDLEWARE_FILES = new Set(['middleware.ts', 'middleware.js', 'src/middleware.ts', 'src/middleware.js']);
export const middlewareDetector = {
    id: 'next-middleware',
    enabled: (ctx) => MIDDLEWARE_FILES.has(ctx.ref.relPath),
    fileScan(ctx) {
        const guard = middlewareGuard(ctx);
        if (!guard)
            return;
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
function middlewareGuard(ctx) {
    for (const binding of ctx.imports.values()) {
        if (!binding.external)
            continue;
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
    let found = null;
    ctx.sf.forEachDescendant((node) => {
        if (found || !Node.isCallExpression(node))
            return;
        const dotted = dottedName(node.getExpression());
        if (!dotted)
            return;
        const guard = guardFromName(dotted, ctx);
        if (guard)
            found = { ...guard, how: 'middleware', line: node.getStartLineNumber(), confidence: 'likely' };
    });
    return found;
}
function readMatchers(sf) {
    for (const decl of sf.getVariableDeclarations()) {
        if (decl.getName() !== 'config')
            continue;
        const init = decl.getInitializer();
        if (!init || !Node.isObjectLiteralExpression(init))
            continue;
        const prop = init.getProperty('matcher');
        if (!prop || !Node.isPropertyAssignment(prop))
            continue;
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
export function matcherMatches(matcher, route) {
    const compiled = compileMatcher(matcher);
    if (!compiled)
        return false;
    return compiled.test(route);
}
const matcherCache = new Map();
function compileMatcher(matcher) {
    const cached = matcherCache.get(matcher);
    if (cached !== undefined)
        return cached;
    let compiled = null;
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
    }
    catch {
        compiled = null;
    }
    matcherCache.set(matcher, compiled);
    return compiled;
}
/** True when the matcher is one of the "protect everything except assets" idioms. */
export function isCatchAllMatcher(matcher) {
    return matcher.includes('(?!') || matcher === '/:path*' || matcher === '/(.*)';
}
export function argString(call, index) {
    return literalString(argAt(call, index));
}
//# sourceMappingURL=auth.js.map