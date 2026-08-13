/**
 * @fileoverview The lock on a Django class-based view, which is never on a `def` (#178).
 *
 * Item 44 followed `path("checks/", views.checks)` to the function and read the
 * decorator on it. It could not follow `path("widgets/", views.WidgetList.as_view())`
 * anywhere: `as_view()` is a call, so the URLconf reader saw no view name at all, and
 * every class-based door in every Django repo came back `unlinked` with an empty guard
 * list — while `LoginRequiredMixin` sat on the line under the class statement.
 *
 * Django gives a class five ways to say who may come in, and this fixture writes each
 * one once: a mixin in the bases, a mixin inherited from a base class two files away,
 * `@method_decorator(login_required, name="dispatch")`, a `dispatch` that returns 403
 * itself, and DRF's `permission_classes`. Two doors have none and are reported as
 * having none, which is the half that makes the other half worth reading.
 *
 * The two DRF blanks are the point of the exercise as much as the verdicts are. A
 * ViewSet naming no `permission_classes` was followed, opened and read — and what
 * governs it is `DEFAULT_PERMISSION_CLASSES` in a settings file, so the door says that
 * rather than "no auth check". Neither is a claim about the application; only one of
 * them is a true sentence about this reader.
 *
 * `LoginPage` is the trap, and it is the third appearance of #147. A check on a class
 * travels by inheritance and by nothing else. Let it travel along the reference graph
 * instead — where an edge means "mentions" — and `SecureView` reaches `BillingView`,
 * `BillingView` reaches the login page that names it, and the product's front door is
 * reported locked.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyzeProject } from '../dist/node/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const { atlas } = await analyzeProject(path.join(here, 'fixtures', 'pycbv'), {
  followReferences: true,
  cache: 'off',
});

const routes = atlas.nodes.filter((n) => n.kind === 'endpoint' && n.meta.endpointKind === 'http-route');
const named = (name) => routes.find((n) => n.name === name);
const guardsOn = (name) => named(name).meta.guards.map((g) => g.name);

test('the fixture parsed, so a silent failure cannot pass as a pass', () => {
  assert.deepEqual(atlas.meta.warnings, []);
});

test('as_view() is a door, at the address the include() chain composes', () => {
  assert.deepEqual(
    routes.map((n) => n.name).sort(),
    [
      '/api/docs/',
      '/api/notes/',
      '/api/quiet/',
      '/api/status/',
      '/api/version/',
      '/app/about/',
      '/app/billing/',
      '/app/gate/',
      '/app/login/',
      '/app/report/',
      '/app/widgets-bare/',
      '/app/widgets/',
    ],
  );
});

test('the door is linked to the class, not to a function that does not exist', () => {
  const widgets = named('/app/widgets/');
  assert.equal(widgets.meta.handlerUnlinked, undefined);
  const link = atlas.edges.filter((e) => e.fromId === widgets.id && e.kind === 'exposed-by');
  assert.deepEqual(
    link.map((e) => e.toId),
    ['type:dashboard/views.py#WidgetList'],
  );
});

test('a mixin in the bases is read with the certainty it was written with', () => {
  // On the class the URLconf names, one line from the class statement. Nothing about
  // this is inferred, so nothing about it is `likely`.
  for (const name of ['/app/widgets/', '/app/widgets-bare/']) {
    assert.deepEqual(guardsOn(name), ['LoginRequiredMixin'], name);
    assert.equal(named(name).meta.guards[0].confidence, 'certain');
    assert.equal(named(name).meta.guards[0].path, 'dashboard/views.py');
  }
});

test('a mixin inherited from a base class reaches the door, and stays `likely`', () => {
  // `BillingView(SecureView)` and `SecureView(LoginRequiredMixin, View)` — neither the
  // URLconf nor the view file mentions the mixin. Never `certain`: a subclass can
  // override `dispatch` and undo the whole thing.
  const billing = named('/app/billing/');
  assert.deepEqual(guardsOn('/app/billing/'), ['LoginRequiredMixin']);
  assert.equal(billing.meta.guards[0].confidence, 'likely');
  // And the evidence points at the class that actually put the mixin in its bases,
  // not at some other class in the repo that happens to use the same one.
  assert.equal(billing.meta.guards[0].path, 'dashboard/base.py');
});

test('method_decorator on the class is the decorator it wraps', () => {
  // `@method_decorator(login_required, name="dispatch")`. `method_decorator` is the
  // adapter; the lock is the name inside the parentheses.
  assert.deepEqual(guardsOn('/app/report/'), ['login_required']);
  assert.equal(named('/app/report/').meta.guards[0].confidence, 'certain');
});

test('a dispatch that turns callers away is a check, and only ever `likely`', () => {
  // Same rule as a function that does it (#147): a method answering a bad request
  // with a 403 is doing its job rather than guarding a door.
  assert.deepEqual(guardsOn('/app/gate/'), ['GateView']);
  assert.equal(named('/app/gate/').meta.guards[0].confidence, 'likely');
});

test('a class with no check is reported as having none, not as unknown', () => {
  const about = named('/app/about/');
  assert.equal(about.meta.handlerUnlinked, undefined, 'the class was found');
  assert.deepEqual(about.meta.guards, []);
});

test('a page that merely mentions a locked view stays open (#147)', () => {
  // The regression this file exists for. `LoginPage` names `BillingView`, which
  // inherits `SecureView`, which carries the mixin. Three hops of "mentions" and the
  // product's front door reads as protected — which is the one error this screen
  // cannot afford, because nobody re-checks a door they were told was locked.
  const login = named('/app/login/');
  assert.deepEqual(login.meta.guards, []);
  assert.equal(login.meta.handlerUnlinked, undefined);
});

test("DRF's permission_classes is read off the class", () => {
  assert.deepEqual(guardsOn('/api/docs/'), ['IsAuthenticated']);
  assert.equal(named('/api/docs/').meta.guards[0].confidence, 'certain');
  assert.deepEqual(guardsOn('/api/status/'), [], 'AllowAny is a declaration of openness');
});

test('a DRF view naming no permission keeps the blank, and says why', () => {
  // Following the link was progress right up to here. DRF falls back to
  // `DEFAULT_PERMISSION_CLASSES` in settings, so silence on the class is not an open
  // door — it is a question this reader has not answered.
  const quiet = named('/api/quiet/');
  assert.equal(quiet.meta.handlerUnlinked, true);
  assert.deepEqual(quiet.meta.guards, []);
  assert.match(quiet.meta.open.because, /DEFAULT_PERMISSION_CLASSES/);
  // And not the stock sentence, which would send a reader looking for a link that is
  // already there.
  assert.doesNotMatch(quiet.meta.open.because, /has not followed it/);
});

test('a permission that locks writes and opens reads is stated, not rounded', () => {
  // `IsAuthenticatedOrReadOnly` on a door whose method DRF never declares. Guarded
  // claims a lock on the GET that has none; unguarded claims none on the POST that
  // has one. Both are false, so the door says which it is and stops there.
  const notes = named('/api/notes/');
  assert.equal(notes.meta.handlerUnlinked, true);
  assert.deepEqual(notes.meta.guards, []);
  assert.match(notes.meta.open.because, /IsAuthenticatedOrReadOnly/);
});

test('a DRF base written with a type parameter is still a DRF base', () => {
  // paperless-ngx writes `GenericAPIView[Any]`, `GenericViewSet[Document]`,
  // `ModelViewSet[ApplicationConfiguration]` — every DRF base it inherits carries a
  // subscript. With the brackets left on the name, none of them matched anything, and
  // `RemoteVersionView` was reported as an open door rather than one whose permissions
  // are in a settings file.
  const version = named('/api/version/');
  assert.equal(version.meta.handlerUnlinked, true);
  assert.match(version.meta.open.because, /DEFAULT_PERMISSION_CLASSES/);
});

test('the blanks stay out of both totals, and the doors stay on the map', () => {
  assert.equal(atlas.meta.stats.routes, 12);
  // `/app/about/`, `/app/login/`, `/api/status/` — read, and genuinely open.
  assert.equal(atlas.meta.stats.unprotectedRoutes, 3);
  assert.equal(atlas.meta.stats.unlinkedRoutes, 3);
});
