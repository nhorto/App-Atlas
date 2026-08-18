/**
 * @fileoverview Rocket: the routes, and the request guards standing in front of them.
 *
 * `boundaries.ts` opens by saying axum and Rocket routes are "left absent rather than
 * guessed at", and that was right while the alternative was guessing. #257 is what it
 * cost: `dani-garcia/vaultwarden` — a Bitwarden-compatible password server — declares 305
 * routes across 60 files and reported **zero doors**. #263 stopped the surfaces calling
 * that "nothing answers a URL"; this reads them.
 *
 * ## Why the routes were the easy half
 *
 * Rocket writes a route as an attribute holding the path, which is the shape
 * `detectCommands` already reads for `#[tauri::command]`:
 *
 * ```rust
 * #[get("/accounts/profile")]
 * async fn profile(headers: Headers, conn: DbConn) -> Json<Value> { … }
 * ```
 *
 * The gate is the manifest rather than the file, and that is a real difference from
 * #195's rule for Tauri. Rocket is brought in with `#[macro_use] extern crate rocket;` at
 * the crate root, so the file declaring the routes imports nothing to key on.
 *
 * ## And why the guards were the hard half — three designs, two of them wrong
 *
 * Emitting routes alone would have made the map worse, not better: 307 doors on a
 * password server, every one of them reading "no auth check". That is #139's netbox shape
 * and the blanket false alarm `exposure.ts` exists to prevent. So the guards had to come
 * with them, and Rocket's guard is the *parameter's type* — a `FromRequest` impl that
 * refuses on its own terms.
 *
 * Deciding which of those types is a check took three tries, and the two failures are the
 * reason this comment is long:
 *
 * 1. **"Count the refusals in the body."** vaultwarden's guards contain no status code at
 *    all — every refusal is `err_handler!(…)`, a project macro whose 401 lives in another
 *    file, and `macro_rules!` bodies are not in the IR. Measured across five Rust services
 *    (#267): vaultwarden is the only one that does this, so extracting macro bodies was
 *    declined as a one-repo change.
 * 2. **"A guard that returns `Outcome::Forward` is refusing."** Plume — a second Rocket
 *    app — refuses that way in four of its five checks, so this looked right. It is not:
 *    Plume's `Password` and `Email` guards forward too, and they read *nothing from the
 *    request*, gating on whether signups are open. That is #203 exactly, and the rule
 *    would have locked Plume's signup pages.
 *
 * What survives is the question this file actually asks, and it works precisely because
 * it stops asking *how* a guard refuses:
 *
 * > **Does this guard read a credential out of the request?**
 *
 * Seven for seven across both repositories and all four refusal spellings. It is #203's
 * rule turned around — a refusal whose condition never reads the request is not a check on
 * the caller — and the vocabulary is the one `auth.ts` already keeps.
 */
import type { GuardInfo } from '../../../model/types.js';
import { unreadHead } from '../../boundaries/address.js';
import type { BoundaryFinding } from '../../boundaries/types.js';
import type { BoundaryInput } from '../languages.js';
import type { GCall, GDef, GenericFile } from '../ir.js';

/** The attributes Rocket declares a route with. `route` is the generic form. */
const ROUTE_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch', 'head', 'options']);

/** Verbs that change something, for the same reason every other tier records it. */
const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * What a credential looks like when a guard reaches for one.
 *
 * Headers first, and deliberately narrow: vaultwarden's `Host` guard reads `Referer`,
 * `X-Forwarded-Proto` and `X-Forwarded-For`, and it authenticates nobody. "Reads a header"
 * would claim it and put a lock on every door in the crate; "reads *this* header" does
 * not. Same reason `KnownDevice`'s `X-Request-Email` is absent — an address is not a
 * secret.
 */
const CREDENTIAL_HEADER = /^(authorization|proxy-authorization|x-api-key|api-key|x-auth-token|x-access-token|cookie)$/i;

/** `Bearer `, as it is written when a token is split out of the header. */
const BEARER = /^\s*(bearer|basic|token)\s*$/i;

/**
 * A cookie a guard reads to find out who is calling.
 *
 * `get_private` is Rocket's *signed* cookie jar and needs no name test — a program does
 * not sign a theme preference. A plain `get` does, and the test is on the cookie's name
 * rather than the guard's, which is #186's rule: `COOKIE_NAME` and `AUTH_COOKIE` are both
 * constants naming a session, and `remember_theme` is not.
 */
const PRIVATE_COOKIE = /(^|\.)get_private$/;
const COOKIE_READ = /(^|\.)(get|get_one|get_pending)$/;
const NAMES_A_CREDENTIAL = /(^|_)(auth|session|token|cookie|jwt|sid|login|credential)(_|$)/i;

/** Rocket's own name for "hand me another guard first": `request.guard::<User>()`. */
const GUARD_OF = /\bguard::<\s*([A-Za-z_]\w*)/;

interface RustGuard {
  def: GDef;
  /** Reaches into the request for something that identifies the caller. */
  reads: boolean;
  /** Other guard types it defers to before deciding anything. */
  defers: string[];
}

/**
 * The doors, and the checks in front of them.
 *
 * Both halves in one pass because they are read off the same file's definitions, and
 * because emitting either without the other is a worse map than emitting neither.
 */
export function detectRocketBoundaries(input: BoundaryInput, findings: BoundaryFinding[]): void {
  detectRocketGuards(input, findings);
  detectRocketRoutes(input, findings);
}

/**
 * `#[get("/accounts/profile")]` — a Rocket route, with its address hedged.
 *
 * The address is the part this cannot finish, and saying so is the whole of the honesty
 * here. vaultwarden mounts with
 *
 * ```rust
 * .mount([basepath, "/api"].concat(), api::core_routes())
 * ```
 *
 * where `basepath` is deployment configuration. The head of every address in the crate is
 * not knowable from source, and printing `/accounts/profile` for a door that answers at
 * `/api/accounts/profile` is #199 exactly — a fabricated prefix on hundreds of doors,
 * wrong and confident and nothing about it looking wrong. `unreadHead` is the settled
 * spelling: the tail, an ellipsis where the head belongs, and `route: null` so nothing
 * downstream matches a prefix against a fragment.
 *
 * The mount is not read even when it *is* a literal. That is an under-claim, and the
 * reason once written here — "this pass sees one file, the mount lives in another" —
 * was not the reason (#290). On Rocket's own `todo` example all three mounts are string
 * literals in the same `main.rs` that defines all four handlers, and `examples/todo`
 * analyzed alone gives four doors with four hedged addresses, every one of them
 * determinable from that single file. A session reading the old sentence would
 * conclude the information is not there when it is.
 *
 * The real reason is that a map's addresses have to be one kind. Composing only the
 * readable mounts puts `/todo/<id>` beside `…/<id>` in the same list, and a reader
 * cannot tell which of the two is a whole address without knowing this rule.
 *
 * What that costs is now counted rather than assumed. Across 92 Rocket crates that
 * mount anything — Rocket's own examples and test suite, vaultwarden, Plume, and seven
 * smaller applications — **90 mount with string literals only**. One mixes, and it is
 * `rocket_cors` mounting its own error route at a base its user configures. One reads
 * no literal at all, and it is vaultwarden. So an all-or-nothing rule, per crate, would
 * resolve ninety crates completely and hedge two completely, and no crate anywhere in
 * that corpus would come out holding both kinds at once.
 *
 * Which makes this a thing not built rather than a thing that cannot be. The evidence
 * bar #290 set for itself is met; what is left is the work and the decision.
 */
function detectRocketRoutes(input: BoundaryInput, findings: BoundaryFinding[]): void {
  const { file } = input;
  for (const def of file.defs) {
    if (def.kind !== 'function') continue;
    const attr = def.decorators.find(isRouteAttribute);
    if (!attr) continue;
    const route = firstStringIn(attr);
    if (!route) continue;

    const method = attr.slice(0, attr.indexOf('(')).trim().toUpperCase();
    findings.push(
      unreadHead(
        {
          type: 'endpoint',
          endpointKind: 'http-route',
          key: `${method} ${file.path}#${def.name}`,
          name: `${method} ${route}`,
          method: method === 'ROUTE' ? null : method,
          route,
          framework: 'Rocket',
          writes: WRITES.has(method),
          guards: [],
          site: { path: file.path, line: def.line, nodeId: input.nodeIdForScope(def.name) },
          handlerId: input.nodeIdForName(def.name),
          // Rocket's checks are types in the signature, and `build.ts` already matches
          // these against `auth-checker` names — the mechanism FastAPI's `Depends`
          // aliases go through (#136). Nothing new was needed to join them.
          paramTypes: def.params.map((param) => bareType(param.type)).filter(Boolean),
        },
        [file.path, def.name],
        def.name,
      ),
    );
  }
}

/**
 * A `FromRequest` implementation that reads a credential is a check on the caller.
 *
 * Emitted for the *type*, because that is the name a handler's signature says. The chain
 * is resolved here rather than left to the merge for one reason: vaultwarden's derived
 * guards defer three deep in a single file — `AdminHeaders` → `OrgHeaders` → `Headers` —
 * and the merge's alias pass runs once, in whatever order the findings arrive, so a
 * two-hop chain would resolve or not depending on how a file happened to be laid out.
 *
 * A deferral this file cannot follow goes out as an `auth-alias` instead, which is how
 * Plume's `Admin` — declared in `admin.rs`, deferring to `User` in `users.rs` — still
 * finds its check.
 *
 * `likely`, never `certain`. The grade is #148's rule: one implementation's behaviour
 * standing in for a decision no framework confirmed.
 */
function detectRocketGuards(input: BoundaryInput, findings: BoundaryFinding[]): void {
  const { file } = input;
  const guards = new Map<string, RustGuard>();
  for (const def of file.defs) {
    if (def.kind !== 'function' || def.name !== 'from_request' || !def.owner) continue;
    const calls = callsInside(file, def);
    guards.set(def.owner, { def, reads: readsACredential(calls), defers: defersTo(calls) });
  }
  if (guards.size === 0) return;

  // Transitive, and bounded by the number of guards in the file — a cycle simply stops
  // growing the set rather than looping.
  const checks = new Set([...guards].filter(([, g]) => g.reads).map(([name]) => name));
  for (let pass = 0; pass < guards.size; pass++) {
    let grew = false;
    for (const [name, guard] of guards) {
      if (checks.has(name)) continue;
      if (!guard.defers.some((target) => checks.has(target))) continue;
      checks.add(name);
      grew = true;
    }
    if (!grew) break;
  }

  for (const [name, guard] of guards) {
    if (checks.has(name)) {
      const info: GuardInfo = {
        name,
        how: 'middleware',
        provider: 'custom',
        path: file.path,
        line: guard.def.line,
        confidence: 'likely',
      };
      findings.push({ type: 'auth-checker', name, guard: info });
      continue;
    }
    // Not a check on this file's evidence, but it defers to something declared
    // elsewhere. The merge resolves it if that turns out to be a check, and leaves the
    // door unclaimed if it does not — which is the direction to be wrong in.
    const elsewhere = guard.defers.filter((target) => !guards.has(target));
    if (elsewhere.length > 0) {
      findings.push({
        type: 'auth-alias',
        name,
        depends: elsewhere,
        binds: 'FromRequest',
        path: file.path,
        line: guard.def.line,
      });
    }
  }
}

/** Whether this guard reaches into the request for something that identifies the caller. */
function readsACredential(calls: GCall[]): boolean {
  for (const call of calls) {
    const method = call.callee.split('.').pop() ?? '';
    const strings = call.args.filter((arg) => arg.t === 'str').map((arg) => arg.v);
    const names = call.args.filter((arg) => arg.t === 'name').map((arg) => arg.v);

    if (PRIVATE_COOKIE.test(call.callee)) return true;
    if (strings.some((value) => CREDENTIAL_HEADER.test(value) || BEARER.test(value))) return true;
    // `cookies.get(COOKIE_NAME)` — the cookie's name, never the guard's (#186).
    if (COOKIE_READ.test(method) && /cookie/i.test(call.callee) && names.some((n) => NAMES_A_CREDENTIAL.test(n))) {
      return true;
    }
  }
  return false;
}

/**
 * The guard types this one hands to before it decides anything.
 *
 * Two spellings, one per repository, and neither is exotic. Plume writes Rocket's own
 * `request.guard::<User>()`; vaultwarden writes `try_outcome!(OrgHeaders::from_request(
 * request).await)`, whose token tree arrives flattened — `[OrgHeaders, from_request,
 * request]` — so the target is the token sitting immediately before `from_request`.
 */
function defersTo(calls: GCall[]): string[] {
  const out = new Set<string>();
  for (const call of calls) {
    const viaTurbofish = GUARD_OF.exec(call.callee);
    if (viaTurbofish) out.add(viaTurbofish[1]);

    // `OrgHeaders::from_request(request)` written straight out.
    const direct = /^([A-Za-z_]\w*)::from_request$/.exec(call.callee);
    if (direct) out.add(direct[1]);

    // The same call handed to a macro, which flattens it into adjacent tokens.
    for (let i = 1; i < call.args.length; i++) {
      const arg = call.args[i];
      const before = call.args[i - 1];
      if (arg.t === 'name' && arg.v === 'from_request' && before.t === 'name' && /^[A-Z]/.test(before.v)) {
        out.add(before.v);
      }
    }
  }
  return [...out];
}

function callsInside(file: GenericFile, def: GDef): GCall[] {
  return file.calls.filter((call) => call.startIndex >= def.startIndex && call.endIndex <= def.endIndex);
}

function isRouteAttribute(attr: string): boolean {
  const open = attr.indexOf('(');
  if (open === -1) return false;
  const name = attr.slice(0, open).trim();
  return ROUTE_METHODS.has(name) || name === 'route';
}

/** The path out of `get("/accounts/profile",data="<data>")`. */
function firstStringIn(attr: string): string | null {
  const match = /"([^"]*)"/.exec(attr);
  const value = match?.[1] ?? null;
  return value && value.startsWith('/') ? value : null;
}

/** `&'rRequest<'_>` → `Request`; `Json<String>` → `Json`. The name a checker is known by. */
function bareType(type: string): string {
  return type.replace(/^[&*]+/, '').replace(/^'\w+\s*/, '').replace(/<.*$/, '').replace(/^mut\s+/, '').trim();
}
