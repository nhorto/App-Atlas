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
import type { CodeSite, GuardInfo } from '../../../model/types.js';
import { isInternalHost, serviceForHost } from '../../boundaries/catalog.js';
import type { BoundaryFinding } from '../../boundaries/types.js';
import { readSqlStatement } from '../../sql.js';
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
  }
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

  for (const call of file.calls) {
    const method = bareMethod(call);
    const verb = MAP_METHODS[method] ?? (method === 'MapMethods' ? verbOfMapMethods(call) : null);

    if (!verb) {
      // `app.MapHub<ChatHub>("/hub")`, `app.MapRazorPages()` — real doors whose verb is
      // not an HTTP one. Named rather than counted, and never given a verb they do not have.
      if (!HUB_MAPS.has(method)) continue;
      const path = call.args.find((arg) => arg.t === 'str');
      if (!path || path.t !== 'str') continue;
      findings.push({
        type: 'endpoint',
        endpointKind: 'http-route',
        key: `ANY ${normalizeRoute(path.v)}`,
        name: `ANY ${normalizeRoute(path.v)}`,
        method: 'ANY',
        route: normalizeRoute(path.v),
        framework: 'ASP.NET Core',
        writes: false,
        guards: guardsForChain(input, call, findings),
        site: at(call, `${call.callee}("${path.v}")`),
        handlerId: input.nodeIdForScope(call.scope),
      });
      continue;
    }

    const first = call.args.find((arg) => arg.t === 'str');
    if (!first || first.t !== 'str') continue;

    const route = joinRoute(groups.get(call.receiver ?? '') ?? '', first.v.replace(/^\//, ''));
    findings.push({
      type: 'endpoint',
      endpointKind: 'http-route',
      key: `${verb} ${route}`,
      name: `${verb} ${route}`,
      method: verb,
      route,
      framework: 'ASP.NET Core',
      writes: WRITE_METHODS.has(verb),
      guards: guardsForChain(input, call, findings),
      site: at(call, `${call.callee}("${first.v}")`),
      handlerId: input.nodeIdForScope(call.scope),
    });
  }
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
    const bound = file.bindings.find((binding) => binding.callee.endsWith('MapGroup') && binding.line === call.line);
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
 * Whether anything chained onto this registration locks it.
 *
 * `.RequireAuthorization()` and `.AllowAnonymous()` both arrive as calls whose range
 * contains the registration's, because that is what chaining looks like in a parse tree.
 * A group's `.RequireAuthorization()` covers routes registered on it and is deliberately
 * *not* read here — it is written on a different statement, and claiming it would mean
 * asserting a lock this file cannot see applied.
 */
function guardsForChain(input: BoundaryInput, call: GCall, _findings: BoundaryFinding[]): GuardInfo[] {
  const { file } = input;
  let locked: GCall | null = null;
  for (const other of file.calls) {
    if (other === call) continue;
    if (other.startIndex > call.startIndex || other.endIndex < call.endIndex) continue;
    if (bareMethod(other) === ALLOW_ANONYMOUS_CALL) return [];
    if (bareMethod(other) === REQUIRE_AUTH) locked = other;
  }
  if (!locked) return [];
  return [
    {
      name: `.${REQUIRE_AUTH}()`,
      how: 'middleware',
      provider: 'ASP.NET Core',
      path: file.path,
      line: locked.line,
      confidence: 'certain',
    },
  ];
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

  for (const call of file.calls) {
    const method = bareMethod(call);

    // --- Dapper: the table is in the SQL, so read the SQL -------------------
    if (hasDapper && DAPPER_CALLS.has(method)) {
      const sql = call.args.find((arg) => arg.t === 'str');
      const statement = sql && sql.t === 'str' ? readSqlStatement(sql.v) : null;
      if (statement) {
        findings.push({
          type: 'store',
          key: 'dapper',
          name: 'Database',
          client: 'Dapper',
          storeKind: 'sql',
          table: statement.table,
          operation: statement.operation,
          site: at(call, `${call.callee}("${sql && sql.t === 'str' ? sql.v.slice(0, 60) : ''}")`),
        });
      }
      continue;
    }

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
    // only when it is written on a table this file declared. The table itself is a third
    // thing again — a `DbContext` usually lives in its own file, so a controller's
    // `_db.Orders.ToListAsync()` is a database read whose table this file cannot name.
    // `null` says exactly that, and is a great deal better than either silence or a guess.
    const efOnly = EF_ONLY_WRITES.has(method) ? 'write' : EF_ONLY_READS.has(method) ? 'read' : null;
    const viaTable = table ? (LINQ_WRITES.has(method) ? 'write' : LINQ_READS.has(method) ? 'read' : null) : null;
    const operation = efOnly ?? viaTable;
    if (!operation) continue;

    findings.push({
      type: 'store',
      key: 'efcore',
      name: 'Database',
      client: 'Entity Framework Core',
      storeKind: 'sql',
      table,
      operation,
      site: at(call, `${call.callee}(…)`),
    });
  }
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
