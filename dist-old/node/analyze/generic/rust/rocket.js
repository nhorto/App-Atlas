import { unreadHead } from '../../boundaries/address.js';
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
/**
 * The doors, and the checks in front of them.
 *
 * Both halves in one pass because they are read off the same file's definitions, and
 * because emitting either without the other is a worse map than emitting neither.
 */
export function detectRocketBoundaries(input, findings) {
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
 * The mount is not read even when it *is* a literal, and that is a deliberate
 * under-claim rather than an oversight: this pass sees one file, the mount lives in
 * another, and a rule that composed the readable ones would give two doors in the same
 * crate addresses of different kinds.
 */
function detectRocketRoutes(input, findings) {
    const { file } = input;
    for (const def of file.defs) {
        if (def.kind !== 'function')
            continue;
        const attr = def.decorators.find(isRouteAttribute);
        if (!attr)
            continue;
        const route = firstStringIn(attr);
        if (!route)
            continue;
        const method = attr.slice(0, attr.indexOf('(')).trim().toUpperCase();
        findings.push(unreadHead({
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
        }, [file.path, def.name], def.name));
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
function detectRocketGuards(input, findings) {
    const { file } = input;
    const guards = new Map();
    for (const def of file.defs) {
        if (def.kind !== 'function' || def.name !== 'from_request' || !def.owner)
            continue;
        const calls = callsInside(file, def);
        guards.set(def.owner, { def, reads: readsACredential(calls), defers: defersTo(calls) });
    }
    if (guards.size === 0)
        return;
    // Transitive, and bounded by the number of guards in the file — a cycle simply stops
    // growing the set rather than looping.
    const checks = new Set([...guards].filter(([, g]) => g.reads).map(([name]) => name));
    for (let pass = 0; pass < guards.size; pass++) {
        let grew = false;
        for (const [name, guard] of guards) {
            if (checks.has(name))
                continue;
            if (!guard.defers.some((target) => checks.has(target)))
                continue;
            checks.add(name);
            grew = true;
        }
        if (!grew)
            break;
    }
    for (const [name, guard] of guards) {
        if (checks.has(name)) {
            const info = {
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
function readsACredential(calls) {
    for (const call of calls) {
        const method = call.callee.split('.').pop() ?? '';
        const strings = call.args.filter((arg) => arg.t === 'str').map((arg) => arg.v);
        const names = call.args.filter((arg) => arg.t === 'name').map((arg) => arg.v);
        if (PRIVATE_COOKIE.test(call.callee))
            return true;
        if (strings.some((value) => CREDENTIAL_HEADER.test(value) || BEARER.test(value)))
            return true;
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
function defersTo(calls) {
    const out = new Set();
    for (const call of calls) {
        const viaTurbofish = GUARD_OF.exec(call.callee);
        if (viaTurbofish)
            out.add(viaTurbofish[1]);
        // `OrgHeaders::from_request(request)` written straight out.
        const direct = /^([A-Za-z_]\w*)::from_request$/.exec(call.callee);
        if (direct)
            out.add(direct[1]);
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
function callsInside(file, def) {
    return file.calls.filter((call) => call.startIndex >= def.startIndex && call.endIndex <= def.endIndex);
}
function isRouteAttribute(attr) {
    const open = attr.indexOf('(');
    if (open === -1)
        return false;
    const name = attr.slice(0, open).trim();
    return ROUTE_METHODS.has(name) || name === 'route';
}
/** The path out of `get("/accounts/profile",data="<data>")`. */
function firstStringIn(attr) {
    const match = /"([^"]*)"/.exec(attr);
    const value = match?.[1] ?? null;
    return value && value.startsWith('/') ? value : null;
}
/** `&'rRequest<'_>` → `Request`; `Json<String>` → `Json`. The name a checker is known by. */
function bareType(type) {
    return type.replace(/^[&*]+/, '').replace(/^'\w+\s*/, '').replace(/<.*$/, '').replace(/^mut\s+/, '').trim();
}
//# sourceMappingURL=rocket.js.map