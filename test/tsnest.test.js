/**
 * @fileoverview The NestJS shape: the whole of an application's auth in files no
 * controller imports.
 *
 * `consumer.apply(AuthMiddleware).forRoutes({ path: 'user', method: RequestMethod.GET })`
 * is how a real NestJS app locks its API, and every fact it needs is in a different
 * file from the routes it covers — the addresses in the module, the prefix in `main.ts`,
 * and whether the thing being applied checks anything at all in the middleware's own
 * file. A per-file pass can see one of the three.
 *
 * Measured on `lujakob/nestjs-realworld-example-app`: twenty-one doors, all twenty-one
 * reported wide open, twelve of them behind a JWT check written exactly this way.
 */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import { analyzeProject } from '../dist/node/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const { atlas } = await analyzeProject(path.join(here, 'fixtures', 'tsnest'), {
  followReferences: true,
  cache: 'off',
});

const endpoint = (name) => atlas.nodes.find((n) => n.kind === 'endpoint' && n.name === name);
const guardNames = (name) => (endpoint(name)?.meta.guards ?? []).map((g) => g.name);

test('the fixture parsed, so a silent failure cannot pass as a pass', () => {
  assert.deepEqual(atlas.meta.warnings, []);
  assert.equal(atlas.nodes.filter((n) => n.kind === 'endpoint').length, 4);
});

test('a check applied in a module reaches the routes it names', () => {
  // Nothing in `notes.controller.ts` mentions a caller, an import or a middleware.
  assert.deepEqual(guardNames('POST /api/notes'), ['Doorman']);
  assert.deepEqual(guardNames('DELETE /api/notes/:id'), ['Doorman']);
});

test('a check is recognised by what it does, not by what it is called', () => {
  // `Doorman` matches no auth vocabulary. It throws a 401, which is the whole of the
  // evidence, and the guard points at the line that does it.
  const guard = endpoint('POST /api/notes').meta.guards[0];
  assert.equal(guard.path, 'src/doorman.ts');
  assert.equal(guard.how, 'middleware');
  assert.equal(guard.confidence, 'likely');
});

test('the method is half the claim, not an afterthought', () => {
  // `notes` is locked for POST and open for GET; the two are written on consecutive
  // lines of the same module. A rule that read only the path would lock both.
  assert.deepEqual(guardNames('GET /api/notes'), []);
  assert.deepEqual(guardNames('GET /api/notes/:id'), []);
});

test('middleware that refuses nobody is not a lock', () => {
  // `Tally` is applied by the same two calls, in the same file, and only logs. It
  // covers `notes`, which is the address the assertion above checks is open.
  const everyGuard = atlas.nodes
    .filter((n) => n.kind === 'endpoint')
    .flatMap((n) => n.meta.guards ?? [])
    .map((g) => g.name);
  assert.ok(!everyGuard.includes('Tally'), everyGuard.join(' | '));
});

test('the prefix in main.ts is in front of the guarded address and the route alike', () => {
  // `forRoutes({ path: 'notes' })` and `@Post('notes')` both omit it, and one line of
  // `main.ts` puts it in front of both. Matching them before that runs matches nothing.
  assert.ok(endpoint('POST /api/notes'), 'the route carries the prefix');
  assert.equal(endpoint('POST /notes'), undefined, 'and the unprefixed spelling is gone');
});
