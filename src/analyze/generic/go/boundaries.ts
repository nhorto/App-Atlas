/**
 * @fileoverview Where a Go service is open to the world, and where its data goes.
 *
 * Every rule here is gated on an import the file actually wrote. A repo that has never
 * heard of chi cannot have a chi route detected in it, whatever its variables are called
 * — which is the difference between reading a codebase and pattern-matching one.
 *
 * The findings are the same ones the TypeScript and Python detectors emit, and they are
 * merged by the same code. That was the bet this tier was built on: `boundaries/build.ts`
 * has never known what language a finding came from, so a Go router mounted under a
 * prefix composes its address through the machinery written for FastAPI, and a Go
 * middleware is decided to be a check by the same rule that decides it for a NestJS
 * guard. Nothing in `build.ts` was changed to make Go work.
 */
import type { CodeSite, GuardInfo, ServiceCategory } from '../../../model/types.js';
import { serviceForHost, isInternalHost } from '../../boundaries/catalog.js';
import type { BoundaryFinding, EndpointFinding } from '../../boundaries/types.js';
import { readSqlStatement } from '../../sql.js';
import type { BoundaryInput } from '../languages.js';
import type { GCall, GDef, GValue, GenericFile } from '../ir.js';
import { goFrameworkFor } from './frameworks.js';

/** What builds a router, by the last segment of the call. */
const CONSTRUCTORS = new Set(['NewRouter', 'New', 'Default', 'NewServeMux', 'NewServeMuxWithOptions']);

/** What hangs a new router off an existing one. */
const SUBROUTERS = new Set(['Group', 'Route', 'Subrouter', 'Party', 'PathPrefix', 'Host']);

/**
 * Type names that mean "this is something routes are registered on".
 *
 * Every Go repo past a certain size stops building its router in one file and starts
 * passing it around — `func registerRoutes(m *web.Router)` — and half of them wrap it in
 * a type of their own first. gitea and PocketBase both do, and a rule that only knows the
 * package names of four libraries reports their entire HTTP API as not existing.
 *
 * The type is the evidence, not the library. Deliberately narrow: `Group` and `App` on
 * their own are left out, because `*core.App` is PocketBase's whole application and
 * `Group` is what half the world calls a slice of anything.
 */
const ROUTER_TYPE = /(^|\.)(Router|RouterGroup|ServeMux|Mux|Engine|Echo|Party)$/;

/** Everything an HTTP method can be spelled as on a router: `Get`, `GET`, `Post`. */
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'CONNECT', 'TRACE']);

/** Methods that change something on the other side. */
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Frameworks that name the handler before the checks standing in front of it.
 *
 * Echo's method reads `GET(path string, h HandlerFunc, m ...MiddlewareFunc)`: the handler
 * has to come first, because the middleware is the variadic tail. gin writes the same
 * line the other way round, `GET(path string, handlers ...HandlerFunc)` with the real
 * handler last — and so does the standard library, and so does every router that takes
 * exactly one argument after the path.
 *
 * Reading an Echo route the gin way names the last middleware as the handler. The door
 * then points at the lock rather than at what is behind it, and the search for checks
 * "one hop out from the handler" begins in the wrong function.
 *
 * Keyed on the label `frameworks.ts` gives a declared dependency, so this is a fact about
 * what the repo's `go.mod` brings in rather than about a variable somebody named `e`.
 */
const HANDLER_FIRST = new Set(['Echo']);

/** How the standard library and the routers register a handler without naming a verb. */
const HANDLERS = new Set(['HandleFunc', 'Handle', 'Any', 'All', 'Match']);

/** How a check is hung on a route that has already been registered. */
const ATTACHES = new Set(['Bind', 'BindFunc', 'With', 'Middleware', 'Use']);

/**
 * The two statuses that mean "not you".
 *
 * A middleware is a check because of what it does, not what it is called. `RequireAuth`
 * and `Logger` are attached with the same call on the same line, and only one of them
 * ever writes one of these.
 */
const REJECTIONS = new Set(['StatusUnauthorized', 'StatusForbidden']);
const REJECTION_CODES = new Set(['401', '403']);

/**
 * Calls that put a status code on the wire.
 *
 * A shape rather than a list, because every framework spells it differently and a list
 * is a list of the frameworks somebody happened to test against: `w.WriteHeader(401)`,
 * `ctx.AbortWithError(401, …)`, `c.SendStatus(403)`, `e.NoContent(403)`. What they have
 * in common is a verb about answering, and a number that is the answer.
 */
const STATUS_CALL = /^(Abort|Write|Send|Set|Reply|Respond|Render|JSON|XML|String|Error|Status|NoContent|Fail)/;

/**
 * A call that spells the status out instead of numbering it: PocketBase's
 * `e.UnauthorizedError(…)`, `e.ForbiddenError(…)`.
 *
 * This is reading the HTTP vocabulary, not guessing from a name. "Unauthorized" and
 * "Forbidden" are the two statuses' own words — a method called that returns that, and
 * there is no second thing it could mean.
 */
const REJECTION_CALL = /(Unauthorized|Forbidden)/;

/**
 * How far a rejection may be from the middleware that owns it.
 *
 * Real auth code does not put the 401 in the function the router names. gotify's
 * `RequireClient` calls `evaluateOr401`, which calls `abort401`, which is where the
 * number finally appears — and a rule that only reads one function reports all
 * forty-four of that server's routes as unchecked. Three hops, same file, the same bound
 * `reach.ts` uses for the same reason.
 */
const MAX_REJECT_HOPS = 3;

/** Go modules that mean somebody is checking a token. */
const AUTH_PACKAGES: Record<string, string> = {
  'github.com/golang-jwt/jwt': 'JWT',
  'github.com/dgrijalva/jwt-go': 'JWT',
  'github.com/lestrrat-go/jwx': 'JWT',
  'github.com/casbin/casbin': 'Casbin',
  'github.com/markbates/goth': 'Goth',
  'github.com/coreos/go-oidc': 'OIDC',
  'golang.org/x/oauth2': 'OAuth2',
  'github.com/clerk/clerk-sdk-go': 'Clerk',
  'github.com/supabase-community': 'Supabase',
};

export function detectGoBoundaries(input: BoundaryInput): BoundaryFinding[] {
  const { file } = input;
  const findings: BoundaryFinding[] = [];
  const site = (line: number, snippet?: string): CodeSite => ({
    path: file.path,
    line,
    nodeId: input.fileId,
    ...(snippet ? { snippet } : {}),
  });
  /** The site of a call, filed under the function it sits in. */
  const at = (call: GCall, snippet?: string): CodeSite => ({
    path: file.path,
    line: call.line,
    nodeId: input.nodeIdForScope(call.scope),
    ...(snippet ? { snippet } : {}),
  });

  const imports = new Map(file.imports.map((imp) => [imp.local, imp.module]));
  const importsModule = (prefix: string) =>
    file.imports.some((imp) => imp.module === prefix || imp.module.startsWith(`${prefix}/`));

  const wiring = detectRoutes(input, imports, findings, at);
  detectCheckers(input, wiring, findings);
  detectPathConstants(file, findings);
  detectEnv(file, imports, findings, at);
  detectStores(file, importsModule, findings, at);
  detectOutbound(file, imports, findings, at);

  void site;
  return findings;
}

// ---------------------------------------------------------------------------
// Doors
// ---------------------------------------------------------------------------

/**
 * A sub-router written as a closure rather than as a variable.
 *
 * chi's `r.Route("/admin", func(r chi.Router) { … })` is the ordinary way to write a
 * prefixed group, and it is invisible to anything that only looks at variable names —
 * the closure's parameter usually shadows the outer router, so the routes inside say `r`
 * and mean something else entirely.
 *
 * Given a name of its own here, it becomes an ordinary router as far as the rest of the
 * pipeline is concerned: built, mounted under its prefix, and carrying whatever checks
 * were attached inside it. The name never reaches a screen; it exists so the merge layer
 * can tell this router from the one it was written on.
 */
interface Scope {
  varName: string;
  startIndex: number;
  endIndex: number;
}

/**
 * A router built inside the function that hands it back, and the name everywhere else
 * knows it by.
 *
 * `func CommonRoutes() *web.Router { r := web.NewRouter(); … }` is mounted in another
 * package entirely, as `r.Mount("/api/packages", packages_router.CommonRoutes())`. The
 * mount can only write the function's name; the routes inside can only write the
 * variable's; and unless those are the same router, the prefix never reaches the
 * addresses it belongs in front of.
 *
 * A range rather than a rename, because the variable is local and reused. gitea's
 * `routers/api/packages/api.go` builds `r` twice, in `CommonRoutes` and in
 * `ContainerRoutes` — two routers, mounted at two different addresses, and telling them
 * apart is the whole of what the reader is owed.
 */
interface RouterAlias {
  varName: string;
  identity: string;
  startIndex: number;
  endIndex: number;
}

function detectRoutes(
  input: BoundaryInput,
  imports: Map<string, string>,
  findings: BoundaryFinding[],
  at: (call: GCall, snippet?: string) => CodeSite,
): Set<string> {
  const { file } = input;
  /** Functions that assemble the router. Returned so nothing mistakes one for a check. */
  const wiring = new Set<string>();
  // A route declared in a `_test.go` file is not a door into the app, and this is not a
  // heuristic about folder names: the Go toolchain does not compile `_test.go` into the
  // binary, so the address genuinely does not exist in anything anybody deploys. gotify's
  // stream test assembles its own server, and its `GET /` was landing on the list of
  // addresses a stranger can reach.
  if (/_test\.go$/.test(file.path)) return wiring;

  /** Router variable → the framework that built it. */
  const routers = new Map<string, string>();
  const scopes: Scope[] = [];
  const aliases: RouterAlias[] = [];
  /** Functions that have already lent their name to a router, so the first one keeps it. */
  const named = new Set<string>();

  // The standard library's own mux is a router with no dependency to declare. `http`
  // itself is one too: `http.HandleFunc` registers on a mux the runtime owns.
  const stdlib = imports.get('http') === 'net/http' ? 'http' : null;
  if (stdlib) routers.set(stdlib, 'net/http');

  // Routers that arrive as arguments rather than being built here. Read off the written
  // type, so a repo that wraps chi in a type of its own is still a repo with doors.
  for (const def of file.defs) {
    for (const param of def.params) {
      const type = bareType(param.type);
      if (!ROUTER_TYPE.test(type) || routers.has(param.name)) continue;
      const pkg = type.includes('.') ? type.slice(0, type.indexOf('.')) : null;
      const module = pkg ? imports.get(pkg) : null;
      // A known library gets its own name; anything else is named after the type it is,
      // which is what a reader would have to go and look at anyway.
      routers.set(param.name, (module && goFrameworkFor(module)) ?? type);
    }
  }

  // Routers held in a struct field, which is how a config object carries one (#129):
  //
  //   type Config struct { Mux *http.ServeMux }
  //   func New(ctx context.Context, cfg Config) { cfg.Mux.HandleFunc("/api/get", …) }
  //
  // The receiver of that call is `cfg.Mux`, which is neither a local nor a parameter, so
  // the lookup above misses it and a secrets server reports no doors at all.
  //
  // Resolved the same way a parameter is — through the field's *written type*, never its
  // name. The shortcut is to accept any receiver ending in `.Mux`, and it would invent
  // doors on any field somebody happened to call that. This tier already tells the reader
  // its links are likely rather than certain; guessing at routers would spend the little
  // credit that leaves.
  const routerFieldsOf = new Map<string, { field: string; framework: string }[]>();
  for (const def of file.defs) {
    if (def.kind !== 'type') continue;
    for (const field of def.fields) {
      const type = bareType(field.type);
      if (!ROUTER_TYPE.test(type)) continue;
      const pkg = type.includes('.') ? type.slice(0, type.indexOf('.')) : null;
      const module = pkg ? imports.get(pkg) : null;
      const list = routerFieldsOf.get(def.name) ?? [];
      // `net/http` names itself, so a mux on a field reads the same as `http.HandleFunc`
      // does two blocks up rather than as the type it happens to be written as.
      const framework = module === 'net/http' ? 'net/http' : ((module && goFrameworkFor(module)) ?? type);
      list.push({ field: field.name, framework });
      routerFieldsOf.set(def.name, list);
    }
  }
  if (routerFieldsOf.size > 0) {
    for (const def of file.defs) {
      for (const param of def.params) {
        const fields = routerFieldsOf.get(bareType(param.type));
        if (!fields) continue;
        for (const { field, framework } of fields) {
          const held = `${param.name}.${field}`;
          if (!routers.has(held)) routers.set(held, framework);
        }
      }
    }
  }

  const frameworkOfPackage = (local: string): string | null => {
    const module = imports.get(local);
    if (!module) return null;
    if (module === 'net/http') return 'net/http';
    return goFrameworkFor(module);
  };

  /**
   * The function a call is written inside, when it is written inside one.
   *
   * By containment rather than by name, because a method and a plain function can share a
   * name and the question here is which body the call sits in.
   */
  const enclosingDef = (call: GCall): GDef | null => {
    let best: GDef | null = null;
    for (const def of file.defs) {
      if (def.kind !== 'function') continue;
      if (def.startIndex > call.startIndex || def.endIndex < call.endIndex) continue;
      if (!best || def.startIndex > best.startIndex) best = def;
    }
    return best;
  };

  /**
   * The function a call sits inside, when that function declares it hands a router back:
   * `func Routes() *web.Router { m := web.NewRouter(); … }`.
   *
   * The written type again, which is the evidence the parameter rule above already trusts
   * — read at the other end of the function this time.
   */
  const handedBack = (call: GCall): { def: GDef; type: string } | null => {
    const def = enclosingDef(call);
    if (!def) return null;
    const type = bareType(def.returns);
    return ROUTER_TYPE.test(type) ? { def, type } : null;
  };

  /**
   * The label for a router whose constructor belongs to a package none of the framework
   * tables have heard of.
   *
   * `func Routes() *web.Router { m := web.NewRouter(); m.Get("/version", …) }` is gitea's
   * entire `/api/v1` surface, and `web` there is gitea's own wrapper rather than anybody's
   * router library. Asked only which library the constructor came from, this file answers
   * "none", builds nothing, and several hundred doors go missing — along with the
   * `r.Mount("/api/packages", …)` written in front of them, which is left with no build to
   * attach itself to.
   *
   * Two things are demanded of the type, and both are load-bearing: the package has to be
   * one this file imported, and the constructor has to come *from* the package that
   * declares the type — `web.NewRouter()` for a `*web.Router`. `New` is close to the most
   * common function name in Go, and a rule that asked only about the return type would
   * make a router out of every logger opened inside a function that hands a router back.
   */
  const wrappedFramework = (call: GCall, handed: { def: GDef; type: string } | null): string | null => {
    if (!handed) return null;
    const dot = handed.type.indexOf('.');
    if (dot <= 0 || call.receiver !== handed.type.slice(0, dot)) return null;
    const module = imports.get(call.receiver);
    if (!module) return null;
    // A known library gets its own name; anything else is named after the type it is,
    // which is the answer the parameter rule gives for that same type.
    return goFrameworkFor(module) ?? handed.type;
  };

  /** What a router variable is called outside the function it was built in. */
  const identityOf = (varName: string, index: number): string => {
    for (const alias of aliases) {
      if (alias.varName !== varName) continue;
      if (alias.startIndex <= index && alias.endIndex >= index) return alias.identity;
    }
    return varName;
  };

  /** Which router a call is written on, and what stands in front of it. */
  const innermost = (index: number): Scope | null => {
    let best: Scope | null = null;
    for (const scope of scopes) {
      if (scope.startIndex > index || scope.endIndex < index) continue;
      if (!best || scope.startIndex > best.startIndex) best = scope;
    }
    return best;
  };
  const routerOf = (call: GCall): { varName: string; framework: string } | null => {
    const scope = innermost(call.startIndex);
    if (scope) {
      const framework = routers.get(scope.varName);
      return framework ? { varName: scope.varName, framework } : null;
    }
    if (!call.receiver) return null;
    const framework = routers.get(call.receiver);
    return framework ? { varName: identityOf(call.receiver, call.startIndex), framework } : null;
  };

  // --- pass one: what the routers are ---------------------------------------
  // Ordered by where they appear, because a group is declared before the routes on it
  // and a closure has to exist before anything inside it can be placed.
  const byPosition = [...file.calls].sort((a, b) => a.startIndex - b.startIndex);
  for (const call of byPosition) {
    const method = call.method ?? '';
    const bound = boundName(file, call);

    // `r := chi.NewRouter()`, `e := echo.New()`, `mux := http.NewServeMux()` — and
    // `m := web.NewRouter()`, where `web` is this repo's own wrapper around one of them.
    if (call.receiver && CONSTRUCTORS.has(method) && bound) {
      const handed = handedBack(call);
      const framework = frameworkOfPackage(call.receiver) ?? wrappedFramework(call, handed);
      if (framework) {
        routers.set(bound, framework);
        // A router built to be handed back is known everywhere else by the name of the
        // function handing it over, because that is the only name a mount ever writes.
        // The second router a function builds keeps its own name: one function is one
        // name, and two builds under it would be one router as far as the merge can see.
        const identity = handed && !named.has(handed.def.name) ? handed.def.name : bound;
        if (identity !== bound) {
          named.add(identity);
          aliases.push({
            varName: bound,
            identity,
            startIndex: handed!.def.startIndex,
            endIndex: handed!.def.endIndex,
          });
        }
        findings.push({
          type: 'router-build',
          routerName: call.callee,
          varName: identity,
          path: file.path,
          line: call.line,
          hasPrefix: false,
        });
        continue;
      }
    }

    const host = routerOf(call);
    if (!host || !SUBROUTERS.has(method)) continue;
    const pattern = patternOf(call.args);
    const closure = call.args.find((arg): arg is Extract<GValue, { t: 'func' }> => arg.t === 'func');

    // `admin := r.Group("/admin")` — a real variable, and every route on it says its
    // name. `r.Route("/admin", func(…){ … })` — no variable at all, so it gets one.
    const varName = bound ?? (closure ? `${host.varName}#${call.line}` : null);
    if (!varName) continue;

    routers.set(varName, host.framework);
    if (closure) scopes.push({ varName, startIndex: closure.startIndex, endIndex: closure.endIndex });
    findings.push({
      type: 'router-build',
      routerName: call.callee,
      varName,
      path: file.path,
      line: call.line,
      hasPrefix: false,
    });
    findings.push({
      type: 'router-mount',
      path: file.path,
      hostVar: host.varName,
      childModule: null,
      childVar: varName,
      hasPrefix: pattern.prefix !== null || pattern.prefixName !== null,
      prefix: pattern.prefix,
      prefixName: pattern.prefixName,
      line: call.line,
    });

    // The lock on a whole group, written either as an argument —
    // `g.Group("/plugin/", RequireClient)`, gin and echo — or chained onto the result:
    // `rg.Group("/collections").Bind(RequireSuperuserAuth())`. Carried as written; the
    // merge decides whether the name checks anything.
    //
    // A pattern written as a name is skipped, because it is the address rather than
    // something standing in front of it, and offering it as a candidate check invites the
    // merge to answer a question about a constant.
    const args = pattern.prefixName === null ? call.args : call.args.slice(1);
    const attached = args.map(nameOf).filter((name): name is string => name !== null);
    for (const chained of byPosition) {
      if (chained.startIndex !== call.startIndex || !ATTACHES.has(chained.method ?? '')) continue;
      for (const name of chained.args.map(nameOf)) if (name) attached.push(name);
    }
    if (attached.length > 0) {
      findings.push({ type: 'router-guard', varName, path: file.path, names: attached, how: 'middleware', line: call.line });
    }
  }

  // --- pass two: the doors, the mounts and the middleware -------------------
  /** Where each door's call started, so a check chained onto it can find it again. */
  const doorsAt = new Map<number, EndpointFinding>();

  for (const call of byPosition) {
    const host = routerOf(call);
    if (!host) continue;
    const method = call.method ?? '';

    // `r.Use(RequireAuth)` — recorded against the router, not resolved. Whether the name
    // turns callers away is another file's fact, and the merge layer knows it.
    if (method === 'Use') {
      const names = call.args.map(nameOf).filter((name): name is string => name !== null);
      if (names.length > 0) {
        findings.push({ type: 'router-guard', varName: host.varName, path: file.path, names, how: 'middleware', line: call.line });
      }
      continue;
    }

    // `r.Mount("/admin", adminRouter)` — a router built somewhere else entirely.
    if (method === 'Mount') {
      // `Mount(pattern, handler)` is how every Go router carrying this method spells it,
      // so the address comes first — and when it is a variable rather than a literal it is
      // a name exactly as the router is. Taking the first name on the line as the router
      // is what left `r.Mount(prefix, actions.ArtifactsRoutes(prefix))` pointing at a
      // router called `prefix` that nothing builds, losing the address and the link to the
      // routes behind it at once. One name on its own has no second candidate, so it can
      // only be the router and there is no address to read.
      const named = call.args.map(nameOf).filter((name): name is string => name !== null);
      const pattern = named.length > 1 ? patternOf(call.args) : { prefix: firstString(call.args), prefixName: null };
      const child = (pattern.prefixName === null ? named[0] : named[1]) ?? null;
      const dot = child?.indexOf('.') ?? -1;
      const module = dot > 0 ? (imports.get(child!.slice(0, dot)) ?? null) : null;
      findings.push({
        type: 'router-mount',
        path: file.path,
        hostVar: host.varName,
        childModule: module === null ? null : packageDir(module, input.signals.goModule),
        // `api.Routes()` names the call that hands the router over, not the variable it
        // was built under — which is why the package it came from has to answer instead.
        childVar: dot > 0 ? child!.slice(dot + 1).replace(/\(\)$/, '') : child,
        hasPrefix: pattern.prefix !== null || pattern.prefixName !== null,
        prefix: pattern.prefix,
        prefixName: pattern.prefixName,
        line: call.line,
      });
      continue;
    }

    const found = routeFor(call, method, host.framework);
    if (!found) continue;
    const door = { ...found, route: absolute(found.route) };

    // `g.GET("/plugin", RequireClient, GetPlugins)` — the handler is last and everything
    // between it and the path is middleware. That is gin's order, and it is also the
    // shape of the one-argument case, which is every other router.
    //
    // Naming the *first* name as the handler put gitea's `DeleteProjectColumn` on screen
    // as the thing protecting `DELETE /projects/{id}` — a handler wearing the label of a
    // lock, on the screen where that distinction is the whole point. Echo is the one
    // framework that really does write it that way round, and it says so in `go.mod`.
    const after = call.args.slice(1).map(nameOf).filter((name): name is string => name !== null);
    const handlerFirst = HANDLER_FIRST.has(host.framework);
    const handler = (handlerFirst ? after[0] : after[after.length - 1]) ?? null;
    const middleware = handlerFirst ? after.slice(1) : after.slice(0, -1);
    const handlerScope = handler?.includes('.') ? (handler.split('.').pop() ?? null) : handler;
    const finding: EndpointFinding = {
      type: 'endpoint',
      endpointKind: 'http-route',
      key: `${door.method ?? 'ANY'} ${door.route}`,
      name: `${door.method ?? 'ANY'} ${door.route}`,
      // `ANY` rather than null: a bare pattern really does answer every verb, and that
      // is what the rest of the pipeline already spells `ANY` — a Supabase edge function
      // says the same thing the same way. Left null, the export's Kind column printed
      // the word `http-route` where every other row has a verb.
      method: door.method ?? 'ANY',
      route: door.route,
      framework: host.framework,
      writes: door.method ? WRITE_METHODS.has(door.method) : false,
      guards: withGuards(call, file),
      site: at(call, `${call.callee}("${door.route}")`),
      handlerId: handlerScope ? input.nodeIdForName(handlerScope) : null,
      routerVar: host.varName,
      // Every name on the line except the handler. Whether any of them is really a check
      // is decided in the merge, against what the project's functions actually do.
      paramTypes: middleware.map((name) => name.split('.').pop() ?? name),
    };
    doorsAt.set(call.startIndex, finding);
    if (call.scope) wiring.add(call.scope.split('.').pop() ?? call.scope);
    findings.push(finding);
  }

  // --- pass three: checks chained onto a door -------------------------------
  // `sub.GET("", backupsList).Bind(RequireSuperuserAuth())` — the lock is attached to
  // the *result* of registering the route, which is how PocketBase and a good deal of
  // builder-style Go spells it. The chained call and the route call begin at the same
  // character, which is the only thing tying them together once the tree is flat.
  for (const call of byPosition) {
    if (!ATTACHES.has(call.method ?? '')) continue;
    if (!call.receiver?.includes('(')) continue;
    const door = doorsAt.get(call.startIndex);
    if (!door || door.site.line !== call.line) continue;
    for (const name of call.args.map(nameOf)) {
      if (name) door.paramTypes?.push(name.split('.').pop() ?? name);
    }
  }

  return wiring;
}

/**
 * The address written at the front of a routing call, whether it was spelled out or named.
 *
 * `Group("/admin", …)` and `Group(adminBase, …)` say the same thing, and only the first is
 * a string this file can read. Carrying the second as a *name* is what lets the merge
 * layer look the constant up — and, when it cannot, print a gap. Dropping it is the one
 * outcome that must not happen, because the address that comes out then is shorter than
 * the real one and still looks complete.
 *
 * The first argument rather than the first string among them. Every Go router that takes a
 * pattern takes it first, and chi's `r.Group(func(r chi.Router){ … })` takes none at all —
 * so a string further along the line is somebody's argument to a middleware, not an
 * address, and reading it as one would put it in front of every route in the group.
 */
function patternOf(args: GValue[]): { prefix: string | null; prefixName: string | null } {
  const first = args[0];
  if (first?.t === 'str') return { prefix: first.v, prefixName: null };
  if (first?.t === 'name') return { prefix: null, prefixName: first.v };
  return { prefix: null, prefixName: null };
}

/**
 * String constants shaped like a path, offered to the merge layer so that a prefix written
 * as a name can be turned back into the address it stands for.
 *
 * `m.Group(artifactRouteBase, …)` names its address instead of writing it, and the
 * declaration is a different statement somewhere else in the file. Only the merge layer
 * sees both, so this is where the two halves are handed over.
 *
 * Path-shaped values only, and that filter is load-bearing rather than tidy. The index
 * these join is keyed by bare name across the whole repo, so every unrelated constant put
 * into it is a chance to answer a prefix with something that is not an address at all: one
 * real repo declares `prefix = "gitea-gitignore"` in a build script, and unfiltered that is
 * the single repo-wide answer for the `prefix` its actions router mounts under — which
 * turns three honestly partial addresses into three confidently wrong ones.
 */
function detectPathConstants(file: GenericFile, findings: BoundaryFinding[]): void {
  for (const constant of file.constants) {
    if (constant.value !== '' && !constant.value.startsWith('/')) continue;
    findings.push({
      type: 'path-constant',
      name: constant.name,
      value: constant.value,
      path: file.path,
      line: constant.line,
    });
  }
}

/**
 * The folder a Go import names, written the way the repo lays its own files out.
 *
 * A Go import names a package, and a package is a directory: `github.com/me/app/internal/api`
 * is the folder `internal/api`, and every `.go` file in it is that package. `go.mod` says
 * what prefix this repo's own folders carry, which is the only thing that can tell one of
 * ours from somebody else's.
 *
 * An import that is not ours is handed back exactly as written. Trimming it down to
 * something that looks like a folder of ours is how `github.com/other/api` would come to
 * stand for our own `api/`, and a prefix invented that way is worse than no prefix at all.
 */
function packageDir(module: string, ownModule: string | null): string {
  if (!ownModule || !module.startsWith(`${ownModule}/`)) return module;
  return module.slice(ownModule.length + 1);
}

/**
 * The variable a call's result was bound to, when it was bound to one.
 *
 * The prefix match is for chains: `subGroup := rg.Group("/collections").Bind(auth)` binds
 * the result of the *outermost* call, so the binding's callee reads
 * `rg.Group("/collections").Bind` while the group-making call is only `rg.Group`. Without
 * it PocketBase's every route sits on a router nothing named, and none of them are found.
 */
function boundName(file: GenericFile, call: GCall): string | null {
  for (const binding of file.bindings) {
    if (binding.line !== call.line) continue;
    if (binding.callee === call.callee || binding.callee.startsWith(`${call.callee}(`)) return binding.name;
  }
  return null;
}

/**
 * The method and address a call registers, or null when it registers nothing.
 *
 * Three spellings, because Go's routers do not agree. chi writes `r.Get("/x", h)`, gin
 * and echo write `r.GET("/x", h)`, and the standard library writes `mux.HandleFunc("GET
 * /x", h)` — where since Go 1.22 the verb is inside the pattern, and a reader who
 * ignores it reports every route as answering to every method.
 */
function routeFor(call: GCall, method: string, framework: string): { method: string | null; route: string } | null {
  const path = firstString(call.args);
  if (path === null) return null;

  // The standard library has no verb methods. `http.Get(url)` and `http.Post(url, …)`
  // are the *client*: calls going out, not doors coming in — and reading them as routes
  // put a Slack webhook URL on the list of addresses a stranger can reach.
  const isStdlib = framework === 'net/http';

  if (!isStdlib && METHODS.has(method.toUpperCase()) && method.toUpperCase() !== 'CONNECT') {
    return { method: method.toUpperCase(), route: path };
  }
  // chi's `r.Method("GET", "/x", h)`, where the verb is the first argument.
  if (method === 'Method' || method === 'MethodFunc') {
    const verb = path.toUpperCase();
    const route = firstString(call.args.slice(1));
    if (!METHODS.has(verb) || route === null) return null;
    return { method: verb, route };
  }
  if (!HANDLERS.has(method)) return null;

  // `"GET /orders/{id}"` — one string holding both halves, which is how the standard
  // library has spelled a method-specific route since Go 1.22. A reader who ignores the
  // first word reports every route as answering to every verb.
  const split = /^([A-Z]+)\s+(\/.*)$/.exec(path);
  if (split && METHODS.has(split[1])) return { method: split[1], route: split[2] };
  // A bare pattern really does answer every verb, and `null` is how the rest of the
  // pipeline spells that.
  return { method: null, route: path };
}

/**
 * The type a name was written with, with everything that is not the type taken off:
 * `*router.RouterGroup[*core.RequestEvent]` → `router.RouterGroup`.
 *
 * Generics first, because their contents are full types of their own and stripping the
 * stars before the brackets welds the outer type onto the inner one.
 */
function bareType(type: string): string {
  return type.replace(/\[.*$/, '').replace(/^[*&[\]]+/, '');
}

/**
 * `version` → `/version`.
 *
 * Every Go router treats a route path as absolute from the router it is written on, and
 * gotify's `g.GET("version", …)` really is spelled without the slash. Printed as written
 * it is an address nobody can paste into a browser, which for the one screen people read
 * out to customers is the difference between an answer and a puzzle.
 */
function absolute(route: string): string {
  if (route === '' || route.startsWith('/')) return route;
  return `/${route}`;
}

/**
 * Checks written onto one route rather than onto its router: `r.With(RequireAuth).Get(…)`.
 *
 * These are `possible` rather than `likely` on purpose. The name is right there on the
 * same line, but whether it turns anybody away is decided elsewhere — and the merge layer
 * will add a stronger, resolved guard for the same name if the project really does define
 * one that rejects.
 */
function withGuards(call: GCall, file: GenericFile): GuardInfo[] {
  const match = /\.With\((.+?)\)\./.exec(call.callee);
  if (!match) return [];
  return match[1]
    .split(',')
    .map((name) => name.trim().replace(/\(\)$/, ''))
    .filter(Boolean)
    .map((name) => ({
      name,
      how: 'middleware' as const,
      provider: 'custom',
      path: file.path,
      line: call.line,
      confidence: 'possible' as const,
    }));
}

// ---------------------------------------------------------------------------
// What counts as a check
// ---------------------------------------------------------------------------

/**
 * Functions that turn an unauthenticated caller away, found by what they write rather
 * than by what they are named.
 *
 * A middleware called `RequireAuth` and one called `Logger` are attached with the same
 * call on the same line. The only thing that tells them apart is that one of them puts a
 * 401 or a 403 on the wire, and that is what this looks for. Reported by the file that
 * *defines* the function; the routers that use it are elsewhere, and `build.ts` matches
 * the two.
 */
function detectCheckers(input: BoundaryInput, wiring: Set<string>, findings: BoundaryFinding[]): void {
  const { file } = input;
  const provider = authProvider(file);
  const rejecting = rejectingFunctions(file, wiring);

  for (const def of file.defs) {
    if (def.kind !== 'function') continue;
    if (!rejecting.has(def.name)) continue;
    const guard: GuardInfo = {
      name: def.name,
      how: 'middleware',
      provider,
      path: file.path,
      line: def.line,
      // Read from the code, not from the name — but it is still one function's behaviour
      // standing in for a decision made by a framework we did not run.
      confidence: 'likely',
    };
    const nodeId = input.nodeIdForScope(def.owner ? `${def.owner}.${def.name}` : def.name);

    // Named, so that a router that attaches it by name — in this file or four files
    // away — can be told a lock from a logger.
    findings.push({ type: 'auth-checker', name: def.name, guard });

    // And attached to itself, because a handler that does its own checking is guarded,
    // and a route answering with it should not read as wide open.
    findings.push({
      type: 'guard',
      guard: { ...guard, how: 'call', confidence: 'certain' },
      scope: 'node',
      nodeId,
      matchers: [],
      sourceId: nodeId,
    });
  }
}

/**
 * The functions in this file that turn a caller away — the ones that write the rejection
 * themselves, and the ones that call something in the same file that does.
 *
 * The second half is what makes this work on real code. A middleware named in a router
 * hands off: `RequireClient` → `evaluateOr401` → `abort401`, and only the last of the
 * three has a number in it. Only same-file calls are followed, because a bare name is
 * only unambiguous inside one package and this pass sees one file.
 */
function rejectingFunctions(file: GenericFile, wiring: Set<string>): Set<string> {
  const declared = new Map<string, GDef>();
  for (const def of file.defs) {
    // A function that registers routes is wiring, and wiring names every middleware it
    // attaches. Letting the chain run through it makes `bindBackupApi` a check because
    // it mentioned one — and then every handler that file declares looks protected by
    // the whole file's worth of locks, whichever route it actually sits on.
    if (def.kind !== 'function' || wiring.has(def.name)) continue;
    if (!declared.has(def.name)) declared.set(def.name, def);
  }

  const rejecting = new Set<string>();
  for (const [name, def] of declared) {
    if (writesARejection(def, file)) rejecting.add(name);
  }

  for (let hop = 0; hop < MAX_REJECT_HOPS; hop++) {
    let grew = false;
    for (const [name, def] of declared) {
      if (rejecting.has(name)) continue;
      if (!def.uses.some((used) => rejecting.has(used))) continue;
      rejecting.add(name);
      grew = true;
    }
    if (!grew) break;
  }
  return rejecting;
}

/** Whether a definition itself ever answers with a 401 or a 403. */
function writesARejection(def: GDef, file: GenericFile): boolean {
  for (const name of def.qualifiedUses) {
    if (REJECTIONS.has(name.split('.').pop() ?? '')) return true;
  }
  for (const name of def.uses) {
    if (REJECTIONS.has(name)) return true;
  }
  for (const call of file.calls) {
    if (call.startIndex < def.startIndex || call.endIndex > def.endIndex) continue;
    const method = call.method ?? '';
    // `e.UnauthorizedError("…")` — the status written out in words.
    if (REJECTION_CALL.test(method)) return true;
    // `w.WriteHeader(401)` — the same statement written as a number.
    if (!STATUS_CALL.test(method)) continue;
    if (call.args.some((arg) => arg.t === 'num' && REJECTION_CODES.has(arg.v))) return true;
  }
  return false;
}

/** Whose auth this is, when the file brings in something that says so. */
function authProvider(file: GenericFile): string {
  for (const imp of file.imports) {
    for (const [prefix, name] of Object.entries(AUTH_PACKAGES)) {
      if (imp.module === prefix || imp.module.startsWith(`${prefix}/`)) return name;
    }
  }
  return 'custom';
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function detectEnv(
  file: GenericFile,
  imports: Map<string, string>,
  findings: BoundaryFinding[],
  at: (call: GCall, snippet?: string) => CodeSite,
): void {
  if (imports.get('os') !== 'os') return;
  for (const call of file.calls) {
    if (call.receiver !== 'os') continue;
    if (call.method !== 'Getenv' && call.method !== 'LookupEnv') continue;
    const name = firstString(call.args);
    if (name) findings.push({ type: 'env', name, site: at(call, `os.${call.method}("${name}")`) });
  }
}

// ---------------------------------------------------------------------------
// Where the data lives
// ---------------------------------------------------------------------------

interface StoreRule {
  /** The import that has to be present before any of this applies. */
  module: string;
  key: string;
  name: string;
  client: string;
  storeKind: 'sql' | 'nosql' | 'kv';
  reads: Set<string>;
  writes: Set<string>;
  /** Calls whose direction is inside the SQL string rather than in the method name. */
  statements?: Set<string>;
}

const STORE_RULES: StoreRule[] = [
  {
    module: 'database/sql',
    key: 'sql',
    name: 'Database',
    client: 'database/sql',
    storeKind: 'sql',
    reads: new Set(['Query', 'QueryRow', 'QueryContext', 'QueryRowContext']),
    writes: new Set([]),
    statements: new Set(['Exec', 'ExecContext', 'Prepare', 'PrepareContext']),
  },
  {
    module: 'gorm.io/gorm',
    key: 'gorm',
    name: 'Database',
    client: 'GORM',
    storeKind: 'sql',
    reads: new Set(['Find', 'First', 'Last', 'Take', 'Scan', 'Count', 'Pluck']),
    writes: new Set(['Create', 'Save', 'Delete', 'Update', 'Updates', 'FirstOrCreate']),
  },
  {
    module: 'github.com/jmoiron/sqlx',
    key: 'sqlx',
    name: 'Database',
    client: 'sqlx',
    storeKind: 'sql',
    reads: new Set(['Select', 'Get', 'Queryx', 'QueryRowx', 'SelectContext', 'GetContext']),
    writes: new Set(['NamedExec', 'MustExec', 'NamedExecContext']),
  },
  {
    module: 'github.com/redis/go-redis',
    key: 'redis',
    name: 'Redis',
    client: 'go-redis',
    storeKind: 'kv',
    reads: new Set(['Get', 'MGet', 'HGet', 'HGetAll', 'Exists', 'TTL', 'SMembers', 'LRange', 'ZRange']),
    writes: new Set(['Set', 'SetEX', 'SetNX', 'MSet', 'HSet', 'Del', 'Expire', 'Incr', 'IncrBy', 'SAdd', 'LPush', 'RPush']),
  },
  {
    module: 'go.mongodb.org/mongo-driver',
    key: 'mongo',
    name: 'MongoDB',
    client: 'mongo-driver',
    storeKind: 'nosql',
    reads: new Set(['Find', 'FindOne', 'Aggregate', 'CountDocuments', 'Distinct']),
    writes: new Set(['InsertOne', 'InsertMany', 'UpdateOne', 'UpdateMany', 'DeleteOne', 'DeleteMany', 'ReplaceOne', 'FindOneAndUpdate']),
  },
];

/**
 * Where this file's data goes, gated on what it imports.
 *
 * `Find` is a GORM read and also a perfectly ordinary method name on anybody's own type.
 * The gate is the file's own import list rather than the repo's dependency list, because
 * a repo with GORM in `go.mod` has plenty of files that have never touched a database,
 * and every one of them has something called `Get` in it.
 */
function detectStores(
  file: GenericFile,
  importsModule: (prefix: string) => boolean,
  findings: BoundaryFinding[],
  at: (call: GCall, snippet?: string) => CodeSite,
): void {
  const active = STORE_RULES.filter((rule) => importsModule(rule.module));
  if (active.length === 0) return;
  const claimed = new Set<number>();

  for (const call of file.calls) {
    const method = call.method ?? '';
    if (!call.receiver || claimed.has(call.line)) continue;

    for (const rule of active) {
      const isStatement = rule.statements?.has(method) ?? false;
      const isRead = rule.reads.has(method);
      const isWrite = rule.writes.has(method);
      if (!isStatement && !isRead && !isWrite) continue;

      // The verb of an `Exec` is inside the string it was handed, and the table with it.
      // No literal string means the query was built elsewhere — the call is still
      // evidence that a database was used, and the arrow is what we cannot draw.
      const sql = isStatement || isRead ? firstString(call.args) : null;
      const statement = sql ? readSqlStatement(sql) : null;
      const operation = statement?.operation ?? (isRead ? 'read' : isWrite ? 'write' : null);

      findings.push({
        type: 'store',
        key: rule.key,
        name: rule.name,
        client: rule.client,
        storeKind: rule.storeKind,
        table: statement?.table ?? null,
        operation,
        site: at(call, `${call.callee}(…)`),
      });
      claimed.add(call.line);
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Who else this app talks to
// ---------------------------------------------------------------------------

/**
 * Calls that leave the machine, and the company on the other end when we can tell.
 *
 * A call with no literal URL is not reported at all. `client.Do(req)` proves an HTTP
 * request happens and says nothing whatever about who answers it, and naming the box
 * after the receiving variable is how `s call` and `session call` once ended up on a
 * repo's list of outside companies (#25).
 */
function detectOutbound(
  file: GenericFile,
  imports: Map<string, string>,
  findings: BoundaryFinding[],
  at: (call: GCall, snippet?: string) => CodeSite,
): void {
  if (imports.get('http') !== 'net/http') return;

  for (const call of file.calls) {
    if (call.receiver !== 'http') continue;
    const method = call.method ?? '';
    const isRequest = method === 'NewRequest' || method === 'NewRequestWithContext';
    if (!['Get', 'Post', 'PostForm', 'Head'].includes(method) && !isRequest) continue;

    const url = call.args.map((arg) => (arg.t === 'str' ? arg.v : null)).find((text) => text && /^https?:\/\//i.test(text));
    if (!url) continue;
    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      continue;
    }
    if (!host || isInternalHost(host)) continue;

    const known = serviceForHost(host);
    findings.push({
      type: 'service',
      name: known?.name ?? host,
      category: (known?.category ?? 'other') as ServiceCategory,
      package: 'net/http',
      host,
      external: true,
      // `NewRequest` carries its verb as the first argument; `http.Post` is in the name.
      writes: isRequest
        ? WRITE_METHODS.has((firstString(call.args) ?? '').toUpperCase())
        : method === 'Post' || method === 'PostForm',
      site: at(call, `http.${method}("${url}")`),
    });
  }
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

function firstString(args: GValue[]): string | null {
  for (const arg of args) {
    if (arg.t === 'str') return arg.v;
  }
  return null;
}

/** A name handed to a call, whether it was written bare or called: `Auth` / `Auth()`. */
function nameOf(arg: GValue): string | null {
  if (arg.t === 'name') return arg.v;
  if (arg.t === 'call') return arg.v;
  return null;
}
