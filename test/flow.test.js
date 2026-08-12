/**
 * @fileoverview The door list and the flow behind one door (SPEC.md 6.4).
 *
 * What is being defended here is not that the traversal works — it is that the two
 * ways it can lie are closed:
 *
 *   - the list is *every* way in, because this is the surface somebody arrives at
 *     hunting for a particular door, and a door left off it reads as one that does
 *     not exist rather than one that did not make a top five;
 *   - a bounded walk says it was bounded, and a door this atlas cannot follow inward
 *     says that too instead of rendering as a door with nothing behind it.
 */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import { analyzeProject, AtlasGraph, buildFlow, listDoors } from '../dist/node/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const BOUNDARY = path.join(here, 'fixtures', 'boundary');

const graph = new AtlasGraph((await analyzeProject(BOUNDARY, { followReferences: true, cache: 'off' })).atlas);
const doors = listDoors(graph);
const everyDoor = doors.groups.flatMap((group) => group.doors);
const doorFor = (route, method) =>
  everyDoor.find((door) => door.route === route && (!method || door.method === method));

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

test('every way in is listed, not the handful worth suggesting', () => {
  // The walkthroughs offer five on purpose. This is the opposite surface: the reader
  // came looking for one door, so the twelfth has to be here too.
  const endpoints = graph
    .nodesOfKind('endpoint')
    .filter((node) => node.meta.endpointKind !== 'env');
  assert.equal(doors.total, endpoints.length);
  assert.equal(everyDoor.length, endpoints.length);
});

test('the environment inventory is not a door anybody walks through', () => {
  assert.ok(
    graph.nodesOfKind('endpoint').some((node) => node.meta.endpointKind === 'env'),
    'the fixture has one, so the exclusion is actually being exercised',
  );
  assert.equal(
    everyDoor.some((door) => door.endpointKind === 'env'),
    false,
  );
});

test('doors are grouped by kind, network before screens', () => {
  const kinds = doors.groups.map((group) => group.kind);
  assert.deepEqual(kinds, ['http-route', 'webhook', 'server-action', 'cron']);
  for (const group of doors.groups) {
    assert.ok(group.label.length > 0, `${group.kind} has no plural a reader would use`);
    assert.ok(group.doors.length > 0, `${group.kind} is an empty group`);
  }
});

// ---------------------------------------------------------------------------
// A door this atlas cannot follow inward
// ---------------------------------------------------------------------------

test('a door no code answers is listed, and says so', () => {
  // PostgREST publishes four doors per table straight out of a migration. They are
  // real ways in; there is simply no file in the repo on the other side of them.
  const door = doorFor('/rest/v1/sessions', 'DELETE');
  assert.ok(door, 'the schema-published door is on the list');
  assert.equal(door.answered, false);
  assert.equal(doors.unanswered, 12, 'three tables, four verbs each');
});

test('following one of those is an empty flow, not an error', () => {
  // "Nothing is behind this" is a real answer to the question, and a different answer
  // from "no such door" — which is what a 404 here would have said.
  const flow = buildFlow(graph, doorFor('/rest/v1/sessions', 'DELETE').id);
  assert.ok(flow);
  assert.equal(flow.stops.length, 0);
  assert.equal(flow.exits.length, 0);
  assert.equal(flow.door.answered, false);
  assert.match(flow.trigger, /sends DELETE to \/rest\/v1\/sessions/);
});

test('something that is not a door at all is refused', () => {
  assert.equal(buildFlow(graph, 'file:src/app/api/users/route.ts'), null);
  assert.equal(buildFlow(graph, 'no such node'), null);
});

// ---------------------------------------------------------------------------
// Where a door leads
// ---------------------------------------------------------------------------

test('a flow reaches past the code that answers the door', () => {
  const flow = buildFlow(graph, doorFor('/api/users', 'POST').id);
  assert.ok(flow.stops.length >= 2, 'the handler and at least what it calls on');
  assert.equal(flow.stops[0].hop, 1, 'the code the framework runs is the first hop');
  assert.ok(
    flow.stops.some((stop) => stop.hop > 1),
    'and the walk keeps going from there',
  );
  assert.ok(
    flow.stops.some((stop) => stop.name === 'sendWelcome'),
    `what the handler calls is on the flow: ${flow.stops.map((s) => s.name).join(', ')}`,
  );
});

test('a flow names where data leaves, and which of those it writes to', () => {
  const flow = buildFlow(graph, doorFor('/api/users', 'POST').id);
  const names = flow.exits.map((exit) => exit.name);
  assert.ok(names.includes('PostgreSQL'), `got ${names.join(', ')}`);
  assert.ok(names.includes('Resend'), 'the welcome mail leaves through Resend');

  const db = flow.exits.find((exit) => exit.name === 'PostgreSQL');
  assert.equal(db.writes, true, 'the handler writes the user it just made');
  assert.ok(db.detail.length > 0, 'an exit says what it is, not just its name');
  assert.ok(
    db.reachedBy.every((id) => flow.stops.some((stop) => stop.id === id)),
    'an exit is reached by code that is on the flow',
  );
});

test('somewhere data is written outranks somewhere it is only read', () => {
  const flow = buildFlow(graph, doorFor('/api/users', 'POST').id);
  const firstReadOnly = flow.exits.findIndex((exit) => !exit.writes);
  const lastWrite = flow.exits.map((exit) => exit.writes).lastIndexOf(true);
  if (firstReadOnly !== -1 && lastWrite !== -1) {
    assert.ok(lastWrite < firstReadOnly, 'writes are not interleaved with reads');
  }
});

test('a door that reaches nothing outside is not given an exit it does not have', () => {
  // The greet function answers, and stops. An empty list is the honest rendering.
  const flow = buildFlow(graph, doorFor('/functions/v1/greet').id);
  assert.ok(flow.stops.length >= 1, 'something answers it');
  assert.deepEqual(flow.exits, []);
});

// ---------------------------------------------------------------------------
// Saying what was not shown
// ---------------------------------------------------------------------------

test('a walk that finished says it was not cut short', () => {
  const flow = buildFlow(graph, doorFor('/api/users', 'POST').id);
  assert.deepEqual(flow.limits, { hitDepth: false, hitStops: false, exitsHidden: 0 });
  assert.equal(flow.maxHop, Math.max(...flow.stops.map((stop) => stop.hop)));
});

test('every link joins two things that are on the flow', () => {
  for (const group of doors.groups) {
    for (const door of group.doors) {
      const flow = buildFlow(graph, door.id);
      const known = new Set([door.id, ...flow.stops.map((stop) => stop.id)]);
      for (const link of flow.links) {
        assert.ok(known.has(link.fromId), `${door.id}: link from an unknown ${link.fromId}`);
        assert.ok(known.has(link.toId), `${door.id}: link to an unknown ${link.toId}`);
      }
    }
  }
});

test('the same pair of files is one link however many times they name each other', () => {
  for (const group of doors.groups) {
    for (const door of group.doors) {
      const flow = buildFlow(graph, door.id);
      const pairs = flow.links.map((link) => `${link.fromId} ${link.toId}`);
      assert.equal(new Set(pairs).size, pairs.length, `${door.id} draws a link twice`);
    }
  }
});

test('confidence is carried through from the edge, never invented', () => {
  const allowed = new Set(['certain', 'likely', 'possible']);
  for (const group of doors.groups) {
    for (const door of group.doors) {
      const flow = buildFlow(graph, door.id);
      for (const stop of flow.stops) {
        assert.ok(allowed.has(stop.confidence), `${stop.name} has confidence ${stop.confidence}`);
      }
    }
  }
});
