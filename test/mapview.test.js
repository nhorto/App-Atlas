/**
 * @fileoverview What the Map draws, and whether it says what it is drawing.
 *
 * Three reports about one screen (#90, #91, #94), all of them the same complaint: the
 * picture is carrying information it never says out loud. An arrow stood for four
 * different relationships and looked identical in all four. The legend looked like a
 * filter and was not one. The names on the boxes were written by a model and nothing
 * said so.
 *
 * Two halves, tested in two ways. The facts the browser is handed come out of `dist/`,
 * like every other test here. The drawing rules — which end of a line carries the
 * arrowhead, what the number counts, what a filter removes — are imported from
 * `web/src/` as source, because the web build is a bundle rather than a module anyone
 * can import, and these are the rules the reports were actually about.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyzeProject, AtlasGraph, enrichAtlas, renderAtlasMarkdown } from '../dist/node/index.js';
import {
  ARROW_BUDGET,
  arrowKindOf,
  arrowStyle,
  budgetEdges,
  edgeLabel,
  filterLevel,
} from '../web/src/mapview.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, 'fixtures', 'boundary');

const { atlas } = await analyzeProject(FIXTURE, { followReferences: true, cache: 'off' });
const graph = new AtlasGraph(atlas);

const lib = graph.getLevel('module:src/lib');
const flowTo = (level, worldId, insideId) =>
  level.outside.find((n) => n.node.id === worldId)?.flows.find((f) => f.insideId === insideId);

// ---------------------------------------------------------------------------
// #90 — an arrow means four things, and one of them pointed the wrong way
// ---------------------------------------------------------------------------

test('every arrow on a level carries the relationships it stands for', () => {
  const root = graph.getLevel(graph.rootId);
  assert.ok(root.edges.length > 0);
  for (const edge of root.edges) {
    assert.ok(edge.kinds.length > 0, `${edge.id} has to say what it is`);
  }

  // The database traffic out of `src` is reads and writes rolled into one line. Drawn
  // as one arrowhead it claimed the data only ever moved one way.
  const outward = root.edges.find((e) => e.fromId === 'module:src' && e.toId === 'zone:outbound');
  assert.ok(outward.kinds.includes('reads-from'));
  assert.ok(outward.kinds.includes('writes-to'));
  assert.equal(arrowKindOf(outward.kinds), 'both');
  assert.equal(arrowStyle(outward.kinds).head, 'both');
});

test('a flow across the boundary says which way the data moves, not which side called', () => {
  // Both of these are the file calling the outside world, so both used to be drawn as
  // an arrow *into* the outside world. Only one of them is data leaving the app.
  const read = flowTo(lib, 'store:prisma', 'file:src/lib/db.ts');
  const write = flowTo(lib, 'service:resend', 'file:src/lib/email.ts');

  assert.deepEqual(read.kinds, ['reads-from']);
  assert.equal(read.out, true, 'the file is still the caller');
  assert.deepEqual(write.kinds, ['writes-to']);
  assert.equal(write.out, true);

  // …and that is the whole difference the picture has to show.
  assert.equal(arrowStyle(read.kinds).head, 'start', 'a read points back at the code');
  assert.equal(arrowStyle(write.kinds).head, 'end', 'a write points at the service');
});

test('a read and a use are not drawn in the same colour', () => {
  assert.notEqual(arrowStyle(['reads-from']).stroke, arrowStyle(['imports']).stroke);
  assert.equal(arrowStyle(['reads-from']).stroke, arrowStyle(['writes-to']).stroke, 'both are data');
});

test('the number on an arrow says what it counts', () => {
  // Fifteen rolled-up imports and fifteen call sites are different quantities, and the
  // bare `15` on the old edge was both of them.
  assert.equal(edgeLabel(['imports'], 15), '15 imports');
  assert.equal(edgeLabel(['reads-from'], 15), '15 reads');
  assert.equal(edgeLabel(['writes-to'], 1), '1 write');
  assert.equal(edgeLabel(['reads-from', 'writes-to'], 4), '4 queries');
  assert.equal(edgeLabel(['imports', 'references'], 2), '2 uses');
});

test('a level with thousands of connections draws its heaviest, and never drops the selection', () => {
  const many = Array.from({ length: 200 }, (_, i) => ({
    id: `e${i}`,
    fromId: `a${i}`,
    toId: `b${i}`,
    weight: i,
    kinds: ['imports'],
  }));

  const capped = budgetEdges(many, null, false);
  assert.equal(capped.length, ARROW_BUDGET);
  assert.ok(
    capped.every((edge) => edge.weight >= 200 - ARROW_BUDGET),
    'the heaviest are the ones kept',
  );

  // Clicking a box asks "what is this connected to". Answering with whichever of its
  // arrows happened to be heavy would be worse than the spaghetti.
  const withSelection = budgetEdges(many, 'a0', false);
  assert.ok(withSelection.some((edge) => edge.id === 'e0'), 'the lightest arrow on the selection stays');
  assert.equal(budgetEdges(many, null, true).length, 200, 'and all of them are one click away');
});

// ---------------------------------------------------------------------------
// #91 — the legend looked like a filter and was not one
// ---------------------------------------------------------------------------

test('hiding a zone takes its boxes, its arrows, and says how many went', () => {
  const level = graph.getLevel('module:src');
  const zones = new Set(level.nodes.map((n) => n.zone));
  assert.ok(zones.has('api') && zones.has('logic'), 'the fixture needs two zones here to be a test');

  const before = level.nodes.filter((n) => n.zone === 'api').length;
  const shown = filterLevel(level, new Set(['api']));

  assert.equal(shown.nodes.length, level.nodes.length - before);
  assert.ok(shown.nodes.every((n) => n.zone !== 'api'));
  assert.deepEqual(shown.hidden, [{ zone: 'api', count: before }]);
  assert.equal(shown.hiddenTotal, before, 'the screen has to be able to say what it is not showing');

  const ids = new Set(shown.nodes.map((n) => n.id));
  for (const edge of shown.edges) {
    assert.ok(ids.has(edge.fromId) && ids.has(edge.toId), 'an arrow to a hidden box is not an arrow');
  }
});

test('the outside world keeps the flows that survive, and loses the ones that do not', () => {
  const level = graph.getLevel('module:src');
  const shown = filterLevel(level, new Set(['api']));

  // The dashboard page is reached only through the folder that has just been hidden, so
  // it goes with it. A ghost card wired to nothing on screen is a loose end, not a fact.
  assert.ok(
    !shown.outside.some((n) => n.node.id === 'endpoint:http-route:PAGE /dashboard'),
    'nothing left on screen is behind it',
  );

  const prisma = shown.outside.find((n) => n.node.id === 'store:prisma');
  assert.ok(prisma, 'the store the surviving folder still queries stays');
  assert.ok(prisma.flows.every((flow) => flow.insideId !== 'module:src/app'));
  assert.equal(
    prisma.total,
    prisma.flows.reduce((sum, flow) => sum + flow.weight, 0),
    'its count moves in step with the flows it kept',
  );
  assert.ok(prisma.total < level.outside.find((n) => n.node.id === 'store:prisma').total);
});

test('nothing hidden means nothing said', () => {
  const shown = filterLevel(lib, new Set());
  assert.equal(shown.hiddenTotal, 0);
  assert.deepEqual(shown.hidden, []);
  assert.equal(shown.nodes.length, lib.nodes.length);
  assert.equal(shown.edges.length, lib.edges.length);
});

// ---------------------------------------------------------------------------
// #94 — the label and the count described different things
// ---------------------------------------------------------------------------

/**
 * A copy of the fixture with one file added at the top of `src/`.
 *
 * That one file is the whole scenario. It pushes `src` past the size where the words
 * layer splits a folder into its subfolders, and because the folder now has a file of
 * its own it keeps its place as a group — a group of one file, sitting on a node whose
 * subtree is seventeen. That is the shape the report was about: `app` shown as
 * "Build Settings · 96 files" over a sentence describing five of them.
 */
function fixtureWithASplitFolder() {
  const dir = path.resolve(fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-split-')));
  fs.cpSync(FIXTURE, dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'src', 'flags.ts'),
    'export const FLAGS = { newCheckout: false };\n',
  );
  return dir;
}

/** Answers module batches by position, the way the real backends are asked to. */
function stubBackend() {
  return {
    id: 'stub',
    label: 'Stub',
    billing: 'subscription',
    concurrency: 4,
    probe: async () => ({ ok: true }),
    run: async (request) => {
      if (/one paragraph/.test(request.user)) return { text: 'It takes requests and stores them.' };
      const keys = [...request.user.matchAll(/^\[(\d+)\]/gm)].map((m) => m[1]);
      const wantsName = request.user.includes('"name"');
      const body = {};
      for (const key of keys) {
        body[key] = wantsName
          ? { name: `Part ${key}`, text: `Holds the things numbered ${key}` }
          : `Does the job of item ${key}`;
      }
      return { text: JSON.stringify(body) };
    },
  };
}

const split = fixtureWithASplitFolder();
const { atlas: splitAtlas } = await analyzeProject(split, { followReferences: true, cache: 'off' });
await enrichAtlas({ atlas: splitAtlas, backend: stubBackend(), cache: new Map() });
const splitGraph = new AtlasGraph(splitAtlas);
const moduleNode = (id) => splitAtlas.nodes.find((n) => n.id === id);

test('a name written about part of a folder records how much of it it covers', () => {
  const src = moduleNode('module:src');
  assert.ok(src.label, 'the folder was named');
  assert.equal(src.meta.descendantFileCount, 17, 'the box stands for the whole subtree');
  assert.equal(src.meta.describedFileCount, 1, 'the words were written about the file sitting in it');
});

test('a description that covers the whole folder claims nothing about a smaller one', () => {
  const libFolder = moduleNode('module:src/lib');
  assert.ok(libFolder.label);
  assert.equal(
    libFolder.meta.describedFileCount,
    libFolder.meta.descendantFileCount,
    'this group is the subtree, so the two numbers agree',
  );
});

test('the export says when the sentence covers fewer files than the count beside it', () => {
  const markdown = renderAtlasMarkdown(splitGraph, { toolVersion: 'test' });
  const line = markdown
    .split('\n')
    .find((row) => row.startsWith('- `src`') || row.startsWith('- `src/`'));
  assert.ok(line, 'the parts list should have a row for src');
  assert.match(line, /17 files/);
  assert.match(line, /about the 1 file directly in it, not all 17/);
});

test('nothing is claimed on a folder the words layer never described', () => {
  const bare = splitAtlas.nodes.find((n) => n.kind === 'module' && !n.label);
  if (!bare) return;
  assert.equal(bare.meta.describedFileCount, undefined);
});

test.after(() => fs.rmSync(split, { recursive: true, force: true }));
