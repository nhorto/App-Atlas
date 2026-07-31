/**
 * @fileoverview SvelteKit and Remix: the directory is the address, the exports are the
 * handlers.
 *
 * Both frameworks decide what answers a URL from where a file sits and what it exports,
 * exactly as the Next.js App Router does — so the shape of this file follows
 * `nextRoutesDetector` deliberately. What differs is the spelling: SvelteKit puts the
 * address in the folder tree and calls its handlers `GET`, `load` and `actions`; Remix
 * puts the whole address in the *filename*, dots and all, and calls its handlers
 * `loader` and `action`.
 *
 * Guards are a separate question, and the rule here is the same as everywhere else in
 * this directory: a file path is evidence of a door and never evidence of a lock. A
 * route is reported open unless something in the code demonstrably turns a caller
 * away — an `error(401)`, or a redirect to a sign-in page — and where that refusal is
 * written decides how far the claim reaches.
 */
import { Node } from 'ts-morph';
import type { SourceFile } from 'ts-morph';
import { argAt, dottedName, literalPrefix, literalString, objectProp, snippetOf } from './ast.js';
import { defaultExport, exportedDeclarations } from './http.js';
import type { BoundaryDetector, DetectorContext } from './types.js';

/** The verbs SvelteKit names an endpoint's exports after. */
const METHOD_EXPORTS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// ---------------------------------------------------------------------------
// SvelteKit
// ---------------------------------------------------------------------------

/**
 * Every door a SvelteKit route directory opens.
 *
 * `+server.ts` answers HTTP under whichever verbs it exports. `+page.server.ts` is two
 * different doors wearing one filename: the page itself, which a browser renders, and
 * one form-post door per entry in its `actions` object — the quietest write in a
 * SvelteKit app, because nothing about it looks like an endpoint.
 *
 * `+page.svelte` files are not read: they are not JavaScript, so a page with no server
 * or universal load beside it is missing from the map rather than guessed at.
 */
export const svelteRoutesDetector: BoundaryDetector = {
  id: 'sveltekit-routes',
  enabled: (ctx) => Boolean(ctx.signals.svelteKitRoutesDir),
  fileScan(ctx) {
    const dir = ctx.signals.svelteKitRoutesDir;
    const { relPath } = ctx.ref;
    if (!dir || !isUnder(relPath, dir)) return;

    const rest = relPath.slice(dir.length + 1);
    const base = fileBase(rest);
    const route = svelteRoutePath(rest);

    if (base === '+server') svelteEndpoints(ctx, route);
    else if (base === '+page.server' || base === '+page') sveltePage(ctx, route, base === '+page.server');
  },
};

/** `+server.ts` exporting GET and POST is two doors at one address, not one. */
function svelteEndpoints(ctx: DetectorContext, route: string): void {
  const exported = exportedDeclarations(ctx.sf);
  let found = false;

  for (const method of METHOD_EXPORTS) {
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
      framework: 'SvelteKit',
      writes: WRITE_METHODS.has(method),
      guards: [],
      site: ctx.site(decl, `${method} ${route}`),
      // The exported handler is the door, so a refusal inside it is an exact match
      // rather than a same-file guess.
      handlerId: ctx.enclosing(decl),
    });
  }

  // A `+server.ts` whose exports we could not read still answers at this address.
  // Silence would read as "nothing here", which is the worse of the two mistakes.
  if (!found) {
    ctx.emit({
      type: 'endpoint',
      endpointKind: 'http-route',
      key: `ANY ${route}`,
      name: `ANY ${route}`,
      method: 'ANY',
      route,
      framework: 'SvelteKit',
      writes: false,
      guards: [],
      site: ctx.site(ctx.sf, route),
      handlerId: ctx.fileId,
    });
  }
}

/** A page is a door too — it is how a person arrives, and it can be left unprotected. */
function sveltePage(ctx: DetectorContext, route: string, isServer: boolean): void {
  const exported = exportedDeclarations(ctx.sf);
  const load = exported.get('load');

  ctx.emit({
    type: 'endpoint',
    endpointKind: 'http-route',
    key: `PAGE ${route}`,
    name: route,
    method: 'PAGE',
    route,
    framework: 'SvelteKit',
    writes: false,
    guards: [],
    site: ctx.site(load ?? ctx.sf, route),
    // The load function is where a check would be written, so it is the handler.
    handlerId: load ? ctx.enclosing(load) : ctx.fileId,
  });

  if (isServer) svelteActions(ctx, route, exported.get('actions'));
}

/**
 * `export const actions = { default: …, delete: … }` — a form post, and a write, at an
 * address a reader will not find anywhere else in their code.
 *
 * The named form is reached at `/cellar?/delete`, so that is what the door is called;
 * `route` keeps the path on its own, because the part after `?` is a query string and
 * every check that matches on addresses matches on paths.
 */
function svelteActions(ctx: DetectorContext, route: string, decl: Node | undefined): void {
  if (!decl || !Node.isVariableDeclaration(decl)) return;

  let init: Node | undefined = decl.getInitializer();
  while (
    init &&
    (Node.isAsExpression(init) || Node.isSatisfiesExpression(init) || Node.isParenthesizedExpression(init))
  ) {
    init = init.getExpression();
  }
  if (!init || !Node.isObjectLiteralExpression(init)) return;

  for (const prop of init.getProperties()) {
    if (!Node.isPropertyAssignment(prop) && !Node.isMethodDeclaration(prop)) continue;
    const name = prop.getName().replace(/^['"]|['"]$/g, '');
    const address = name === 'default' ? route : `${route}?/${name}`;
    ctx.emit({
      type: 'endpoint',
      endpointKind: 'http-route',
      key: `POST ${address}`,
      name: `POST ${address}`,
      method: 'POST',
      route,
      framework: 'SvelteKit',
      // An action exists to change something; that is the whole of what it is for.
      writes: true,
      guards: [],
      site: ctx.site(prop, `actions.${name}`),
      handlerId: ctx.enclosing(prop),
    });
  }
}

/** Where SvelteKit keeps the one function that runs before every request. */
const SVELTE_HOOKS = new Set([
  'src/hooks.server.ts',
  'src/hooks.server.js',
  'hooks.server.ts',
  'hooks.server.js',
]);

/**
 * The `handle` hook — the only place in a SvelteKit app where one line locks many doors.
 *
 * It is read for the same reason Next.js middleware is, and with the same suspicion: a
 * hook that reads the session cookie and hangs a user on `event.locals` protects
 * nothing at all, and most of them do exactly that. So a guard is only reported when
 * the hook demonstrably refuses somebody, and it reaches only as far as the code says —
 * a refusal written inside `if (event.url.pathname.startsWith('/admin'))` covers
 * `/admin`, and a refusal written outside every such test covers everything.
 *
 * Unlike a layout's load, this really does run for endpoints as well as for pages,
 * which is what makes the project-wide claim an honest one.
 */
export const svelteHooksDetector: BoundaryDetector = {
  id: 'sveltekit-hooks',
  enabled: (ctx) => ctx.signals.packages.has('@sveltejs/kit') && SVELTE_HOOKS.has(ctx.ref.relPath),
  fileScan(ctx) {
    for (const refusal of refusalsIn(ctx.sf, ctx)) {
      const prefixes = pathPrefixes(refusal.node);
      ctx.emit({
        type: 'guard',
        guard: {
          name: refusal.name,
          how: 'middleware',
          provider: 'custom',
          path: ctx.ref.relPath,
          line: refusal.line,
          confidence: 'likely',
        },
        scope: 'matcher',
        nodeId: null,
        matchers:
          prefixes.length > 0
            ? prefixes.map((prefix) => `${prefix.replace(/\/$/, '')}/:path*`)
            : ['/:path*'],
        sourceId: ctx.fileId,
      });
    }
  },
};

/**
 * Turns a SvelteKit route directory into the URL it serves.
 *
 * Route groups `(app)` shape the folder tree and never appear in an address — the same
 * trick Next.js plays, and the same thing nobody can be expected to hold in their head
 * while reading a folder listing.
 */
function svelteRoutePath(rest: string): string {
  const segments = rest
    .split('/')
    .slice(0, -1)
    .map(svelteSegment)
    .filter((segment): segment is string => segment !== null);
  return `/${segments.join('/')}`.replace(/\/{2,}/g, '/').replace(/(.)\/$/, '$1');
}

/** null means the folder shapes the tree but not the URL. */
function svelteSegment(segment: string): string | null {
  if (segment === '') return null;
  if (segment.startsWith('(') && segment.endsWith(')')) return null;
  // `[...rest]` swallows whatever is left of the path.
  if (/^\[\[?\.\.\..+?\]?\]$/.test(segment)) return '*';
  const dynamic = /^\[\[?(.+?)\]?\]$/.exec(segment);
  // `[id=integer]` names a matcher function as well as the parameter; the address only
  // cares about the parameter. An optional `[[lang]]` prints as a parameter too, which
  // says less than the truth rather than more.
  if (dynamic) return `:${dynamic[1].split('=')[0]}`;
  return segment;
}

// ---------------------------------------------------------------------------
// Remix / React Router 7
// ---------------------------------------------------------------------------

/**
 * Every door a Remix route file opens.
 *
 * Remix writes the whole address into the filename — `routes/api.users.$id.tsx`
 * answers at `/api/users/:id` — which is compact to type and genuinely hard to read
 * back out of a directory listing, so translating it is most of what this detector is
 * for. A route exports `loader` for reads, `action` for writes, and a component for
 * the page; a file that exports none of the three is a module the route keeps beside
 * it, and inventing a door for it would put a URL on the map that answers nothing.
 */
export const remixRoutesDetector: BoundaryDetector = {
  id: 'remix-routes',
  enabled: (ctx) => Boolean(ctx.signals.remixRoutesDir),
  fileScan(ctx) {
    const dir = ctx.signals.remixRoutesDir;
    const { relPath } = ctx.ref;
    if (!dir || !isUnder(relPath, dir)) return;

    const id = remixRouteId(relPath.slice(dir.length + 1));
    if (id === null) return;
    const route = remixRoutePath(id);
    if (route === null) return;

    const exported = exportedDeclarations(ctx.sf);
    const loader = exported.get('loader');
    const action = exported.get('action');
    const component = defaultExport(ctx.sf);
    if (!loader && !action && !component) return;

    const framework = remixFramework(ctx);

    if (component) {
      ctx.emit({
        type: 'endpoint',
        endpointKind: 'http-route',
        key: `PAGE ${route}`,
        name: route,
        method: 'PAGE',
        route,
        framework,
        writes: false,
        guards: [],
        site: ctx.site(loader ?? component, route),
        // The loader is where a check would be written, so when there is one it is the
        // handler rather than the component it renders.
        handlerId: ctx.enclosing(loader ?? component),
      });
    } else if (loader) {
      // No component: a resource route, which is an API endpoint in everything but name.
      ctx.emit({
        type: 'endpoint',
        endpointKind: 'http-route',
        key: `GET ${route}`,
        name: `GET ${route}`,
        method: 'GET',
        route,
        framework,
        writes: false,
        guards: [],
        site: ctx.site(loader, `GET ${route}`),
        handlerId: ctx.enclosing(loader),
      });
    }

    if (action) {
      // One `action` answers POST, PUT, PATCH and DELETE. POST is the one every form
      // sends and the one the door is named for; the others are covered by the same
      // handler and the same check, so nothing here is claimed to be safer than it is.
      ctx.emit({
        type: 'endpoint',
        endpointKind: 'http-route',
        key: `POST ${route}`,
        name: `POST ${route}`,
        method: 'POST',
        route,
        framework,
        writes: true,
        guards: [],
        site: ctx.site(action, `POST ${route}`),
        handlerId: ctx.enclosing(action),
      });
    }
  },
};

/** Whichever of the two names the project actually installed. */
function remixFramework(ctx: DetectorContext): string {
  for (const name of ctx.signals.packages) {
    if (name.startsWith('@remix-run/')) return 'Remix';
  }
  return 'React Router';
}

/**
 * The route id a file declares, or null when the file is not a route at all.
 *
 * A file directly under `routes/` is a route and its name is the whole address. Inside
 * a folder, only `route.tsx` is the route and the folder name is the address — which is
 * the point of the convention: it is where a route puts the code it does not want
 * turned into URLs of its own.
 */
function remixRouteId(rest: string): string | null {
  const parts = rest.split('/');
  const base = (parts.pop() ?? '').replace(/\.[cm]?[jt]sx?$/, '');
  if (parts.length === 0) return base;
  if (base !== 'route') return null;
  return parts.join('/');
}

/**
 * Turns a Remix route id into the URL it answers at, or null when it answers at none.
 *
 * `_index` is the address of its parent, `$id` is a parameter, a bare `$` swallows the
 * rest of the path, and a segment starting with `_` is a layout that wraps other routes
 * without adding anything to the address — so a file whose *last* segment is one of
 * those is a layout rather than a door.
 */
function remixRoutePath(id: string): string | null {
  const raw = id.split('/').flatMap(flatSegments);
  const last = raw[raw.length - 1] ?? '';
  if (last !== '_index' && last.startsWith('_')) return null;

  const segments = raw.map(remixSegment).filter((segment): segment is string => segment !== null);
  return `/${segments.join('/')}`.replace(/\/{2,}/g, '/').replace(/(.)\/$/, '$1') || '/';
}

/**
 * Splits a flat filename on its dots, honouring the escape.
 *
 * `sitemap[.]xml` is one segment containing a dot, not two segments — the brackets are
 * how the convention spells "this character is part of the address".
 */
function flatSegments(part: string): string[] {
  const out: string[] = [];
  let current = '';
  for (let i = 0; i < part.length; i++) {
    const char = part[i];
    if (char === '[') {
      const end = part.indexOf(']', i + 1);
      if (end === -1) {
        current += char;
        continue;
      }
      current += part.slice(i + 1, end);
      i = end;
      continue;
    }
    if (char === '.') {
      out.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  out.push(current);
  return out.filter((segment) => segment !== '');
}

/** null means the segment shapes the route tree but not the URL. */
function remixSegment(segment: string): string | null {
  if (segment === '' || segment === '_index') return null;
  if (segment.startsWith('_')) return null;
  // A trailing underscore opts a route out of its parent's layout. It changes what the
  // page is nested in and nothing at all about the address.
  const name = segment.replace(/_$/, '');
  if (name === '$') return '*';
  if (name.startsWith('$')) return `:${name.slice(1)}`;
  return name;
}

// ---------------------------------------------------------------------------
// Refusals — the only thing either framework offers as evidence of a lock
// ---------------------------------------------------------------------------

/**
 * A check found by what the code does rather than by what it is called.
 *
 * Neither framework has a decorator, a middleware argument or a naming convention for
 * auth. What they have is a handler that stops: `error(401)`, or a redirect to the sign
 * in page. That is the same rule the Python and NestJS detectors already use — a
 * function is a check because it turns somebody away, not because of the word "auth" in
 * its name.
 *
 * Emitted for every function in the project, not only for route files, because the
 * Remix idiom is `const userId = await requireUserId(request)` at the top of a loader
 * with the refusal itself a file away. The reference graph carries it back the one hop,
 * and badges it `likely` when it does.
 */
export const refusalDetector: BoundaryDetector = {
  id: 'framework-refusals',
  enabled: (ctx) => Boolean(ctx.signals.svelteKitRoutesDir || ctx.signals.remixRoutesDir),
  fileScan(ctx) {
    if (runsInTheBrowserToo(ctx)) return;
    for (const refusal of refusalsIn(ctx.sf, ctx)) {
      ctx.emit({
        type: 'guard',
        guard: {
          name: refusal.name,
          how: 'call',
          provider: 'custom',
          path: ctx.ref.relPath,
          line: refusal.line,
          confidence: 'certain',
        },
        // Which function this sits in is the whole of its reach: a refusal in one
        // handler says nothing about the handler beside it, and `build.ts` decides how
        // sure to be from whether this is the door's own handler or a hop away.
        scope: 'node',
        nodeId: ctx.enclosing(refusal.node),
        matchers: [],
        sourceId: ctx.fileId,
      });
    }
  },
};

/**
 * Whether this file's code also runs in the visitor's browser.
 *
 * SvelteKit's `+page.ts` and `+layout.ts` are *universal* loads: the server runs them
 * for the first request and the browser runs them for every navigation after it. A
 * redirect written there is a piece of routing, not a lock — the framework's own
 * documentation says so — and reporting it as protection would put a green badge on the
 * exact mistake this tool exists to catch.
 */
function runsInTheBrowserToo(ctx: DetectorContext): boolean {
  const dir = ctx.signals.svelteKitRoutesDir;
  if (!dir || !isUnder(ctx.ref.relPath, dir)) return false;
  const base = fileBase(ctx.ref.relPath.slice(dir.length + 1));
  return base === '+page' || base === '+layout';
}

/** The two statuses that mean "I do not accept who you are". */
const REFUSAL_STATUS = new Set([401, 403]);

/** Calls either framework refuses a caller with. */
const REFUSAL_CALLS = new Set(['error', 'fail', 'json', 'redirect']);

/**
 * The packages those calls have to have come from.
 *
 * `error` and `redirect` are ordinary words. Gating on the import is what keeps a
 * project's own `redirect()` helper, or a `json()` from some other library, from being
 * read as a lock on a route.
 */
const FRAMEWORK_MODULES = /^(@sveltejs\/kit$|@remix-run\/|@react-router\/|react-router$)/;

interface Refusal {
  /** The refusal as it is written, so a reader can go and check our work. */
  name: string;
  node: Node;
  line: number;
}

function refusalsIn(scope: SourceFile, ctx: DetectorContext): Refusal[] {
  const out: Refusal[] = [];
  scope.forEachDescendant((node) => {
    const name = refusalName(node, ctx);
    if (name) out.push({ name, node, line: node.getStartLineNumber() });
  });
  return out;
}

/** How this node refuses a caller, or null when it does not. */
function refusalName(node: Node, ctx: DetectorContext): string | null {
  // `throw new Response('Unauthorized', { status: 401 })` — no import to check, and no
  // other reading of it either.
  if (Node.isNewExpression(node)) {
    if (dottedName(node.getExpression()) !== 'Response') return null;
    return node.getArguments().some(hasRefusalStatus) ? snippetOf(node, 60) : null;
  }

  if (!Node.isCallExpression(node)) return null;
  const dotted = dottedName(node.getExpression());
  if (!dotted) return null;
  const callee = dotted.split('.').pop() ?? dotted;
  if (!REFUSAL_CALLS.has(callee)) return null;
  if (!fromTheFramework(dotted.split('.')[0], ctx)) return null;

  const args = node.getArguments();
  if (callee === 'redirect') {
    // Where it sends them is the whole of the evidence: `/login` is a refusal and
    // `/dashboard` is an ordinary redirect.
    return args.some((arg) => sendsToSignIn(literalPrefix(arg))) ? snippetOf(node, 60) : null;
  }
  return args.some(hasRefusalStatus) ? snippetOf(node, 60) : null;
}

/** A literal 401 or 403, written either bare or as `{ status: 401 }`. */
function hasRefusalStatus(node: Node): boolean {
  if (Node.isNumericLiteral(node)) return REFUSAL_STATUS.has(node.getLiteralValue());
  const status = objectProp(node, 'status');
  return Boolean(status && Node.isNumericLiteral(status) && REFUSAL_STATUS.has(status.getLiteralValue()));
}

/** Whether this address is where an app sends somebody who is not signed in. */
function sendsToSignIn(target: string | null): boolean {
  if (!target || !target.startsWith('/')) return false;
  return target
    .split(/[?#]/)[0]
    .split('/')
    .some((segment) => /^(login|signin|sign-in|sign_in|auth|authenticate)$/i.test(segment));
}

function fromTheFramework(root: string, ctx: DetectorContext): boolean {
  const binding = ctx.imports.get(root);
  return Boolean(binding?.external && FRAMEWORK_MODULES.test(binding.module));
}

/**
 * The URL prefixes the surrounding `if` limits a refusal to, if it limits it at all.
 *
 * A `handle` hook that refuses everybody who is not signed in guards the whole app; one
 * that only does it under `/admin` guards `/admin`, and claiming the rest of the site
 * on the strength of it would be the single most expensive thing this tool could say.
 *
 * Only the branch the refusal is actually in counts — a condition whose `else` holds the
 * refusal means the opposite of what it says — and the search stops at the innermost
 * test, because nested tests all have to hold at once and the narrowest of them is the
 * only address that really gets refused.
 */
function pathPrefixes(node: Node): string[] {
  let previous: Node = node;
  let current: Node | undefined = node.getParent();

  while (current) {
    if (Node.isIfStatement(current) && current.getElseStatement() !== previous) {
      const found: string[] = [];
      current.getExpression().forEachDescendant((child) => {
        if (!Node.isCallExpression(child)) return;
        if (!dottedName(child.getExpression())?.endsWith('.pathname.startsWith')) return;
        const prefix = literalString(argAt(child, 0));
        if (prefix?.startsWith('/')) found.push(prefix);
      });
      // Several tests inside one condition are alternatives, so they all count.
      if (found.length > 0) return [...new Set(found)];
    }
    previous = current;
    current = current.getParent();
  }

  return [];
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function isUnder(relPath: string, dir: string): boolean {
  return relPath.startsWith(`${dir}/`);
}

/** `cellar/[id]/+page.server.ts` → `+page.server` */
function fileBase(rest: string): string {
  const file = rest.split('/').pop() ?? '';
  return file.replace(/\.[cm]?[jt]sx?$/, '');
}
