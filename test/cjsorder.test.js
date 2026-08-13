/**
 * @fileoverview The router handed to another file, and the line that hands it (#206).
 *
 * `tsorder` (#201/#224) orders a check against routes and mounts written in the file
 * that writes the check. This is the case it left open, and it is the commoner one in
 * CommonJS: the app is not mounted anywhere, it is passed as an *argument*, and the
 * receiving module writes `app.get(…)` on the parameter it arrived in.
 *
 *   const app = express();
 *   require('./public')(app);   // ← /health is registered here
 *   app.use(requireAuth);       // ← the gate
 *
 * `public.js` mentions no check and could not; the mount graph has no edge, because
 * nothing was mounted. So every route in it kept `requireAuth`, and `/health` — a door
 * deliberately put above the gate — was reported as locked. Which is the failure this
 * subsystem exists to prevent: a check printed where there is none.
 *
 * The fact the fix reads is the position of the *call*. `require` runs where it is
 * written and so does an ordinary function call, so the call's line stands in for every
 * route the callee registers, however far down the callee's file the `.get` sits.
 *
 * #206 asked for something else — "the direction of the import" — and the shape it argued
 * from does not survive being run. In ESM, `app.js` importing `routes.js` which imports
 * `app` back is a ReferenceError on the `const app` binding: the program never starts, so
 * there is no wrong answer to correct. The CJS cycle does run, and what decides it there
 * is where the `require()` sits. The line is the fact; the import edge is not.
 *
 * Five shapes, chosen for which of them the rule must decline:
 *
 *   /health           `require('./public')(app)` above the gate     → open
 *   /webhooks/stripe  `registerBilling(app)` above the gate         → open
 *   /both             handed above the gate *and* below it          → open
 *   /items            `require('./private')(app)` below the gate    → guarded
 *   /reports          handed inside a function written above the
 *                     gate and called below it                      → guarded, unread
 *
 * The last is the one that keeps line numbers honest. `function wireReports(app) { … }`
 * has a smaller line number than the gate and runs *after* it, so comparing the two
 * numbers answers a question nobody asked — which is why the rule checks that the gate
 * belongs to the same run of statements before it compares. NodeBB writes exactly that
 * shape, `setupExpressApp(app)` with the parameter shadowing the module's own `app`.
 */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import { analyzeProject } from '../dist/node/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, 'fixtures', 'cjsorder');

const { atlas } = await analyzeProject(FIXTURE, { followReferences: true, cache: 'off' });

const doors = new Map(
  atlas.nodes
    .filter((node) => node.kind === 'endpoint')
    .map((node) => [`${node.meta.method} ${node.meta.route}`, node.meta.guards.map((guard) => guard.name)]),
);

test('the fixture wires all five shapes', () => {
  assert.deepEqual([...doors.keys()].sort(), [
    'GET /both',
    'GET /health',
    'GET /items',
    'GET /reports',
    'POST /webhooks/stripe',
  ]);
});

test('a require call above the gate registers its routes above the gate', () => {
  // The only line in the repo that says so is `require('./public')(app)` in app.js.
  // `public.js` names no check, and its own line numbers are smaller than the gate's for
  // a reason that has nothing to do with the gate.
  assert.deepEqual(doors.get('GET /health'), []);
});

test('an ordinary function call is the same fact as a require call', () => {
  assert.deepEqual(doors.get('POST /webhooks/stripe'), []);
});

test('a router handed over below the gate keeps its check', () => {
  assert.deepEqual(doors.get('GET /items'), ['requireAuth']);
});

test('handed over on both sides of the gate, the earlier registration is the one that answers', () => {
  // Express matches in registration order, so requiring the module above the gate puts a
  // copy of every route in it in front of the copy below. Claiming the check because one
  // of the two calls is below the gate would be a lock on a door that opens without it.
  assert.deepEqual(doors.get('GET /both'), []);
});

test('a smaller line number inside a function is not an earlier statement', () => {
  // `wireReports` is written above the gate and called below it. Its position is real and
  // is not a line number, so the check stands — the same choice `tsorder` makes for a
  // position that cannot be read, and for the same reason: under-claiming one door is
  // recoverable, and blanking a whole application's checks is not.
  assert.deepEqual(doors.get('GET /reports'), ['requireAuth']);
});

test('the check is dropped once, not once per rule that found it', () => {
  for (const [door, guards] of doors) {
    assert.equal(new Set(guards).size, guards.length, `${door} lists a check twice`);
  }
});
