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
import type { CodeSite, GuardInfo, StoreKind } from '../../model/types.js';
import type { StoreDef } from '../boundaries/catalog.js';
import {
  engineForDatabaseUrl,
  isInternalHost,
  serviceForHost,
  serviceForPythonModule,
  storeForPythonModule,
} from '../boundaries/catalog.js';
import type { SqlStatement } from '../sql.js';
import { readSqlStatement } from '../sql.js';
import { appendAll } from '../../util/append.js';
import type { BoundaryFinding } from '../boundaries/types.js';
import type { PyBinding, PyCall, PyDef, PyFile, PyImport, PyValue } from './types.js';

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
  if (has('django')) detectDjangoRoutes(input, findings, site);
  if (modules.has('rest_framework')) detectDrfRouters(input, findings, site);
  detectTasks(input, has, findings, site);
  detectEnv(input, findings, site);
  detectOutbound(input, modules, findings, site);
  detectStores(input, modules, has, findings, site);
  detectServices(input, findings, site);
  detectGuards(input, findings);
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

/**
 * The first argument of a decorator, exactly as it was written (#142).
 *
 * Read off `decorator.text` rather than off the parsed value, because the parse throws
 * away the part a reader needs. `org_scoped_rule("/login")` reduces to the value
 * `org_scoped_rule()` — correct for a *callee*, and useless as a label, since the whole
 * of what distinguishes this route from the twenty-two beside it is the string inside
 * the parentheses.
 *
 * Returns null when there is no argument at all, which is what keeps `@property` and
 * every other bare decorator out.
 */
function writtenFirstArg(text: string | undefined): string | null {
  if (!text) return null;
  const open = text.indexOf('(');
  if (open < 0) return null;

  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
      // The decorator's own closing bracket: one argument, and this is the end of it.
      if (depth === 0) return trimmedArg(text.slice(open + 1, i));
    } else if (ch === ',' && depth === 1) {
      return trimmedArg(text.slice(open + 1, i));
    }
  }
  return null;
}

function trimmedArg(raw: string): string | null {
  const arg = raw.trim();
  // A keyword argument is not the path — `@app.route(methods=["GET"])` has no address.
  if (arg === '' || /^[A-Za-z_][A-Za-z0-9_]*\s*=/.test(arg)) return null;
  return arg;
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
      // A path the source computes — `@routes.route(org_scoped_rule("/login"))`. The
      // address is genuinely unknowable from here and guessing one would be worse, but
      // dropping the door is not the neutral choice it looks like: it says this handler
      // answers no URL, which is false. redash writes 23 of its 28 route decorators this
      // way, and `/login`, `/forgot` and `/reset/<token>` were all absent while the
      // summary said `4 of 5 routes` in the type it uses when the denominator is right
      // (#142). Same trade the sqlx reader already makes: a call whose SQL is built
      // elsewhere still proves the database is used, and only the arrow is missing.
      const computed = route === null ? writtenFirstArg(decorator.text) : null;
      if (route === null && computed === null) continue;

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
          // Always a route here. Whether it is really a webhook is decided once, in the
          // merge, on the address after its prefixes are composed — a handler spelled
          // `@router.post("/")` under `prefix="/webhooks"` cannot know its own name.
          endpointKind: 'http-route',
          // The expression as the author wrote it when there is no literal to show. Not
          // a URL and not pretending to be one: `POST org_scoped_rule('/login')` sits
          // where the address goes and a reader recognises their own line in it. The
          // alternative — reconstructing `/login` from inside the call — would be
          // inventing an address, since the helper is a prefix and the real path is not
          // the one in the parentheses.
          //
          // For a literal, the key IS the address, so `GET /health` in two files is one
          // door — that merge is the point. For a computed one, identical text is not an
          // identical address: two blueprints with different url_prefixes both write
          // `make_rule("/list")`, and merging them put one file's login_required on the
          // other's open route (#160). The file and the callee — which carries the
          // blueprint variable — are the identity the text alone doesn't have.
          key: route !== null ? `${method} ${route}` : `${method} ${input.file.path}#${decorator.callee}(${computed})`,
          name: `${method} ${route ?? computed}`,
          method,
          // Null, because nothing downstream may treat this as an address it can match
          // a prefix or a webhook pattern against.
          route,
          framework,
          writes: method !== 'GET' && method !== 'HEAD',
          guards: guardsFor(def, input.file.path),
          site: site(decorator.line, decorator.text),
          handlerId: input.nodeIdForScope(scope),
          // The signature is where FastAPI declares a route's dependencies, and an
          // alias imported from `deps.py` is unresolvable from here.
          //
          // …and so is the decorator, which was read by nothing until #136. A handler
          // that never touches the user object takes no `CurrentUser` parameter, so
          // `dependencies=[Depends(get_current_active_superuser)]` is the only place its
          // lock is written down — the spelling FastAPI's own template uses for every
          // administrator-only route, and five of them read as doors nobody checks.
          // Both halves go into the same list because whether a dependency is a *check*
          // is decided once, in build.ts, against the checkers the project defines.
          paramTypes: [...paramTypeNames(def), ...decoratorDepends(decorator)],
          routerVar: parts.length > 1 ? parts[0] : null,
          // `AdminBackupController.get_all` — the class is where a class-based view
          // keeps the dependencies it injects into every route on it.
          handlerOwner: def.owner ?? null,
        });
      }
    }
  }

}

/**
 * Django keeps its routes in a list rather than on the handler.
 *
 * Its own function, and called unconditionally, because for two releases this lived at
 * the bottom of `detectRoutes` — below the `if (!framework) return` that picks between
 * FastAPI, Flask, Quart and Sanic. A Django `urls.py` imports `django.urls` and none of
 * those, so the gate returned first and this was unreachable: netbox-community/netbox,
 * 1,266 files and several hundred routes, mapped as twelve ways in and not one of them
 * HTTP (#139). Adding `import flask` to a `urls.py` made every route appear, which is
 * how the gate was identified as the cause rather than the reader.
 *
 * The gate that belongs here is the manifest, not the file's imports: `path()` inside a
 * file named `urls.py` is already specific enough that only Django's presence needs
 * confirming.
 */
function detectDjangoRoutes(
  input: PythonBoundaryInput,
  findings: BoundaryFinding[],
  site: (line: number, snippet?: string) => CodeSite,
): void {
  if (!/(^|\/)urls\.py$/.test(input.file.path)) return;

  for (const call of input.file.calls ?? []) {
    if (call.callee !== 'path' && call.callee !== 're_path' && call.callee !== 'url') continue;
    const route = strArg(call.args[0]);
    if (route === null) continue;
    const view = nameArg(call.args[1]);
    // `path('providers/', include(...))` mounts another URLconf: a prefix, not an
    // endpoint. netbox writes 290 of its 377 `path()` calls this way, so counting them
    // would trade an undercount for an overcount — and every one of those prefixes
    // would be a door with no handler and therefore no visible auth.
    if (view !== null && /^include\(/.test(view)) continue;
    // `re_path(r'^legacy/widgets/$', …)` serves `/legacy/widgets/`. The anchors are
    // regex punctuation, not part of the address, and leaving them in prints a URL
    // nobody can visit. Only the anchors come off: the rest of the pattern is left
    // exactly as written, because a capture group is a real part of the route and
    // rewriting it into something prettier would be inventing an address.
    const pattern = call.callee === 'path' ? route : route.replace(/^\^/, '').replace(/\$$/, '');
    const shown = `/${pattern}`.replace(/\/+/g, '/');
    findings.push({
      type: 'endpoint',
      endpointKind: 'http-route',
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
      // The view lives in another file and this reader does not follow it there yet, so
      // whatever guards it is invisible from `urls.py`. Say that, rather than counting
      // it as a door nobody checks — see EndpointMeta.handlerUnlinked.
      handlerUnlinked: true,
    });
  }
}

/**
 * A DRF router's register() table, which is the whole API (#170).
 *
 * `api_router.register(r"documents", DocumentViewSet)` is Django REST Framework's way
 * of declaring an entire REST resource — and paperless-ngx writes twenty of them in
 * `urls.py`, spliced into the URL tree as `*api_router.urls`, covering documents,
 * tags, saved views and tasks. Every one produced zero doors, so the map said "83
 * ways in" about the application while missing its primary surface completely. Same
 * registration-table shape #142 noted in redash's Flask-RESTful `add_org_resource`,
 * in the ecosystem's most canonical spelling.
 *
 * What is claimed is the under-claiming floor: ONE door per registration, method
 * unknown. DRF derives list/detail/extra-action URLs from the class body — a
 * ReadOnlyModelViewSet has no POST — so claiming the generated set without reading
 * the class would invent doors. The mount prefix lives wherever the router's urls
 * were spliced, usually another expression entirely, so the address wears #153's
 * ellipsis and `route` stays null. The ViewSet's name is the way back to the code
 * and travels as handlerOwner, so a class-level check the owner chain can read
 * still reaches the door.
 *
 * Gated on the file importing rest_framework, so somebody's own `.register(...)`
 * in an unrelated codebase proves nothing. The first argument must be a string:
 * `admin.site.register(Document)` registers a model, not a route, and has no
 * prefix to read.
 */
function detectDrfRouters(
  input: PythonBoundaryInput,
  findings: BoundaryFinding[],
  site: (line: number, snippet?: string) => CodeSite,
): void {
  for (const call of input.file.calls ?? []) {
    if (!call.callee.endsWith('.register')) continue;
    const prefix = strArg(call.args[0]);
    if (prefix === null) continue;
    const view = nameArg(call.args[1]);
    if (view === null) continue;
    const shown = `/${prefix}`.replace(/\/+/g, '/');
    findings.push({
      type: 'endpoint',
      endpointKind: 'http-route',
      key: `ANY ${input.file.path}#${call.callee}(${prefix})`,
      name: `…${shown} (${view})`,
      // The ViewSet decides which verbs exist, so claiming one would be a guess.
      method: null,
      route: null,
      framework: 'Django REST Framework',
      writes: false,
      guards: [],
      site: site(call.line, `${call.callee}("${prefix}", ${view})`),
      handlerId: null,
      handlerOwner: view.split('.').pop() ?? view,
      handlerUnlinked: true,
    });
  }
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

/**
 * The `Depends(...)` targets written on the route decorator itself (#136).
 *
 * `@router.get("/", dependencies=[Depends(get_current_active_superuser)])` is how
 * FastAPI guards a route whose handler has no use for the user object, and it is the
 * only place that lock appears — the signature has nothing in it to find. Reusing
 * `dependsTargets` rather than re-reading the list keeps this the same idea as the one
 * already applied to `APIRouter(...)` and `include_router(...)`.
 */
function decoratorDepends(decorator: PyCall): string[] {
  const listed = decorator.kwargs.dependencies;
  if (!listed) return [];
  return dependsTargets({ ...decorator, args: [listed], kwargs: {} });
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

  // A class is named by what it is, and the rejection is inside a method — so nothing
  // the caller writes (`add_middleware(AuthMiddleware)`, `Depends(AdminOnly())`) can be
  // matched against the method that does the work. Only the two methods that *are* the
  // contract count: `dispatch` for a Starlette middleware, `__call__` for a raw ASGI
  // one or a dependency class. A service class with a method that happens to raise 403
  // is not offering itself as a lock, and treating it as one would put a check on every
  // handler that takes it as an argument.
  for (const def of input.file.defs ?? []) {
    if (def.kind !== 'class') continue;
    const contract = (def.methods ?? []).find(
      (method) => (method.name === 'dispatch' || method.name === '__call__') && typeof method.rejects === 'number',
    );
    if (!contract) continue;
    findings.push({
      type: 'auth-checker',
      name: def.name,
      guard: {
        name: def.name,
        how: 'middleware',
        provider: 'custom',
        path: input.file.path,
        line: contract.rejects as number,
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

  // The same idea wearing a class, twice over.
  //
  // A router subclass bakes the dependency into its constructor:
  // `class UserAPIRouter(APIRouter)` calling `super().__init__(dependencies=[…])`.
  // A class-based view puts it on the class the handlers are methods of:
  // `class BaseUserController: user: PrivateUser = Depends(get_current_user)`, and the
  // controller that inherits it three levels down declares routes that mention nobody.
  //
  // A class with no dependency of its own is still recorded — with parents because it
  // is a link in the chain (`class Reporting(SignedIn): ...` carries nothing and
  // decides everything), and without them because its *declaration* is the fact that
  // protects its namesakes. The merge trusts a name only while exactly one class
  // declares it, and a guardless class that stayed silent made its guarded namesake in
  // another file look unique — which lent that lock to doors it was never written on
  // (#162).
  for (const def of input.file.defs ?? []) {
    if (def.kind !== 'class') continue;
    const bases = (def.bases ?? []).map((base) => base.split('.').pop() ?? base).filter(Boolean);
    const depends = (def.depends ?? []).map((name) => name.split('.').pop() ?? name);
    findings.push({ type: 'auth-alias', name: def.name, depends, bases, path: input.file.path, line: def.line });
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
      // `APIRouter(dependencies=[Depends(get_current_user)])`. The router build and the
      // call that made it are the same line of source, reported twice because one pass
      // reads assignments and the other reads calls.
      dependencies: dependsOnLine(input.file, router.line),
    });
  }

  for (const constant of input.file.constants ?? []) {
    // The extractor collects addresses of both kinds — route prefixes and whole URLs
    // (#89). A prefix is the one that starts with a slash; `https://updates.example/…`
    // is somewhere else's address and would only collide with a real one here.
    if (!constant.value.startsWith('/')) continue;
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
      // The check written on the mount rather than on the router:
      // `api_router.include_router(everything_else, dependencies=[Depends(get_current_user)])`.
      // One line, and the only record that a hundred and sixty routes are locked.
      dependencies: dependsTargets(call),
      ...prefixArgs(call, method === 'mount'),
    });
  }
}

/** The `Depends(...)` targets of whichever call was written on this line. */
function dependsOnLine(file: PyFile, line: number): string[] {
  const out: string[] = [];
  for (const call of file.calls ?? []) {
    if (call.line === line) appendAll(out, dependsTargets(call));
  }
  return out;
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
  // `FEED = "https://…"` at the top of the file, `requests.get(FEED)` further down —
  // the same fact written the way people write it (#89). Same file only: Python's
  // detectors read one file at a time and there is no import graph here to follow a
  // constant across, so a URL defined in `config.py` and used in `client.py` is still
  // missed. Said plainly rather than papered over.
  const constants = new Map<string, string>();
  for (const constant of input.file.constants ?? []) {
    if (/^https?:\/\//i.test(constant.value)) constants.set(constant.name, constant.value);
  }

  for (const call of input.file.calls ?? []) {
    const parts = call.callee.split('.');
    const root = parts[0];
    const method = parts[parts.length - 1].toLowerCase();
    const viaClient = HTTP_CLIENTS.has(root) && modules.has(root);
    // `client.post(...)` where the client came out of httpx or requests.
    const viaLocal = /^(client|session|http|s)$/.test(root) && (modules.has('httpx') || modules.has('requests'));
    if (!viaClient && !viaLocal) continue;
    if (!ROUTE_METHODS.has(method) && method !== 'request' && method !== 'send') continue;

    const url = firstUrl(call, constants);
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

function firstUrl(call: PyCall, constants: Map<string, string>): string | null {
  const resolve = (value: PyValue | undefined): string | null => {
    const text = strArg(value);
    if (text && /^https?:\/\//i.test(text)) return text;
    // A bare name, resolved against the constants this file declares. Nothing is
    // inferred from the name itself — an unknown one gives back null, exactly as
    // before, which is what keeps `s.get(build_url())` from naming a company.
    const named = nameArg(value);
    return named ? (constants.get(named) ?? null) : null;
  };

  for (const arg of call.args) {
    const url = resolve(arg);
    if (url) return url;
  }
  return resolve(call.kwargs.url);
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/**
 * Where a Python project's data lives: databases, data files, and the disk.
 *
 * Three readings, strongest first. A database call is the strongest because the SQL or
 * the client names itself; a `pd.read_csv` is next because the call says the format out
 * loud; a bare `open()` is last because it says only that a file was touched. A line
 * already read by a stronger rule is not read again — `pd.read_csv(open(path))` is one
 * dataset being loaded, not a dataset and a file.
 */
function detectStores(
  input: PythonBoundaryInput,
  modules: Set<string>,
  has: (name: string) => boolean,
  findings: BoundaryFinding[],
  site: (line: number, snippet?: string) => CodeSite,
): void {
  const claimed = new Set<number>();
  for (const line of detectDatabases(input, modules, findings, site)) claimed.add(line);
  for (const line of detectDataFiles(input, modules, has, findings, site, claimed)) claimed.add(line);
  detectFiles(input, findings, site, claimed);
}

/** A store as the finding wants it, before a site is attached. */
interface StoreTarget {
  key: string;
  name: string;
  client: string;
  storeKind: StoreKind;
  generic?: boolean;
}

function targetFor(def: StoreDef, name?: string): StoreTarget {
  return { key: def.client.toLowerCase(), name: name ?? def.fallbackName, client: def.client, storeKind: def.storeKind };
}

/** A database we can prove was used but cannot name. Folded into the real one at merge. */
const UNNAMED_SQL: StoreTarget = { key: 'sql', name: 'Database', client: 'SQL', storeKind: 'sql', generic: true };

/**
 * Receivers that are conventionally a database handle.
 *
 * The point of the list is what it leaves out. `get` and `all` are ordinary English and
 * ordinary method names, so "a call whose method is `get`" describes `os.environ.get`
 * as exactly as it describes `session.get` — and one repo's MySQL box ended up citing
 * eleven environment lines and not one line of database code. The conclusion was right
 * and every piece of evidence for it was wrong, which is the failure a reader catches
 * first and forgives last. On one FastAPI app the same rule counted `form_data.get`,
 * `payload.get` and — the one that gives the game away — `router.get`, the decorator
 * that declares an HTTP route.
 *
 * Matched a word at a time, because `db_session` is a session and `form_data` is not.
 */
const DB_RECEIVERS = /(^|_)(session|sess|db|database|conn|connection|cursor|cur|engine|collection|objects|query|pool|redis|cache|kv|tx|txn)(_|$)/i;

/** Calls that hand back something you then run queries on. */
const HANDLE_CALLS = /^(connect|connection|cursor|session|Session|begin|client|Client|collection|get_collection|database|get_database|create_engine|create_async_engine|sessionmaker|scoped_session|async_sessionmaker|MongoClient|AsyncIOMotorClient|Redis|StrictRedis|from_url|ConnectionPool|create_pool)$/;

/** Opening a connection is not a read or a write; it is the database being declared. */
const CONNECTION_CALLS = /^(connect|create_engine|create_async_engine|MongoClient|AsyncIOMotorClient|Redis|StrictRedis|from_url|create_pool|ConnectionPool)$/;

/**
 * asyncpg's `conn.fetchrow(sql)`, which carries its own query.
 *
 * DB-API's `fetchone`/`fetchall` are deliberately absent: they always follow an
 * `execute`, so counting them would report every query in the repo twice.
 */
const FETCH_CALLS = new Set(['fetchval', 'fetchrow']);

/** Redis verbs, used only once the store is already known to be a key–value one. */
const KV_READS = new Set(['get', 'mget', 'hget', 'hgetall', 'hmget', 'exists', 'ttl', 'keys', 'scan', 'smembers', 'lrange', 'llen', 'zrange']);
const KV_WRITES = new Set(['set', 'mset', 'setex', 'setnx', 'hset', 'hmset', 'expire', 'incr', 'incrby', 'decr', 'sadd', 'srem', 'lpush', 'rpush', 'zadd', 'flushall', 'flushdb']);

function detectDatabases(
  input: PythonBoundaryInput,
  modules: Set<string>,
  findings: BoundaryFinding[],
  site: (line: number, snippet?: string) => CodeSite,
): number[] {
  const aliases = moduleAliases(input.file.imports ?? []);
  const handles = storeHandles(input, aliases, findings, site);
  const only = onlyStoreInFile(modules);
  const lines: number[] = [];

  const built = statementsBuiltHere(input.file.bindings ?? []);

  const resolve = (parts: string[]): StoreTarget | null => {
    const direct = handles.get(parts[0]);
    if (direct) return direct;
    // Either end of the chain will do: `db.users.update(...)` is held by its root and
    // `self.db_session.add(...)` by the segment before the verb.
    const named = DB_RECEIVERS.test(parts[0]) || (parts.length >= 2 && DB_RECEIVERS.test(parts[parts.length - 2]));
    // One client in the file makes a conventional receiver unambiguous. Two make it a
    // coin toss, and the answer would be a real database with another's name on it.
    return only && named ? only : null;
  };

  for (const call of input.file.calls ?? []) {
    // `session.query(User).limit(n).all()` is one database read written as three
    // chained calls. Only the first link has a plain name; counting the rest would
    // triple every query in the app.
    if (call.callee.includes('()')) continue;
    const parts = call.callee.split('.');
    const method = parts[parts.length - 1];
    if (parts.length < 2) continue;

    if (method === 'execute' || method === 'executemany') {
      const statement = literalSql(call.args[0]);
      const store = resolve(parts);
      // A literal `SELECT` handed to `.execute()` is a database read whoever opened the
      // connection. Scripts reach theirs through the project's own helper module, so
      // requiring the import here would lose every query in the repo that has one.
      if (!statement && !store) continue;
      findings.push({
        type: 'store',
        ...(store ?? UNNAMED_SQL),
        table: statement?.table ?? null,
        // The query built somewhere else: the call is evidence, the direction is not.
        operation: statement?.operation ?? constructed(call.args[0], built),
        site: site(call.line, callSnippet(call)),
      });
      lines.push(call.line);
      continue;
    }

    // `pd.read_sql(query, conn)` and `df.to_sql("orders", engine)` are pandas calls that
    // land in a database rather than a file.
    if (method === 'read_sql' || method === 'read_sql_query' || method === 'read_sql_table' || method === 'to_sql') {
      const writes = method === 'to_sql';
      const connection = nameArg(call.args[1]);
      const store = (connection ? handles.get(connection) : null) ?? only ?? UNNAMED_SQL;
      findings.push({
        type: 'store',
        ...store,
        table: writes ? strArg(call.args[0]) : (literalSql(call.args[0])?.table ?? null),
        operation: writes ? 'write' : 'read',
        site: site(call.line, callSnippet(call)),
      });
      lines.push(call.line);
      continue;
    }

    const store = resolve(parts);
    if (!store) continue;

    const kv = store.storeKind === 'kv';
    const isRead = READ_CALLS.has(method) || FETCH_CALLS.has(method) || (kv && KV_READS.has(method));
    const isWrite = WRITE_CALLS.has(method) || (kv && KV_WRITES.has(method));
    if (!isRead && !isWrite) continue;

    // `User.objects.filter(...)` names its own table; SQLAlchemy names it in the call.
    // Only a class-looking name counts: `session.add(order)` passes a variable, and
    // listing `order` as a table would be a plain lie about the schema.
    const objects = parts.indexOf('objects');
    const djangoModel = objects > 0 ? parts[objects - 1] : null;
    const table = djangoModel ?? nameArg(call.args[0]);

    findings.push({
      type: 'store',
      ...store,
      table: table && /^[A-Z][A-Za-z0-9_]*$/.test(table) ? table : null,
      operation: isWrite ? 'write' : 'read',
      site: site(call.line, callSnippet(call)),
    });
    lines.push(call.line);
  }

  return lines;
}

/**
 * Every local name bound to a database handle, and the connections that opened them.
 *
 * Two passes so `cur = conn.cursor()` finds the `conn = pymysql.connect(...)` above it
 * whichever order the file happens to declare them in.
 */
function storeHandles(
  input: PythonBoundaryInput,
  aliases: Map<string, string>,
  findings: BoundaryFinding[],
  site: (line: number, snippet?: string) => CodeSite,
): Map<string, StoreTarget> {
  const handles = new Map<string, StoreTarget>();
  const bindings = input.file.bindings ?? [];
  const declared = new Set<number>();

  for (let pass = 0; pass < 3; pass++) {
    let added = false;
    for (const binding of bindings) {
      if (handles.has(binding.name)) continue;
      const parts = binding.callee.split('.');
      const last = parts[parts.length - 1];
      if (!HANDLE_CALLS.test(last)) continue;

      const inherited = handles.get(parts[0]);
      const module = aliases.get(parts[0]) ?? parts[0];
      const def = storeForPythonModule(module);
      const target = inherited ?? (def ? targetFor(def, engineName(binding, def)) : null);
      if (!target) continue;

      handles.set(binding.name, target);
      added = true;

      // The connection itself. `sqlite3.connect("app.db")` may be the only line in the
      // repo that says which database this is, and a store with no read and no write is
      // still a truer answer than no store at all — the same reading a Worker binding
      // gets from `wrangler.toml`.
      if (!inherited && CONNECTION_CALLS.test(last) && !declared.has(binding.line)) {
        declared.add(binding.line);
        findings.push({
          type: 'store',
          ...target,
          table: null,
          operation: null,
          site: site(binding.line, `${binding.callee}(${openedWith(binding)})`),
        });
      }
    }
    if (!added) break;
  }

  return handles;
}

/**
 * The engine behind a SQLAlchemy connection, read from its URL.
 *
 * SQLAlchemy is the same import whichever database is underneath, so `create_engine`'s
 * first argument is the only place the answer is written down.
 */
function engineName(binding: PyBinding, def: StoreDef): string | undefined {
  if (def.client !== 'SQLAlchemy' || !binding.arg) return undefined;
  return engineForDatabaseUrl(binding.arg) ?? undefined;
}

/**
 * What to show inside a connection call.
 *
 * A path is worth showing — it names the database file. A URL is not: a connection
 * string carries the password, and the atlas is a file people share.
 */
function openedWith(binding: PyBinding): string {
  const arg = binding.arg;
  if (!arg || /:\/\//.test(arg)) return '…';
  return `"${arg}"`;
}

/** The one store client this file imports, or nothing when it imports several. */
function onlyStoreInFile(modules: Set<string>): StoreTarget | null {
  const found = new Map<string, StoreDef>();
  for (const module of modules) {
    const def = storeForPythonModule(module);
    if (def) found.set(def.client, def);
  }
  if (found.size !== 1) return null;
  return targetFor([...found.values()][0]);
}

/** Local name → the module it came from, for both `import x as y` and `from x import y`. */
function moduleAliases(imports: PyImport[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const imp of imports) {
    if (imp.level > 0 || !imp.module) continue;
    if (imp.alias) out.set(imp.alias, imp.module);
    else if (imp.names.length === 0) out.set(imp.module.split('.')[0], imp.module);
    for (const [, local] of imp.names) out.set(local, imp.module);
  }
  return out;
}

/** SQLAlchemy 2.0 builds a statement before running it, and the builder names the verb. */
const STATEMENT_BUILDERS: Record<string, 'read' | 'write'> = {
  select: 'read',
  insert: 'write',
  update: 'write',
  delete: 'write',
};

/**
 * Which way `session.execute(stmt)` moved the data, when the query is not a string.
 *
 * Modern SQLAlchemy writes `select(User)` rather than `"SELECT …"`, so the verb is a
 * function name — either inside the call, or one line up where `stmt = select(User)`
 * bound it to a name.
 */
function constructed(value: PyValue | undefined, built: Map<string, 'read' | 'write'>): 'read' | 'write' | null {
  if (!value || value.t !== 'name') return null;
  return builderVerb(value.v) ?? built.get(value.v) ?? null;
}

function statementsBuiltHere(bindings: PyBinding[]): Map<string, 'read' | 'write'> {
  const out = new Map<string, 'read' | 'write'>();
  for (const binding of bindings) {
    const direction = builderVerb(binding.callee);
    if (direction) out.set(binding.name, direction);
  }
  return out;
}

/**
 * The verb in `select`, `sa.select()` or `select().where` alike.
 *
 * A statement is almost always refined before it is run, and a call in the middle of a
 * chain flattens to `select()` — so the trailing parentheses are the normal case here,
 * not the exception.
 */
function builderVerb(callee: string): 'read' | 'write' | undefined {
  const bare = callee.endsWith('()') ? callee.slice(0, -2) : callee;
  return STATEMENT_BUILDERS[bare.split('.').pop() ?? ''];
}

/** A query we can read, from an argument that is a string. An f-string counts too. */
function literalSql(value: PyValue | undefined): SqlStatement | null {
  if (!value || value.t !== 'str') return null;
  return readSqlStatement(value.v, !value.partial);
}

// ---------------------------------------------------------------------------
// Data files
// ---------------------------------------------------------------------------

/**
 * File formats a library names in its own API, and the box each one becomes.
 *
 * The format comes from the call, never from the path: `open(out_path, "w")` and
 * `open("report.json", "w")` are the same code written two ways, and splitting them
 * into two boxes would let an inlined string decide what a reader sees.
 */
const FILE_FORMATS: Record<string, { key: string; name: string }> = {
  csv: { key: 'csv-files', name: 'CSV files' },
  excel: { key: 'excel-files', name: 'Excel files' },
  parquet: { key: 'parquet-files', name: 'Parquet files' },
  feather: { key: 'feather-files', name: 'Feather files' },
  json: { key: 'json-files', name: 'JSON files' },
  hdf: { key: 'hdf-files', name: 'HDF5 files' },
  pickle: { key: 'pickle-files', name: 'Saved Python objects' },
  numpy: { key: 'numpy-files', name: 'NumPy array files' },
};

/** pandas and polars: `pd.read_csv`, `df.to_parquet`, `df.write_csv`. */
const FRAME_IO = /^(read|to|write)_(csv|excel|parquet|feather|json|hdf|pickle)$/;

/** NumPy's file API, and the two libraries whose whole job is writing an object out. */
const ARRAY_IO: Record<string, { format: string; operation: 'read' | 'write' }> = {
  save: { format: 'numpy', operation: 'write' },
  savez: { format: 'numpy', operation: 'write' },
  savez_compressed: { format: 'numpy', operation: 'write' },
  savetxt: { format: 'numpy', operation: 'write' },
  load: { format: 'numpy', operation: 'read' },
  loadtxt: { format: 'numpy', operation: 'read' },
  genfromtxt: { format: 'numpy', operation: 'read' },
};

function detectDataFiles(
  input: PythonBoundaryInput,
  modules: Set<string>,
  has: (name: string) => boolean,
  findings: BoundaryFinding[],
  site: (line: number, snippet?: string) => CodeSite,
  claimed: Set<number>,
): number[] {
  const frames = has('pandas') || has('polars');
  const aliases = moduleAliases(input.file.imports ?? []);
  const lines: number[] = [];

  for (const call of input.file.calls ?? []) {
    if (claimed.has(call.line)) continue;
    const method = call.method ?? call.callee.split('.').pop() ?? '';
    const root = call.callee.split('.')[0];
    const module = aliases.get(root) ?? root;

    let format: string | null = null;
    let operation: 'read' | 'write' = 'read';
    let client = '';

    const frame = frames ? FRAME_IO.exec(method) : null;
    if (frame) {
      // `df.to_csv(path)` hangs off a DataFrame, whose name tells us nothing, so the
      // dependency is the whole gate here.
      format = frame[2];
      operation = frame[1] === 'read' ? 'read' : 'write';
      client = module === 'polars' || has('polars') ? 'polars' : 'pandas';
    } else if (module === 'numpy' && ARRAY_IO[method]) {
      format = ARRAY_IO[method].format;
      operation = ARRAY_IO[method].operation;
      client = 'NumPy';
    } else if ((module === 'joblib' || module === 'torch' || module === 'pickle') && (method === 'dump' || method === 'load')) {
      // `pickle.dump(obj, f)` is handed an already-open file, so the `open` beside it is
      // the site; `joblib.dump(obj, "model.pkl")` names the path itself and is the site.
      if (module === 'pickle') continue;
      format = 'pickle';
      operation = method === 'dump' ? 'write' : 'read';
      client = module === 'torch' ? 'PyTorch' : 'joblib';
    }

    if (!format) continue;
    const shape = FILE_FORMATS[format];
    if (!shape) continue;

    findings.push({
      type: 'store',
      key: shape.key,
      name: shape.name,
      client,
      storeKind: 'filesystem',
      table: null,
      operation,
      site: site(call.line, callSnippet(call)),
    });
    lines.push(call.line);
  }

  return lines;
}

// ---------------------------------------------------------------------------
// Plain files
// ---------------------------------------------------------------------------

/** pathlib's whole-file API — names distinctive enough to stand on their own. */
const PATH_IO: Record<string, 'read' | 'write'> = {
  read_text: 'read',
  read_bytes: 'read',
  write_text: 'write',
  write_bytes: 'write',
};

/**
 * `open(path, "w")` and `Path(path).read_text()`.
 *
 * No dependency gates this one, the same way browser storage gates nothing on the
 * TypeScript side: an app whose data is a folder of files is still an app with data,
 * and for a repo of scripts it is the entire story.
 */
function detectFiles(
  input: PythonBoundaryInput,
  findings: BoundaryFinding[],
  site: (line: number, snippet?: string) => CodeSite,
  claimed: Set<number>,
): void {
  for (const call of input.file.calls ?? []) {
    if (claimed.has(call.line)) continue;
    const method = call.method ?? '';
    const builtin = call.callee === 'open';
    const viaPath = call.callee === 'Path()' || call.callee.endsWith('.Path()');

    let operation: 'read' | 'write' | null = null;
    if (builtin) operation = writesTo(strArg(call.args[1]) ?? strArg(call.kwargs.mode));
    else if (PATH_IO[method]) operation = PATH_IO[method];
    else if (method === 'open' && (viaPath || opensAFile(call))) {
      // `Path.open` puts the mode first, where the builtin puts the path.
      operation = writesTo(strArg(call.args[0]) ?? strArg(call.kwargs.mode));
    }
    if (!operation) continue;

    findings.push({
      type: 'store',
      key: 'filesystem',
      name: 'Files on disk',
      client: 'Python',
      storeKind: 'filesystem',
      table: null,
      operation,
      site: site(call.line, callSnippet(call)),
    });
  }
}

/** `open(p)` is a read; anything with `w`, `a`, `x` or `+` in its mode is a write. */
function writesTo(mode: string | null): 'read' | 'write' {
  return mode && /[wax+]/.test(mode) ? 'write' : 'read';
}

/** A file mode as Python spells one: `r`, `wb`, `a+`, `rt`. */
const FILE_MODE = /^(?=[rwxabt+]*[rwxa])[rwxabt+]{1,3}$/;

/**
 * Whether `something.open(...)` is a file being opened.
 *
 * The receiver's name is no help — a `Path`, a `ZipFile` and a `webbrowser` all spell
 * it `open`, and only one of them is holding a file. The call's own shape decides it:
 * a mode string or an `encoding=` is the file signature, and `webbrowser.open(url)` has
 * neither.
 */
function opensAFile(call: PyCall): boolean {
  if (call.kwargs.encoding || call.kwargs.mode) return true;
  const first = strArg(call.args[0]);
  return first !== null && FILE_MODE.test(first);
}

/**
 * The call as evidence: every argument in its place, the ones we can read quoted.
 *
 * Which argument the path was is part of what the reader is checking — `joblib.dump`
 * takes the object first and the file second, and a snippet that showed only the file
 * would look like a call that does not exist.
 */
function callSnippet(call: PyCall): string {
  const shown = call.args.slice(0, 3).map((arg) => (arg.t === 'str' && !arg.partial ? `"${clip(arg.v)}"` : '…'));
  // `Model.objects.filter(project=p)` passes everything by keyword, and rendering it as
  // `filter()` would show a call that takes no arguments — which is a different call.
  if (call.args.length > 3 || Object.keys(call.kwargs).length > 0) shown.push('…');
  return `${calleeText(call)}(${shown.join(', ')})`;
}

/** `Path()` is what a call in the middle of a chain flattens to; put the verb back. */
function calleeText(call: PyCall): string {
  if (!call.callee.endsWith('()')) return call.callee;
  const head = `${call.callee.slice(0, -2)}(…)`;
  return call.method ? `${head}.${call.method}` : head;
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= 48 ? flat : `${flat.slice(0, 47)}…`;
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
 * Auth attached to a whole application rather than to any route on it: an ASGI
 * middleware.
 *
 * `app.add_middleware(AuthMiddleware)` and `@app.middleware("http")` are how a large
 * Python service normally checks its callers, and neither leaves a mark in any of the
 * files that declare the routes. What is recorded here is only *what was attached to
 * which variable* — a middleware that gzips is written exactly like one that turns
 * strangers away, and telling them apart means reading the thing named, which is
 * usually in another file.
 */
function detectGuards(input: PythonBoundaryInput, findings: BoundaryFinding[]): void {
  for (const call of input.file.calls ?? []) {
    const parts = call.callee.split('.');
    if (parts.pop() !== 'add_middleware' || parts.length === 0) continue;
    const named = nameArg(call.args[0]);
    if (!named) continue;
    findings.push({
      type: 'router-guard',
      varName: parts[parts.length - 1],
      path: input.file.path,
      names: [named.split('.').pop() ?? named],
      how: 'middleware',
      line: call.line,
    });
  }

  // The decorator spelling of the same thing. The function underneath is right here,
  // so this is the one case where the check can be read on the spot — but it is still
  // resolved by name in the merge, so that both spellings answer the same question.
  for (const { def } of everyDef(input.file)) {
    for (const decorator of def.decorators) {
      const parts = decorator.callee.split('.');
      if (parts.pop() !== 'middleware' || parts.length === 0) continue;
      findings.push({
        type: 'router-guard',
        varName: parts[parts.length - 1],
        path: input.file.path,
        names: [def.name],
        how: 'middleware',
        line: def.line,
      });
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
