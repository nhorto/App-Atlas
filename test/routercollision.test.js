/**
 * @fileoverview Two files that both name their router `router` are two routers (#276).
 *
 * `onTheGatesRouter` decides whether a door is even on the router a gate was written on.
 * It could not always tell, and where it could not it abstained and kept the check —
 * because `reports.ts` doing `import { app }` and registering a route on it really is the
 * same router, and a `module\0var` key cannot see the difference. Under-claiming a whole
 * application is the failure that rule was protecting against (#201).
 *
 * What it did not weigh is that `router` is not an incidental name. It is *the* name.
 * outline writes `const router = new Router()` in 60 separate modules, so one file's
 * `router.use(authMiddleware({ optional: true }))` was credited to doors in 53 others —
 * and the repository reported **0 unprotected routes**, with `/sitemap.xml`, `/robots.txt`
 * and three unsubscribe links among the doors wearing that lock.
 *
 * ## What settles it
 *
 * The module built its own. `const router = express.Router()` on both sides is two
 * objects, and `RouterBuildFinding` already records exactly that, per module and per
 * variable — the same evidence `registeredAboveTheGate` consults a few lines down when it
 * says a router a module built is its own. Where the door's module built nothing of that
 * name the alias is still live, and the abstention stands untouched.
 *
 * So this fixture holds all three cases at once, and the third is the one that matters:
 * a fix that simply stopped trusting names across modules would pass the first two and
 * take `/reports/summary` down with it.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyzeProject } from '../dist/node/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const { atlas } = await analyzeProject(path.join(here, 'fixtures', 'routercollision'), {
  followReferences: true,
  cache: 'off',
});

const doors = new Map(
  atlas.nodes
    .filter((n) => n.kind === 'endpoint' && n.meta.endpointKind === 'http-route')
    .map((n) => [n.meta.route, (n.meta.guards ?? []).map((g) => g.name).sort()]),
);

test('the fixture parsed, so a silent failure cannot pass as a pass', () => {
  assert.deepEqual(atlas.meta.warnings, []);
  assert.deepEqual([...doors.keys()].sort(), ['/admin/purge', '/public/health', '/reports/summary']);
});

test("a gate on one module's router does not reach an identically-named router next door", () => {
  // The defect, in one line. `public.ts` does not import `requireAuth`, does not call it,
  // and is mounted separately — it was reported as locked by a check in another file.
  assert.deepEqual(doors.get('/public/health'), ['requireSession']);
});

test('the gate still covers the doors on its own router', () => {
  // The other direction, and the reason the rule is about identity rather than distance:
  // `requireAuth` is written on this module's router and belongs to this module's doors.
  assert.deepEqual(doors.get('/admin/purge'), ['requireAuth', 'requireSession']);
});

test('a module handed the guarded router, that builds none of its own, keeps the check', () => {
  // #201's case, and the one a blunter fix breaks. `reports.ts` builds no router; the
  // `app` it registers on is the very object the gate was written on, so the name means
  // what it says and the check must stand.
  assert.deepEqual(doors.get('/reports/summary'), ['requireSession']);
});

test('the app-level gate still reaches every door through the mount graph', () => {
  // `requireSession` is on `app`, and all three doors arrive at `app` — two by mount and
  // one by handoff. If #276 had been written as a file-equality rule this is what would
  // have gone quiet, across the whole application at once.
  for (const [route, guards] of doors) {
    assert.ok(guards.includes('requireSession'), `${route} lost the app-level gate: ${guards}`);
  }
});
