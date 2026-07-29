/**
 * @fileoverview Where data enters and leaves a Python app.
 *
 * Same contract as the TypeScript detectors and for the same reason: nothing here
 * builds an atlas node. Findings go into the one project-wide merge in
 * `boundaries/build.ts`, so a FastAPI route and a Next.js route land in the same list
 * and forty `requests.post` calls become one box.
 *
 * The rules are conventions, not proofs, so each one is gated on the project actually
 * depending on the library it belongs to. `session.query(...)` in an app with no
 * SQLAlchemy is somebody's own helper, and an invented box is worse than a missing one.
 */
import type { CodeSite, GuardInfo } from '../../model/types.js';
import { isInternalHost, serviceForHost, serviceForPythonModule, storeForPythonModule } from '../boundaries/catalog.js';
import type { BoundaryFinding } from '../boundaries/types.js';
import type { PyCall, PyDef, PyFile, PyImport, PyValue } from './types.js';

/** Decorator suffixes that open an HTTP route, by the framework that spells them. */
const ROUTE_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);

/** Decorators that say "somebody must be signed in", and the name to show. */
const GUARD_DECORATORS: Record<string, string> = {
  login_required: 'Django login_required',
  staff_member_required: 'Django staff_member_required',
  permission_required: 'Django permission_required',
  jwt_required: 'Flask-JWT',
  token_required: 'token check',
  requires_auth: 'auth check',
  authenticated: 'auth check',
  auth_required: 'auth check',
};

/**
 * Function names that, when a route depends on one, are checking the caller rather
 * than fetching it a resource. `get_db` and `get_session` are deliberately outside
 * this: a database handle is not a lock, and calling one would be the sort of
 * rounding-up that makes the whole security screen worthless.
 */
const GUARD_HINTS =
  /^((get_|require_|verify_|check_|ensure_)?(current_)?(active_)?(user|superuser|admin|auth|token|principal|identity)|authenticated_user|auth_user)$/;

const HTTP_CLIENTS = new Set(['requests', 'httpx', 'aiohttp', 'urllib']);
const WRITE_METHODS = new Set(['post', 'put', 'patch', 'delete', 'send', 'stream']);

/** SQLAlchemy and friends: the call that means the database was touched. */
const READ_CALLS = new Set(['query', 'get', 'scalar', 'scalars', 'first', 'all', 'select', 'filter', 'fetch', 'find', 'find_one', 'aggregate']);
const WRITE_CALLS = new Set(['add', 'add_all', 'commit', 'delete', 'insert', 'update', 'merge', 'bulk_save_objects', 'create', 'save', 'insert_one', 'insert_many', 'update_one', 'delete_one']);

export interface PythonBoundaryInput {
  file: PyFile;
  /** Atlas id of the file. */
  fileId: string;
  /** Scope name (`list_users`, `Repo.save`) → atlas node id. */
  nodeIdForScope: (scope: string | null) => string;
  /** Everything the project declares in requirements.txt / pyproject.toml / Pipfile. */
  packages: Set<string>;
}

export function detectPythonBoundaries(input: PythonBoundaryInput): BoundaryFinding[] {
  const { file } = input;
  if (!file.ok) return [];

  const findings: BoundaryFinding[] = [];
  const modules = importedModules(file.imports ?? []);
  const has = (name: string) => modules.has(name) || input.packages.has(name);

  const site = (line: number, snippet?: string): CodeSite => ({
    path: file.path,
    line,
    nodeId: input.fileId,
    snippet,
  });

  detectRoutes(input, modules, findings, site);
  detectTasks(input, has, findings, site);
  detectEnv(input, findings, site);
  detectOutbound(input, modules, findings, site);
  detectStores(input, modules, findings, site);
  detectServices(input, findings, site);
  detectGuards(input, findings, site);
  detectAuthAliases(input, findings);
  detectCli(input, has, findings, site);

  return findings;
}

/** Top-level import names: `from sqlalchemy.orm import Session` counts as sqlalchemy. */
function importedModules(imports: PyImport[]): Set<string> {
  const out = new Set<string>();
  for (const imp of imports) {
    if (imp.level > 0 || !imp.module) continue;
    out.add(imp.module.split('.')[0]);
    out.add(imp.module);
  }
  return out;
}

function strArg(value: PyValue | undefined): string | null {
  return value && value.t === 'str' ? value.v : null;
}

function nameArg(value: PyValue | undefined): string | null {
  return value && value.t === 'name' ? value.v : null;
}

/** Every function and method, flattened, with the scope name the extractor used. */
function everyDef(file: PyFile): { def: PyDef; scope: string }[] {
  const out: { def: PyDef; scope: string }[] = [];
  for (const def of file.defs ?? []) {
    if (def.kind === 'function') out.push({ def, scope: def.name });
    for (const method of def.methods ?? []) out.push({ def: method, scope: `${def.name}.${method.name}` });
  }
  return out;
}

/**
 * FastAPI, Flask and their routers all spell a route the same way: a decorator whose
 * last segment is an HTTP verb, or a `.route(...)` with the methods listed separately.
 */
function detectRoutes(
  input: PythonBoundaryInput,
  modules: Set<string>,
  findings: BoundaryFinding[],
  site: (line: number, snippet?: string) => CodeSite,
): void {
  const framework = modules.has('fastapi')
    ? 'FastAPI'
    : modules.has('flask')
      ? 'Flask'
      : modules.has('quart')
        ? 'Quart'
        : modules.has('sanic')
          ? 'Sanic'
          : null;
  if (!framework) return;

  for (const { def, scope } of everyDef(input.file)) {
    for (const decorator of def.decorators) {
      const parts = decorator.callee.split('.');
      const last = parts[parts.length - 1];
      const route = strArg(decorator.args[0]);
      if (!route) continue;

      let methods: string[] = [];
      if (ROUTE_METHODS.has(last)) {
        methods = [last.toUpperCase()];
      } else if (last === 'route') {
        const listed = decorator.kwargs.methods;
        methods =
          listed && listed.t === 'list'
            ? listed.items.map((item) => strArg(item)).filter((m): m is string => Boolean(m))
            : ['GET'];
      } else {
        continue;
      }

      for (const method of methods) {
        findings.push({
          type: 'endpoint',
          endpointKind: isWebhookPath(route) ? 'webhook' : 'http-route',
          key: `${method} ${route}`,
          name: `${method} ${route}`,
          method,
          route,
          framework,
          writes: method !== 'GET' && method !== 'HEAD',
          guards: guardsFor(def, input.file.path),
          site: site(decorator.line, decorator.text),
          handlerId: input.nodeIdForScope(scope),
          // The signature is where FastAPI declares a route's dependencies, and an
          // alias imported from `deps.py` is unresolvable from here.
          paramTypes: paramTypeNames(def),
          routerVar: parts.length > 1 ? parts[0] : null,
        });
      }
    }
  }

  // Django keeps its routes in a list rather than on the handler.
  if (/(^|\/)urls\.py$/.test(input.file.path)) {
    for (const call of input.file.calls ?? []) {
      if (call.callee !== 'path' && call.callee !== 're_path' && call.callee !== 'url') continue;
      const route = strArg(call.args[0]);
      if (route === null) continue;
      const view = nameArg(call.args[1]);
      const shown = `/${route}`.replace(/\/+/g, '/');
      findings.push({
        type: 'endpoint',
        endpointKind: isWebhookPath(shown) ? 'webhook' : 'http-route',
        key: `GET ${shown}`,
        // Django does not declare the method here; the view decides. Saying GET would
        // be a guess, so the name says what is actually known: a URL is served.
        name: shown,
        method: null,
        route: shown,
        framework: 'Django',
        writes: false,
        guards: [],
        site: site(call.line, view ? `path("${route}", ${view})` : undefined),
        handlerId: null,
      });
    }
  }
}

function isWebhookPath(route: string): boolean {
  return /webhook|callback|\/hooks?\//i.test(route);
}

/** Auth that is visible on the handler itself: a decorator, or an injected dependency. */
function guardsFor(def: PyDef, path: string): GuardInfo[] {
  const guards: GuardInfo[] = [];

  for (const decorator of def.decorators) {
    const last = decorator.callee.split('.').pop() ?? '';
    const label = GUARD_DECORATORS[last];
    // The decorator is written on the handler, so it can only be guarding that handler.
    if (label) {
      guards.push({
        name: last,
        how: 'decorator',
        provider: label,
        path,
        line: decorator.line,
        confidence: 'certain',
      });
    }
  }

  // A `Depends(...)` in the signature is not read here. Whether the thing depended on
  // is a *check* is a fact about that function, usually in another file, so it is
  // decided once in `build.ts` against every checker the project defines — which also
  // keeps one route from collecting two names for the same lock.
  return guards;
}

/** Every bare name a signature's annotations mention, alias candidates included. */
function paramTypeNames(def: PyDef): string[] {
  const names = new Set<string>();
  for (const param of def.params ?? []) {
    for (const match of `${param.type} ${param.default ?? ''}`.matchAll(/[A-Za-z_]\w*/g)) {
      names.add(match[0]);
    }
  }
  return [...names];
}

/**
 * The two halves of Python's "auth lives in the signature" idiom, each reported by the
 * file that can see it and joined in `build.ts`:
 *
 *   - a function that rejects strangers with a 401 or a 403, which is what makes a
 *     dependency a check;
 *   - `CurrentUser = Annotated[User, Depends(get_current_user)]`, a name that carries
 *     that check wherever it is used as a type.
 *
 * The first is decided by what the function does. The second only records what it
 * depends on — whether that dependency checks anything is not this file's business,
 * and it is usually not even this file.
 */
function detectAuthAliases(input: PythonBoundaryInput, findings: BoundaryFinding[]): void {
  for (const { def } of everyDef(input.file)) {
    // A route handler that returns 403 to the wrong user is doing its job, not
    // offering itself as a dependency. Only things other code can depend on count.
    if (def.decorators.some((d) => ROUTE_METHODS.has(d.callee.split('.').pop() ?? ''))) continue;
    // A name that looks like a check is a weak second signal, kept because plenty of
    // guards delegate the actual 401 to a library we never see. Both stay `likely`.
    const rejects = typeof def.rejects === 'number';
    if (!rejects && !GUARD_HINTS.test(def.name)) continue;
    findings.push({
      type: 'auth-checker',
      name: def.name,
      guard: {
        name: def.name,
        how: 'call',
        provider: 'custom',
        path: input.file.path,
        line: rejects ? (def.rejects as number) : def.line,
        confidence: 'likely',
      },
    });
  }

  // Plenty of dependencies are somebody else's: `Depends(fastapi_users.current_user)`
  // has no definition in this repo to read a 401 out of. There the name is all there
  // is, so it is accepted as the weaker signal it is — still only ever `likely`.
  for (const call of input.file.calls ?? []) {
    for (const target of dependsTargets(call)) {
      if (!GUARD_HINTS.test(target)) continue;
      findings.push({
        type: 'auth-checker',
        name: target,
        guard: {
          name: `Depends(${target})`,
          how: 'call',
          provider: 'custom',
          path: input.file.path,
          line: call.line,
          confidence: 'likely',
        },
      });
    }
  }

  for (const alias of input.file.aliases ?? []) {
    findings.push({
      type: 'auth-alias',
      name: alias.name,
      depends: alias.depends.map((name) => name.split('.').pop() ?? name),
      path: input.file.path,
      line: alias.line,
    });
  }

  // A router subclass that bakes a dependency into its constructor is the same idea
  // wearing a class: `class UserAPIRouter(APIRouter)` calling
  // `super().__init__(dependencies=[Depends(get_current_user)])`. Every route file
  // that builds one of these is guarded, and none of them mentions a check.
  for (const def of input.file.defs ?? []) {
    if (def.kind !== 'class' || !(def.bases ?? []).some((base) => isRouterName(base))) continue;
    const depends = (input.file.calls ?? [])
      .filter((call) => (call.scope ?? '').startsWith(`${def.name}.`))
      .flatMap((call) => dependsTargets(call));
    if (depends.length === 0) continue;
    findings.push({ type: 'auth-alias', name: def.name, depends, path: input.file.path, line: def.line });
  }

  // …and the other half: which variable in this file was built out of what.
  const here = modulePath(input.file.path);
  for (const router of input.file.routers ?? []) {
    findings.push({
      type: 'router-build',
      routerName: router.callee.split('.').pop() ?? router.callee,
      varName: router.var,
      path: input.file.path,
      line: router.line,
      hasPrefix: router.hasPrefix ?? false,
      prefix: router.prefix ?? null,
      prefixName: router.prefixName ?? null,
    });
  }

  for (const constant of input.file.constants ?? []) {
    findings.push({
      type: 'path-constant',
      name: constant.name,
      value: constant.value,
      path: input.file.path,
      line: constant.line,
    });
  }

  detectRouterMounts(input, here, findings);
}

/**
 * `api_router.include_router(items.router, prefix="/x")` — one router hung off another.
 *
 * Resolved to a module here rather than in the merge layer because this is the only
 * place that can see the file's own imports: `items` is a name, and which file it names
 * depends on a `from … import …` twenty lines above.
 */
const MOUNT_CALLS = new Set(['include_router', 'register_blueprint', 'mount']);

function detectRouterMounts(input: PythonBoundaryInput, here: string, findings: BoundaryFinding[]): void {
  for (const call of input.file.calls ?? []) {
    const parts = call.callee.split('.');
    const method = parts.pop();
    if (!MOUNT_CALLS.has(method ?? '') || parts.length === 0) continue;
    // `app.mount("/api/v1", app=api)` puts the path first and the thing being mounted
    // second; the router spellings put the router first and name the path.
    const child = method === 'mount' ? (call.args[1] ?? call.kwargs.app) : call.args[0];
    if (!child || child.t !== 'name') continue;

    const segments = child.v.split('.');
    const name = segments.pop() as string;
    // `include_router(items.router)` names a module then a variable inside it;
    // `include_router(router)` names a variable that some import brought in whole.
    const target =
      segments.length > 0
        ? { module: childModulePath(input.file, segments), varName: name }
        : localRouter(input.file, name, here);

    findings.push({
      type: 'router-mount',
      path: input.file.path,
      // `a.b.include_router(...)` is a mount onto `b`; the route decorator that has to
      // match it will have written `b` too.
      hostVar: parts[parts.length - 1],
      childModule: target.module,
      childVar: target.varName,
      overridesPrefix: method === 'register_blueprint',
      ...prefixArgs(call, method === 'mount'),
    });
  }
}

/** A bare `include_router(router)`: either imported from somewhere, or built here. */
function localRouter(file: PyFile, name: string, here: string): { module: string | null; varName: string } {
  const found = importBinding(file, name);
  return found ? { module: found.base, varName: found.exported } : { module: here, varName: name };
}

function prefixArgs(
  call: PyCall,
  positional: boolean,
): { hasPrefix: boolean; prefix: string | null; prefixName: string | null; line: number } {
  const value = positional ? call.args[0] : (call.kwargs.prefix ?? call.kwargs.url_prefix);
  if (!value) return { hasPrefix: false, prefix: null, prefixName: null, line: call.line };
  if (value.t === 'str' && !value.partial) {
    return { hasPrefix: true, prefix: value.v, prefixName: null, line: call.line };
  }
  return { hasPrefix: true, prefix: null, prefixName: value.t === 'name' ? value.v : null, line: call.line };
}

/**
 * `items` in `include_router(items.router)` → `app/api/routes/items`, by way of the
 * `from app.api.routes import items` that introduced the name.
 *
 * Left absolute-ish on purpose: the dotted name in the source is relative to whatever
 * directory the app is started from, which nothing in the repo records. The merge layer
 * matches on the tail, so `app/api/routes/items` still finds
 * `backend/app/api/routes/items.py`.
 */
function childModulePath(file: PyFile, segments: string[]): string | null {
  const [head, ...rest] = segments;
  const found = importBinding(file, head);
  // Here the imported name is itself a module — `from app.api.routes import items`.
  if (found) return found.base === null ? null : [found.base, found.exported, ...rest].filter(Boolean).join('/');

  // `import app.api.routes` binds only `app`, and the expression that follows spells
  // the rest of the module out itself — so the dotted name *is* the path.
  for (const imp of file.imports ?? []) {
    if (imp.level !== 0 || imp.names.length > 0 || imp.alias !== null) continue;
    const declared = imp.module.split('.');
    if (declared[0] === head && declared.every((part, i) => segments[i] === part)) {
      return segments.join('/');
    }
  }
  return null;
}

/**
 * The import that introduced a local name, split into the module it came from and the
 * name that module knows it by.
 *
 * Kept split because `from mealie.routes import router` is genuinely ambiguous — it is
 * either a variable in `mealie/routes/__init__.py` or a `mealie/routes/router.py` — and
 * which one it is depends on how the name is then used.
 */
function importBinding(file: PyFile, local: string): { base: string | null; exported: string } | null {
  for (const imp of file.imports ?? []) {
    if (imp.alias === local && imp.level === 0) {
      const parts = imp.module.split('.');
      return { base: parts.slice(0, -1).join('/'), exported: parts[parts.length - 1] };
    }
    for (const [exported, bound] of imp.names) {
      if (bound === local) return { base: importBase(file.path, imp), exported };
    }
  }
  return null;
}

/** The directory part of an import, with relative dots climbed. */
function importBase(fromPath: string, imp: PyImport): string | null {
  if (imp.level === 0) return imp.module.split('.').join('/');
  // One dot means the file's own package; each extra dot climbs one more. A file that
  // is not an `__init__` is one level below its package to begin with.
  const parts = modulePath(fromPath).split('/');
  const keep = parts.length - (imp.level - 1) - (isPackageInit(fromPath) ? 0 : 1);
  if (keep < 0) return null;
  return [...parts.slice(0, keep), ...(imp.module ? imp.module.split('.') : [])].join('/');
}

function isPackageInit(relPath: string): boolean {
  return /(^|\/)__init__\.pyi?$/.test(relPath);
}

/** A file as another file would import it: no extension, no `__init__`. */
function modulePath(relPath: string): string {
  const withoutExt = relPath.replace(/\.pyi?$/, '');
  return isPackageInit(relPath) ? withoutExt.replace(/\/?__init__$/, '') : withoutExt;
}

function isRouterName(name: string): boolean {
  return /Router$/.test(name.split('.').pop() ?? '');
}

/** The functions a `Depends(...)` anywhere in this call hands off to. */
function dependsTargets(call: PyCall): string[] {
  const out: string[] = [];
  for (const value of [...call.args, ...Object.values(call.kwargs)]) {
    const items = value.t === 'list' ? value.items : [value];
    for (const item of items) {
      const text = item.t === 'name' ? item.v : null;
      const match = text ? /^Depends\((.+)\)$/.exec(text) : null;
      if (match) out.push(match[1].split('.').pop() ?? match[1]);
    }
  }
  if (call.callee.split('.').pop() === 'Depends') {
    for (const arg of call.args) {
      if (arg.t === 'name') out.push(arg.v.split('.').pop() ?? arg.v);
    }
  }
  return out;
}

/** Celery tasks and scheduled jobs: code that runs without anyone knocking. */
function detectTasks(
  input: PythonBoundaryInput,
  has: (name: string) => boolean,
  findings: BoundaryFinding[],
  site: (line: number, snippet?: string) => CodeSite,
): void {
  for (const { def, scope } of everyDef(input.file)) {
    for (const decorator of def.decorators) {
      const last = decorator.callee.split('.').pop() ?? '';
      const isCelery = (last === 'task' || last === 'shared_task') && (has('celery') || has('shared_task'));
      const isRq = last === 'job' && has('rq');
      const isScheduled = last === 'scheduled_job' || last === 'scheduled';
      if (!isCelery && !isRq && !isScheduled) continue;

      findings.push({
        type: 'endpoint',
        endpointKind: isScheduled ? 'cron' : 'queue',
        key: `task ${def.name}`,
        name: def.name,
        method: null,
        route: null,
        framework: isCelery ? 'Celery' : isRq ? 'RQ' : 'scheduler',
        writes: true,
        guards: [],
        site: site(decorator.line, decorator.text),
        handlerId: input.nodeIdForScope(scope),
      });
    }
  }
}

/** Every environment variable the file reads, however it spells the read. */
function detectEnv(
  input: PythonBoundaryInput,
  findings: BoundaryFinding[],
  site: (line: number, snippet?: string) => CodeSite,
): void {
  for (const sub of input.file.subscripts ?? []) {
    if (sub.base === 'os.environ' || sub.base === 'environ') {
      findings.push({ type: 'env', name: sub.key, site: site(sub.line, `os.environ["${sub.key}"]`) });
    }
  }
  for (const call of input.file.calls ?? []) {
    const callee = call.callee;
    const isGet = callee === 'os.getenv' || callee === 'getenv' || callee === 'os.environ.get' || callee === 'environ.get';
    if (!isGet) continue;
    const name = strArg(call.args[0]);
    if (name) findings.push({ type: 'env', name, site: site(call.line, `${callee}("${name}")`) });
  }
}

/** Calls that leave the machine, and the company on the other end when we can tell. */
function detectOutbound(
  input: PythonBoundaryInput,
  modules: Set<string>,
  findings: BoundaryFinding[],
  site: (line: number, snippet?: string) => CodeSite,
): void {
  for (const call of input.file.calls ?? []) {
    const parts = call.callee.split('.');
    const root = parts[0];
    const method = parts[parts.length - 1].toLowerCase();
    const viaClient = HTTP_CLIENTS.has(root) && modules.has(root);
    // `client.post(...)` where the client came out of httpx or requests.
    const viaLocal = /^(client|session|http|s)$/.test(root) && (modules.has('httpx') || modules.has('requests'));
    if (!viaClient && !viaLocal) continue;
    if (!ROUTE_METHODS.has(method) && method !== 'request' && method !== 'send') continue;

    const url = firstUrl(call);
    const host = url ? hostOf(url) : null;
    // No literal URL means no destination to name. `s.get(build_url())` tells us an
    // HTTP call happens and nothing whatever about who answers it, and naming the box
    // after the receiving variable is how `s call` and `session call` ended up on
    // psf/requests' list of outside companies (#25). A blank costs the reader far
    // less than a company that does not exist.
    if (!host || isInternalHost(host)) continue;

    const known = serviceForHost(host);
    findings.push({
      type: 'service',
      name: known?.name ?? host,
      category: known?.category ?? 'other',
      // Evidence, so only the real import — `s` is a local variable, not a package.
      package: viaClient ? root : null,
      host,
      external: true,
      writes: WRITE_METHODS.has(method),
      site: site(call.line, `${call.callee}("${url}")`),
    });
  }
}

function firstUrl(call: PyCall): string | null {
  for (const arg of call.args) {
    const text = strArg(arg);
    if (text && /^https?:\/\//i.test(text)) return text;
  }
  const kw = call.kwargs.url;
  const text = strArg(kw);
  return text && /^https?:\/\//i.test(text) ? text : null;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/** Database work, gated on the project actually depending on the client. */
function detectStores(
  input: PythonBoundaryInput,
  modules: Set<string>,
  findings: BoundaryFinding[],
  site: (line: number, snippet?: string) => CodeSite,
): void {
  let store = null;
  for (const module of modules) {
    const found = storeForPythonModule(module);
    if (found) {
      store = found;
      break;
    }
  }
  if (!store) return;

  for (const call of input.file.calls ?? []) {
    // `session.query(User).limit(n).all()` is one database read written as three
    // chained calls. Only the first link has a plain name; counting the rest would
    // triple every query in the app.
    if (call.callee.includes('()')) continue;

    const parts = call.callee.split('.');
    const method = parts[parts.length - 1];
    const isRead = READ_CALLS.has(method);
    const isWrite = WRITE_CALLS.has(method);
    if (!isRead && !isWrite) continue;
    // A bare `get(...)` or `all(...)` with nothing in front of it is not the database.
    if (parts.length < 2) continue;

    // `User.objects.filter(...)` names its own table; SQLAlchemy names it in the call.
    // Only a class-looking name counts: `session.add(order)` passes a variable, and
    // listing `order` as a table would be a plain lie about the schema.
    const djangoModel = parts.length >= 3 && parts[1] === 'objects' ? parts[0] : null;
    const table = djangoModel ?? nameArg(call.args[0]);

    findings.push({
      type: 'store',
      key: store.client.toLowerCase(),
      name: store.fallbackName,
      client: store.client,
      storeKind: store.storeKind,
      table: table && /^[A-Z][A-Za-z0-9_]*$/.test(table) ? table : null,
      operation: isWrite ? 'write' : 'read',
      site: site(call.line, `${call.callee}(…)`),
    });
  }
}

/** SDKs that are a company by themselves — importing `stripe` is the whole signal. */
function detectServices(
  input: PythonBoundaryInput,
  findings: BoundaryFinding[],
  site: (line: number, snippet?: string) => CodeSite,
): void {
  for (const imp of input.file.imports ?? []) {
    if (imp.level > 0 || !imp.module) continue;
    const known = serviceForPythonModule(imp.module);
    if (!known) continue;
    findings.push({
      type: 'service',
      name: known.name,
      category: known.category,
      package: imp.module.split('.')[0],
      host: null,
      external: true,
      writes: false,
      site: site(imp.line, `import ${imp.module}`),
    });
  }
}

/**
 * Auth that guards a whole file rather than one handler — a Django middleware list, or
 * a router created with dependencies attached. Scope `file` on purpose: attributing it
 * to a single handler would be the mistake M2 spent a milestone avoiding.
 */
function detectGuards(
  input: PythonBoundaryInput,
  findings: BoundaryFinding[],
  site: (line: number, snippet?: string) => CodeSite,
): void {
  for (const call of input.file.calls ?? []) {
    if (call.callee !== 'APIRouter') continue;
    const deps = call.kwargs.dependencies;
    if (!deps || deps.t !== 'list') continue;
    for (const item of deps.items) {
      const text = item.t === 'name' ? item.v : null;
      if (text && /depends/i.test(text)) {
        findings.push({
          type: 'guard',
          guard: {
            name: text,
            how: 'call',
            provider: 'custom',
            path: input.file.path,
            line: call.line,
            confidence: 'likely',
          },
          scope: 'file',
          nodeId: null,
          matchers: [],
          sourceId: input.fileId,
        });
      }
    }
  }
}

/** A command-line entry point is a way into the app too. */
function detectCli(
  input: PythonBoundaryInput,
  has: (name: string) => boolean,
  findings: BoundaryFinding[],
  site: (line: number, snippet?: string) => CodeSite,
): void {
  for (const call of input.file.calls ?? []) {
    const last = call.callee.split('.').pop() ?? '';
    const isArgparse = call.callee === 'argparse.ArgumentParser' || call.callee === 'ArgumentParser';
    const isClick = (last === 'command' || last === 'group') && has('click');
    const isTyper = call.callee === 'typer.Typer' || call.callee === 'Typer';
    if (!isArgparse && !isClick && !isTyper) continue;

    findings.push({
      type: 'endpoint',
      endpointKind: 'cli',
      key: `cli ${input.file.path}`,
      name: input.file.path,
      method: null,
      route: null,
      framework: isArgparse ? 'argparse' : isClick ? 'Click' : 'Typer',
      writes: false,
      guards: [],
      site: site(call.line),
      handlerId: null,
    });
    return;
  }

  // No argument parser, but `if __name__ == "__main__":` still says this file is meant
  // to be run rather than imported. It is the oldest and commonest way a Python script
  // declares itself, and the only one a script that prompts for its input will have —
  // without it, a folder of runnable scripts reads as a library nobody imports.
  if (typeof input.file.main === 'number') {
    findings.push({
      type: 'endpoint',
      endpointKind: 'cli',
      key: `cli ${input.file.path}`,
      name: input.file.path,
      method: null,
      route: null,
      framework: '__main__',
      writes: false,
      guards: [],
      site: site(input.file.main),
      handlerId: null,
    });
  }
}
