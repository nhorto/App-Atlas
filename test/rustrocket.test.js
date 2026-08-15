/**
 * @fileoverview Rocket's routes, and the request guards in front of them (#257).
 *
 * `dani-garcia/vaultwarden` — a Bitwarden-compatible password server — declares 305
 * Rocket routes across 60 Rust files and App Atlas reported **zero**, with an archetype
 * that said `"nothing answers a URL"` on a screen whose own framework list read
 * `["Diesel", "Rocket"]`.
 *
 * #263 fixed the sentence: a known absence stopped being reported as a positive finding.
 * This is the second half, and it reads the routes. The assertion this file used to carry
 * — `stats.routes === 0`, marked as the one that should fail when somebody wrote the
 * reader — is gone, along with the caveat assertions that went with it.
 *
 * ## Why the guards had to ship with the routes
 *
 * Emitting 305 doors on a password server, every one reading "no auth check", would have
 * been a worse map than none: #139's netbox shape, and the blanket false alarm
 * `exposure.ts` exists to prevent. So the two halves are one change.
 *
 * ## What decides a check, after two designs that did not
 *
 * Rocket's check is the parameter's *type* — a `FromRequest` impl. Which of those types
 * is a check took three attempts, and both failures are planted in `guards.rs`:
 *
 * - **Counting refusals in the body** fails because vaultwarden's guards contain no
 *   status code at all; every refusal is `err_handler!`, whose body is not in the IR.
 *   Measured across five Rust services in #267 and declined as a one-repo change.
 * - **Treating `Outcome::Forward` as a refusal** fails because Plume's `Password` and
 *   `Email` guards forward too, and read nothing from the request — they ask whether
 *   signups are open. That is #203 in a second language.
 *
 * What survives asks whether the guard **reads a credential out of the request**, and it
 * works because it stops asking how the guard refuses. Verified on both applications:
 * vaultwarden 305 doors / 255 guarded, Plume 109 / 30.
 *
 * The control is still Tauri, in `rustengine`: its commands *are* read, so a Tauri crate
 * with no doors genuinely has none and must keep saying so.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyzeProject } from '../dist/node/index.js';
import { authHeadline } from '../dist/node/model/exposure.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const analyze = (name) =>
  analyzeProject(path.join(here, 'fixtures', name), { followReferences: false, cache: 'off' });

const { atlas } = await analyze('rustrocket');
const { atlas: tauri } = await analyze('rustengine');

const doors = new Map(
  atlas.nodes
    .filter((n) => n.kind === 'endpoint' && n.meta.endpointKind === 'http-route')
    .map((n) => [n.name, (n.meta.guards ?? []).map((g) => g.name)]),
);
const guardsOn = (fn) => doors.get([...doors.keys()].find((k) => k.includes(`(${fn})`)) ?? '') ?? null;

test('the fixture parsed, so a silent failure cannot pass as a pass', () => {
  assert.deepEqual(atlas.meta.warnings, []);
  assert.ok(atlas.nodes.some((n) => n.kind === 'function' && n.name === 'bind_address'));
});

test('Rocket is still detected and named', () => {
  assert.ok(atlas.meta.frameworks.includes('Rocket'), JSON.stringify(atlas.meta.frameworks));
});

test('the routes are read — all of them, from the attribute that declares them', () => {
  assert.equal(atlas.meta.stats.routes, 9);
  assert.deepEqual(
    [...doors.keys()].sort(),
    [
      'DELETE …/admin/users/<user_id> (delete_user)',
      'GET …/accounts/profile (profile)',
      'GET …/accounts/revision-date (revision_date)',
      'GET …/blogs/<name>/settings (blog_settings)',
      'GET …/health (health)',
      'GET …/legacy (legacy)',
      'GET …/status (status)',
      'GET …/users/<user_id>/public-key (public_key)',
      'POST …/accounts/register (register)',
    ],
  );
});

test('the address is hedged, because the mount prefix is not in the source', () => {
  // vaultwarden mounts with `[basepath, "/api"].concat()`, where `basepath` is deployment
  // configuration. Printing `/accounts/profile` for a door that answers at
  // `/api/accounts/profile` is #199 exactly — a fabricated prefix, wrong and confident.
  // `unreadHead` is the settled spelling: the tail, an ellipsis, and `route: null` so
  // nothing downstream matches a prefix against a fragment.
  const profile = atlas.nodes.find((n) => n.name.includes('(profile)'));
  assert.match(profile.name, /^GET …\/accounts\/profile/);
  assert.equal(profile.meta.route, null);
});

test('a guard that reads a bearer token is a check', () => {
  // vaultwarden's `Headers`, the strongest lock in that crate. Named after nothing, and
  // it refuses through a project macro rather than a status code.
  assert.deepEqual(guardsOn('profile'), ['Session']);
});

test('a guard that reads a signed cookie is a check', () => {
  // Plume's `User`. Refuses with `Outcome::Forward` — no status code anywhere, because
  // in Rocket a forwarding guard means the route does not match.
  assert.deepEqual(guardsOn('revision_date'), ['SignedIn']);
});

test('a guard that defers through a macro inherits the check it defers to', () => {
  // `AdminOnly` reads no credential of its own — `try_outcome!(Session::from_request(…))`
  // does. vaultwarden's real chain is three deep in one file, `AdminHeaders` →
  // `OrgHeaders` → `Headers`, which is why this is followed to a fixed point and not one
  // hop. Without it, 40 of vaultwarden's doors lose a check they have.
  assert.deepEqual(guardsOn('delete_user'), ['AdminOnly']);
});

test('a guard that defers to another file still finds its check', () => {
  // Plume's `Admin` lives in `admin.rs` and hands to `User` in `users.rs`, and this pass
  // sees one file. The deferral goes out as an `auth-alias` and the merge resolves it —
  // the mechanism a FastAPI `Depends` alias already travels through (#136). The trail
  // says where it came from, because a reader looking for a check in `owner.rs` finds
  // none written there.
  assert.deepEqual(guardsOn('blog_settings'), ['Owner → FromRequest(SignedIn)']);
});

test('a guard that reads a header which is not a credential is not a check', () => {
  // The trap a "reads a header" rule falls into. vaultwarden's `Host` reads `Referer` and
  // `X-Forwarded-Host` and authenticates nobody; claiming it locks every door in the
  // crate. `Pool` is on the same door and is the other half — it writes a real status
  // code, `ServiceUnavailable`, which is an infrastructure failure and not a decision
  // about who is calling.
  assert.deepEqual(guardsOn('status'), []);
});

test('a guard that reads nothing from the request is not a check, however it refuses', () => {
  // #203 in a second language, and the reason the `Outcome::Forward` design was dropped.
  // Plume's `Password` guard forwards exactly as its real checks do, and what it consults
  // is whether signups are open. Reading it as a lock puts one on every signup page.
  assert.deepEqual(guardsOn('register'), []);
});

test('a type in the signature with no FromRequest impl is not a guard at all', () => {
  assert.deepEqual(guardsOn('legacy'), []);
});

test('the crate is a service now, because things answer URLs in it', () => {
  // It used to read `pipeline` / "Something you run", which was the honest answer while
  // the routes were invisible. #140's evidence — `src/main.rs` beside a manifest — is
  // untouched and still in the reasons; the crate simply turns out to serve HTTP too.
  assert.equal(atlas.meta.archetype.archetype, 'service');
  assert.ok(
    !atlas.meta.archetype.because.includes('nothing answers a URL'),
    `the claim survived: ${JSON.stringify(atlas.meta.archetype.because)}`,
  );
});

test('the unread-framework caveat is withdrawn, because it stopped being true', () => {
  // The mirror of #263. A caveat saying Rocket's routes are never in view is the same
  // kind of false claim as "nothing answers a URL" once they are.
  assert.ok(
    !(atlas.meta.stats.unreadFrameworks ?? []).includes('Rocket'),
    `Rocket is still listed as unread: ${JSON.stringify(atlas.meta.stats.unreadFrameworks)}`,
  );
  const headline = authHeadline(atlas.meta.stats);
  assert.ok(headline, 'a crate with doors got no auth sentence');
  assert.doesNotMatch(headline.headline, /never in view/);
});

test('Tauri is the control: its commands are read, so its silence is earned', () => {
  assert.ok(tauri.meta.frameworks.includes('Tauri'), JSON.stringify(tauri.meta.frameworks));
  assert.equal(tauri.meta.stats.unreadFrameworks, undefined);
  assert.ok(
    tauri.meta.archetype.because.includes('nothing answers a URL'),
    `a Tauri crate must keep the claim, got ${JSON.stringify(tauri.meta.archetype.because)}`,
  );
});
