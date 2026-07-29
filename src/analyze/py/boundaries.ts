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

/** Function names that, when a route depends on one, are checking the caller. */
const GUARD_HINTS = /^(get_)?(current_user|current_active_user|authenticated_user|require_user|verify_token|get_user|require_auth|check_auth|auth_user)$/;

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

  // FastAPI: `user = Depends(get_current_user)` in the signature. It can be written as
  // a default, as an annotation, or inside `Annotated[...]`, so both halves are read.
  // The name of the dependency is the only evidence there is, so this stays `likely` —
  // a `get_current_user` that returns None for a stranger is not a check.
  for (const param of def.params ?? []) {
    const match = /Depends\(\s*([A-Za-z_][\w.]*)/.exec(`${param.type} ${param.default ?? ''}`);
    const target = match?.[1]?.split('.').pop() ?? '';
    if (target && GUARD_HINTS.test(target)) {
      guards.push({
        name: `Depends(${target})`,
        how: 'call',
        provider: 'custom',
        path,
        line: def.line,
        confidence: 'likely',
      });
    }
  }

  return guards;
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
    if (host && isInternalHost(host)) continue;

    const known = host ? serviceForHost(host) : null;
    findings.push({
      type: 'service',
      name: known?.name ?? host ?? `${root} call`,
      category: known?.category ?? 'other',
      package: root,
      host,
      external: host !== null,
      writes: WRITE_METHODS.has(method),
      site: site(call.line, `${call.callee}(${url ? `"${url}"` : '…'})`),
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
