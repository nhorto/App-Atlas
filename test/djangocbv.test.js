/**
 * @fileoverview A Django view that is a class, and the check it never wears (item 44).
 *
 * Item 44 taught the Security page to follow a Django URLconf to its handler and read the
 * decorator on it, and took `healthchecks` from 0 of 141 routes with an auth verdict to
 * 178 of 179. healthchecks uses function views throughout — which is exactly why the fix
 * looked complete on it.
 *
 * `paperless-ngx` writes classes. It reached an auth verdict on **none** of its 74 routes,
 * for three separate reasons, and this fixture holds one shape for each:
 *
 * - **`X.as_view()` is a call.** The URLconf reader recorded a view only when the second
 *   argument was *not* a call, so all 32 of paperless's class views recorded no handler
 *   at all and every door stayed unlinked.
 * - **The name is bound to a symbol, not a module.** healthchecks writes
 *   `from hc.front import views` and then `views.checks`, so the resolver only ever had
 *   to resolve a module. paperless writes `from documents.views import PostDocumentView`,
 *   and the old resolver asked for a module called `documents.views.PostDocumentView`.
 * - **The check is inherited.** `class BulkView(PermissionMixin)` declares no policy of
 *   its own; the mixin above it holds `permission_classes = (IsAuthenticated,)`. Reading
 *   a class's own fields and stopping there left eleven of paperless's doors looking
 *   unexamined while a real check sat one line up the chain.
 *
 * `AllowAny` is deliberately not silence. It is somebody writing down that a door is open
 * on purpose, the same distinction #152 draws for a NestJS guard that permits everything —
 * so the door reads examined-and-open rather than never-examined.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyzeProject } from '../dist/node/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const { atlas } = await analyzeProject(path.join(here, 'fixtures', 'djangocbv'), {
  followReferences: true,
  cache: 'off',
});

const doors = atlas.nodes.filter((node) => node.kind === 'endpoint');
const at = (route) => doors.find((node) => node.meta.route === route);
const guardsOn = (route) => at(route)?.meta.guards.map((guard) => guard.name) ?? null;

test('a class-based view is followed to its class', () => {
  assert.deepEqual(
    doors.map((node) => node.meta.route).sort(),
    ['/bulk/', '/own/', '/public/', '/stats/'],
  );
  for (const door of doors) assert.notEqual(door.meta.handlerUnlinked, true);
});

test('permission_classes written on the class is the check', () => {
  assert.deepEqual(guardsOn('/own/'), ['IsAuthenticated']);
  assert.equal(at('/own/')?.meta.guards[0].confidence, 'certain');
});

test('permission_classes inherited from a base is the same check', () => {
  // `class BulkView(PermissionMixin)` — the whole of paperless's bulk-operation API.
  // Named with the class it came from rather than as a bare `IsAuthenticated`: the
  // reader's next question about an inherited check is always *inherited from where*,
  // and the chain is the answer.
  assert.deepEqual(guardsOn('/bulk/'), ['PermissionMixin → IsAuthenticated']);
});

test('a guard mixin in the base list counts', () => {
  assert.deepEqual(guardsOn('/stats/'), ['LoginRequiredMixin']);
});

test('AllowAny is an open door, not an unexamined one', () => {
  // No guard — but the handler *was* read, so this door is counted as open on purpose
  // rather than set aside. Claiming `AllowAny` as a lock would be the worse error, and
  // saying nothing at all would lose the fact that somebody decided this.
  assert.deepEqual(guardsOn('/public/'), []);
  assert.notEqual(at('/public/')?.meta.handlerUnlinked, true);
});
