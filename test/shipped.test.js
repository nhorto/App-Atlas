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
import { knownServiceNames } from '../dist/node/analyze/boundaries/catalog.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const analyze = (name) =>
  analyzeProject(path.join(here, 'fixtures', name), { followReferences: true, cache: 'off' });

const { atlas: py } = await analyze('pyout');
const services = py.nodes.filter((n) => n.kind === 'service');

test('a call with a literal URL still names the company on the other end', () => {
  assert.deepEqual(
    services.map((n) => n.name).sort(),
    ['Google', 'Microsoft', 'api.postmarkapp.com', 'status.internal-vendor.example'],
  );
});

test('an import path names the company when only its later segments do (#178)', () => {
  // `from httpx_oauth.clients.google import GoogleOAuth2`. paperless-ngx reaches Gmail
  // and Outlook through exactly these two lines, and they are the only mention of
  // either company in 748 files — the mail server itself comes from the user's own
  // account settings, so no hostname literal exists anywhere to read. Reduced to a
  // top-level import name both are `httpx_oauth`, a library nobody sends data to.
  for (const [name, line] of [
    ['Google', 10],
    ['Microsoft', 11],
  ]) {
    const found = services.find((n) => n.name === name);
    assert.ok(found, `${name} missing from ${services.map((n) => n.name).join(', ')}`);
    assert.equal(found.meta.category, 'auth');
    assert.equal(found.meta.sites[0].path, 'app/mail_oauth.py');
    assert.equal(found.meta.sites[0].line, line);
  }
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
  //
  // A service earns its name from a host it calls or from a package the catalog knows
  // by name — `httpx_oauth.clients.google` is Google without a hostname appearing
  // anywhere. Anything with neither was invented from whatever variable took the call.
  const known = new Set(knownServiceNames());
  for (const service of services) {
    assert.ok(
      service.meta.hosts.length > 0 || known.has(service.name),
      `${service.name} was named from neither a host nor a package`,
    );
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
