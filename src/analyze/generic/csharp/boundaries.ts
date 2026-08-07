/**
 * @fileoverview Where a .NET service is open to the world, and where its data goes.
 *
 * The same bet the Go tier was built on: these are the findings the TypeScript and Python
 * detectors emit, merged by the same code, so a C# route is badged by the rule that
 * badges a FastAPI one and nothing in `boundaries/build.ts` was changed to make room.
 *
 * C# does differ from Go in one way that shapes this whole file. Go says what it is doing
 * in calls — `r.Get("/orders", h)` — and C# says most of it in *attributes*:
 * `[Route("api/v1/orders")]` on the class, `[HttpGet("{id}")]` on the method,
 * `[Authorize]` above both. The query file captures an attribute as the call it is
 * spelled like, so everything below reads one vocabulary rather than two, and the
 * minimal-API style (`app.MapGet("/orders", …)`) arrives in exactly the same shape.
 *
 * What gates a rule is a declaration, never a name. A repo whose project file has no web
 * SDK and no ASP.NET reference cannot have a route detected in it, however many methods
 * somebody has called `Get`.
 */
import type { CodeSite, GuardInfo, SignInKind } from '../../../model/types.js';
import { isInternalHost, serviceForHost } from '../../boundaries/catalog.js';
import type { BoundaryFinding } from '../../boundaries/types.js';
import { isSqlStatement, readSqlStatement } from '../../sql.js';
import type { BoundaryInput } from '../languages.js';
import type { GCall, GDef, GValue, GenericFile } from '../ir.js';

/** The attributes that declare an HTTP door, and the verb each one means. */
const VERB_ATTRIBUTES: Record<string, string> = {
  HttpGet: 'GET',
  HttpPost: 'POST',
  HttpPut: 'PUT',
  HttpPatch: 'PATCH',
  HttpDelete: 'DELETE',
  HttpHead: 'HEAD',
  HttpOptions: 'OPTIONS',
};

/** Minimal-API registrations, and the verb each one means. `MapMethods` names its own. */
const MAP_METHODS: Record<string, string> = {
  MapGet: 'GET',
  MapPost: 'POST',
  MapPut: 'PUT',
  MapPatch: 'PATCH',
  MapDelete: 'DELETE',
};

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** How a Razor Page or a SignalR hub says it is reachable. */
const HUB_MAPS = new Set(['MapHub', 'MapRazorPages', 'MapControllers', 'MapGrpcService']);

/**
 * Attributes that lock a door, and the ones that unlock it again.
 *
 * `[AllowAnonymous]` is not merely the absence of `[Authorize]` — it *overrides* one on
 * the controller, which is how nearly every ASP.NET app writes its login endpoint: the
 * class is locked and the two actions that must not be are excused by name. Reading the
 * class attribute alone would report the sign-in route as protected, which is the one
 * direction this tool must never be wrong in.
 */
const AUTHORIZE = 'Authorize';
const ALLOW_ANONYMOUS = 'AllowAnonymous';

/** Chained on a minimal-API route: `app.MapGet(…).RequireAuthorization()`. */
const REQUIRE_AUTH = 'RequireAuthorization';
const ALLOW_ANONYMOUS_CALL = 'AllowAnonymous';

/**
 * The two statuses that mean "not you".
 *
 * A filter is a check because of what it writes, not what it is called —  the rule the
 * Go tier is built on, and the one that matters most here. `[Authorize]` and
 * `.RequireAuthorization()` are ASP.NET's built-ins, and a great many real .NET services
 * never use either: they write their own endpoint filter, chain it onto the routes it
 * covers, and return a 401 from inside it. Reading only the built-ins reported a
 * connector with a device-token scheme and a supervisor-session scheme as **48 of 48
 * routes unprotected**, which is the cry-wolf failure that teaches a reader to stop
 * believing the page.
 */
const REJECTION_STATUS = /(^|\.)Status(401Unauthorized|403Forbidden)$/;

/** `Results.Unauthorized()`, `Results.Forbid()` — the same answer, spelled shorter. */
const REJECTION_CALL = /(^|\.)(Unauthorized|Forbid)$/;

/** A number handed to something that sets a status: `StatusCode(401)`. */
const REJECTION_CODE = new Set(['401', '403']);

/**
 * Chained calls that are never a check, so a route's filter list stays worth reading.
 *
 * Every one of these is ASP.NET's own route metadata — naming, OpenAPI, caching, CORS.
 * They cost nothing to carry, but a reader who is shown them among the locks has to
 * work out which is which.
 */
const NOT_A_FILTER = new Set([
  'WithName', 'WithTags', 'WithSummary', 'WithDescription', 'WithOpenApi', 'WithMetadata',
  'Produces', 'ProducesProblem', 'ProducesValidationProblem', 'Accepts', 'ExcludeFromDescription',
  'DisableAntiforgery', 'CacheOutput', 'RequireCors', 'RequireHost', 'WithDisplayName',
  'AddEndpointFilter', 'MapGroup', 'WithGroupName', 'ShortCircuit', 'WithOrder',
]);

/**
 * Calls that only ever mean Entity Framework, whatever they are written on.
 *
 * The async ones are EF's own extension methods — `ToListAsync` does not exist on an
 * ordinary list — and `Include`/`AsNoTracking` are EF vocabulary with no other meaning.
 * These stand on their own, because nothing else in C# spells them.
 */
const EF_ONLY_READS = new Set([
  'ToListAsync', 'ToArrayAsync', 'FirstOrDefaultAsync', 'FirstAsync', 'SingleOrDefaultAsync',
  'SingleAsync', 'FindAsync', 'AnyAsync', 'CountAsync', 'LongCountAsync', 'SumAsync', 'MaxAsync',
  'MinAsync', 'Include', 'ThenInclude', 'AsNoTracking', 'FromSqlRaw', 'FromSqlInterpolated',
]);

const EF_ONLY_WRITES = new Set([
  'AddAsync', 'AddRangeAsync', 'ExecuteDelete', 'ExecuteDeleteAsync', 'ExecuteUpdate',
  'ExecuteUpdateAsync', 'ExecuteSqlRaw', 'ExecuteSqlRawAsync', 'ExecuteSqlInterpolated',
]);

/**
 * Calls that mean Entity Framework *only when the thing they are written on is a table*.
 *
 * `Where`, `Select` and `Add` are LINQ and `List<T>`, which every C# file in the world is
 * full of. Counting `items.Select(x => x.Name)` as a database read is how a map ends up
 * claiming an app queries a table called `items`, so these need the receiver to be a
 * `DbSet` this file actually declared before they count for anything.
 */
const LINQ_READS = new Set([
  'ToList', 'ToArray', 'FirstOrDefault', 'First', 'SingleOrDefault', 'Single', 'Any', 'Count',
  'Where', 'Select', 'OrderBy', 'OrderByDescending', 'Find',
]);

const LINQ_WRITES = new Set(['Add', 'AddRange', 'Update', 'UpdateRange', 'Remove', 'RemoveRange']);

/**
 * The ADO.NET drivers, and the engine each one is a driver for.
 *
 * Raw ADO.NET is the most common data access in .NET after Entity Framework, and it
 * hides its query where nothing else does: `cmd.CommandText = "SELECT …"` on one line,
 * `ExecuteReaderAsync()` with no arguments on another. Read only through EF and Dapper,
 * a connector whose entire storage layer is `Microsoft.Data.Sqlite` reports a database
 * it never names and tables it never found.
 */
const ADO_DRIVERS: Record<string, string> = {
  'Microsoft.Data.Sqlite': 'SQLite',
  'System.Data.SQLite': 'SQLite',
  MySqlConnector: 'MySQL',
  'MySql.Data': 'MySQL',
  Npgsql: 'PostgreSQL',
  'Microsoft.Data.SqlClient': 'SQL Server',
  'System.Data.SqlClient': 'SQL Server',
  'Oracle.ManagedDataAccess': 'Oracle',
};

/** Dapper's whole surface, near enough: it takes SQL and gives back rows. */
const DAPPER_CALLS = new Set([
  'Query', 'QueryAsync', 'QueryFirst', 'QueryFirstAsync', 'QueryFirstOrDefault', 'QueryFirstOrDefaultAsync',
  'QuerySingle', 'QuerySingleAsync', 'QuerySingleOrDefault', 'QuerySingleOrDefaultAsync',
  'Execute', 'ExecuteAsync', 'ExecuteScalar', 'ExecuteScalarAsync', 'QueryMultiple', 'QueryMultipleAsync',
]);

/** `HttpClient` methods that put a request on the wire. */
const HTTP_CALLS: Record<string, boolean> = {
  GetAsync: false,
  GetStringAsync: false,
  GetStreamAsync: false,
  GetByteArrayAsync: false,
  GetFromJsonAsync: false,
  PostAsync: true,
  PostAsJsonAsync: true,
  PutAsync: true,
  PutAsJsonAsync: true,
  PatchAsync: true,
  DeleteAsync: true,
  SendAsync: true,
};

/**
 * `ExecuteScalarAsync<int>` → `ExecuteScalarAsync`.
 *
 * A generic method carries its type argument in its name, and C# code is full of them —
 * `QueryAsync<Order>`, `AddDbContext<ShopContext>`, `GetRequiredService<IClock>`. Compared
 * against a table of method names without this, Dapper's entire surface goes unread.
 */
function bareMethod(call: GCall): string {
  const method = call.method ?? '';
  const angle = method.indexOf('<');
  return angle === -1 ? method : method.slice(0, angle);
}

export function detectCSharpBoundaries(input: BoundaryInput): BoundaryFinding[] {
  const { file } = input;
  const findings: BoundaryFinding[] = [];

  const at = (call: GCall, snippet?: string): CodeSite => ({
    path: file.path,
    line: call.line,
    nodeId: input.nodeIdForScope(call.scope),
    ...(snippet ? { snippet } : {}),
  });

  if (isAspNet(input)) {
    detectControllers(input, findings, at);
    detectMinimalApis(input, findings, at);
    detectCheckers(input, findings);
    detectSignInCalls(input, findings, at);
  }
  if (isDotnetHost(input)) detectHostedServices(input, findings, at);
  detectStores(input, findings, at);
  detectOutbound(input, findings, at);
  detectEnv(input, findings, at);

  return findings;
}

/**
 * Whether this project is a web application at all.
 *
 * Three ways to know, because .NET writes it down in three places and a real repo uses
 * whichever it feels like. The project file's SDK is the strongest — `Microsoft.NET.Sdk.Web`
 * means ASP.NET Core is in the runtime — and it is also the *only* one available in a
 * `Program.cs` that uses implicit usings, which is how every project created since .NET 6
 * is written. Failing that, the file's own `using` is evidence about the file.
 */
function isAspNet(input: BoundaryInput): boolean {
  const { signals, file } = input;
  if (signals.dotnetSdks?.has('Microsoft.NET.Sdk.Web')) return true;
  for (const id of signals.dotnetPackages ?? []) {
    if (id.startsWith('Microsoft.AspNetCore')) return true;
  }
  return file.imports.some((imp) => imp.module.startsWith('Microsoft.AspNetCore'));
}

/**
 * Every attribute the file wrote, filed under the declaration it was written on.
 *
 * The query captures an attribute as a call, so this is a filter over `file.calls` rather
 * than a second pass over the tree — and the filter is a list of names. A method really
 * called `HttpGet()` would be mistaken for the attribute, which is the one hole in
 * reading attributes as calls; against that, `HttpGet`, `Route`, `Authorize` and
 * `ApiController` are ASP.NET's own vocabulary and not what anybody names a method they
 * then call. The narrower the list, the smaller the hole, so nothing general is admitted.
 */
const ATTRIBUTE_NAMES = new Set([
  ...Object.keys(VERB_ATTRIBUTES),
  'Route',
  'ApiController',
  AUTHORIZE,
  ALLOW_ANONYMOUS,
]);

function attributesByScope(file: GenericFile): Map<string, GCall[]> {
  const out = new Map<string, GCall[]>();
  for (const call of file.calls) {
    // An attribute is written bare — `[Authorize]`, never `[x.Authorize]` — so a
    // receiver means this is an ordinary call that happens to share the name.
    if (call.receiver || !ATTRIBUTE_NAMES.has(call.callee)) continue;
    const scope = call.scope ?? '';
    const list = out.get(scope);
    if (list) list.push(call);
    else out.set(scope, [call]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Doors: controllers
// ---------------------------------------------------------------------------

/**
 * `[Route("api/v1/orders")] class OrdersController` + `[HttpGet("{id}")] GetOrder`.
 *
 * The address is split across two attributes on two declarations, and neither half is an
 * address on its own. Everything needed to join them is in this file — the class is here,
 * the method is here, and the attribute captures carry the enclosing definition as their
 * scope — so the composition happens here rather than through the mount machinery, which
 * exists for the harder case of a router assembled somewhere else.
 */
function detectControllers(
  input: BoundaryInput,
  findings: BoundaryFinding[],
  at: (call: GCall, snippet?: string) => CodeSite,
): void {
  const { file } = input;
  const attributes = attributesByScope(file);

  for (const def of file.defs) {
    if (def.kind !== 'type' || !isController(def, attributes)) continue;

    const classAttrs = attributes.get(def.name) ?? [];
    const prefix = routeTemplate(classAttrs, def.name, null);
    const classLocked = classAttrs.some((call) => call.callee === AUTHORIZE);

    for (const method of file.defs) {
      if (method.kind !== 'function' || method.owner !== def.name) continue;
      const scope = `${def.name}.${method.name}`;
      const methodAttrs = attributes.get(scope) ?? [];

      for (const attr of methodAttrs) {
        const verb = VERB_ATTRIBUTES[attr.callee];
        if (!verb) continue;

        const template = routeTemplate([attr], def.name, method.name);
        const route = joinRoute(prefix, template);
        // `[AllowAnonymous]` on the action beats `[Authorize]` on the class. This is how
        // a login endpoint is written, and getting it backwards would badge the one door
        // that is meant to be open as locked.
        const anonymous = methodAttrs.some((call) => call.callee === ALLOW_ANONYMOUS);
        const locked = !anonymous && (classLocked || methodAttrs.some((call) => call.callee === AUTHORIZE));

        findings.push({
          type: 'endpoint',
          endpointKind: 'http-route',
          key: `${verb} ${route}`,
          name: `${verb} ${route}`,
          method: verb,
          route,
          framework: 'ASP.NET Core',
          writes: WRITE_METHODS.has(verb),
          guards: locked ? [authorizeGuard(file, attr, classLocked ? def.name : scope)] : [],
          site: at(attr, `[${attr.callee}] ${scope}`),
          handlerId: input.nodeIdForName(scope) ?? input.nodeIdForName(method.name),
          handlerOwner: def.name,
        });
      }
    }
  }
}

/**
 * Whether a type is a controller.
 *
 * `[ApiController]` says so outright. So does a `[Route]` attribute on a class, which is
 * what an MVC controller that predates the attribute has. The `Controller` name suffix is
 * the third and weakest, and it is only trusted when the class also declares at least one
 * verb attribute — a class called `PaymentController` with no `[HttpGet]` anywhere in it
 * is somebody's naming convention, not a door.
 */
function isController(def: GDef, attributes: Map<string, GCall[]>): boolean {
  const own = attributes.get(def.name) ?? [];
  if (own.some((call) => call.callee === 'ApiController' || call.callee === 'Route')) return true;
  if (!/Controller$/.test(def.name)) return false;
  for (const [scope, calls] of attributes) {
    if (!scope.startsWith(`${def.name}.`)) continue;
    if (calls.some((call) => VERB_ATTRIBUTES[call.callee])) return true;
  }
  return false;
}

/**
 * The template one attribute declares, with ASP.NET's own tokens filled in.
 *
 * `[Route("api/[controller]")]` on `OrdersController` is `api/orders` — the framework
 * substitutes the class name minus its suffix, lowercased, and a reader who is shown
 * `api/[controller]` has been handed the source instead of the address.
 */
function routeTemplate(calls: GCall[], className: string, methodName: string | null): string {
  for (const call of calls) {
    const first = calls.length === 1 ? call.args[0] : call.callee === 'Route' ? call.args[0] : undefined;
    if (!first || first.t !== 'str') continue;
    return substituteTokens(first.v, className, methodName);
  }
  return '';
}

function substituteTokens(template: string, className: string, methodName: string | null): string {
  return template
    .replace(/\[controller\]/gi, className.replace(/Controller$/, '').toLowerCase())
    .replace(/\[action\]/gi, (methodName ?? '').toLowerCase());
}

/** `api/v1/orders` + `{id}` → `/api/v1/orders/{id}`. A leading `/` means "ignore the prefix". */
function joinRoute(prefix: string, template: string): string {
  if (template.startsWith('/')) return normalizeRoute(template);
  if (template.startsWith('~/')) return normalizeRoute(template.slice(1));
  const joined = [prefix, template].filter(Boolean).join('/');
  return normalizeRoute(joined);
}

function normalizeRoute(route: string): string {
  const collapsed = `/${route}`.replace(/\/{2,}/g, '/');
  return collapsed.length > 1 ? collapsed.replace(/\/$/, '') : '/';
}

function authorizeGuard(file: GenericFile, call: GCall, where: string): GuardInfo {
  return {
    name: `[Authorize] on ${where}`,
    how: 'decorator',
    provider: 'ASP.NET Core',
    path: file.path,
    line: call.line,
    // The attribute is on the declaration itself: nothing was followed, nothing was
    // matched by name, and the framework's own rule is that it runs.
    confidence: 'certain',
  };
}

// ---------------------------------------------------------------------------
// Doors: minimal APIs
// ---------------------------------------------------------------------------

/**
 * `app.MapGet("/orders", handler)` and the group prefixes it may hang under.
 *
 * The whole route is one expression here, which makes this the easier half — except for
 * `.RequireAuthorization()`, which is chained *onto* the registration and therefore
 * arrives as a separate call whose text contains the whole thing. Containment is what
 * connects them: the chained call's character range covers the registration's.
 */
function detectMinimalApis(
  input: BoundaryInput,
  findings: BoundaryFinding[],
  at: (call: GCall, snippet?: string) => CodeSite,
): void {
  const { file } = input;
  const groups = groupPrefixes(file);
  const groupChains = groupFilters(file);

  for (const call of file.calls) {
    const method = bareMethod(call);
    const verb = MAP_METHODS[method] ?? (method === 'MapMethods' ? verbOfMapMethods(call) : null);

    if (!verb) {
      // `app.MapHub<ChatHub>("/hub")`, `app.MapRazorPages()` — real doors whose verb is
      // not an HTTP one. Named rather than counted, and never given a verb they do not have.
      if (!HUB_MAPS.has(method)) continue;
      const path = call.args.find((arg) => arg.t === 'str');
      if (!path || path.t !== 'str') continue;
      const hub = chainedOnto(file, call);
      findings.push({
        type: 'endpoint',
        endpointKind: 'http-route',
        key: `ANY ${normalizeRoute(path.v)}`,
        name: `ANY ${normalizeRoute(path.v)}`,
        method: 'ANY',
        route: normalizeRoute(path.v),
        framework: 'ASP.NET Core',
        writes: false,
        guards: hub.guards,
        paramTypes: hub.filters,
        site: at(call, `${call.callee}("${path.v}")`),
        handlerId: input.nodeIdForScope(call.scope),
      });
      continue;
    }

    const first = call.args.find((arg) => arg.t === 'str');
    if (!first || first.t !== 'str') continue;

    const route = joinRoute(groups.get(call.receiver ?? '') ?? '', first.v.replace(/^\//, ''));
    // A filter chained onto the group covers every route registered on it — written on
    // another statement, in this same file, which is where the evidence has to be.
    const chain = chainedOnto(file, call);
    const inherited = groupChains.get(call.receiver ?? '');
    // The handler is the argument, not the method the registration sits in (#99). A
    // method-group handler — `app.MapGet("/x", handler.GetX)` — is a real definition
    // and the door points at it; a lambda has no node yet, so its range rides on the
    // finding for the plugin to turn into one.
    const handler = handlerOf(call, input);
    findings.push({
      type: 'endpoint',
      endpointKind: 'http-route',
      key: `${verb} ${route}`,
      name: `${verb} ${route}`,
      method: verb,
      route,
      framework: 'ASP.NET Core',
      writes: WRITE_METHODS.has(verb),
      guards: [...chain.guards, ...(inherited?.guards ?? [])],
      paramTypes: [...chain.filters, ...(inherited?.filters ?? [])],
      site: at(call, `${call.callee}("${first.v}")`),
      handlerId: handler.id ?? input.nodeIdForScope(call.scope),
      ...(handler.span ? { handlerSpan: handler.span } : {}),
    });
  }
}

/**
 * The handler argument of a minimal-API registration, walked from the end because the
 * route string comes first. A named handler that this file declares is answered with
 * its node; one it does not declare (an instance method group on an injected service)
 * resolves to nothing, and the door falls back to what it always did.
 */
function handlerOf(
  call: GCall,
  input: BoundaryInput,
): { id?: string | null; span?: { startIndex: number; endIndex: number; line: number; endLine: number } } {
  for (let i = call.args.length - 1; i >= 0; i--) {
    const arg = call.args[i]!;
    if (arg.t === 'func') {
      return { span: { startIndex: arg.startIndex, endIndex: arg.endIndex, line: arg.line, endLine: arg.endLine } };
    }
    if (arg.t === 'name') {
      const id = input.nodeIdForName(arg.v) ?? input.nodeIdForName(arg.v.split('.').pop() ?? arg.v);
      return id ? { id } : {};
    }
  }
  return {};
}

/** `app.MapMethods("/x", new[] { "GET", "POST" }, h)` — the verb is in the array. */
function verbOfMapMethods(call: GCall): string | null {
  const verbs = call.args.filter((arg): arg is { t: 'str'; v: string } => arg.t === 'str').slice(1);
  const found = verbs.map((arg) => arg.v.toUpperCase()).filter((verb) => /^[A-Z]+$/.test(verb));
  return found[0] ?? null;
}

/**
 * `var admin = app.MapGroup("/admin");` — the prefix every route on `admin` carries.
 *
 * Read off the bindings the query already recorded, so a group defined three lines above
 * its routes composes without any of the mount machinery. A group whose parent is itself
 * a group composes too, which is how a versioned API is usually written.
 */
function groupPrefixes(file: GenericFile): Map<string, string> {
  const direct = new Map<string, { prefix: string; parent: string | null }>();
  for (const call of file.calls) {
    if (bareMethod(call) !== 'MapGroup') continue;
    const arg = call.args.find((value) => value.t === 'str');
    if (!arg || arg.t !== 'str') continue;
    // `includes`, not `endsWith`: `app.MapGroup("/x").RequireDevice()` binds the name to
    // the *outermost* call in the chain, and matching only the end loses the group
    // entirely — its prefix and its filter both, on the one line that declared them.
    const bound = file.bindings.find((binding) => binding.callee.includes('MapGroup') && binding.line === call.line);
    if (!bound) continue;
    direct.set(bound.name, { prefix: arg.v.replace(/^\//, ''), parent: call.receiver });
  }

  const out = new Map<string, string>();
  for (const [name] of direct) {
    const parts: string[] = [];
    let current: string | null = name;
    // Bounded rather than `while (current)`: a binding that somehow refers to itself
    // would otherwise spin, and four levels is deeper than any real API is grouped.
    for (let hop = 0; hop < 4 && current; hop++) {
      const entry: { prefix: string; parent: string | null } | undefined = direct.get(current);
      if (!entry) break;
      parts.unshift(entry.prefix);
      current = entry.parent;
    }
    out.set(name, parts.filter(Boolean).join('/'));
  }
  return out;
}

/**
 * The filters chained onto each group, which every route registered on it inherits.
 *
 * `var admin = app.MapGroup("/api/admin").RequireSupervisor();` locks a dozen routes in
 * one line, and none of those routes says so anywhere near itself. Read here because the
 * group and its routes are in the same file — the evidence is on screen together, which
 * is the bar for claiming a lock rather than guessing one.
 */
function groupFilters(file: GenericFile): Map<string, Chain> {
  const out = new Map<string, Chain>();
  for (const call of file.calls) {
    if (bareMethod(call) !== 'MapGroup') continue;
    // `includes`, not `endsWith`: `app.MapGroup("/x").RequireDevice()` binds the name to
    // the *outermost* call in the chain, and matching only the end loses the group
    // entirely — its prefix and its filter both, on the one line that declared them.
    const bound = file.bindings.find((binding) => binding.callee.includes('MapGroup') && binding.line === call.line);
    if (!bound) continue;
    const chain = chainedOnto(file, call);
    if (chain.guards.length > 0 || chain.filters.length > 0) out.set(bound.name, chain);
  }
  return out;
}

/** What was chained onto a route registration: the built-in lock, and everything else. */
interface Chain {
  guards: GuardInfo[];
  /**
   * Names of filters this file cannot resolve — `RequireDevice`, `RequireSupervisor`.
   * Carried on the door for `build.ts` to match against the `auth-checker` findings,
   * which is how a filter defined in `Auth.cs` reaches a route declared three files away.
   */
  filters: string[];
}

/**
 * What is chained onto this registration, and what it means.
 *
 * `.RequireAuthorization()` and `.AllowAnonymous()` arrive as calls whose character range
 * contains the registration's, because that is what chaining looks like in a parse tree.
 * So does everything else in the chain — and the rest is the interesting part, because a
 * .NET service that rolls its own auth writes `.RequireDevice()` there instead, and its
 * body is in another file.
 *
 * Nothing here decides that `RequireDevice` is a lock. This only records that the route
 * has it; whether it is a check is settled by whether some file declares a method of that
 * name that answers 401, which is a fact about that method rather than about its name.
 */
function chainedOnto(file: GenericFile, call: GCall): Chain {
  const out: Chain = { guards: [], filters: [] };

  for (const other of file.calls) {
    if (other === call) continue;
    if (other.startIndex > call.startIndex || other.endIndex < call.endIndex) continue;

    const method = bareMethod(other);
    // An explicit opt-out beats everything chained beside it, exactly as the attribute
    // does on a controller.
    if (method === ALLOW_ANONYMOUS_CALL) return { guards: [], filters: [] };
    if (method === REQUIRE_AUTH) {
      out.guards.push({
        name: `.${REQUIRE_AUTH}()`,
        how: 'middleware',
        provider: 'ASP.NET Core',
        path: file.path,
        line: other.line,
        confidence: 'certain',
      });
      continue;
    }
    if (!method || NOT_A_FILTER.has(method) || MAP_METHODS[method] || HUB_MAPS.has(method)) continue;
    if (!out.filters.includes(method)) out.filters.push(method);
  }

  return out;
}

/**
 * Every method in this file that turns a caller away with a 401 or a 403.
 *
 * The Go tier's rule, in C#: `r.Use(Logger)` and `r.Use(RequireAuth)` are the same line
 * of code, and only one of them ever puts one of those two statuses on the wire. What is
 * read here is the body — the status constant it names, or the `Results.Unauthorized()`
 * it calls — so a filter called `Gatekeeper` counts and one called `RequireTelemetry`
 * does not.
 *
 * Emitted for every such method, and it costs nothing when nobody chains it: the merge
 * layer only ever looks one up by a name a *route* carried. A login handler that answers
 * 401 to a bad password is named here and matches nothing, which is the right outcome.
 */
function detectCheckers(input: BoundaryInput, findings: BoundaryFinding[]): void {
  const { file } = input;

  for (const def of file.defs) {
    if (def.kind !== 'function') continue;

    const names = [...def.uses, ...def.qualifiedUses];
    const rejects =
      names.some((name) => REJECTION_STATUS.test(name)) ||
      names.some((name) => REJECTION_CALL.test(name)) ||
      file.calls.some(
        (call) =>
          call.scope === (def.owner ? `${def.owner}.${def.name}` : def.name) &&
          call.args.some((arg) => arg.t === 'num' && REJECTION_CODE.has(arg.v)),
      );
    if (!rejects) continue;

    findings.push({
      type: 'auth-checker',
      name: def.name,
      guard: {
        name: `.${def.name}()`,
        how: 'middleware',
        provider: 'custom',
        path: file.path,
        line: def.line,
        // The route names the filter and the filter answers 401. Both halves are written
        // down; what is not proven is that every path through it rejects, which is the
        // same thing `likely` means everywhere else in this codebase.
        confidence: 'likely',
      },
    });
  }
}

// ---------------------------------------------------------------------------
// The door people sign in through
// ---------------------------------------------------------------------------

/**
 * The calls that hand a session out, which is #40's rule in .NET: a door whose handler
 * issues the session cannot demand one first, and without this finding a login route is
 * indistinguishable from a route somebody forgot to lock.
 *
 * A closed list of the framework's own methods, not a pattern. Identity's sign-in
 * surface all ends in `SignInAsync`, but matching that suffix would also excuse a door
 * because somebody *named* a method `KioskSignInAsync` — and `/api/auth/setup` staying
 * on the worry list is exactly as important as `/api/auth/login` leaving it. A .NET app
 * with a hand-rolled scheme gets nothing from this table, which is the honest limit of
 * a list: under-excusing leaves a deliberate door on the list, over-excusing silences a
 * real one.
 */
const SIGN_IN_CALLS: Record<string, SignInKind> = {
  SignInAsync: 'sign-in',
  PasswordSignInAsync: 'sign-in',
  CheckPasswordSignInAsync: 'sign-in',
  RefreshSignInAsync: 'sign-in',
  TwoFactorSignInAsync: 'sign-in',
  TwoFactorAuthenticatorSignInAsync: 'sign-in',
  TwoFactorRecoveryCodeSignInAsync: 'sign-in',
  ExternalLoginSignInAsync: 'sign-in',
  SignOutAsync: 'sign-out',
};

/** The methods only ASP.NET Core Identity spells; the rest are the cookie middleware's. */
const IDENTITY_ONLY = /^(Password|CheckPassword|Refresh|TwoFactor|ExternalLogin)/;

function detectSignInCalls(
  input: BoundaryInput,
  findings: BoundaryFinding[],
  at: (call: GCall, snippet?: string) => CodeSite,
): void {
  const { file } = input;
  for (const call of file.calls) {
    const method = bareMethod(call);
    const what = SIGN_IN_CALLS[method];
    // A bare `SignInAsync()` with no receiver is not the framework's — every real call
    // site is `HttpContext.SignInAsync` or `_signInManager.PasswordSignInAsync`.
    if (!what || !call.receiver || !call.scope) continue;
    findings.push({
      type: 'sign-in-call',
      provider: IDENTITY_ONLY.test(method) ? 'ASP.NET Core Identity' : 'ASP.NET Core',
      what,
      call: `${call.callee}(…)`,
      nodeId: input.nodeIdForScope(call.scope),
      site: at(call, `${call.callee}(…)`),
    });
  }
}

// ---------------------------------------------------------------------------
// Doors: hosted services, which run without anybody knocking
// ---------------------------------------------------------------------------

/**
 * The types whose whole meaning is "this runs with the app".
 *
 * `BackgroundService` is an abstract class with one method to override and no second
 * reason to inherit it; the two interfaces are the same idea in older code. Nothing here
 * matches by the *name of the app's own class* — `SyncWorker` could be anything, and the
 * evidence is the base list, not the word Worker.
 */
const HOSTED_BASES = new Set(['BackgroundService', 'IHostedService', 'IHostedLifecycleService']);

/**
 * Hosting ships inside every ASP.NET runtime and inside `Microsoft.NET.Sdk.Worker`, so —
 * exactly as with the web SDK — a real service can declare no hosting package at all.
 */
function isDotnetHost(input: BoundaryInput): boolean {
  if (isAspNet(input)) return true;
  if (input.signals.dotnetSdks?.has('Microsoft.NET.Sdk.Worker')) return true;
  for (const id of input.signals.dotnetPackages ?? []) {
    if (id.startsWith('Microsoft.Extensions.Hosting')) return true;
  }
  return input.file.imports.some((imp) => imp.module.startsWith('Microsoft.Extensions.Hosting'));
}

/**
 * `class Sync : BackgroundService`, and `builder.Services.AddHostedService<Sync>()`.
 *
 * The .NET equivalent of a cron job or a queue worker: it starts with the application
 * and touches the database and the network without any request arriving. On the repo
 * that filed #100, one of these is what actually pushes time records to the vendor —
 * the most consequential code in the app, and the one thing the map did not mention.
 *
 * Both pieces of evidence are declarations, either is enough on its own, and both emit
 * under the same key, so a class in one file and its registration in another merge into
 * one door that names the type and the place it was wired in.
 */
function detectHostedServices(
  input: BoundaryInput,
  findings: BoundaryFinding[],
  at: (call: GCall, snippet?: string) => CodeSite,
): void {
  const { file } = input;

  const worker = (className: string, schedule: string | null, site: CodeSite) => {
    findings.push({
      type: 'endpoint',
      endpointKind: 'worker',
      key: `worker ${className}`,
      name: className,
      method: 'RUNS',
      route: null,
      framework: '.NET Generic Host',
      writes: true,
      guards: [],
      ...(schedule ? { schedule } : {}),
      site,
      // `ExecuteAsync` is the method the framework calls, so it is the handler; the
      // class is the fallback when the override is named something older.
      handlerId: input.nodeIdForName(`${className}.ExecuteAsync`) ?? input.nodeIdForName(className),
      handlerOwner: className,
    });
  };

  for (const def of file.defs) {
    if (def.kind !== 'type' || !def.bases.some((base) => HOSTED_BASES.has(base))) continue;
    worker(def.name, workerSchedule(file, def), {
      path: file.path,
      line: def.line,
      nodeId: input.nodeIdForName(def.name) ?? input.fileId,
      snippet: `class ${def.name} : ${def.bases.join(', ')}`,
    });
  }

  for (const call of file.calls) {
    if (bareMethod(call) !== 'AddHostedService') continue;
    const typeArg = /^AddHostedService<\s*([\w.]+)\s*>$/.exec(call.method ?? '');
    if (!typeArg) continue;
    const className = typeArg[1].split('.').pop()!;
    worker(className, null, at(call, `AddHostedService<${className}>()`));
  }
}

/**
 * The interval the class itself wrote down, or null.
 *
 * A `BackgroundService` usually loops on a `PeriodicTimer` or a `Task.Delay`, and the
 * interval is sometimes a literal and sometimes configuration. Where it is a literal —
 * `new PeriodicTimer(TimeSpan.FromMinutes(5))` — it is read; where it is not, this
 * returns null and the door says nothing, because "runs continuously" is true and
 * "every 5 minutes" would be invented.
 */
const TIMESPAN_UNITS: Record<string, string> = {
  FromMilliseconds: 'ms',
  FromSeconds: 'second',
  FromMinutes: 'minute',
  FromHours: 'hour',
  FromDays: 'day',
};

function workerSchedule(file: GenericFile, def: GDef): string | null {
  for (const timer of file.calls) {
    if (timer.startIndex < def.startIndex || timer.endIndex > def.endIndex) continue;
    const callee = timer.callee;
    if (callee !== 'PeriodicTimer' && !/(^|\.)Task\.Delay$/.test(callee)) continue;

    // The TimeSpan call is an argument, so its range sits inside the timer's.
    for (const span of file.calls) {
      if (span.startIndex < timer.startIndex || span.endIndex > timer.endIndex || span === timer) continue;
      const unit = TIMESPAN_UNITS[bareMethod(span)];
      if (!unit || !/(^|\.)TimeSpan\.\w+$/.test(span.callee)) continue;
      const amount = span.args.find((arg) => arg.t === 'num');
      if (!amount || amount.t !== 'num') continue;
      if (unit === 'ms') return `every ${amount.v} ms`;
      return amount.v === '1' ? `every ${unit}` : `every ${amount.v} ${unit}s`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Where data goes
// ---------------------------------------------------------------------------

/**
 * Entity Framework's tables, and Dapper's SQL.
 *
 * A `DbContext` writes its tables down as properties — `public DbSet<Order> Orders` — and
 * that is a better list than anything the queries could be mined for: it is every table
 * the app knows about, declared, in one place, whether or not code has touched it yet.
 * The queries then say which way the data moved.
 */
function detectStores(
  input: BoundaryInput,
  findings: BoundaryFinding[],
  at: (call: GCall, snippet?: string) => CodeSite,
): void {
  const { file } = input;

  // --- the declared tables -------------------------------------------------
  const tables = new Map<string, string>();
  for (const def of file.defs) {
    if (def.kind !== 'type') continue;
    for (const field of def.fields) {
      const entity = /^DbSet<\s*([A-Za-z_][\w.]*)\s*>$/.exec(field.type);
      if (!entity) continue;
      tables.set(field.name, field.name);
      findings.push({
        type: 'store',
        key: 'efcore',
        name: 'Database',
        client: 'Entity Framework Core',
        storeKind: 'sql',
        table: field.name,
        // A declaration is not a use. The table exists and this line proves it; which way
        // the data moves is what the queries below say, and inventing a direction here
        // would put a write on a screen somebody reads to find out what writes.
        operation: null,
        // …and it is the half of #104's pairing every other file resolves against.
        declares: true,
        site: { path: file.path, line: def.line, nodeId: input.nodeIdForName(def.name) ?? input.fileId },
      });
    }
  }

  const hasEf =
    tables.size > 0 ||
    file.imports.some((imp) => imp.module.startsWith('Microsoft.EntityFrameworkCore')) ||
    (input.signals.dotnetPackages && [...input.signals.dotnetPackages].some((id) => id.startsWith('Microsoft.EntityFrameworkCore')));
  const hasDapper =
    file.imports.some((imp) => imp.module === 'Dapper') ||
    (input.signals.dotnetPackages && [...input.signals.dotnetPackages].some((id) => id === 'Dapper' || id.startsWith('Dapper.')));

  // --- a SQL statement, wherever it was written ----------------------------
  // The statement is the evidence, which is the rule the Python detector already runs
  // on and the only one that survives contact with real .NET. This repo's entire
  // storage layer goes through `connection.Sql("SELECT …")` — a four-line extension
  // method somebody wrote — and a rule that only knows Dapper's method names and
  // `CommandText` finds none of it. What a query is written *through* is that repo's
  // business; that a `SELECT` ran is not.
  const engine = adoEngine(input);
  const sqlFrom = (text: string, line: number, scope: string | null, snippet: string, method: string) => {
    const [sql] = holesRemoved(text);
    // The shape test, not the first word. Without it, "Update the settings for this
    // shop" is a write against a table called `the`.
    if (!isSqlStatement(sql)) return;
    const statement = readSqlStatement(sql);
    if (!statement) return;
    const dapper = hasDapper && DAPPER_CALLS.has(method);
    findings.push({
      type: 'store',
      key: `${dapper ? 'dapper' : engine ? 'ado' : 'sql'}${engine ? `-${engine.toLowerCase()}` : ''}`,
      name: engine ?? 'Database',
      client: dapper ? 'Dapper' : engine ? 'ADO.NET' : 'SQL',
      storeKind: 'sql',
      table: statement.table,
      operation: statement.operation,
      // No driver imported anywhere means the statement proves a database and names
      // nothing. `build.ts` folds a generic store into the named one when the project
      // has exactly one, and leaves it standing alone when it does not.
      ...(dapper || engine ? {} : { generic: true }),
      site: { path: file.path, line, nodeId: input.nodeIdForScope(scope), snippet },
    });
  };

  for (const binding of file.bindings) {
    if (!/(^|\.)CommandText$/.test(binding.name) || !binding.arg) continue;
    sqlFrom(binding.arg, binding.line, binding.scope, `CommandText = "${oneLine(binding.arg)}"`, '');
  }

  for (const call of file.calls) {
    for (const arg of call.args) {
      if (arg.t !== 'str') continue;
      sqlFrom(arg.v, call.line, call.scope, `${call.callee}("${oneLine(arg.v)}")`, bareMethod(call));
      break;
    }
  }

  for (const call of file.calls) {
    const method = bareMethod(call);
    if (!hasEf) continue;

    // --- EF Core: the receiver names the table ------------------------------
    // `db.Orders.Add(order)` — the segment before the call is the DbSet, which is the
    // table. `db.SaveChangesAsync()` is a write with no table of its own: it flushes
    // whatever was staged, and saying which table would be a guess.
    if (method === 'SaveChanges' || method === 'SaveChangesAsync') {
      findings.push({
        type: 'store',
        key: 'efcore',
        name: 'Database',
        client: 'Entity Framework Core',
        storeKind: 'sql',
        table: null,
        operation: 'write',
        site: at(call, `${call.callee}()`),
      });
      continue;
    }

    const table = tableOfReceiver(call.receiver, tables);

    // Two tiers of evidence. An EF-only method is proof on its own; a LINQ verb is proof
    // only when it is written on a table — this file's own `DbSet`, or one declared in
    // another file, which is #104's whole problem: a `DbContext` usually lives alone,
    // so a controller's `_db.Orders.ToListAsync()` is a read whose table this file
    // cannot name. The receiver is carried instead, and the merge layer matches it
    // against the tables the project declared once every file has been read.
    const efOnly = EF_ONLY_WRITES.has(method) ? 'write' : EF_ONLY_READS.has(method) ? 'read' : null;
    const linq = LINQ_WRITES.has(method) ? 'write' : LINQ_READS.has(method) ? 'read' : null;
    const operation = efOnly ?? (table ? linq : null);
    // A dotted receiver — `_db.Orders`, never a bare `items` — is the shape a DbSet
    // reached through a context has. A single name stays what it always was: a list.
    const deferred = !table && call.receiver?.includes('.') ? call.receiver : null;

    if (operation) {
      findings.push({
        type: 'store',
        key: 'efcore',
        name: 'Database',
        client: 'Entity Framework Core',
        storeKind: 'sql',
        table,
        operation,
        ...(deferred ? { tableReceiver: deferred } : {}),
        site: at(call, `${call.callee}(…)`),
      });
    } else if (linq && deferred) {
      findings.push({
        type: 'store',
        key: 'efcore',
        name: 'Database',
        client: 'Entity Framework Core',
        storeKind: 'sql',
        table: null,
        operation: linq,
        tableReceiver: deferred,
        // A LINQ verb is only evidence if the receiver turns out to be a table. If it
        // does not, this finding must vanish rather than survive with a null table —
        // kept, it would count somebody's list as a database.
        requiresTable: true,
        site: at(call, `${call.callee}(…)`),
      });
    }
  }
}

/**
 * An interpolated string with its holes closed up, and whether it is still whole.
 *
 * `$"SELECT {Columns} FROM punches WHERE id = $id"` names a table a reader can go and
 * find, and losing it because the *column list* was interpolated would cost most of the
 * queries in a real repo. `$"SELECT * FROM {table}"` names nothing, and reading it
 * naively answers `WHERE` with a straight face — the failure the Python detector
 * documents.
 *
 * Both are handled by putting something in the hole that cannot be mistaken for an
 * identifier. Then the ordinary reader gets the table when the table was written down,
 * and gets nothing when it was not.
 */
function holesRemoved(text: string): [string, boolean] {
  if (!text.includes('{')) return [text, true];
  return [text.replace(/\{[^{}]*\}/g, ' ? '), true];
}

/** One line of a query, short enough to sit in a snippet. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 70);
}

/**
 * Which engine this project's ADO.NET calls reach, or null when it has no driver.
 *
 * The file's own `using` first, because a repo can talk to two databases and the file
 * that talks to one of them says which. Falling back to the project's references keeps
 * a file working when the driver arrived through a helper.
 */
function adoEngine(input: BoundaryInput): string | null {
  for (const imported of input.file.imports) {
    for (const [driver, engine] of Object.entries(ADO_DRIVERS)) {
      if (imported.module === driver || imported.module.startsWith(`${driver}.`)) return engine;
    }
  }
  for (const id of input.signals.dotnetPackages ?? []) {
    for (const [driver, engine] of Object.entries(ADO_DRIVERS)) {
      if (id === driver || id.startsWith(`${driver}.`)) return engine;
    }
  }
  return null;
}

/**
 * `db.Orders` → `Orders`, and `_context.Orders.Where(…).Select(…)` → `Orders` too.
 *
 * Only ever a name this file declared as a `DbSet`. Taking any capitalised segment would
 * turn `logger.LogInformation` into a table called `LogInformation`, which is how a map
 * ends up naming things the database has never heard of.
 */
function tableOfReceiver(receiver: string | null, tables: Map<string, string>): string | null {
  if (!receiver) return null;
  for (const segment of receiver.split('.').reverse()) {
    const table = tables.get(segment);
    if (table) return table;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Outbound
// ---------------------------------------------------------------------------

/**
 * `_http.GetAsync("https://api.example.com/v1")`, and the base address a typed client is
 * configured with.
 *
 * Same rule as everywhere else in this codebase: a literal URL is a fact and the host is
 * reported; an unrecognised domain is named, never guessed into a brand; and a call with
 * no literal URL in it says an HTTP request happens and nothing about who answers it,
 * which is not enough to put a company on anybody's map.
 */
function detectOutbound(
  input: BoundaryInput,
  findings: BoundaryFinding[],
  at: (call: GCall, snippet?: string) => CodeSite,
): void {
  const { file } = input;
  const constants = new Map<string, string>();
  for (const constant of file.constants) {
    if (/^https?:\/\//i.test(constant.value)) constants.set(constant.name, constant.value);
  }

  const report = (url: string, call: GCall, writes: boolean) => {
    const host = hostOf(url);
    if (!host || isInternalHost(host)) return;
    const known = serviceForHost(host);
    findings.push({
      type: 'service',
      name: known?.name ?? host,
      category: known?.category ?? 'other',
      package: null,
      host,
      external: true,
      writes,
      site: at(call, `${call.callee}("${url}")`),
    });
  };

  for (const call of file.calls) {
    const method = bareMethod(call);

    // `new Uri("https://…")` handed to a BaseAddress, and the HttpClient calls themselves.
    const writes = HTTP_CALLS[method];
    if (writes !== undefined) {
      const url = literalUrl(call.args, constants);
      if (url) report(url, call, writes);
      continue;
    }
    if (method === 'Uri') {
      const url = literalUrl(call.args, constants);
      if (url) report(url, call, false);
    }
  }
}

/** The first argument that is, or resolves to, an absolute URL. */
function literalUrl(args: GValue[], constants: Map<string, string>): string | null {
  for (const arg of args) {
    if (arg.t === 'str' && /^https?:\/\//i.test(arg.v)) return arg.v;
    if (arg.t === 'name') {
      const resolved = constants.get(arg.v.split('.').pop() ?? arg.v);
      if (resolved) return resolved;
    }
  }
  return null;
}

function hostOf(url: string): string | null {
  const match = /^https?:\/\/([^/?#]+)/i.exec(url.trim());
  if (!match) return null;
  const host = (match[1].split('@').pop() ?? '').split(':')[0].toLowerCase();
  return host.length > 0 ? host : null;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * `Environment.GetEnvironmentVariable("STRIPE_KEY")`.
 *
 * Only the environment, deliberately. `builder.Configuration["Stripe:Key"]` reads from a
 * stack of providers — appsettings.json, user secrets, key vault, and the environment
 * last — and reporting a JSON settings key as an environment variable would put names in
 * the env list that no deployment has ever set.
 */
function detectEnv(
  input: BoundaryInput,
  findings: BoundaryFinding[],
  at: (call: GCall, snippet?: string) => CodeSite,
): void {
  for (const call of input.file.calls) {
    if (bareMethod(call) !== 'GetEnvironmentVariable') continue;
    const name = call.args.find((arg) => arg.t === 'str');
    if (!name || name.t !== 'str') continue;
    findings.push({ type: 'env', name: name.v, site: at(call, `${call.callee}("${name.v}")`) });
  }
}
