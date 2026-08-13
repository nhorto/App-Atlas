/**
 * @fileoverview HTTP doors: routes, pages, server actions and procedures.
 *
 * Three detectors, because three genuinely different conventions exist:
 *   - Next.js decides routes from the *file system*, so it is a path problem.
 *   - Express, Fastify, Hono and Koa declare routes with a *call*, so it is a syntax
 *     problem.
 *   - NestJS and tRPC declare them with decorators and builder chains.
 *
 * All three converge on the same finding, so a project mixing them still gets one
 * honest list of every way in.
 */
import { Node, SyntaxKind } from 'ts-morph';
import type {
  ArrowFunction,
  BinaryExpression,
  CallExpression,
  ClassDeclaration,
  FunctionDeclaration,
  FunctionExpression,
  SourceFile,
  VariableDeclaration,
} from 'ts-morph';
import type { GuardInfo } from '../../model/types.js';
import {
  argAt,
  dottedName,
  functionArg,
  hasDirective,
  isRouterCallee,
  literalString,
  looksLikeRouter as isRouter,
  objectProp,
  permitsEverything,
} from './ast.js';
import { guardFromName } from './auth.js';
import type { ArgPosition, BoundaryDetector, DetectorContext, RouteHelperFinding } from './types.js';

/** The three ways a route helper gets written down. */
type FunctionLike = FunctionDeclaration | FunctionExpression | ArrowFunction;

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const ROUTER_METHODS = new Set([...HTTP_METHODS.map((m) => m.toLowerCase()), 'all']);

// ---------------------------------------------------------------------------
// Next.js — the file system is the router
// ---------------------------------------------------------------------------

export const nextRoutesDetector: BoundaryDetector = {
  id: 'next-routes',
  enabled: (ctx) => Boolean(ctx.signals.nextAppDir || ctx.signals.nextPagesDir),
  fileScan(ctx) {
    const { relPath } = ctx.ref;
    const appDir = ctx.signals.nextAppDir;
    const pagesDir = ctx.signals.nextPagesDir;

    if (appDir && isUnder(relPath, appDir)) {
      const rest = relPath.slice(appDir.length + 1);
      const base = fileBase(rest);
      if (base === 'route') return appRouteHandlers(ctx, rest);
      if (base === 'page') return appPage(ctx, rest);
    }

    if (pagesDir && isUnder(relPath, pagesDir)) {
      return pagesRouterFile(ctx, relPath.slice(pagesDir.length + 1));
    }

    // Server actions can live anywhere, not only under `app/`.
    serverActions(ctx);
  },
};

/** `app/api/users/[id]/route.ts` exporting GET and POST is two doors, not one. */
function appRouteHandlers(ctx: DetectorContext, rest: string): void {
  const route = appRoutePath(rest);
  const exported = exportedDeclarations(ctx.sf);
  let found = false;

  for (const method of HTTP_METHODS) {
    const decl = exported.get(method);
    if (!decl) continue;
    found = true;
    ctx.emit({
      type: 'endpoint',
      endpointKind: 'http-route',
      key: `${method} ${route}`,
      name: `${method} ${route}`,
      method,
      route,
      framework: 'Next.js',
      writes: WRITE_METHODS.has(method),
      guards: [],
      site: ctx.site(decl, `${method} ${route}`),
      // Attribute the door to the handler itself, so an `auth()` call inside it is an
      // exact match rather than a same-file guess.
      handlerId: ctx.enclosing(decl),
    });
  }

  // A route file with no recognised export is still worth reporting — silence would
  // read as "no route here", which is worse than an unlabelled one.
  if (!found) {
    ctx.emit({
      type: 'endpoint',
      endpointKind: 'http-route',
      key: `ANY ${route}`,
      name: `ANY ${route}`,
      method: 'ANY',
      route,
      framework: 'Next.js',
      writes: false,
      guards: [],
      site: ctx.site(ctx.sf, route),
      handlerId: ctx.fileId,
    });
  }
}

/** A page is a door too — it is how a person arrives, and it can be left unprotected. */
function appPage(ctx: DetectorContext, rest: string): void {
  const route = appRoutePath(rest);
  const component = defaultExport(ctx.sf);
  ctx.emit({
    type: 'endpoint',
    endpointKind: 'http-route',
    key: `PAGE ${route}`,
    name: route,
    method: 'PAGE',
    route,
    framework: 'Next.js',
    writes: false,
    guards: [],
    site: ctx.site(component ?? ctx.sf, route),
    // The page component is the handler, so an `auth()` call in its body is an exact
    // match rather than a same-file guess.
    handlerId: component ? ctx.enclosing(component) : ctx.fileId,
  });
  serverActions(ctx);
}

function pagesRouterFile(ctx: DetectorContext, rest: string): void {
  const base = fileBase(rest);
  if (base.startsWith('_') || base === 'middleware') return;

  const route = pagesRoutePath(rest);
  const isApi = route === '/api' || route.startsWith('/api/');
  ctx.emit({
    type: 'endpoint',
    endpointKind: 'http-route',
    key: `${isApi ? 'ANY' : 'PAGE'} ${route}`,
    name: isApi ? `ANY ${route}` : route,
    method: isApi ? 'ANY' : 'PAGE',
    route,
    framework: 'Next.js',
    // A pages/api handler switches on req.method, so assume it can write.
    writes: isApi,
    guards: [],
    site: ctx.site(ctx.sf, route),
    handlerId: ctx.fileId,
  });
}

/**
 * Server actions are the quietest door in a Next.js app: an exported async function
 * that any browser can invoke. Worth surfacing precisely because they do not look
 * like an endpoint.
 */
function serverActions(ctx: DetectorContext): void {
  const fileLevel = fileHasDirective(ctx.sf, 'use server');

  for (const fn of ctx.sf.getFunctions()) {
    if (!fn.isExported() && !fn.isDefaultExport()) continue;
    if (!fileLevel && !hasDirective(fn, 'use server')) continue;
    const name = fn.getName() ?? 'default';
    ctx.emit({
      type: 'endpoint',
      endpointKind: 'server-action',
      key: `action ${ctx.ref.relPath}#${name}`,
      name,
      method: 'ACTION',
      route: null,
      framework: 'Next.js',
      writes: true,
      guards: [],
      site: ctx.site(fn, `${name}()`),
      handlerId: ctx.enclosing(fn),
    });
  }

  for (const decl of ctx.sf.getVariableDeclarations()) {
    const init = decl.getInitializer();
    if (!init || !(Node.isArrowFunction(init) || Node.isFunctionExpression(init))) continue;
    if (!decl.getVariableStatement()?.isExported()) continue;
    if (!fileLevel && !hasDirective(init, 'use server')) continue;
    ctx.emit({
      type: 'endpoint',
      endpointKind: 'server-action',
      key: `action ${ctx.ref.relPath}#${decl.getName()}`,
      name: decl.getName(),
      method: 'ACTION',
      route: null,
      framework: 'Next.js',
      writes: true,
      guards: [],
      site: ctx.site(decl, `${decl.getName()}()`),
      handlerId: ctx.enclosing(decl),
    });
  }
}

// ---------------------------------------------------------------------------
// Expo Router — a native/web app whose file system is the router
// ---------------------------------------------------------------------------

/**
 * Expo Router (and the file-routes convention React Navigation borrowed from Next)
 * turns every file under `app/` into a screen a person can land on. These are doors
 * too — but doors into a *client*, not doors a stranger reaches over the network — so
 * they get their own `screen` kind and are kept out of the auth-coverage count. The
 * point is to answer "what are the ways into this app?" for a mobile app the same way
 * the route list answers it for a server, without crying wolf about missing auth on
 * two dozen screens.
 */
export const expoRoutesDetector: BoundaryDetector = {
  id: 'expo-routes',
  enabled: (ctx) => Boolean(ctx.signals.expoRouterDir),
  fileScan(ctx) {
    const dir = ctx.signals.expoRouterDir;
    const { relPath } = ctx.ref;
    if (!dir || !isUnder(relPath, dir)) return;

    const rest = relPath.slice(dir.length + 1);
    const base = fileBase(rest);
    // `_layout` wraps screens without being one; `+not-found`, `+html` and
    // `+native-intent` are framework hooks, not navigable routes.
    if (base.startsWith('_') || base.startsWith('+')) return;

    const route = expoRoutePath(rest);
    const component = defaultExport(ctx.sf);
    ctx.emit({
      type: 'endpoint',
      endpointKind: 'screen',
      key: `SCREEN ${route}`,
      name: route,
      method: 'SCREEN',
      route,
      framework: 'Expo Router',
      writes: false,
      guards: [],
      site: ctx.site(component ?? ctx.sf, route),
      // The screen component is the handler, so a redirect-if-signed-out guard in its
      // body is an exact match rather than a same-file guess.
      handlerId: component ? ctx.enclosing(component) : ctx.fileId,
    });
  },
};

// ---------------------------------------------------------------------------
// Express / Fastify / Hono / Koa / NestJS — the call is the router
// ---------------------------------------------------------------------------

const SERVER_PACKAGES: { pkg: string; name: string }[] = [
  { pkg: 'express', name: 'Express' },
  { pkg: 'fastify', name: 'Fastify' },
  { pkg: 'hono', name: 'Hono' },
  { pkg: 'koa', name: 'Koa' },
  { pkg: '@koa/router', name: 'Koa' },
  { pkg: '@nestjs/common', name: 'NestJS' },
  { pkg: '@hapi/hapi', name: 'Hapi' },
];

export const nodeRoutesDetector: BoundaryDetector = {
  id: 'node-routes',
  enabled: (ctx) => serverFrameworks(ctx).length > 0,
  fileScan(ctx) {
    // Which variable in this file is a router, so a `use('/api', …)` elsewhere can find
    // it. Emitted from the constructor rather than the name: `router` is a convention,
    // `express.Router()` is a fact.
    for (const [name, local] of ctx.locals) {
      if (!isRouterCallee(local.callee)) continue;
      ctx.emit({
        type: 'router-build',
        routerName: local.callee,
        varName: name,
        path: ctx.ref.relPath,
        line: 1,
        hasPrefix: false,
        prefix: null,
        prefixName: null,
      });
    }
  },
  visit(node, ctx) {
    if (Node.isCallExpression(node)) {
      routeCall(node, ctx);
      fastifyRouteObject(node, ctx);
      routerMount(node, ctx);
      routerHandoff(node, ctx);
      globalPrefix(node, ctx);
    } else if (Node.isClassDeclaration(node)) {
      nestController(node, ctx);
    } else if (Node.isBinaryExpression(node)) {
      mountMethod(node, ctx);
    } else if (Node.isVariableDeclaration(node)) {
      pathConstant(node, ctx);
    }
  },
};

/**
 * Route helpers, and the calls that might be to one (#229).
 *
 * Separate from `nodeRoutesDetector`, and ungated, because **the file that defines a
 * route helper is the file least likely to import the framework**. It takes the router
 * as a parameter — that is the entire point of the pattern — so it has no reason to
 * mention Express at all. NodeBB's `src/routes/helpers.js` carries 334 doors and its
 * imports are `winston`, `../middleware` and `../controllers/helpers`.
 *
 * Gating this on the framework import would therefore switch it off in exactly the case
 * it exists for, which is #230's lesson arriving from the other direction: the evidence
 * that a file registers routes is what the file *does*, not what it declares.
 *
 * The shape rule is strict enough to stand without the gate — see `routeHelper` — and
 * the merge throws away every call whose callee no file declared as a helper.
 */
export const routeHelperDetector: BoundaryDetector = {
  id: 'route-helpers',
  enabled: () => true,
  visit(node, ctx) {
    if (Node.isCallExpression(node)) {
      helperRouteCall(node, ctx);
    } else if (Node.isBinaryExpression(node)) {
      // `helpers.setupPageRoute = function (…) {…}`, which is how a CommonJS module
      // hangs a helper off its exports — NodeBB's three are all written this way.
      const assigned = node.getRight();
      const target = node.getLeft();
      if (
        node.getOperatorToken().getKind() === SyntaxKind.EqualsToken &&
        (Node.isFunctionExpression(assigned) || Node.isArrowFunction(assigned)) &&
        Node.isPropertyAccessExpression(target)
      ) {
        routeHelper(assigned, target.getName(), ctx);
      }
    } else if (Node.isFunctionDeclaration(node)) {
      const name = node.getName();
      if (name) routeHelper(node, name, ctx);
    } else if (Node.isVariableDeclaration(node)) {
      const initializer = node.getInitializer();
      const nameNode = node.getNameNode();
      if (
        Node.isIdentifier(nameNode) &&
        initializer &&
        (Node.isFunctionExpression(initializer) || Node.isArrowFunction(initializer))
      ) {
        routeHelper(initializer, nameNode.getText(), ctx);
      }
    }
  },
};

/**
 * `app.lazyUse = function (mountPath, fn) { app.use(mountPath, …) }` — a mount method an
 * app gave its own name (#204).
 *
 * The evidence is the body, never the name: the function hands its own first parameter
 * to `use` as the path, which is the whole of what "this is a mount" means. Ghost's seven
 * `lazyUse` calls carry every API mount in the repo, and a whitelist that simply grew to
 * include the word would mount whatever anybody else called `lazyUse`.
 */
function mountMethod(node: BinaryExpression, ctx: DetectorContext): void {
  if (node.getOperatorToken().getKind() !== SyntaxKind.EqualsToken) return;

  const target = node.getLeft();
  if (!Node.isPropertyAccessExpression(target)) return;
  const host = target.getExpression();
  if (!Node.isIdentifier(host) || !looksLikeRouter(host.getText(), ctx)) return;

  const fn = node.getRight();
  if (!Node.isFunctionExpression(fn) && !Node.isArrowFunction(fn)) return;
  const first = fn.getParameters()[0]?.getNameNode();
  if (!first || !Node.isIdentifier(first)) return;
  const pathParam = first.getText();

  // Somewhere inside, `<a router>.use(<that same parameter>, …)`. The receiver is not
  // required to be the same variable — a wrapper that forwards to a router it closes
  // over is the same fact — but it does have to be one.
  const forwards = fn.getDescendantsOfKind(SyntaxKind.CallExpression).some((call) => {
    const dotted = dottedName(call.getExpression());
    if (!dotted?.endsWith('.use')) return false;
    const receiver = dotted.slice(0, -'.use'.length);
    if (receiver.includes('.') || !looksLikeRouter(receiver, ctx)) return false;
    const arg = call.getArguments()[0];
    return Boolean(arg && Node.isIdentifier(arg) && arg.getText() === pathParam);
  });
  if (!forwards) return;

  ctx.emit({ type: 'mount-method', name: target.getName(), path: ctx.ref.relPath, line: node.getStartLineNumber() });
}

// ---------------------------------------------------------------------------
// Route helpers — route registration wearing the app's own name (#229)
// ---------------------------------------------------------------------------

/**
 * Where each of a function's own parameters lands in the argument list callers write.
 *
 * Three spellings, because a rest parameter is what you are left with once one of the
 * arguments in the middle is optional, and then the ones after it can only be reached
 * from the end:
 *
 *   function (router, name, controller)          — plain, counted from the front
 *   const [router, name] = args                  — destructured off a rest parameter
 *   const controller = args[args.length - 1]     — counted from the back
 *
 * NodeBB's three helpers need all three at once. A conditional (`args.length > 3 ? … : []`)
 * is deliberately not read: it resolves to a different argument depending on how the
 * caller wrote the call, and a position that is only sometimes right is not a position.
 */
function paramPositions(fn: FunctionLike): Map<string, ArgPosition> {
  const positions = new Map<string, ArgPosition>();
  const params = fn.getParameters();
  let restName: string | null = null;

  params.forEach((param, index) => {
    const nameNode = param.getNameNode();
    if (!Node.isIdentifier(nameNode)) return;
    if (param.isRestParameter()) restName = nameNode.getText();
    else positions.set(nameNode.getText(), { from: 'start', index });
  });

  if (!restName) return positions;

  const body = fn.getBody();
  if (!body) return positions;

  for (const declaration of body.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    const initializer = declaration.getInitializer();
    if (!initializer) continue;
    const nameNode = declaration.getNameNode();

    // `const [router, name] = args` — the front of the list, by position in the pattern.
    if (Node.isArrayBindingPattern(nameNode) && initializer.getText() === restName) {
      nameNode.getElements().forEach((element, index) => {
        if (!Node.isBindingElement(element)) return;
        const local = element.getNameNode();
        if (Node.isIdentifier(local)) positions.set(local.getText(), { from: 'start', index });
      });
      continue;
    }

    if (!Node.isIdentifier(nameNode) || !Node.isElementAccessExpression(initializer)) continue;
    if (initializer.getExpression().getText() !== restName) continue;
    const position = indexFromAccess(initializer.getArgumentExpression(), restName);
    if (position) positions.set(nameNode.getText(), position);
  }

  return positions;
}

/** `args[2]` and `args[args.length - 1]` — a position from either end of the list. */
function indexFromAccess(index: Node | undefined, restName: string): ArgPosition | null {
  if (!index) return null;
  if (Node.isNumericLiteral(index)) return { from: 'start', index: index.getLiteralValue() };
  if (!Node.isBinaryExpression(index)) return null;
  if (index.getOperatorToken().getKind() !== SyntaxKind.MinusToken) return null;
  if (index.getLeft().getText() !== `${restName}.length`) return null;
  const right = index.getRight();
  if (!Node.isNumericLiteral(right)) return null;
  // `args.length - 1` is the last argument, which is index 0 counted from the back.
  return { from: 'end', index: right.getLiteralValue() - 1 };
}

/**
 * `setupPageRoute(router, '/login', controller)` — a route registered on the caller's
 * behalf by a function this repo wrote itself (#229).
 *
 * The evidence is the body and never the name, exactly as for `mountMethod` above: the
 * function hands one of its own parameters to a route method as the path. NodeBB's three
 * helpers carry 334 doors against 41 written the plain way, so on that repo this rule is
 * the difference between a map of the application and a map of its leftovers.
 *
 * Two guards against reading an ordinary function as a route helper. The route call has
 * to take **at least two arguments** — a path and something to answer it — which is what
 * separates `router.get(name, controller)` from `cache.get(key)`, the shape that
 * otherwise matches word for word. And the whole detector only runs on a file where a
 * server framework is in play.
 */
function routeHelper(fn: FunctionLike, name: string, ctx: DetectorContext): void {
  const body = fn.getBody();
  if (!body) return;
  // A router and a path at the very least. Also the cheap way out of walking the body of
  // every function in the repo, now that this runs ungated.
  const positions = paramPositions(fn);
  if (positions.size < 2) return;

  let router: ArgPosition | null = null;
  let pathArg: ArgPosition | null = null;
  let verb: RouteHelperFinding['verb'] | null = null;
  let handler: ArgPosition | null = null;
  const templates: string[] = [];

  for (const call of body.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression();
    let receiver: Node;
    let thisVerb: RouteHelperFinding['verb'];

    if (Node.isPropertyAccessExpression(callee)) {
      const method = callee.getName();
      if (!ROUTER_METHODS.has(method)) continue;
      receiver = callee.getExpression();
      thisVerb = { literal: method };
    } else if (Node.isElementAccessExpression(callee)) {
      // `router[verb](name, …)` — the method itself comes from an argument, which is how
      // one helper covers every verb. NodeBB's `setupApiRoute` is 204 of the 334.
      const argument = callee.getArgumentExpression();
      if (!argument || !Node.isIdentifier(argument)) continue;
      const at = positions.get(argument.getText());
      if (!at) continue;
      receiver = callee.getExpression();
      thisVerb = { at };
    } else continue;

    if (!Node.isIdentifier(receiver)) continue;
    const routerAt = positions.get(receiver.getText());
    if (!routerAt) continue;

    const args = call.getArguments();
    // A path and something to answer it. `cache.get(key)` stops here.
    if (args.length < 2) continue;

    const template = pathTemplate(args[0], positions);
    if (!template) continue;

    router = routerAt;
    pathArg = template.at;
    verb = thisVerb;
    templates.push(template.shape);
    handler ??= handlerPosition(args[args.length - 1], positions);
  }

  if (!router || !pathArg || !verb || templates.length === 0) return;

  ctx.emit({
    type: 'route-helper',
    name,
    router,
    pathArg,
    verb,
    handler,
    templates,
    path: ctx.ref.relPath,
    line: fn.getStartLineNumber(),
  });
}

/**
 * The path a route call is given, when it is built out of one of the enclosing
 * function's parameters.
 *
 * `name` is the plain case. `` `/api${name}` `` is the other one, and it matters: NodeBB
 * registers every page twice, once for the browser and once for the JSON the browser
 * fetches, so half of that application's addresses exist nowhere in the calling file.
 */
function pathTemplate(arg: Node | undefined, positions: Map<string, ArgPosition>): { at: ArgPosition; shape: string } | null {
  if (!arg) return null;
  if (Node.isIdentifier(arg)) {
    const at = positions.get(arg.getText());
    return at ? { at, shape: '{}' } : null;
  }
  if (!Node.isTemplateExpression(arg)) return null;
  const spans = arg.getTemplateSpans();
  if (spans.length !== 1) return null;
  const expression = spans[0].getExpression();
  if (!Node.isIdentifier(expression)) return null;
  const at = positions.get(expression.getText());
  if (!at) return null;
  // Anything after the interpolation would be a suffix on the address; none of the real
  // ones have that, and inventing it is how a door gets an address nobody serves it at.
  if (spans[0].getLiteral().getLiteralText() !== '') return null;
  return { at, shape: `${arg.getHead().getLiteralText()}{}` };
}

/** The handler, through the one wrapper a helper usually puts round it. */
function handlerPosition(arg: Node | undefined, positions: Map<string, ArgPosition>): ArgPosition | null {
  if (!arg) return null;
  if (Node.isIdentifier(arg)) return positions.get(arg.getText()) ?? null;
  // `helpers.tryRoute(controller)` — the real handler is inside the wrapper.
  if (Node.isCallExpression(arg)) {
    const inner = arg.getArguments()[0];
    if (inner && Node.isIdentifier(inner)) return positions.get(inner.getText()) ?? null;
  }
  return null;
}

/**
 * Any call carrying a `/…` string literal, kept in case the merge turns out to know the
 * callee as a route helper (#229).
 *
 * The same division of labour as `mount-method`: whether `setupPageRoute` registers
 * routes is a fact from another file, so the call travels and the merge decides. The
 * literal is a filter on noise rather than the check — a helper call with no readable
 * path would be an address nobody could print anyway.
 */
/**
 * The checks a *caller* hands a route helper, which are not the helper's own (#229).
 *
 * `helperRoutes` deliberately refuses to read the middleware a helper injects into every
 * door it opens, because NodeBB's is `authenticateRequest` and it lets anonymous callers
 * straight through. This is the other list, and it is ordinary evidence:
 *
 *   const middlewares = [middleware.ensureLoggedIn, middleware.admin.checkPrivileges];
 *   setupApiRoute(router, 'get', '/analytics', [...middlewares], controllers…);
 *
 * `checkPrivileges` refuses a guest outright. Written beside the door by the person
 * declaring it, it is the same evidence as `router.get('/x', requireAuth, handler)` — and
 * withholding it left 21 of NodeBB's `/api/v3/admin/*` doors reading as unchecked.
 *
 * Three shapes, because the list is usually assembled rather than written out: the name
 * on its own, inside an array literal, and spread from a local the file built earlier.
 * The spread is resolved through the identifier's symbol rather than by scanning the
 * file, so a `middlewares` declared inside a factory is still found — the scope trap
 * that hid every one of Ghost's routers in #204.
 */
function helperGuards(call: CallExpression, ctx: DetectorContext): GuardInfo[] {
  const guards: GuardInfo[] = [];
  const seen = new Set<string>();

  const consider = (node: Node): void => {
    const name = dottedName(Node.isCallExpression(node) ? node.getExpression() : node);
    if (!name || seen.has(name)) return;
    seen.add(name);
    const guard = guardFromName(name, ctx);
    if (guard) guards.push({ ...guard, how: 'middleware', line: call.getStartLineNumber() });
  };

  const expand = (node: Node, depth: number): void => {
    if (depth > 2) return;
    if (Node.isArrayLiteralExpression(node)) {
      for (const element of node.getElements()) expand(element, depth + 1);
      return;
    }
    if (Node.isSpreadElement(node)) {
      const inner = node.getExpression();
      for (const declared of arrayBehind(inner)) expand(declared, depth + 1);
      return;
    }
    consider(node);
  };

  for (const arg of call.getArguments()) expand(arg, 0);
  return guards;
}

/** The elements of `const x = [a, b]`, given the `x` in `...x`. */
function arrayBehind(node: Node): Node[] {
  if (!Node.isIdentifier(node)) return [];
  const declarations = node.getSymbol()?.getDeclarations() ?? [];
  for (const declaration of declarations) {
    if (!Node.isVariableDeclaration(declaration)) continue;
    const initializer = declaration.getInitializer();
    if (initializer && Node.isArrayLiteralExpression(initializer)) return initializer.getElements();
  }
  return [];
}

function helperRouteCall(call: CallExpression, ctx: DetectorContext): void {
  const callee = dottedName(call.getExpression());
  if (!callee) return;

  const args = call.getArguments();
  if (args.length < 2) return;

  const literals = args.map((arg) => literalString(arg));
  if (!literals.some((value) => value !== null && value.startsWith('/'))) return;

  ctx.emit({
    type: 'helper-route-call',
    callee,
    args: literals,
    names: args.map((arg) => (Node.isIdentifier(arg) ? arg.getText() : dottedName(arg))),
    guards: helperGuards(call, ctx),
    framework: serverFrameworks(ctx)[0] ?? 'HTTP',
    path: ctx.ref.relPath,
    line: call.getStartLineNumber(),
    nodeId: ctx.enclosing(call),
    snippet: `${callee}(…)`,
  });
}

/**
 * `const BASE_API_PATH = '/ghost/api'` — a name a mount elsewhere may be written with.
 *
 * Only values that begin with a slash, for the reason the Python side gives: a prefix is
 * the one that starts with one, and `https://updates.example/…` is somebody else's
 * address that would only collide with a real one. The merge layer is what turns a name
 * back into a path, and it already refuses when two files disagree about the value.
 */
function pathConstant(decl: VariableDeclaration, ctx: DetectorContext): void {
  const name = decl.getNameNode();
  if (!Node.isIdentifier(name)) return;
  const value = literalString(decl.getInitializer());
  if (!value || !value.startsWith('/')) return;
  ctx.emit({
    type: 'path-constant',
    name: name.getText(),
    value,
    path: ctx.ref.relPath,
    line: decl.getStartLineNumber(),
  });
}

/**
 * `app.use('/api/users', usersRouter)` and Hono's `app.route('/api', users)` — the line
 * that decides what every route in another file is actually called.
 *
 * A bare `app.use(thing)` counts too: no prefix of its own, but it is what links a
 * sub-router to whatever the parent was mounted under. Only identifiers that resolve to
 * this repo's own code are followed, so `app.use(cors())` and `app.use(morgan)` cannot
 * turn a logger into a router.
 */
function routerMount(call: CallExpression, ctx: DetectorContext): void {
  const dotted = dottedName(call.getExpression());
  if (!dotted?.includes('.')) return;
  const parts = dotted.split('.');
  const method = parts[parts.length - 1];
  // Anything but `use`/`route` is only a mount if this project declared it as one, and
  // that is a fact from another file. So the method travels with the finding and the
  // merge layer, which has seen every file, decides. See `MountMethodFinding`.
  if (!COULD_MOUNT.test(method)) return;
  const hostVar = parts[parts.length - 2];
  if (!looksLikeRouter(hostVar, ctx)) return;

  const args = call.getArguments();
  const prefix = literalString(args[0]);
  if (prefix !== null && !prefix.startsWith('/')) return;

  // `lazyUse(BASE_API_PATH, …)`. Carried as a name because JavaScript will not say
  // whether it is a path or a middleware, and resolved only if the repo declares it as
  // a path constant — see `prefixOnlyIfNamed`.
  const named = prefix === null && args.length > 1 ? dottedName(args[0]) : null;

  // Hono's `.route(path, app)` takes exactly one; Express's `.use` takes a chain.
  for (const arg of prefix === null && named === null ? args : args.slice(1)) {
    const target = mountedRouter(arg, ctx);
    if (!target) continue;
    ctx.emit({
      type: 'router-mount',
      path: ctx.ref.relPath,
      hostVar,
      childModule: target.module,
      childVar: target.varName,
      childName: mountedName(arg),
      hasPrefix: prefix !== null || named !== null,
      prefix,
      prefixName: named,
      prefixOnlyIfNamed: named !== null,
      method,
      line: call.getStartLineNumber(),
    });
  }
}

/**
 * `require('./routes')(app)` and `registerRoutes(app)` — the app handed to another file
 * as an argument, on a line the reader can see (#206).
 *
 * This is the CommonJS half of "where was the route registered". A mount says *this
 * router hangs under that one*; a handoff says *this module was given the router itself*,
 * and everything it writes on the parameter it received is registered at the call's own
 * line. `const app = express(); require('./public')(app); app.use(requireAuth)` puts
 * `/health` above the gate from a file that never mentions the gate — and today the map
 * says the gate covers it.
 *
 * The argument has to be a bare identifier this file thinks is a router, and the callee
 * has to resolve to code in this repo. Both halves matter: `http.createServer(app)` hands
 * the app to a package, and a package's internals are not where routes are declared; and
 * a property access as the argument (`app.locals`, `config.app`) is not the router.
 *
 * Mounts are skipped rather than double-read. `app.use('/api', users)` is already a
 * `router-mount` and already ordered by {@link registeredAboveTheGate}; reading it a
 * second time here would say the same thing in a weaker way, since a handoff cannot see
 * which of several arguments was the router.
 */
function routerHandoff(call: CallExpression, ctx: DetectorContext): void {
  const callee = call.getExpression();

  // `app.use(...)`, `app.get(...)`, `router.route(...)`: the router is the *receiver*
  // here, not a passenger. Its ordering is the mount rule's to answer.
  const dotted = dottedName(callee);
  if (dotted?.includes('.')) {
    const parts = dotted.split('.');
    const receiver = parts[parts.length - 2];
    if (receiver && isRouter(receiver, ctx.locals)) return;
  }

  const target = handoffTarget(callee, ctx);
  if (!target) return;

  for (const arg of call.getArguments()) {
    if (!Node.isIdentifier(arg)) continue;
    const hostVar = arg.getText();
    if (!isRouter(hostVar, ctx.locals)) continue;
    ctx.emit({
      type: 'router-handoff',
      path: ctx.ref.relPath,
      hostVar,
      targetModule: target,
      line: call.getStartLineNumber(),
      scope: sequenceOf(call, ctx.sf),
    });
    return;
  }
}

/**
 * The module a call hands its arguments to, or null when that is not this repo's code.
 *
 * Three spellings, and they are the three CommonJS actually writes:
 *
 *   require('./routes')(app)   — the module invoked where it is loaded
 *   routes(app)                — a name bound by an import or an earlier `require`
 *   routes.setup(app)          — a method on one
 *
 * External packages are refused outright. Whatever `express.static(app)` or
 * `winston.info(app)` does with the argument, it does not declare routes in a file this
 * analysis can read, and a finding pointing into `node_modules` can only ever match
 * nothing or match by accident.
 */
function handoffTarget(callee: Node, ctx: DetectorContext): string | null {
  // `require('./routes')(app)` — the specifier is right there in the callee.
  if (Node.isCallExpression(callee)) {
    const specifier = requireSpecifier(callee);
    return specifier ? importedModule(ctx.ref.relPath, specifier) : null;
  }

  const root = Node.isIdentifier(callee) ? callee.getText() : dottedName(callee)?.split('.')[0];
  if (!root) return null;
  const imported = ctx.imports.get(root);
  if (!imported || imported.external) return null;
  return importedModule(ctx.ref.relPath, imported.module);
}

/**
 * The run of statements a call belongs to: its innermost enclosing function, or the
 * whole file when it has none.
 *
 * Line numbers are only an ordering while both statements are in one sequence. A
 * `function wire(app) { require('./x')(app) }` at the top of a file has a smaller line
 * number than the `app.use(auth)` at the bottom and runs *after* it, so the merge checks
 * that the gate falls in this span before it compares — see {@link RouterHandoffFinding}.
 */
function sequenceOf(call: CallExpression, sf: SourceFile): { from: number; to: number } {
  const fn = call.getFirstAncestor(
    (node) =>
      Node.isFunctionDeclaration(node) ||
      Node.isFunctionExpression(node) ||
      Node.isArrowFunction(node) ||
      Node.isMethodDeclaration(node) ||
      Node.isConstructorDeclaration(node),
  );
  if (fn) return { from: fn.getStartLineNumber(), to: fn.getEndLineNumber() };
  return { from: 1, to: sf.getEndLineNumber() };
}

/**
 * Method names worth carrying to the merge layer at all.
 *
 * `use` and `route` are mounts everywhere. Beyond them only a name a project could
 * plausibly have given its own wrapper is worth the finding — Ghost's is `lazyUse` —
 * and the merge still throws it away unless that project declared it. This is a filter
 * on noise, not the check: the check is `MountMethodFinding`.
 */
const COULD_MOUNT = /^(use|route|\w*[uU]se)$/;

/**
 * The router an argument to `use` stands for, in the four spellings that are one.
 *
 * ESM writes the name and CommonJS writes the module, and Ghost writes both at once —
 * `backendApp.use('/ghost', …, require('../admin')())` mounts a router that has no name
 * anywhere for a resolver to match on (#204). Four shapes, and every one of them is a
 * literal specifier or a binding the file already declared:
 *
 *   app.use('/api', users)              — the name, which is what ESM produces
 *   app.use('/api', routes())           — a factory, called on a name bound by a require
 *   app.use('/api', require('./users')) — the module itself
 *   app.use('/api', require('./x')())   — a factory on the module, which is Ghost's
 *
 * Deliberately not a property access: `app.use(sentry.errorHandler)` and
 * `app.use(bodyParser.json({…}))` are the overwhelming majority of what sits in these
 * argument lists, and reading one of them as a router would put every route in the file
 * under a prefix it does not have. A wrong address is worse than a missing one — it is
 * printed as a fact and nothing about it looks wrong.
 */
function mountedRouter(
  arg: Node,
  ctx: DetectorContext,
): { module: string | null; varName: string | null } | null {
  if (Node.isIdentifier(arg)) return mountTarget(arg.getText(), ctx);

  if (!Node.isCallExpression(arg)) return null;

  // `require('./users')` — the module handed over whole.
  const direct = requireSpecifier(arg);
  if (direct) return { module: importedModule(ctx.ref.relPath, direct), varName: null };

  const callee = arg.getExpression();

  // `require('./admin')()` — the factory Ghost mounts with.
  if (Node.isCallExpression(callee)) {
    const inner = requireSpecifier(callee);
    return inner ? { module: importedModule(ctx.ref.relPath, inner), varName: null } : null;
  }

  // `routes()` — a factory on a name this file bound. Resolved the same way the plain
  // identifier is, so a package (`cors()`, `morgan()`) still comes back null.
  if (Node.isIdentifier(callee)) return mountTarget(callee.getText(), ctx);

  return null;
}

/**
 * The name a mounted argument was written under here, in the two spellings that have
 * one: `authRouter` and `routes()`. `require('./users')` names nothing.
 *
 * Deliberately the *written* name rather than the resolved one. What this answers is
 * "which argument of this call was the router", and the other reader of the same call
 * knows its arguments by the names in front of it.
 */
function mountedName(arg: Node): string | null {
  if (Node.isIdentifier(arg)) return arg.getText();
  if (!Node.isCallExpression(arg)) return null;
  const callee = arg.getExpression();
  return Node.isIdentifier(callee) ? callee.getText() : null;
}

/** `require('./x')` → `./x`, and null for anything that is not exactly that. */
function requireSpecifier(call: CallExpression): string | null {
  const callee = call.getExpression();
  if (!Node.isIdentifier(callee) || callee.getText() !== 'require') return null;
  return literalString(argAt(call, 0));
}

/**
 * The file a mounted router lives in, or null when the name is not this repo's.
 *
 * A default export gives no name to match on, so the child is left unnamed and the
 * merge layer accepts it only if that file declares exactly one router — the same "one
 * candidate or nothing" rule the rest of this resolution uses.
 */
function mountTarget(name: string, ctx: DetectorContext): { module: string | null; varName: string | null } | null {
  const imported = ctx.imports.get(name);
  if (imported) {
    if (imported.external) return null;
    return {
      module: importedModule(ctx.ref.relPath, imported.module),
      varName: imported.imported === 'default' || imported.imported === '*' ? null : imported.imported,
    };
  }
  const local = ctx.locals.get(name);
  if (local && isRouterCallee(local.callee)) return { module: null, varName: name };
  return null;
}

/**
 * `./routes/users` from `src/app.ts` → `src/routes/users`.
 *
 * A bare-but-internal specifier (`@/routes/users`) keeps only the part after the alias:
 * what the alias points at lives in a tsconfig this layer does not read, and the merge
 * matches on the tail anyway.
 */
function importedModule(fromRelPath: string, specifier: string): string {
  if (!specifier.startsWith('.')) return withoutExtension(specifier.replace(/^[@~#]\/?/, ''));
  const parts = fromRelPath.split('/').slice(0, -1);
  for (const segment of withoutExtension(specifier).split('/')) {
    if (segment === '.' || segment === '') continue;
    if (segment === '..') parts.pop();
    else parts.push(segment);
  }
  return parts.join('/');
}

/**
 * Drops a module extension, and only a module extension.
 *
 * `./admin.routes` is a whole file name, not a name with a suffix on it. Trimming
 * everything after the last dot turns it into `./admin`, which matches nothing — and
 * `thing.routes.ts`, `thing.controller.ts`, `thing.module.ts` is the ordinary way a
 * NestJS repo is laid out, so the mount is lost on exactly the projects that mount most.
 * A specifier only ever carries an extension in ESM-style imports (`./admin.routes.js`).
 */
function withoutExtension(specifier: string): string {
  return specifier.replace(/\.[cm]?[jt]sx?$/, '');
}

/** `app.setGlobalPrefix('api')` — one line that renames every route NestJS serves. */
function globalPrefix(call: CallExpression, ctx: DetectorContext): void {
  if (!dottedName(call.getExpression())?.endsWith('.setGlobalPrefix')) return;
  const prefix = literalString(argAt(call, 0));
  if (!prefix) return;
  ctx.emit({
    type: 'global-prefix',
    framework: 'NestJS',
    prefix,
    path: ctx.ref.relPath,
    line: call.getStartLineNumber(),
  });
}

/**
 * Which server framework is in play — asked of the manifest *and* of the file itself.
 *
 * The manifest alone is not evidence enough, and a repo with no manifest at all is not
 * a repo with no doors. `NodeBB/NodeBB` keeps its `package.json` in `install/` and
 * copies it into place during setup, so a checked-out clone has none — and 927 files
 * and 150,000 lines of Express came out as two ways in, no framework, and the archetype
 * "a service other things call, no interface files". For a forum with a full web UI.
 *
 * Nothing was unreadable and nothing warned: the whole route detector is gated on this
 * answer, so the map was confident and empty, which is the shape of wrong this project
 * is built to avoid.
 *
 * `require('express')` in the file doing the routing is the better evidence anyway. A
 * manifest says what somebody declared; the import says what this code uses.
 */
function serverFrameworks(ctx: DetectorContext): string[] {
  return SERVER_PACKAGES.filter(({ pkg }) => ctx.signals.packages.has(pkg) || ctx.packages.has(pkg)).map(
    ({ name }) => name,
  );
}

/** `app.post('/users', requireAuth, createUser)` */
function routeCall(call: CallExpression, ctx: DetectorContext): void {
  const dotted = dottedName(call.getExpression());
  if (!dotted || !dotted.includes('.')) return;

  const parts = dotted.split('.');
  const method = parts[parts.length - 1];
  if (!ROUTER_METHODS.has(method)) return;

  const holder = parts[parts.length - 2];
  if (!looksLikeRouter(holder, ctx)) return;

  const route = literalString(argAt(call, 0));
  if (!route || !route.startsWith('/')) return;

  const frameworks = serverFrameworks(ctx);
  const framework = frameworkFor(holder, ctx) ?? frameworks[0] ?? 'HTTP';
  const httpMethod = method === 'all' ? 'ANY' : method.toUpperCase();

  ctx.emit({
    type: 'endpoint',
    endpointKind: 'http-route',
    key: `${httpMethod} ${route}`,
    name: `${httpMethod} ${route}`,
    method: httpMethod,
    route,
    framework,
    writes: WRITE_METHODS.has(httpMethod),
    guards: middlewareGuards(call, ctx),
    site: ctx.site(call, `${dotted}('${route}', …)`),
    handlerId: guessHandlerId(call, ctx),
    // Which router this hangs off, so whatever prefix that router was mounted under
    // becomes part of the address before anything is merged.
    routerVar: holder,
  });
}

/** `fastify.route({ method: 'GET', url: '/users', handler })` */
function fastifyRouteObject(call: CallExpression, ctx: DetectorContext): void {
  const dotted = dottedName(call.getExpression());
  if (!dotted?.endsWith('.route')) return;
  const config = argAt(call, 0);
  const route = literalString(objectProp(config, 'url')) ?? literalString(objectProp(config, 'path'));
  if (!route) return;

  const methodNode = objectProp(config, 'method');
  const methods = literalString(methodNode) ? [literalString(methodNode)!] : ['ANY'];
  for (const raw of methods) {
    const method = raw.toUpperCase();
    ctx.emit({
      type: 'endpoint',
      endpointKind: 'http-route',
      key: `${method} ${route}`,
      name: `${method} ${route}`,
      method,
      route,
      framework: 'Fastify',
      writes: WRITE_METHODS.has(method),
      guards: objectProp(config, 'preHandler') || objectProp(config, 'onRequest')
        ? [
            {
              name: 'preHandler',
              how: 'config',
              provider: 'custom',
              path: ctx.ref.relPath,
              line: call.getStartLineNumber(),
              confidence: 'likely',
            },
          ]
        : [],
      site: ctx.site(call, `route({ method: '${method}', url: '${route}' })`),
      handlerId: ctx.enclosing(call),
    });
  }
}

/**
 * What a class contributes to the question of who may call it: the guards written on it,
 * and the class it extends.
 *
 * Neither half is an answer on its own. `@UseGuards(SessionGuard)` two links up the
 * chain is the only place a controller is locked, and the controller's own file will not
 * mention a caller anywhere — so the chain is reported as facts and joined in the merge,
 * where every class in the project is in view. Guard names are carried as checks in
 * their own right because `@UseGuards` is Nest saying, in as many words, that this is
 * what decides whether the request proceeds.
 */
function nestClassChain(cls: ClassDeclaration, ctx: DetectorContext): void {
  const name = cls.getName();
  if (!name) return;
  const guards = decoratorGuards(cls.getDecorator('UseGuards'), ctx);
  const bases = [cls.getExtends()?.getExpression().getText()].filter((base): base is string => Boolean(base));
  // A class that carries nothing and extends nothing is still *declared* — and saying so
  // is the whole protection against name collisions. The merge trusts a name only when
  // exactly one class declares it, and it can only count the declarations it was told
  // about: when the guardless `UsersController` stayed silent, its guarded namesake in
  // another file became "the only UsersController", and its lock walked onto a door it
  // was never written on (#162).

  for (const guard of guards) ctx.emit({ type: 'auth-checker', name: guard.name, guard });
  ctx.emit({
    type: 'auth-alias',
    name,
    depends: guards.map((guard) => guard.name),
    binds: 'UseGuards',
    bases,
    path: ctx.ref.relPath,
    line: cls.getStartLineNumber(),
  });
}

/** `@Controller('users')` with `@Get(':id')` methods inside. */
function nestController(cls: ClassDeclaration, ctx: DetectorContext): void {
  if (!ctx.signals.packages.has('@nestjs/common')) return;
  nestClassChain(cls, ctx);

  const controller = cls.getDecorator('Controller');
  if (!controller) return;

  // `@Controller()` with nothing in it means "no prefix", and that is an address.
  // `@Controller(`${ApiPath.Rest}/metadata/pageLayouts`)` means "a prefix I could not
  // read", and that is not. Both used to produce an empty base, which is how twentyhq/
  // twenty's 141 route decorators collapsed onto 44 doors (#153).
  const prefixArg = controller.getArguments()[0];
  const literalBase = literalString(prefixArg);
  const prefixUnread = prefixArg !== undefined && literalBase === null;
  const base = normalizeSegment(literalBase ?? '');
  const classUseGuards = cls.getDecorator('UseGuards');
  const classGuards = decoratorGuards(classUseGuards, ctx);
  const classDeclaredPublic = declaresPublic(classUseGuards);

  for (const method of cls.getMethods()) {
    for (const name of HTTP_METHODS) {
      const decorator = method.getDecorator(capitalize(name.toLowerCase()));
      if (!decorator) continue;
      const sub = normalizeSegment(literalString(decorator.getArguments()[0]) ?? '');
      const path = `/${[base, sub].filter(Boolean).join('/')}`;
      const owner = cls.getName() ?? null;
      // An unread prefix makes the whole address unknown, and two unknown addresses are
      // not the same door. Keyed on the *file*, not the class name: a v1/v2 split puts
      // a `UsersController` in two files, and keying on the name merged them back into
      // one entry wearing one of their guards — #153's false green through a smaller
      // hole (#159). A file holds one class of a given name, so file-plus-tail is the
      // identity the class name only approximates. The tail is real and is shown; the
      // ellipsis is where the prefix would be.
      const route = prefixUnread ? null : path;
      const shown = prefixUnread ? `${name} …${path}${owner ? ` (${owner})` : ''}` : `${name} ${path}`;
      const key = prefixUnread ? `${name} ${ctx.ref.relPath}#${owner ?? ''}${path}` : `${name} ${path}`;
      const methodUseGuards = method.getDecorator('UseGuards');
      ctx.emit({
        type: 'endpoint',
        endpointKind: 'http-route',
        key,
        name: shown,
        method: name,
        route,
        framework: 'NestJS',
        writes: WRITE_METHODS.has(name),
        // A guard that permits everything is not a lock and not silence either: it is
        // somebody writing down that this door is open on purpose (#152).
        ...(classDeclaredPublic || declaresPublic(methodUseGuards) ? { declaredPublic: true } : {}),
        guards: [...classGuards, ...decoratorGuards(methodUseGuards, ctx)],
        site: ctx.site(method, `@${capitalize(name.toLowerCase())}('${sub}')`),
        handlerId: ctx.enclosing(method),
        // The class this route was declared on, so a check written further up the chain
        // than this file goes can still be found.
        handlerOwner: owner,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Supabase Edge Functions — deployed HTTP the rest of the repo never mentions
// ---------------------------------------------------------------------------

/**
 * A file under `supabase/functions/<name>/` that calls `Deno.serve(handler)` — or the
 * older `serve(handler)` from the Deno std library — answers HTTP at
 * `/functions/v1/<name>` once deployed. No package.json dependency announces this,
 * so it is gated on the path convention instead: that directory layout *is* the
 * deployment contract.
 */
export const edgeFunctionDetector: BoundaryDetector = {
  id: 'supabase-edge-functions',
  enabled: () => true,
  visit(node, ctx) {
    if (!Node.isCallExpression(node)) return;
    const name = edgeFunctionName(ctx.ref.relPath);
    if (!name) return;
    const dotted = dottedName(node.getExpression());
    if (dotted !== 'Deno.serve' && dotted !== 'serve') return;

    const route = `/functions/v1/${name}`;
    ctx.emit({
      type: 'endpoint',
      endpointKind: 'http-route',
      key: `ANY ${route}`,
      name: `ANY ${route}`,
      method: 'ANY',
      route,
      framework: 'Supabase Edge Function',
      // The handler takes every method, and what it does inside is its own business.
      writes: false,
      // Supabase verifies the caller's JWT before the function runs unless the
      // project's config turns that off — a default we can't see from here, hence
      // likely rather than certain.
      guards: [
        {
          name: 'JWT verified by the platform (verify_jwt default)',
          how: 'config',
          provider: 'Supabase',
          path: ctx.ref.relPath,
          line: node.getStartLineNumber(),
          confidence: 'likely',
        },
      ],
      site: ctx.site(node, `${dotted}(handler)`),
      handlerId: ctx.enclosing(node),
    });
  },
};

function edgeFunctionName(relPath: string): string | null {
  const match = /(?:^|\/)supabase\/functions\/([^/]+)\//.exec(relPath);
  return match ? match[1] : null;
}

function decoratorGuards(decorator: ReturnType<ClassDeclaration['getDecorator']>, ctx: DetectorContext): GuardInfo[] {
  if (!decorator) return [];
  return decorator
    .getArguments()
    .filter((arg) => !permitsEverything(arg))
    .map((arg) => ({
      name: arg.getText(),
      how: 'decorator' as const,
      provider: providerForGuardName(arg.getText(), ctx),
      path: ctx.ref.relPath,
      line: decorator.getStartLineNumber(),
      confidence: 'certain' as const,
    }));
}

/** Whether any argument of a `@UseGuards(...)` is a guard that lets everybody through. */
function declaresPublic(decorator: ReturnType<ClassDeclaration['getDecorator']>): boolean {
  return (decorator?.getArguments() ?? []).some((arg) => permitsEverything(arg));
}


/** Middleware arguments sitting between the path and the handler. */
function middlewareGuards(call: CallExpression, ctx: DetectorContext): GuardInfo[] {
  const guards: GuardInfo[] = [];
  for (const arg of call.getArguments().slice(1, -1)) {
    const name = dottedName(Node.isCallExpression(arg) ? arg.getExpression() : arg);
    if (!name) continue;
    const guard = guardFromName(name, ctx);
    if (guard) guards.push({ ...guard, how: 'middleware', line: call.getStartLineNumber() });
  }
  return guards;
}

function looksLikeRouter(name: string, ctx: DetectorContext): boolean {
  return isRouter(name, ctx.locals);
}

function frameworkFor(name: string, ctx: DetectorContext): string | null {
  const local = ctx.locals.get(name);
  if (local?.module) {
    const match = SERVER_PACKAGES.find(({ pkg }) => pkg === local.module);
    if (match) return match.name;
  }
  if (local && /Hono/.test(local.callee)) return 'Hono';
  if (local && /express|Router/.test(local.callee)) return 'Express';
  if (local && /[Ff]astify/.test(local.callee)) return 'Fastify';
  return null;
}

/**
 * The handler is usually an inline arrow, which is not a node in the atlas, so we
 * attribute the door to whatever *is*: the function or file the route is declared in.
 */
function guessHandlerId(call: CallExpression, ctx: DetectorContext): string {
  const handler = functionArg(call);
  return ctx.enclosing(handler ?? call);
}

// ---------------------------------------------------------------------------
// tRPC — procedures are routes without URLs
// ---------------------------------------------------------------------------

const PROCEDURE_KINDS: Record<string, { method: string; writes: boolean }> = {
  query: { method: 'QUERY', writes: false },
  mutation: { method: 'MUTATION', writes: true },
  subscription: { method: 'SUBSCRIPTION', writes: false },
};

export const trpcDetector: BoundaryDetector = {
  id: 'trpc',
  enabled: (ctx) => ctx.signals.packages.has('@trpc/server'),
  visit(node, ctx) {
    if (!Node.isPropertyAssignment(node)) return;
    const init = node.getInitializer();
    if (!init || !Node.isCallExpression(init)) return;

    const chain = dottedName(init.getExpression());
    if (!chain) return;
    const last = chain.split('.').pop() ?? '';
    const kind = PROCEDURE_KINDS[last];
    if (!kind) return;

    // `publicProcedure.query(...)` vs `protectedProcedure.mutation(...)` — the name of
    // the base procedure is how every tRPC codebase encodes its auth boundary.
    const base = chain.split('.')[0];
    if (!/procedure/i.test(base)) return;

    const name = node.getName().replace(/^['"]|['"]$/g, '');
    const guards: GuardInfo[] = /protected|private|auth|admin|signed/i.test(base)
      ? [
          {
            name: base,
            how: 'procedure',
            provider: 'tRPC',
            path: ctx.ref.relPath,
            line: node.getStartLineNumber(),
            confidence: 'certain',
          },
        ]
      : [];

    ctx.emit({
      type: 'endpoint',
      endpointKind: 'http-route',
      key: `${kind.method} ${name}`,
      name: `${name}`,
      method: kind.method,
      route: name,
      framework: 'tRPC',
      writes: kind.writes,
      guards,
      site: ctx.site(node, `${name}: ${base}.${last}(…)`),
      handlerId: ctx.enclosing(node),
    });
  },
};

function providerForGuardName(name: string, ctx: DetectorContext): string {
  return guardFromName(name, ctx)?.provider ?? 'custom';
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function isUnder(relPath: string, dir: string): boolean {
  return relPath.startsWith(`${dir}/`);
}

/** `users/[id]/route.ts` → `route` */
function fileBase(rest: string): string {
  const file = rest.split('/').pop() ?? '';
  return file.replace(/\.[cm]?[jt]sx?$/, '');
}

/**
 * Turns an App Router directory into the URL it serves. Route groups `(marketing)`
 * and parallel slots `@modal` shape the folder tree but not the URL, which is exactly
 * the sort of thing a person cannot be expected to hold in their head.
 */
function appRoutePath(rest: string): string {
  const segments = rest.split('/').slice(0, -1);
  return `/${segments.map(routeSegment).filter((s) => s !== null).join('/')}`.replace(/\/{2,}/g, '/').replace(/(.)\/$/, '$1');
}

function pagesRoutePath(rest: string): string {
  const withoutExt = rest.replace(/\.[cm]?[jt]sx?$/, '');
  const segments = withoutExt.split('/');
  if (segments[segments.length - 1] === 'index') segments.pop();
  const mapped = segments.map(routeSegment).filter((s) => s !== null);
  return `/${mapped.join('/')}`.replace(/\/{2,}/g, '/').replace(/(.)\/$/, '$1');
}

/**
 * Like the Pages Router, an Expo screen file *is* the route — `cellar/[id].tsx` is the
 * screen, not a `page.tsx` inside a folder. So every segment counts, including the
 * basename, and a trailing `index` drops to its parent (`(tabs)/index` → `/`).
 */
function expoRoutePath(rest: string): string {
  const parts = rest.replace(/\.[cm]?[jt]sx?$/, '').split('/');
  if (parts[parts.length - 1] === 'index') parts.pop();
  const segs = parts.map(routeSegment).filter((s) => s !== null);
  return `/${segs.join('/')}`.replace(/\/{2,}/g, '/').replace(/(.)\/$/, '$1') || '/';
}

/** null means the segment shapes the folder tree but not the URL. */
function routeSegment(segment: string): string | null {
  if (segment === '') return null;
  if (segment.startsWith('(') && segment.endsWith(')')) return null;
  if (segment.startsWith('@')) return null;
  if (/^\[\[?\.\.\..+?\]?\]$/.test(segment)) return '*';
  const dynamic = /^\[(.+)\]$/.exec(segment);
  if (dynamic) return `:${dynamic[1]}`;
  return segment;
}

function normalizeSegment(value: string): string {
  return value.replace(/^\/+|\/+$/g, '');
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * Exported name → the declaration that defines it.
 *
 * Shared with the SvelteKit and Remix detectors, because "the file system is the router
 * and the exported names are the handlers" is one convention wearing three sets of
 * clothes.
 */
export function exportedDeclarations(sf: SourceFile): Map<string, Node> {
  const out = new Map<string, Node>();
  for (const fn of sf.getFunctions()) {
    if (fn.isExported() || fn.isDefaultExport()) out.set(fn.getName() ?? 'default', fn);
  }
  for (const decl of sf.getVariableDeclarations()) {
    if (decl.getVariableStatement()?.isExported()) out.set(decl.getName(), decl);
  }
  return out;
}

/** The declaration behind `export default` — a page's component, usually. */
export function defaultExport(sf: SourceFile): Node | undefined {
  for (const fn of sf.getFunctions()) {
    if (fn.isDefaultExport()) return fn;
  }
  const assignment = sf.getExportAssignment((node) => !node.isExportEquals());
  const expression = assignment?.getExpression();
  if (expression && Node.isIdentifier(expression)) {
    const declared = sf.getVariableDeclaration(expression.getText());
    if (declared) return declared;
  }
  return expression ?? undefined;
}

function fileHasDirective(sf: SourceFile, directive: string): boolean {
  for (const statement of sf.getStatements().slice(0, 2)) {
    if (statement.getKind() !== SyntaxKind.ExpressionStatement) continue;
    if (!Node.isExpressionStatement(statement)) continue;
    if (literalString(statement.getExpression()) === directive) return true;
  }
  return false;
}
