/**
 * @fileoverview A route declared as data rather than as a call (#246), and an address
 * whose head was never written down (#245).
 *
 * Strapi's route helper has exactly one call site, so #229's rule — recognise a helper by
 * what its body does — finds nothing here. There is no call to read. The doors are object
 * literals: 272 of them across 112 files in the real repo, against **2** ways in on the
 * map before this existed.
 *
 * Measured on `strapi/strapi` at the time this landed: `core/admin` 92 doors (62 carrying
 * a policy), `core/content-manager` 42, `plugins/users-permissions` 42, `core/upload` 30,
 * `plugins/i18n` 12.
 *
 * ## The two things that would make the map worse
 *
 * **Reading `config.middlewares` as checks.** `rateLimit` lives there, and it stands on
 * `/auth/local`, `/auth/local/register`, `/auth/forgot-password` and `/auth/reset-password`.
 * Claiming it would put a lock on the door that hands out sessions — NodeBB's
 * `authenticateRequest` on `/login` (#229), in a second framework. Only `policies` has a
 * refusal contract, written into Strapi's `services/server/policy.ts`: a handler
 * returning anything but `true`/`undefined` throws `PolicyError`.
 *
 * **Reading any object with a `path` and a `method`.** #235's warning, and Strapi is
 * where it bites: the React admin declares its outbound fetches the same way. What
 * excludes them is that they key the address as `url` rather than `path` — established by
 * removing the other rule and watching nothing change, not by reading the code and
 * assuming. The `handler` requirement is a second, deliberate narrowing that this corpus
 * never exercises; the test that looks like it covers it says so in as many words.
 *
 * ## Why every address here wears an ellipsis
 *
 * `/settings` is served at `/upload/settings`, because `register-routes.ts` does
 * `router.prefix ?? ` + a template on the plugin's *registered name* — read off a registry
 * keyed by the directory the plugin was loaded from. The content API adds
 * `strapi.config.get('api.rest.prefix', '/api')` on top, a deployment setting. Nothing in
 * the route file says either. Printing `/settings` would be a wrong address printed as a
 * fact; the tail is real and is shown.
 */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import { analyzeProject } from '../dist/node/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, 'fixtures', 'strapiroutes');

const { atlas } = await analyzeProject(FIXTURE, { followReferences: true, cache: 'off' });
const doors = atlas.nodes.filter((node) => node.kind === 'endpoint' && node.meta.framework === 'Strapi');
const byName = new Map(doors.map((node) => [node.name, node]));

/**
 * A door by name *and* the file that declared it.
 *
 * `byName` cannot be trusted for `…/settings`: two plugins declare that tail and a Map
 * keeps whichever came last. That collapse is the test harness's, not the tool's — the
 * doors themselves stay separate, which is what `two unread addresses…` asserts.
 */
const declaredIn = (name, file) =>
  doors.find((node) => node.name === name && node.meta.sites.some((site) => site.path === file));

test('a route written as an object literal is a door', () => {
  assert.deepEqual(doors.map((node) => node.name).sort(), [
    'GET …/',
    'GET …/files/:id',
    'GET …/settings',
    'GET …/settings',
    'GET …/uploads/(.*)',
    'POST …/auth/forgot-password',
    'POST …/auth/local',
    'PUT …/settings',
  ]);
});

test('the head is unread, so the address says so rather than pretending to be whole', () => {
  // `route` is what the machinery downstream reads — prefix matching, webhook sniffing,
  // pairing a cron with a route — and a fragment cannot answer any of those questions.
  // The tail stays in the label because it is a fact and a reader needs it.
  const door = declaredIn('GET …/settings', 'server/src/routes/admin.ts');
  assert.equal(door?.meta.route, null, 'a fragment must not be offered as an address');
  assert.match(door?.name ?? '', /^GET …\/settings$/);
});

test('two unread addresses with the same name in different files are two doors', () => {
  // Same verb, same tail, different plugin — the collision the key has to survive, and
  // the one a tail-keyed door would fail. `/settings` appears seven times in the real
  // repo. Asserted through the *guards*, because that is what merging would corrupt:
  // `plugin::email.settings.read` landing on the upload plugin's settings door would be a
  // check reported on a door nobody wrote it on, which is #159's false green.
  const settings = doors.filter((node) => node.meta.method === 'GET' && node.name === 'GET …/settings');
  assert.equal(settings.length, 2, 'two plugins declare this tail and both are doors');
  assert.equal(new Set(settings.map((node) => node.id)).size, 2, 'they must not share an id');
  assert.deepEqual(
    settings.map((node) => node.meta.guards.map((guard) => guard.name).join('+')).sort(),
    ['admin::isAuthenticatedAdmin+admin::hasPermissions', 'admin::isAuthenticatedAdmin+plugin::email.settings.read'].sort(),
  );
});

test('the policies beside a route are read, because they are a refusal by contract', () => {
  // Both spellings the schema allows: the bare string, and `{ name, config: { actions } }`.
  assert.deepEqual(
    declaredIn('GET …/settings', 'server/src/routes/admin.ts')?.meta.guards.map((guard) => guard.name),
    ['admin::isAuthenticatedAdmin', 'admin::hasPermissions'],
  );
  assert.equal(byName.get('PUT …/settings')?.meta.guards.length, 1);
});

test('a route with no config claims nothing', () => {
  // Strapi authorizes the content API through a scope generated at boot from the handler
  // name. That is not in this file, so "not examined" is the honest answer.
  assert.deepEqual(byName.get('GET …/files/:id')?.meta.guards ?? [], []);
});

test('the middleware list is refused, so the login door keeps no lock it cannot prove', () => {
  // The whole point, and the reason this fixture carries a second route file.
  // `plugin::users-permissions.rateLimit` sits in `config.middlewares` on both of these.
  for (const name of ['POST …/auth/local', 'POST …/auth/forgot-password']) {
    assert.deepEqual(byName.get(name)?.meta.guards ?? [], [], `${name} claimed a check it cannot prove`);
  }
});

test('a handler written as a method shorthand still declares a door', () => {
  // `handler(ctx) { … }` has no initializer, so resolving the property to its *value*
  // returns nothing and the route was dropped — the redirect at the root of every Strapi
  // site, gone, while the two beside it came through. Found by measuring `core/core`
  // against the source rather than by counting a total.
  assert.ok(declaredIn('GET …/', 'server/src/middlewares/upload.ts'), 'the root redirect is a door');
});

test('`auth: false` is somebody saying the door is open on purpose', () => {
  // Not silence, and not a lock: a decision, written down. #152's rule, read off Strapi's
  // spelling of it.
  assert.equal(byName.get('GET …/uploads/(.*)')?.meta.declaredPublic, true);
  assert.deepEqual(byName.get('GET …/uploads/(.*)')?.meta.guards ?? [], []);
});

test('an outbound request from the admin UI is not a door', () => {
  // Same repo, same file tree, same `method: 'POST'`. Reading these would invent routes
  // the server never serves — #235's warning, at the place it applies.
  //
  // What excludes them is the **`url`** key: they name no `path`. The detector also
  // requires a `handler`, and deleting that rule changes nothing here — checked by
  // deleting it — so this test does not stand for that one. The `handler` rule is a
  // deliberate narrowing kept for the case `url` does not cover; see `strapiRoute`.
  //
  // The file has to be *read* for the absence to mean anything: if it stopped being
  // analyzed this assertion would pass while proving nothing, which is the trap #234's
  // fixture fell into.
  const analyzed = atlas.nodes.some(
    (node) => node.kind === 'file' && node.path === 'admin/src/services/webhooks.ts',
  );
  assert.ok(analyzed, 'the fixture stopped testing the rule — the file was not analyzed');
  const invented = atlas.nodes.filter(
    (node) => node.kind === 'endpoint' && node.meta.sites?.some((site) => site.path.includes('admin/src/services')),
  );
  assert.deepEqual(invented, []);
});
