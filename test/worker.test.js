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
    ['durable-object:ROOM:ChatRoom', 'kv:CACHE:abc123'],
    'both spellings are read — durable objects say `name`, everything else says `binding`',
  );
});

test('the Worker is counted among the doors, not badged as guarded', () => {
  const insights = buildInsights(new AtlasGraph(atlas));
  const door = insights.auth.routes.find((r) => r.name === 'ANY /* (edge-api)');
  assert.ok(door, 'the Worker appears in auth coverage');
  // No check was found, and saying so is the point — a Worker with no auth is open.
  assert.equal(door.protection, 'open');
});
