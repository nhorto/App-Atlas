/**
 * @fileoverview Cloudflare deploys, read out of wrangler configs.
 *
 * The bug these pin (#20): a repo with a Worker in it was told, in writing, that
 * "nothing answers a URL". The config file is the only place a Worker is declared —
 * nothing in the source calls it, because the platform does.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyzeProject, AtlasGraph, buildInsights } from '../dist/node/index.js';
import { readWorkers } from '../dist/node/analyze/wrangler.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, 'fixtures', 'worker');

const { atlas } = await analyzeProject(FIXTURE, { followReferences: true, cache: 'off' });
const endpoints = atlas.nodes.filter((n) => n.kind === 'endpoint');

test('finds a wrangler config that is not at the repo root', () => {
  const workers = readWorkers(FIXTURE);
  assert.deepEqual(
    workers.map((w) => w.configPath).sort(),
    ['edge/wrangler.toml', 'wrangler.toml'],
    'the Worker beside the Pages config is the normal layout, not an edge case',
  );
});

test('a Worker and a Pages deploy are not the same thing', () => {
  const workers = readWorkers(FIXTURE);
  const worker = workers.find((w) => w.configPath === 'edge/wrangler.toml');
  const pages = workers.find((w) => w.configPath === 'wrangler.toml');

  assert.equal(worker.isPages, false);
  // `main` is relative to the config file, not the repo root.
  assert.equal(worker.entry, 'edge/index.ts');

  assert.equal(pages.isPages, true);
  assert.equal(pages.entry, null, 'Pages serves files; no script of ours runs on the request');
});

test('a commented-out key is not config', () => {
  const worker = readWorkers(FIXTURE).find((w) => w.configPath === 'edge/wrangler.toml');
  assert.equal(worker.entry, 'edge/index.ts', 'the decoy `main` inside a comment was ignored');
});

test('the Worker is a door, and Pages is not', () => {
  const http = endpoints.filter((n) => n.meta.endpointKind === 'http-route');
  assert.deepEqual(http.map((n) => n.name), ['ANY /* (edge-api)']);
  // One script answers every path on the domain, so the door is the script.
  assert.equal(http[0].meta.route, '/*');
  assert.equal(http[0].meta.framework, 'Cloudflare Workers');
});

test('the door hangs off the entry file, so the map can walk into it', () => {
  const graph = new AtlasGraph(atlas);
  const door = atlas.nodes.find((n) => n.name === 'ANY /* (edge-api)');
  const exposes = atlas.edges.filter((e) => e.kind === 'exposed-by' && e.fromId === door.id);
  assert.ok(
    exposes.some((e) => e.toId === 'file:edge/index.ts'),
    `the handler is real code, not a floating box (got ${exposes.map((e) => e.toId)})`,
  );
  assert.ok(graph.getLevel(graph.rootId).nodes.length > 0);
});

test('[triggers] crons are scheduled doors', () => {
  const crons = endpoints.filter((n) => n.meta.endpointKind === 'cron');
  assert.deepEqual(
    crons.map((n) => n.name).sort(),
    ['*/15 * * * * (edge-api)', '0 8 * * * (edge-api)'],
  );
});

test('the frameworks name the deploy target the dependency list never mentions', () => {
  assert.ok(atlas.meta.frameworks.includes('Cloudflare Workers'));
  assert.ok(atlas.meta.frameworks.includes('Cloudflare Pages'));
});

test('an app with a Worker is never told nothing answers a URL', () => {
  // The exact wording of the bug in #20.
  const because = atlas.meta.archetype.because.join('; ');
  assert.ok(
    !because.includes('nothing answers a URL'),
    `the archetype must not deny a network surface it can see: ${because}`,
  );
  assert.ok(['service', 'web-app'].includes(atlas.meta.archetype.archetype));
});

test('bindings name the stores the Worker reaches for', () => {
  const worker = readWorkers(FIXTURE).find((w) => w.configPath === 'edge/wrangler.toml');
  assert.deepEqual(
    worker.bindings.map((b) => `${b.kind}:${b.name}:${b.target}`).sort(),
    ['durable-object:ROOM:ChatRoom', 'kv:CACHE:null'],
    'both spellings are read — durable objects say `name`, everything else says `binding`',
  );
});

test('an opaque id is evidence, not a name', () => {
  // A KV namespace has no name in the config, only `id = "abc123"`. Showing that as
  // the store's name puts a hex string where the reader expects to read what the
  // thing is; the binding the code says (`CACHE`) is the better label and the one
  // they can grep for.
  const worker = readWorkers(FIXTURE).find((w) => w.configPath === 'edge/wrangler.toml');
  const kv = worker.bindings.find((b) => b.kind === 'kv');
  assert.equal(kv.target, null);
  assert.equal(kv.id, 'abc123');
});

test('the Worker is counted among the doors, not badged as guarded', () => {
  const insights = buildInsights(new AtlasGraph(atlas));
  const door = insights.auth.routes.find((r) => r.name === 'ANY /* (edge-api)');
  assert.ok(door, 'the Worker appears in auth coverage');
  // No check was found, and saying so is the point — a Worker with no auth is open.
  assert.equal(door.protection, 'open');
});

// ---------------------------------------------------------------------------
// #29: a Worker whose entry has not been built yet is still a Worker

const { atlas: edge } = await analyzeProject(path.join(here, 'fixtures', 'edge'), {
  followReferences: true,
  cache: 'off',
});

test('a `main` pointing at an unbuilt artifact still makes this an edge deploy', () => {
  // mirrorquiz's entry is `.open-next/worker.js`, which no fresh clone contains.
  // Deciding "is this a Worker" on whether someone had run a build meant the check
  // never fired on the repo it was written for.
  const worker = readWorkers(path.join(here, 'fixtures', 'edge'))[0];
  assert.equal(worker.declaredEntry, '.open-next/worker.js');
  assert.equal(worker.entry, null, 'and the file is honestly reported as absent');
  assert.ok(edge.meta.frameworks.includes('Cloudflare Workers'));
});

test('the door is real even though the file behind it is not there yet', () => {
  const door = edge.nodes.find((n) => n.kind === 'endpoint' && n.meta.framework === 'Cloudflare Workers');
  assert.equal(door.meta.route, '/*');
  assert.equal(door.meta.sites[0].snippet, 'main = ".open-next/worker.js"');
  // No handler edge: there is no file to walk into, and inventing one would put a
  // node on the map that nobody can open.
  assert.equal(
    edge.edges.some((e) => e.fromId === door.id && e.kind === 'exposed-by'),
    false,
  );
});

/**
 * Issue #123, found by running the published package over a real OpenNext repo.
 *
 * `.open-next/worker.js` is not a door somebody wrote — it is a Next.js app packaged for
 * the edge, and the routes it serves are already on this map one at a time, each with its
 * own guards. Counting the adapter too says "a route nobody protects" about an app whose
 * routes are all accounted for, and there is nowhere to put a check in a file nobody
 * wrote.
 *
 * The door still exists, because #29 above is the bug where a Worker repo was told in
 * writing that nothing answers a URL. It is excused from the count, not removed from the
 * map — those are different things, and only one of them hides information.
 */
test('a build wrote this entry, so it is a door but not an accusation', () => {
  const door = edge.nodes.find((n) => n.kind === 'endpoint' && n.meta.framework === 'Cloudflare Workers');
  assert.equal(door.meta.generatedEntry, true, 'the entry is marked as generated');
  assert.equal(door.meta.open.kind, 'generated');
  assert.match(door.meta.open.because, /already/, 'and it says why, rather than going quiet');
  assert.equal(edge.meta.stats.unprotectedRoutes, 0, 'nothing here is worth a reader opening');
  assert.ok(edge.meta.stats.publicRoutes >= 1, 'but it is still counted among the doors that were explained');
});

/**
 * The rule that was tempting and wrong. Dogfooding turned up a repo with two real
 * Workers (`main: "src/worker.ts"`) and no other doors, reporting `2 of 2 routes have no
 * auth check` — which was true, and suppressing it would have hidden two genuinely open
 * doors on the edge. So the test is the entry path, never "are there other routes".
 */
test('a hand-written entry is still a door, however few of them there are', () => {
  const door = atlas.nodes.find((n) => n.kind === 'endpoint' && n.meta.framework === 'Cloudflare Workers');
  assert.equal(door.meta.generatedEntry ?? false, false, 'edge/index.ts is source, not output');
  assert.notEqual(door.meta.open?.kind, 'generated');
});

test('the databases the platform injects are named, not left generic', () => {
  const stores = edge.nodes
    .filter((n) => n.kind === 'store')
    .map((n) => `${n.name} (${n.meta.client}/${n.meta.storeKind})`)
    .sort();
  assert.deepEqual(stores, [
    'OG_CACHE (Cloudflare KV/kv)',
    'quiz-db (Cloudflare D1/sql)',
    'quiz-uploads (Cloudflare R2/blob)',
  ]);
});

test('a declared binding claims no reads or writes it did not see', () => {
  const d1 = edge.nodes.find((n) => n.kind === 'store' && n.name === 'quiz-db');
  assert.equal(d1.meta.reads, 0);
  assert.equal(d1.meta.writes, 0);
  assert.equal(d1.meta.sites[0].path, 'wrangler.jsonc', 'the config is the evidence');
});

test('a queue you write into is not a place data is kept', () => {
  assert.equal(
    edge.nodes.some((n) => n.kind === 'store' && n.name === 'quiz-jobs'),
    false,
  );
});
