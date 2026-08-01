/**
 * @fileoverview A literal URL that reaches an HTTP call is an outside service (#89).
 *
 * The repo this came from is a desktop app that checks for its own updates on launch,
 * and the map said **0 outside services** — because the address is a property of a
 * config object in one module, handed to a helper in a second, which is the only place
 * `fetch` is written. Every part of that is ordinary code.
 *
 * Half of these assertions are negative, and they are the important half. #25 removed
 * services invented from test files and variable names, and the cheap version of this
 * fix — every `https://` string is a service — would put them all back. The same
 * fixture therefore ships a licence-notices generator full of registry URLs that are
 * copied into a file and never fetched. Finding `updates.fabispulse.com` while staying
 * silent about `crates.io` is the whole test.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyzeProject } from '../dist/node/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = await analyzeProject(path.join(here, 'fixtures', 'updatecheck'), { cache: 'off' });

const services = app.atlas.nodes.filter((node) => node.kind === 'service');
const hosts = services.map((node) => node.name).sort();

// ---------------------------------------------------------------------------
// What it must find
// ---------------------------------------------------------------------------

test('an address two hops from the call is still an address', () => {
  // `EXPECTED.feedLatest` in config.mjs → `fetchFeedVersion(...)` in context.mjs →
  // `fetch(url)` in net.mjs. This is the case the issue was filed for.
  assert.ok(hosts.includes('updates.fabispulse.com'), `got ${hosts.join(', ') || '(none)'}`);
});

test('a constant one line up is not a mystery', () => {
  assert.ok(hosts.includes('mirror.fabispulse.com'), `got ${hosts.join(', ') || '(none)'}`);
});

test('the literal that always worked still works', () => {
  assert.ok(hosts.includes('telemetry.fabispulse.com'), `got ${hosts.join(', ') || '(none)'}`);
});

test('an unrecognised host is reported as a host, never guessed into a brand', () => {
  // The catalog has never heard of fabispulse. "An outside host we could not identify"
  // is the honest line and a great deal more useful than silence; inventing a category
  // for it would be the failure the catalog exists to prevent.
  const feed = services.find((node) => node.name === 'updates.fabispulse.com');
  assert.equal(feed.meta.category, 'other');
  assert.deepEqual(feed.meta.hosts, ['updates.fabispulse.com']);
});

// ---------------------------------------------------------------------------
// What it must not find
// ---------------------------------------------------------------------------

test('licence metadata written into a file is not a service (#25 still holds)', () => {
  // `gen_third_party_notices.mjs` names crates.io, pypi.org and npmjs.com. Every one of
  // them is a string interpolated into a markdown link and handed to `writeFileSync`.
  // A rule that reported them would be a fresh false positive of exactly the kind #25
  // was filed to remove.
  for (const registry of ['crates.io', 'pypi.org', 'www.npmjs.com', 'opensource.org', 'apache.org']) {
    assert.ok(!hosts.includes(registry), `${registry} is a licence notice, not a call:\n  ${hosts.join('\n  ')}`);
  }
});

test('loopback is not an outside service, even through the helper', () => {
  // `LOCAL_PREVIEW` goes through `fetchFeedVersion` exactly as the real feed does, so
  // this pins that the internal-host rule is applied after the hop, not before it.
  assert.ok(!hosts.some((host) => host.includes('127.0.0.1') || host === 'localhost'), hosts.join(', '));
});

test('the app phones home, and the count says so', () => {
  // The sentence the overview used to write was "No outside service showed up anywhere
  // in this". Three is the whole answer for this repo — no more, and no fewer.
  assert.deepEqual(hosts, ['mirror.fabispulse.com', 'telemetry.fabispulse.com', 'updates.fabispulse.com']);
});
