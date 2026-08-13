/**
 * @fileoverview The address a customer types, not the fragment one file happens to
 * hold (issue #33).
 *
 * A route's real path is assembled from a decorator, the prefix its router was built
 * with, and the prefix that router was mounted under — three facts in three files, none
 * of which knows about the others. Showing only the first is not terseness: it is an
 * address that does not answer, handed to someone about to read it out to a customer.
 *
 * The fixtures are deliberately awkward. The prefix is a name rather than a literal;
 * two route files declare character-for-character the same decorator; one mount is
 * unreadable; one router is hung in two places; and Flask's `url_prefix` *replaces*
 * where FastAPI's concatenates.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyzeProject } from '../dist/node/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = async (name) =>
  (await analyzeProject(path.join(here, 'fixtures', name), { followReferences: true, cache: 'off' })).atlas;

const fastapi = await read('mounts');
const flask = await read('flaskmounts');
const node = await read('tsmounts');

const routes = (atlas) =>
  atlas.nodes
    .filter((n) => n.kind === 'endpoint' && n.meta.route)
    .map((n) => n.name)
    .sort();

test('the fixtures parsed, so a silent failure cannot pass as a pass', () => {
  assert.deepEqual(fastapi.meta.warnings, []);
  assert.deepEqual(flask.meta.warnings, []);
  assert.deepEqual(node.meta.warnings, []);
});

// ---------------------------------------------------------------------------
// FastAPI: decorator + router prefix + mount prefix, across three files

test('a route wears the address it answers at, not the fragment its file holds', () => {
  // `@router.get("/{item_id}")` in `api/items.py`, under `APIRouter(prefix="/items")`,
  // under `include_router(api_router, prefix=settings.API_PREFIX)` in `main.py`.
  assert.ok(routes(fastapi).includes('GET /api/v2/items/{item_id}'));
});

test('a prefix written as a name is looked up rather than given up on', () => {
  // `prefix=settings.API_PREFIX`, with `API_PREFIX: str = "/api/v2"` on a class two
  // files away. This is how FastAPI's own project template writes it, and no route file
  // in such a repo contains the string `/api/v2` anywhere.
  assert.ok(routes(fastapi).every((name) => !name.includes('/api/v2/api/v2')), 'and only once');
  // Six, not four: `reports.router` is hung under two prefixes and answers at both, so
  // it contributes two of these. See the twice-mounted test below.
  assert.equal(routes(fastapi).filter((name) => name.startsWith('GET /api/v2/')).length, 6);
});

test('two files declaring the same decorator are two doors, not one', () => {
  // `@router.get("/")` appears character for character in `items.py` and `users.py`.
  // The merge keys doors by their address, so before the prefixes were composed these
  // two collapsed into a single `GET /` — a repo-wide undercount nobody would query.
  const names = routes(fastapi);
  assert.ok(names.includes('GET /api/v2/items/'));
  assert.ok(names.includes('GET /api/v2/users/'));
});

test('the trailing slash the framework really serves is kept', () => {
  // `@router.get("/")` under `prefix="/items"` answers at `/api/v2/items/`, and the
  // slashless spelling is a redirect. The API docs will say the slash, and the docs are
  // what the reader will be asked about.
  assert.ok(routes(fastapi).includes('GET /api/v2/items/'));
});

test('a router mounted straight onto the app needs no chain', () => {
  assert.ok(routes(fastapi).includes('GET /health/live'));
});

test('an unreadable prefix is shown as a gap, never dropped', () => {
  // `include_router(guessing, prefix=os.environ["MOUNT_AT"])`. Printing `/anyone` would
  // be a complete-looking address that does not answer; the marker says there is more
  // in front of it that App Atlas could not read.
  assert.ok(routes(fastapi).includes('GET …/anyone'));
});

test('a router hung in two places names both addresses', () => {
  // `reports.router` is included under `/reports` and again under `/exports`, so the
  // route really does answer at two addresses. This used to print one `…/monthly`, on
  // the grounds that naming one of them would be picking a favourite — true, but naming
  // *both* is not picking, and the ellipsis withheld two addresses that were fully
  // readable. healthchecks is the case that settled it: it mounts one fifteen-route
  // list under `api/v1/`, `api/v2/` and `api/v3/`, and a reader who has to call their
  // own API needs the version in the string.
  const names = routes(fastapi);
  assert.ok(names.includes('GET /api/v2/reports/monthly'));
  assert.ok(names.includes('GET /api/v2/exports/monthly'));
  assert.ok(!names.includes('GET …/monthly'));
});

test('an address is still withheld when the alternatives cannot all be read', () => {
  // The rule the test above relaxes has a floor: two mounts are two addresses only when
  // both can be named. `…/anyone` is mounted once, through a prefix nothing declares,
  // and no amount of enumerating mounts turns that into an address.
  assert.ok(routes(fastapi).includes('GET …/anyone'));
});

// ---------------------------------------------------------------------------
// Flask: the same idea, spelled the other way round

test('Flask says url_prefix, and means it in the same place', () => {
  assert.ok(routes(flask).includes('GET /api/orders/<order_id>'));
});

test('registering a blueprint replaces its prefix rather than stacking on it', () => {
  // The blueprint is built with `url_prefix="/orders"` and registered with
  // `url_prefix="/api/orders"`. Flask discards the first; FastAPI would concatenate.
  // Treating them alike prints `/api/orders/orders/<order_id>` — a wrong address given
  // with total confidence.
  assert.ok(!routes(flask).some((name) => name.includes('/orders/orders')));
});

test('a route with nothing in front of it is left exactly as written', () => {
  // The guard that matters most: a repo with no mounts at all must come out unchanged,
  // and no route anywhere may collect a `…` it did not earn.
  assert.ok(routes(flask).includes('GET /healthz'));
});

// ---------------------------------------------------------------------------
// Express, and NestJS's one global line

test('an Express router reached through a default export is still followed', () => {
  // `export default router` names nothing to match on, so the file answers for itself:
  // one router in it means one answer.
  assert.ok(routes(node).includes('POST /api/v1/orders/:id/refund'));
});

test('a router built and mounted in the same file composes too', () => {
  assert.ok(routes(node).includes('GET /api/v1/ping'));
});

test('middleware cannot become a router', () => {
  // `app.use(express.json())` is a call, and `app.use(morgan)` is somebody else's
  // package. Following either would hang this app's routes off a logger.
  assert.ok(routes(node).includes('GET /healthz'), 'the app-level route keeps its own path');
});

test("NestJS's global prefix reaches its own controllers", () => {
  // `setGlobalPrefix('nest-api')` sits in `main.ts`, nowhere near a controller.
  assert.ok(routes(node).includes('GET /nest-api/billing/:id'));
  assert.ok(routes(node).includes('POST /nest-api/billing'));
});

test('…and stops at the Express routes beside them', () => {
  // Nest runs on Express, so both frameworks are present in one package. A global
  // prefix belongs to the framework that declared it and to nothing else.
  assert.ok(!routes(node).some((name) => name.includes('nest-api/api/v1')));
  assert.ok(!routes(node).some((name) => name.startsWith('GET /nest-api/healthz')));
});
