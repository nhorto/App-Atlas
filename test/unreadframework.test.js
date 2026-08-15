/**
 * @fileoverview A framework whose routes go unread is a fact about the repository, not
 * about the route count (#271).
 *
 * #257 gave the hedge its sentence: a crate declaring Rocket had not been shown to answer
 * no URL, it had been *not asked*, and reporting "nothing answers a URL" turned a known
 * absence into a positive finding. That was filed on vaultwarden, which had exactly zero
 * doors — so zero read as the condition, and both surfaces were gated on it.
 *
 * windmill is the correction. A workflow engine whose axum backend serves hundreds of
 * endpoints, of which this tool reads none, reported:
 *
 *     1 of 2 routes have no auth check App Atlas can see
 *
 * Both of those routes are websocket servers in Python debugger scripts. Two incidental
 * doors from a `debugger/` directory suppressed a hedge about the framework serving the
 * entire application — and the sentence left behind is worse than the one #257 fixed,
 * because it hands the reader a denominator and invites them to believe it.
 *
 * ## The fixture
 *
 * The interesting case named in the issue, rather than windmill's: a small Express panel
 * beside a large unread service. It is the harder one, because the one route it *can*
 * read is properly checked — so the map produced a clean green with no caveat at all,
 * about a repository whose actual backend it had never opened.
 *
 * The tone assertion is not decoration. `AuthHeadline` says `warn` when something is
 * either open or unknown, and an unread framework is the second exactly; `ok` is the
 * signal that says nothing below needs your eye.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyzeProject } from '../dist/node/index.js';
import { authHeadline } from '../dist/node/model/exposure.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const { atlas } = await analyzeProject(path.join(here, 'fixtures', 'unreadframework'), {
  followReferences: true,
  cache: 'off',
});
const headline = authHeadline(atlas.meta.stats);

test('the fixture parsed, so a silent failure cannot pass as a pass', () => {
  // Both halves have to be present for the test to mean anything: the unread framework,
  // and a route from somewhere else that would suppress the hedge.
  assert.deepEqual(atlas.meta.stats.unreadFrameworks, ['Actix Web']);
  assert.equal(atlas.meta.stats.routes, 1);
});

test('the hedge survives a route arriving from somewhere else', () => {
  const caveat = headline.caveats.find((c) => c.includes('Actix Web'));
  assert.ok(caveat, `no caveat named the unread framework: ${JSON.stringify(headline.caveats)}`);
  assert.match(caveat, /whose routes App Atlas does not read/);
});

test('the ordinary headline is kept, not replaced', () => {
  // The route that *was* read is real and was really checked, and saying so is right.
  // #257's sentence — "whether anything answers a URL was never in view" — would be a
  // false claim here, because one thing demonstrably does.
  assert.equal(headline.headline, 'the one route has an auth check');
});

test('an unread framework is not an ok', () => {
  // Without this the map shows a green tick over a repository whose entire service went
  // unread, which is the failure mode #257 exists against wearing a different hat.
  assert.equal(headline.tone, 'warn');
});

test('a project with nothing unread keeps its clean sentence', () => {
  // The other direction, so the hedge cannot quietly become universal. Nothing here
  // declares an unread framework, and nothing should be appended.
  const clean = authHeadline({ ...atlas.meta.stats, unreadFrameworks: [] });
  assert.deepEqual(clean.caveats, []);
  assert.equal(clean.tone, 'ok');
});
