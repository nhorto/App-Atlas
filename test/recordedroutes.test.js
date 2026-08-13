/**
 * @fileoverview A route recorded in one method and registered in another (#235).
 *
 * `parse-community/parse-server` declares its whole API this way. `PromiseRouter.route`
 * pushes `{ path, method, handler }` onto `this.routes` and calls nothing; forty lines
 * later `mountOnto(expressApp)` walks that array and does
 * `expressApp[method].call(expressApp, route.path, handler)`. **84** `this.route(…)` call
 * sites against six direct verb calls in `src/`, and #229's rule — does the helper's own
 * body register a route — could see none of them.
 *
 * Measured after this landed: **75 doors**, and the missing nine are accounted for rather
 * than lost. Seven are `PagesRouter`'s, whose addresses are `` `/${this.pagesEndpoint}/…` ``
 * — an instance field, not a literal — and two are `GraphQLRouter`'s, keyed on an imported
 * constant. Nine addresses this repository computes and does not write down, and a guess
 * at any of them would be a wrong address printed as a fact.
 *
 * ## Why it takes two methods
 *
 * Neither half is evidence alone. A `push` into a field proves nothing — every
 * application does it — and a loop calling `app[verb](x.path, …)` says only that
 * *something* in that array becomes a route. Over the same field on the same class, they
 * say that what this class records is what it serves. `Telemetry` in the fixture is the
 * control: same recorded shape, same literal call sites, a replay that posts to a metrics
 * sink instead of a router, and no doors.
 *
 * That control is the whole reason the rule is not the general one the issue warns
 * about. "A function that assigns its parameters into a structure something else later
 * registers" reads every `{ method, path }` literal as a door, and #246 found what that
 * costs inside Strapi's own admin.
 *
 * ## What is not covered here
 *
 * apostrophe has the same pattern with the halves in **different modules** —
 * `compileSectionRoutes` pushes into `self._routes`, and `@apostrophecms/express`
 * replays them. Requiring one class is what keeps the rule tight, and the cost is that
 * apostrophe stays where it was. It is byte-identical on the corpus, deliberately.
 */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import { analyzeProject } from '../dist/node/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const { atlas } = await analyzeProject(path.join(here, 'fixtures', 'recordedroutes'), {
  followReferences: true,
  cache: 'off',
});
const doors = atlas.nodes.filter((node) => node.kind === 'endpoint');

test('a route the helper only wrote down is still a door', () => {
  assert.deepEqual(doors.map((node) => node.name).sort(), [
    'DELETE …/users/:objectId',
    'GET …/users',
    'GET …/users/me',
    'POST …/login',
    'POST …/users',
  ]);
});

test('the address wears an ellipsis, because the head is a deployment setting', () => {
  // Parse Server finishes with `app.use(options.mountPath, this.app)` — a value defaulted
  // in another file and overridable by anybody running it. `/users` is a tail. Printing
  // it as an address would be #245's case exactly, so it goes through #245's answer.
  for (const door of doors) {
    assert.equal(door.meta.route, null, `${door.name} offered a fragment as an address`);
  }
});

test('a recorder with no replay opens nothing', () => {
  // The control, and the reason both halves are required. `Telemetry.record` writes
  // `{ method, path }` built from its own parameters into a field, and its call sites
  // pass a literal verb and a `/…` path — everything the rule needs except a loop that
  // hands them to a router. `flush` sends them to a metrics sink instead.
  //
  // The file has to be *read* for its silence to mean anything: if it dropped out of the
  // analysis this would pass while proving nothing, which is #234's fixture trap.
  const analyzed = atlas.nodes.some((node) => node.kind === 'file' && node.path === 'src/instrument.js');
  assert.ok(analyzed, 'the fixture stopped testing the rule — the file was not analyzed');
  assert.deepEqual(
    doors.filter((node) => node.name.includes('/metrics')),
    [],
  );
});

test('a replay that hands over something other than the address opens nothing', () => {
  // The second control, and it exists because the first one does not reach this rule:
  // `Telemetry.flush` calls `sink.send(…)`, and `send` is not an HTTP verb, so its loop
  // is refused a step earlier. `ResponseCache.warm` gets past that — it replays a field
  // and calls `store.get(…)`, spelled exactly like a route registration — and is refused
  // only because what it passes is the element's `key` and not its `path`.
  //
  // Established by deleting the rule and watching this fail, which is the only way to
  // know a control is testing the thing its comment claims. The first one was not.
  const analyzed = atlas.nodes.some((node) => node.kind === 'file' && node.path === 'src/warmup.js');
  assert.ok(analyzed, 'the fixture stopped testing the rule — the file was not analyzed');
  assert.deepEqual(
    doors.filter((node) => node.name.includes('/cached')),
    [],
  );
});

test('an address the repo computes is declined rather than guessed', () => {
  // `` this.route('GET', `/${this.prefix}/verify_email`, …) `` — parse-server has seven of
  // these. The verb is right there and the tail is nearly readable, which is exactly what
  // makes a guess tempting. Nine of its 84 call sites end here and all nine stay off.
  assert.equal(doors.filter((node) => node.name.includes('verify_email')).length, 0);
});
