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
import type { CallExpression, ClassDeclaration, SourceFile } from 'ts-morph';
import type { GuardInfo } from '../../model/types.js';
import { argAt, dottedName, functionArg, hasDirective, literalString, objectProp } from './ast.js';
import { guardFromName } from './auth.js';
import type { BoundaryDetector, DetectorContext } from './types.js';

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

/** Names people actually give the thing they hang routes off. */
const ROUTER_NAMES = /^(app|router|server|api|fastify|hono|koa|instance|r)$/i;

export const nodeRoutesDetector: BoundaryDetector = {
  id: 'node-routes',
  enabled: (ctx) => serverFrameworks(ctx).length > 0,
  visit(node, ctx) {
    if (Node.isCallExpression(node)) {
      routeCall(node, ctx);
      fastifyRouteObject(node, ctx);
    } else if (Node.isClassDeclaration(node)) {
      nestController(node, ctx);
    }
  },
};

function serverFrameworks(ctx: DetectorContext): string[] {
  return SERVER_PACKAGES.filter(({ pkg }) => ctx.signals.packages.has(pkg)).map(({ name }) => name);
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

/** `@Controller('users')` with `@Get(':id')` methods inside. */
function nestController(cls: ClassDeclaration, ctx: DetectorContext): void {
  if (!ctx.signals.packages.has('@nestjs/common')) return;
  const controller = cls.getDecorator('Controller');
  if (!controller) return;

  const base = normalizeSegment(literalString(controller.getArguments()[0]) ?? '');
  const classGuards = decoratorGuards(cls.getDecorator('UseGuards'), ctx);

  for (const method of cls.getMethods()) {
    for (const name of HTTP_METHODS) {
      const decorator = method.getDecorator(capitalize(name.toLowerCase()));
      if (!decorator) continue;
      const sub = normalizeSegment(literalString(decorator.getArguments()[0]) ?? '');
      const route = `/${[base, sub].filter(Boolean).join('/')}`;
      ctx.emit({
        type: 'endpoint',
        endpointKind: 'http-route',
        key: `${name} ${route}`,
        name: `${name} ${route}`,
        method: name,
        route,
        framework: 'NestJS',
        writes: WRITE_METHODS.has(name),
        guards: [...classGuards, ...decoratorGuards(method.getDecorator('UseGuards'), ctx)],
        site: ctx.site(method, `@${capitalize(name.toLowerCase())}('${sub}')`),
        handlerId: ctx.enclosing(method),
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
  return decorator.getArguments().map((arg) => ({
    name: arg.getText(),
    how: 'decorator' as const,
    provider: providerForGuardName(arg.getText(), ctx),
    path: ctx.ref.relPath,
    line: decorator.getStartLineNumber(),
    confidence: 'certain' as const,
  }));
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
  if (ROUTER_NAMES.test(name)) return true;
  const local = ctx.locals.get(name);
  if (!local) return false;
  return /express|Router|Hono|Fastify|fastify|Koa|Server/.test(local.callee);
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

/** Exported name → the declaration that defines it. */
function exportedDeclarations(sf: SourceFile): Map<string, Node> {
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
function defaultExport(sf: SourceFile): Node | undefined {
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
