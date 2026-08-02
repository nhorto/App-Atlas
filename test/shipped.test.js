/**
 * @fileoverview What belongs to the app, and what only belongs to its tests (#25).
 *
 * `psf/requests` reported four outside companies. All four came from `tests/`, and two
 * of them — `s call` and `session call` — were not companies at all but the names of
 * local variables that happened to receive an HTTP call. A reader briefing a customer
 * on "where your data goes" would have named two vendors that do not exist.
 *
 * Both halves are the same mistake in different clothes: reporting something we cannot
 * actually see. Where the destination is not in the code, the honest answer is silence.
 */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import { analyzeProject } from '../dist/node/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const analyze = (name) =>
  analyzeProject(path.join(here, 'fixtures', name), { followReferences: true, cache: 'off' });

const { atlas: py } = await analyze('pyout');
const services = py.nodes.filter((n) => n.kind === 'service');

test('a call with a literal URL still names the company on the other end', () => {
  assert.deepEqual(
    services.map((n) => n.name).sort(),
    ['api.postmarkapp.com', 'status.internal-vendor.example'],
  );
});

test('a module constant is the same fact as the literal it holds (#89)', () => {
  // `STATUS_FEED = "https://…"` at the top, `requests.get(STATUS_FEED)` below. Same
  // file only on the Python side — there is no import graph here to carry a constant
  // across one, so a URL in `config.py` used from `client.py` is still not found.
  const feed = services.find((n) => n.name === 'status.internal-vendor.example');
  assert.ok(feed, `got ${services.map((n) => n.name).join(', ')}`);
  assert.deepEqual(feed.meta.hosts, ['status.internal-vendor.example']);
});

test('a variable that receives an HTTP call is not a company', () => {
  // `session.get(url)` says an HTTP call happens and nothing about who answers it.
  for (const service of services) {
    assert.ok(service.meta.hosts.length > 0, `${service.name} was named without a host`);
  }
  assert.equal(
    services.some((n) => /\bcall\b/.test(n.name)),
    false,
    'no service should be named after the receiving variable',
  );
});

test('a fixture URL in a test file is not somewhere your data goes', () => {
  // The fixture calls httpbin.org and example.org from `tests/`. Both are real hosts
  // and neither is a vendor this app has a relationship with.
  const hosts = services.flatMap((n) => n.meta.hosts);
  assert.equal(hosts.includes('httpbin.org'), false);
  assert.equal(hosts.includes('example.org'), false);
});

test('evidence stays evidence: only a real import is listed as the package', () => {
  assert.deepEqual(services[0].meta.packages, ['requests']);
});

const { atlas: lib } = await analyze('lib');

test("a library's test helpers are not part of its public API", () => {
  // `src/__tests__/helpers.ts` exports `randomSeconds` and `Recorded`. Nobody's
  // semver depends on either.
  const names = lib.nodes
    .filter((n) => n.kind === 'endpoint' && n.meta.endpointKind === 'export')
    .map((n) => n.name)
    .sort();
  assert.deepEqual(names, ['Duration', 'clamp', 'format']);
});

test('…and the helper file is still on the map, just not on the boundary', () => {
  // Filtered from the public surface, not deleted from the atlas: a reader looking
  // for that file should still find it.
  assert.ok(lib.nodes.some((n) => n.kind === 'file' && n.path === 'src/__tests__/helpers.ts'));
});
