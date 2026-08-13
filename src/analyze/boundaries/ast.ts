/**
 * @fileoverview Small syntax helpers shared by every detector.
 *
 * Boundary detection is mostly a matter of recognising shapes — `x.y.z(...)` with a
 * string literal in the first argument — so these helpers exist to keep the detectors
 * readable rather than to do anything clever.
 */
import { Node, SyntaxKind, VariableDeclarationKind } from 'ts-morph';
import type { CallExpression, ObjectLiteralExpression } from 'ts-morph';
import type { LocalBinding } from './types.js';

/** Names people actually give the thing they hang routes off. */
const ROUTER_NAMES = /^(app|router|server|api|fastify|hono|koa|instance|r)$/i;

/**
 * What a router is actually built by, as opposed to what it tends to be called.
 *
 * Matched loosely on purpose: `new OpenAPIHono()` and `express.Router()` are both
 * routers, and the wrappers people put around them keep the original name inside.
 */
const ROUTER_CALLEE = /express|Router|Hono|Fastify|fastify|Koa|Server/;

export function isRouterCallee(callee: string): boolean {
  return ROUTER_CALLEE.test(callee);
}

/**
 * Whether a name is the thing routes hang off. Shared between the route detectors and
 * the auth detector because `admin.use(requireAuth)` and `admin.post('/purge')` have to
 * agree about what `admin` is — one of them deciding it is a router and the other not
 * is how a check ends up attached to the wrong set of doors.
 */
export function looksLikeRouter(name: string, locals: Map<string, LocalBinding>): boolean {
  if (ROUTER_NAMES.test(name)) return true;
  const local = locals.get(name);
  return local ? ROUTER_CALLEE.test(local.callee) : false;
}

/** `a.b.c` for an identifier or property-access chain; null for anything else. */
export function dottedName(node: Node | undefined): string | null {
  if (!node) return null;
  if (Node.isIdentifier(node)) return node.getText();
  if (Node.isThisExpression(node)) return 'this';
  if (Node.isPropertyAccessExpression(node)) {
    const left = dottedName(node.getExpression());
    return left ? `${left}.${node.getName()}` : null;
  }
  if (Node.isElementAccessExpression(node)) {
    const left = dottedName(node.getExpression());
    const key = literalString(node.getArgumentExpression());
    return left && key ? `${left}.${key}` : left;
  }
  // `db.select().from(x)` — look through the call so the chain stays readable.
  if (Node.isCallExpression(node)) return dottedName(node.getExpression());
  if (Node.isNonNullExpression(node) || Node.isParenthesizedExpression(node)) {
    return dottedName(node.getExpression());
  }
  if (Node.isAwaitExpression(node)) return dottedName(node.getExpression());
  return null;
}

/** The leftmost identifier of a chain: `prisma` in `prisma.user.findMany()`. */
export function rootName(node: Node | undefined): string | null {
  const dotted = dottedName(node);
  return dotted ? dotted.split('.')[0] : null;
}

/** The string a node evaluates to, when that is knowable without running anything. */
export function literalString(node: Node | undefined): string | null {
  if (!node) return null;
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) {
    return node.getLiteralValue();
  }
  if (Node.isAsExpression(node) || Node.isParenthesizedExpression(node)) {
    return literalString(node.getExpression());
  }
  return null;
}

/**
 * The fixed prefix of a template literal: `https://api.stripe.com/v1/` from
 * `` `https://api.stripe.com/v1/${id}` ``. Enough to recover the hostname, which is
 * the part the boundary view cares about.
 */
export function literalPrefix(node: Node | undefined): string | null {
  const exact = literalString(node);
  if (exact) return exact;
  if (node && Node.isTemplateExpression(node)) {
    const head = node.getHead().getLiteralText();
    return head.length > 0 ? head : null;
  }
  return null;
}

export function argAt(call: CallExpression, index: number): Node | undefined {
  return call.getArguments()[index];
}

/**
 * How far a name may be followed back to the value behind it. Three covers
 * `fetch(url)` ← `url = EXPECTED.feedLatest` ← `EXPECTED = { feedLatest: "https://…" }`
 * with a hop to spare, and past that the chain stops being something a reader could
 * check by eye.
 */
const MAX_CONST_HOPS = 3;

/**
 * The string constant behind a name (#89).
 *
 * `fetch(FEED_URL)` and `fetch(EXPECTED.feedLatest)` state the same fact as
 * `fetch("https://…")` — the value is fixed, written down, and the compiler can say
 * what it is. Only `const` is followed: a `let` can hold something else by the time
 * the call runs, and a URL that was true at the declaration is not evidence about the
 * call.
 *
 * This never guesses from a name. A value it cannot resolve returns `null`, which is
 * the same silence the caller got before, and the reason #25's rule still holds.
 */
export function constantString(node: Node | undefined, depth = 0): string | null {
  if (!node || depth > MAX_CONST_HOPS) return null;

  const direct = literalPrefix(node);
  if (direct) return direct;

  if (Node.isAsExpression(node) || Node.isParenthesizedExpression(node)) {
    return constantString(node.getExpression(), depth + 1);
  }
  if (Node.isIdentifier(node)) {
    return constantString(constantValue(node), depth + 1);
  }
  if (Node.isPropertyAccessExpression(node)) {
    const object = objectBehind(node.getExpression(), depth);
    return object ? constantString(objectProp(object, node.getName()), depth + 1) : null;
  }
  return null;
}

/**
 * The initializer of the `const` an identifier refers to, wherever it was declared.
 *
 * `getDefinitionNodes` is the compiler's own answer, so an import resolves to the
 * declaration in the other file rather than to the import specifier — which is the
 * whole point, since the config object and the call that uses it are rarely in the
 * same file.
 */
function constantValue(id: Node): Node | undefined {
  if (!Node.isIdentifier(id)) return undefined;
  for (const declaration of id.getDefinitionNodes()) {
    if (!Node.isVariableDeclaration(declaration)) continue;
    if (declaration.getVariableStatement()?.getDeclarationKind() !== VariableDeclarationKind.Const) continue;
    return declaration.getInitializer();
  }
  return undefined;
}

/** The object literal a name stands for, so `EXPECTED.feedLatest` can be read. */
function objectBehind(node: Node, depth: number): ObjectLiteralExpression | null {
  if (Node.isObjectLiteralExpression(node)) return node;
  if (Node.isAsExpression(node) || Node.isParenthesizedExpression(node)) {
    return objectBehind(node.getExpression(), depth);
  }
  if (depth >= MAX_CONST_HOPS) return null;
  const value = Node.isIdentifier(node) ? constantValue(node) : undefined;
  return value ? objectBehind(value, depth + 1) : null;
}

/** The initializer of one property of an object literal, by name. */
export function objectProp(obj: Node | undefined, name: string): Node | undefined {
  if (!obj || !Node.isObjectLiteralExpression(obj)) return undefined;
  const prop = (obj as ObjectLiteralExpression).getProperty(name);
  if (!prop) return undefined;
  if (Node.isPropertyAssignment(prop)) return prop.getInitializer();
  if (Node.isShorthandPropertyAssignment(prop)) return prop.getNameNode();
  return undefined;
}

/** Every string literal in an array literal (or the single string, if it is one). */
export function stringArray(node: Node | undefined): string[] {
  if (!node) return [];
  const single = literalString(node);
  if (single) return [single];
  if (Node.isArrayLiteralExpression(node)) {
    return node
      .getElements()
      .map((el) => literalString(el))
      .filter((s): s is string => Boolean(s));
  }
  return [];
}

/** Does this call take a function as one of its arguments, and which one. */
export function functionArg(call: CallExpression): Node | undefined {
  const args = call.getArguments();
  for (let i = args.length - 1; i >= 0; i--) {
    const arg = args[i];
    if (Node.isArrowFunction(arg) || Node.isFunctionExpression(arg) || Node.isIdentifier(arg)) return arg;
  }
  return undefined;
}

/** `@scope/pkg/sub` → `@scope/pkg`; `pkg/sub` → `pkg`. Relative paths pass through. */
export function packageRoot(specifier: string): string {
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('#')) return specifier;
  const clean = specifier.startsWith('node:') ? specifier.slice(5) : specifier;
  const parts = clean.split('/');
  return clean.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

export function isBareSpecifier(specifier: string): boolean {
  return !specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.startsWith('#');
}

/** True when a function-ish node's body opens with the given directive. */
export function hasDirective(node: Node, directive: string): boolean {
  const body = Node.isBlock(node)
    ? node
    : (node.getFirstChildByKind(SyntaxKind.Block) ?? undefined);
  const statements = body && Node.isBlock(body) ? body.getStatements() : [];
  for (const statement of statements.slice(0, 2)) {
    if (!Node.isExpressionStatement(statement)) break;
    if (literalString(statement.getExpression()) === directive) return true;
  }
  return false;
}

/** The first line of a node, collapsed — enough to show as evidence without a wall of code. */
export function snippetOf(node: Node, max = 120): string {
  const text = node.getText().split('\n')[0].replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Whether a NestJS guard lets everybody through — an opt-out wearing a lock's clothes.
 *
 * Nest has no `[AllowAnonymous]`. Excusing a route from a globally applied guard is
 * conventionally written *as a guard that permits everything*, so the opt-out and the
 * lock are spelled identically and only the class body tells them apart. twentyhq/twenty
 * uses one 27 times:
 *
 *     // Guard that explicitly marks an endpoint as public/unprotected.
 *     // This guard always returns true …
 *     canActivate(_context: ExecutionContext): boolean { return true; }
 *
 * Counting that as a check reported two OAuth endpoints, deliberately reachable without
 * a session, as protected at `certain` confidence (#152) — the direction
 * `csharp/boundaries.ts` calls "the one direction this tool must never be wrong in",
 * which is why that tier has `ALLOW_ANONYMOUS`. This is the same rule for the framework
 * where the opt-out has no name of its own.
 *
 * Read from the body, never from the name: `PublicEndpointGuard` and `PublicApiKeyGuard`
 * are indistinguishable as strings and one of them is a real check. A guard whose class
 * cannot be resolved — anything from a package — is left alone and stays a guard, which
 * keeps the failure on the side of over-reporting a lock rather than silencing one.
 */
export function permitsEverything(arg: Node): boolean {
  const symbol = arg.getSymbol();
  if (!symbol) return false;
  // A guard is almost always imported, and an imported name's symbol is the *alias* —
  // its declaration is the `ImportSpecifier`, not the class. Following the alias is the
  // whole difference between this rule working and silently never firing.
  let aliased: ReturnType<typeof symbol.getAliasedSymbol>;
  try {
    aliased = symbol.getAliasedSymbol();
  } catch {
    aliased = undefined;
  }
  const declarations = (aliased ?? symbol).getDeclarations() ?? [];
  for (const declaration of declarations) {
    if (!Node.isClassDeclaration(declaration)) continue;
    const method = declaration.getMethod('canActivate');
    const body = method?.getBody();
    if (!body || !Node.isBlock(body)) continue;
    const statements = body.getStatements();
    // One statement, and it hands back `true`. Anything else — a branch, a throw, a
    // look at the ExecutionContext — is a decision, and a decision is a check.
    if (statements.length !== 1) continue;
    const only = statements[0];
    if (!Node.isReturnStatement(only)) continue;
    if (only.getExpression()?.getKind() === SyntaxKind.TrueKeyword) return true;
  }
  return false;
}

/**
 * Whether every way out of this middleware hands control on — a session parser wearing
 * the name of a check (#237).
 *
 * directus puts `app.use(authenticate)` in front of 241 of its 253 doors, and
 * `authenticate` is in `GUARD_NAMES`, so all 241 were reported locked. Its own docstring
 * says what it does: *"Verify the passed JWT and assign the user ID and role to `req`"*.
 * An anonymous caller carries no token, `getAccountabilityForToken` skips its whole
 * verification block on `if (token)`, the request keeps the default accountability —
 * `{ role: null, user: null, admin: false }` — and the middleware calls `next()`. It
 * refuses nobody. That is NodeBB's `authenticateRequest` (#229) in a second framework,
 * and it was the largest false lock in the corpus.
 *
 * ## Only ever asked in one direction
 *
 * This proves *always continues*. It is never read backwards as "no proof of continuing,
 * therefore a check", and the reason is NodeBB's `authenticateRequest`: it has a bare
 * `return;` — reached only when a plugin has already responded — so it is structurally
 * indistinguishable from a refusal and is not one. Answering "is this a refusal" from
 * shape alone would claim it, and it stands on `/login`.
 *
 * So the absence of an answer here changes nothing, which is what makes the rule safe:
 * it can only ever withdraw a claim somebody's *spelling* earned, and a withdrawn lock
 * reports a door as open. That is the recoverable direction.
 *
 * ## What counts as handing control on
 *
 * Every `return` in this function's own body mentions the continuation, no `throw`
 * escapes except a re-throw from inside a `catch`, and the continuation is used
 * somewhere. `setImmediate(next)` and `return next()` both count — passing it anywhere
 * is enough, because this is asking whether the door stays shut, not how it opens.
 *
 * A re-throw from a `catch` is not a refusal for the same reason `rejectionOutsideCatch`
 * already says so: it is how a handler reports a failure it was given, not a decision it
 * made about a caller. directus's is `catch (err) { …; throw err }`, reached only when a
 * token was supplied *and* was invalid — never by the anonymous caller this is about.
 */
export function alwaysContinues(fn: Node): boolean {
  if (!Node.isFunctionDeclaration(fn) && !Node.isFunctionExpression(fn) && !Node.isArrowFunction(fn)) {
    return false;
  }
  // Express hands the continuation in third. Fewer parameters than that and this is not
  // the shape being reasoned about, so it gets no answer.
  const params = fn.getParameters();
  if (params.length < 3) return false;
  const next = params[2].getName();
  if (!/^_?next$/.test(next)) return false;

  const body = fn.getBody();
  if (!body || !Node.isBlock(body)) return false;

  const mine = (node: Node): boolean => enclosingFunctionOf(node) === fn;
  const mentionsNext = (node: Node): boolean =>
    node.getDescendantsOfKind(SyntaxKind.Identifier).some((id) => id.getText() === next);

  for (const ret of body.getDescendantsOfKind(SyntaxKind.ReturnStatement)) {
    if (mine(ret) && !mentionsNext(ret)) return false;
  }
  for (const thrown of body.getDescendantsOfKind(SyntaxKind.ThrowStatement)) {
    if (mine(thrown) && !thrown.getFirstAncestorByKind(SyntaxKind.CatchClause)) return false;
  }
  // Falling off the end only continues if something passed the continuation on.
  return mentionsNext(body);
}

function enclosingFunctionOf(node: Node): Node | undefined {
  return node.getFirstAncestor(
    (a) =>
      Node.isFunctionDeclaration(a) ||
      Node.isFunctionExpression(a) ||
      Node.isArrowFunction(a) ||
      Node.isMethodDeclaration(a),
  );
}

/**
 * The function a name stands for, followed through the spellings middleware is written
 * in — so `alwaysContinues` has a body to read.
 *
 * Following the alias is the whole difference between this working and silently never
 * firing, which is #152's lesson written down twice in this file. Wrappers are unwrapped
 * for the same reason: directus exports `asyncHandler(handler)` and NodeBB writes
 * `helpers.try(async (req, res, next) => …)`, so the function that decides is an
 * argument rather than the export.
 */
export function functionBehind(node: Node, depth = 0): Node | null {
  if (depth > 3) return null;
  if (Node.isFunctionDeclaration(node) || Node.isFunctionExpression(node) || Node.isArrowFunction(node)) {
    return node;
  }
  if (Node.isCallExpression(node)) {
    const inner = node
      .getArguments()
      .find((arg) => Node.isArrowFunction(arg) || Node.isFunctionExpression(arg) || Node.isIdentifier(arg));
    return inner ? functionBehind(inner, depth + 1) : null;
  }

  const symbol = node.getSymbol();
  if (!symbol) return null;
  let aliased;
  try {
    aliased = symbol.getAliasedSymbol();
  } catch {
    aliased = undefined;
  }
  for (const declaration of (aliased ?? symbol).getDeclarations() ?? []) {
    if (declaration === node) continue;
    if (
      Node.isFunctionDeclaration(declaration) ||
      Node.isFunctionExpression(declaration) ||
      Node.isArrowFunction(declaration)
    ) {
      return declaration;
    }
    const initializer =
      Node.isVariableDeclaration(declaration) || Node.isPropertyAssignment(declaration)
        ? declaration.getInitializer()
        : Node.isExportAssignment(declaration)
          ? declaration.getExpression()
          : Node.isBinaryExpression(declaration)
            ? declaration.getRight()
            : undefined;
    if (initializer) {
      const found = functionBehind(initializer, depth + 1);
      if (found) return found;
    }
  }
  return null;
}
