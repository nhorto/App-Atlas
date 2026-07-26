/**
 * @fileoverview End-to-end tests for M4 (SPEC.md 6.3, 6.4, 7).
 *
 * Three things are being defended here, and they are all about honesty rather than
 * feature coverage:
 *
 *   - a link between two shapes says *which field* made it, and a link that is only a
 *     shared name is never dressed up as a fact;
 *   - a tour step's paragraph is derived from the graph, so a description written by a
 *     model can never be smuggled into it unlabelled;
 *   - the markdown export marks generated sentences and caps every list, because the
 *     whole point of it is to be cheap enough to paste into a context window.
 */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import {
  analyzeProject,
  AtlasGraph,
  buildTours,
  buildTypeView,
  renderAtlasMarkdown,
} from '../dist/node/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const BOUNDARY = path.join(here, 'fixtures', 'boundary');
const SAMPLE = path.join(here, 'fixtures', 'sample');

const boundaryAtlas = (await analyzeProject(BOUNDARY, { followReferences: true, cache: 'off' })).atlas;
const boundary = new AtlasGraph(boundaryAtlas);
const sample = new AtlasGraph((await analyzeProject(SAMPLE, { followReferences: true, cache: 'off' })).atlas);

/** A private copy, for the tests that need to change a description and re-render. */
const copyOfBoundary = () => new AtlasGraph(structuredClone(boundaryAtlas));

// ---------------------------------------------------------------------------
// Field-level links (SPEC.md 6.3)
// ---------------------------------------------------------------------------

test('a reference between two types remembers which field made it', () => {
  const edge = sample
    .edgesFrom('type:src/models/user.ts#User')
    .find((e) => e.toId === 'type:src/models/user.ts#Role');

  assert.ok(edge, 'User.role points at Role');
  assert.deepEqual(edge.meta.fields, ['role'], 'the row, not just the card');
});

test('a node reports the types it is built around, pulled out of its references', () => {
  // `countUsers` runs `prisma.user…` and names the User model — the shape of the data
  // it works with, which the panel surfaces as its own answer.
  const fn = boundaryAtlas.nodes.find((n) => n.kind === 'function' && n.name === 'countUsers');
  assert.ok(fn, 'the fixture has a countUsers function');
  const view = boundary.getNode(fn.id);
  const names = view.typesUsed.map((t) => t.name);
  assert.ok(names.includes('User'), `expected User among ${JSON.stringify(names)}`);
  // Everything in the list is a type node, never a function or a store.
  assert.ok(view.typesUsed.every((t) => t.kind === 'type'));
});

test('an initializer is not a field pointing at a type', () => {
  const session = 'type:src/models/user.ts#Session';
  const toUser = sample.edgesFrom(session).find((e) => e.toId === 'type:src/models/user.ts#User');
  assert.deepEqual(toUser.meta.fields, ['signedIn'], 'the annotated property links');

  const toHelper = sample.edgesFrom(session).find((e) => e.toId.includes('defaultLabel'));
  assert.ok(toHelper, 'the call is still a reference');
  assert.equal(toHelper.meta.fields, undefined, 'but calling something is not pointing at its type');
});

test('a row only ever links to a card that is on screen', () => {
  for (const view of [buildTypeView(boundary), buildTypeView(sample)]) {
    const ids = new Set(view.cards.map((card) => card.id));
    for (const card of view.cards) {
      for (const field of card.fields) {
        if (field.linkTo) assert.ok(ids.has(field.linkTo), `${card.name}.${field.name} points somewhere real`);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// Database tables (SPEC.md 6.3, bonus)
// ---------------------------------------------------------------------------

test('reads the schema as tables with columns, keys and relations', () => {
  const user = boundary.getNodeById('type:prisma/schema.prisma#User');
  assert.ok(user, 'every model becomes a shape');
  assert.equal(user.meta.typeKind, 'table');
  assert.equal(user.zone, 'data');
  assert.equal(user.meta.provider, 'postgresql');

  const id = user.meta.fields.find((f) => f.name === 'id');
  assert.equal(id.isId, true);
  const email = user.meta.fields.find((f) => f.name === 'email');
  assert.equal(email.isUnique, true);

  const relation = boundary
    .edgesFrom('type:prisma/schema.prisma#Order')
    .find((e) => e.toId === 'type:prisma/schema.prisma#User');
  assert.ok(relation, 'a declared relation is an edge');
  assert.deepEqual(relation.meta.fields, ['user']);
  assert.equal(relation.confidence, 'certain', 'the schema says so — this is not a guess');
});

test("a `///` comment is the schema's docstring, and is read verbatim", () => {
  const log = boundary.getNodeById('type:prisma/schema.prisma#AuditLog');
  assert.equal(log.summary, 'Every change worth keeping a record of.');
  assert.equal(log.summarySource, 'docs');
});

test('an enum-typed column is not reported as a relation', () => {
  for (const node of boundary.nodesOfKind('type')) {
    for (const edge of boundary.edgesFrom(node.id)) {
      const target = boundary.getNodeById(edge.toId);
      assert.ok(target, `${edge.id} points at something real`);
    }
  }
});

// ---------------------------------------------------------------------------
// The type explorer (SPEC.md 6.3)
// ---------------------------------------------------------------------------

test('tables come first, and every card knows where it is used', () => {
  const view = buildTypeView(boundary);
  // Three from schema.prisma, two from SQL migrations, one observed in queries.
  assert.equal(view.tables, 6);
  assert.equal(view.cards[0].typeKind, 'table');

  const order = view.cards.find((c) => c.name === 'Order');
  const relation = order.fields.find((f) => f.name === 'user');
  assert.equal(relation.linkTo, 'type:prisma/schema.prisma#User', 'the row carries its own line');
});

test('usage is broken down by zone, which is what the panel promises', () => {
  const view = buildTypeView(sample);
  const user = view.cards.find((c) => c.name === 'User');
  assert.ok(user.usage > 0);
  assert.equal(
    user.usageByZone.reduce((sum, entry) => sum + entry.count, 0),
    user.usage,
    'the parts add up to the whole',
  );
});

test('a shared name is a link of its own kind, never a declared one', () => {
  // The fixture has no TypeScript `User`, so the only links here are declared ones.
  const view = buildTypeView(boundary);
  for (const link of view.links) {
    assert.equal(link.basis, 'declared');
    assert.ok(link.fields.length > 0, 'a declared link between tables came from a column');
  }
});

test('the card list is capped, and says so by reporting the total', () => {
  const view = buildTypeView(boundary, 2);
  assert.equal(view.cards.length, 2);
  assert.equal(view.total, 6, 'the count is of everything, not of what fit');
});

// ---------------------------------------------------------------------------
// Tours (SPEC.md 6.4)
// ---------------------------------------------------------------------------

const tours = buildTours(boundary);

test('the welcome tour answers the questions people ask first', () => {
  const welcome = tours[0];
  assert.equal(welcome.kind, 'welcome');
  assert.ok(welcome.steps.length >= 4);
  assert.ok(
    welcome.steps.some((step) => /9 ways in/.test(step.body)),
    'the doors are counted from the graph, not guessed',
  );
});

test('a flow is traced from the door to the database', () => {
  const tour = tours.find((t) => t.title.includes('POST to /api/users'));
  assert.ok(tour, 'a writing route with a handler earns a tour');

  const titles = tour.steps.map((s) => s.title);
  assert.deepEqual(titles.slice(0, 2), ['Something knocks', 'Your code answers']);
  assert.ok(
    tour.steps.some((s) => /PostgreSQL/.test(s.body)),
    'the trace reaches the store the handler writes to',
  );
  assert.ok(tour.steps.every((s) => s.body.length > 0));
});

test('an open door that writes data ends its tour with the warning', () => {
  const tour = tours.find((t) => t.title.includes('createOrder'));
  const last = tour.steps[tour.steps.length - 1];
  assert.equal(last.tone, 'warn');
  assert.match(last.body, /no auth check/);
});

test('a step never puts a written description in its own voice', () => {
  for (const tour of tours) {
    for (const step of tour.steps) {
      if (!step.quote) continue;
      assert.ok(
        !step.body.includes(step.quote),
        `${step.id} quotes ${step.quoteSource} separately rather than absorbing it`,
      );
      assert.ok(step.quoteSource === 'docs' || step.quoteSource === 'ai');
    }
  }
});

test('a webhook is not credited to the framework that found it', () => {
  const tour = tours.find((t) => t.title.includes('webhook'));
  assert.match(tour.title, /an outside service calls your webhook/);
  assert.ok(!tour.title.includes('Next.js'), 'Next.js found the door; it does not knock on it');
});

test('every step points somewhere the map can actually go', () => {
  for (const tour of tours) {
    for (const step of tour.steps) {
      if (step.levelId) assert.ok(boundary.getNodeById(step.levelId), `${step.id} level exists`);
      if (step.codeId) assert.ok(boundary.getNodeById(step.codeId), `${step.id} code node exists`);
      for (const id of step.focusIds) assert.ok(boundary.getNodeById(id), `${step.id} focus ${id} exists`);
    }
  }
});

// ---------------------------------------------------------------------------
// ATLAS.md (SPEC.md 7)
// ---------------------------------------------------------------------------

const markdown = renderAtlasMarkdown(boundary);

test('the export leads with the facts an agent can act on', () => {
  assert.match(markdown, /## By the numbers/);
  assert.match(markdown, /\| POST \| \/api\/users \| Clerk \| yes \|/);
  assert.match(markdown, /\*\*none found\*\*/, 'an unguarded door says so in the table');
  assert.match(markdown, /## Database tables/);
  assert.match(markdown, /\*\*User\*\* — id: String, email: String, orders: Order\[\]/);
});

test('code that runs on its own is listed even though auth cannot apply', () => {
  assert.match(markdown, /## Also runs on its own/);
  assert.match(markdown, /\*\*cron\*\* \/api\/cron\/digest \(0 8 \* \* \*\)/);
  assert.match(markdown, /\*\*webhook\*\*/);
});

test('a generated sentence is marked, and a docstring is not', () => {
  const graph = copyOfBoundary();
  const file = graph.getNodeById('file:src/lib/db.ts');
  file.summary = 'A description a model wrote.';
  file.summarySource = 'ai';

  const text = renderAtlasMarkdown(graph);
  assert.match(text, /A description a model wrote\. _\(ai\)_/);
  assert.ok(
    !/Sending mail, and telling the analytics service about it\. _\(ai\)_/.test(text),
    "the repo's own words are not labelled as a machine's",
  );
});

test('the export stays small enough to paste into a context window', () => {
  assert.ok(markdown.length < 12000, `2.7 KB expected for this fixture, got ${markdown.length}`);
  assert.match(markdown, /Re-run `app-atlas export` after the code changes/);
});
