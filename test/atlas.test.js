/**
 * @fileoverview End-to-end tests against the built analyzer.
 *
 * These run on dist/, not src/, so they test what actually ships. Run with:
 *   npm run build:node && npm test
 */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import { analyzeProject, AtlasGraph } from '../dist/node/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, 'fixtures', 'sample');

const { atlas } = await analyzeProject(FIXTURE, { followReferences: true });
const graph = new AtlasGraph(atlas);

const byId = new Map(atlas.nodes.map((n) => [n.id, n]));
const find = (kind, name) => atlas.nodes.find((n) => n.kind === kind && n.name === name);

test('finds every source file exactly once', () => {
  const paths = atlas.nodes
    .filter((n) => n.kind === 'file')
    .map((f) => f.path)
    .sort();
  assert.deepEqual(paths, [
    'src/api/routes.ts',
    'src/components/Badge.tsx',
    'src/lib/format.ts',
    'src/models/user.ts',
  ]);
});

test('reads types with their fields', () => {
  const user = find('type', 'User');
  assert.ok(user, 'User interface should exist');
  assert.equal(user.meta.typeKind, 'interface');
  assert.deepEqual(
    user.meta.fields.map((f) => f.name),
    ['id', 'email', 'displayName', 'role'],
  );
  assert.equal(user.meta.fields.find((f) => f.name === 'displayName').optional, true);
  assert.equal(user.meta.isExported, true);

  const role = find('type', 'Role');
  assert.equal(role.meta.typeKind, 'type-alias');

  const status = find('type', 'Status');
  assert.equal(status.meta.typeKind, 'enum');
  assert.deepEqual(status.meta.fields.map((f) => f.name), ['Active', 'Suspended']);
});

test('reads functions with signatures, including arrow consts', () => {
  const formatName = find('function', 'formatName');
  assert.ok(formatName);
  assert.equal(formatName.meta.returnType, 'string');
  assert.deepEqual(formatName.meta.params.map((p) => p.name), ['user']);
  assert.equal(formatName.meta.params[0].type, 'User');
  assert.equal(formatName.meta.isExported, true);

  const shout = find('function', 'shout');
  assert.ok(shout, 'arrow function consts should be captured');
  assert.equal(shout.meta.isExported, true);

  const helper = find('function', 'unusedHelper');
  assert.equal(helper.meta.isExported, false);
});

test('uses docstrings verbatim and labels their provenance', () => {
  const userFile = atlas.nodes.find((n) => n.path === 'src/models/user.ts' && n.kind === 'file');
  assert.equal(userFile.summarySource, 'docs');
  assert.match(userFile.summary, /sign in to the sample app/);
  assert.equal(userFile.provenance, 'docs');
  assert.ok(userFile.docHash);

  const formatName = find('function', 'formatName');
  assert.equal(formatName.summarySource, 'docs');
  assert.match(formatName.summary, /name shown in the interface/);

  // Body and doc hash separately, so M5 can spot stale documentation.
  assert.ok(formatName.bodyHash);
  assert.notEqual(formatName.bodyHash, formatName.docHash);

  const routes = atlas.nodes.find((n) => n.path === 'src/api/routes.ts' && n.kind === 'file');
  assert.equal(routes.summary, null, 'no docstring means no invented summary');
  assert.equal(routes.provenance, 'static');
});

test('links files that import each other, and records external packages', () => {
  const imports = atlas.edges.filter((e) => e.kind === 'imports');
  const hasEdge = (from, to) =>
    imports.some((e) => e.fromId === `file:${from}` && e.toId === `file:${to}`);

  assert.ok(hasEdge('src/api/routes.ts', 'src/lib/format.ts'));
  assert.ok(hasEdge('src/api/routes.ts', 'src/models/user.ts'));
  assert.ok(hasEdge('src/lib/format.ts', 'src/models/user.ts'));
  assert.ok(hasEdge('src/components/Badge.tsx', 'src/models/user.ts'));

  const routes = atlas.nodes.find((n) => n.id === 'file:src/api/routes.ts');
  assert.deepEqual(routes.meta.externalImports, ['express']);
});

test('traces symbol references across files', () => {
  const references = atlas.edges.filter((e) => e.kind === 'references');
  const userId = find('type', 'User').id;
  const formatNameId = find('function', 'formatName').id;

  const usersOfUser = references.filter((e) => e.toId === userId);
  assert.ok(usersOfUser.length >= 3, `User should be referenced from several places, got ${usersOfUser.length}`);

  const callersOfFormatName = references.filter((e) => e.toId === formatNameId);
  assert.ok(
    callersOfFormatName.some((e) => e.fromId.includes('registerRoutes')),
    'registerRoutes calls formatName',
  );
  assert.ok(
    callersOfFormatName.some((e) => e.fromId.includes('Badge')),
    'Badge calls formatName',
  );
});

test('classifies zones from conventions', () => {
  const zoneOf = (p) => atlas.nodes.find((n) => n.kind === 'file' && n.path === p).zone;
  assert.equal(zoneOf('src/components/Badge.tsx'), 'ui');
  assert.equal(zoneOf('src/api/routes.ts'), 'api');
  assert.equal(zoneOf('src/models/user.ts'), 'data');
  assert.equal(zoneOf('src/lib/format.ts'), 'logic');
});

test('builds a containment tree the map can walk', () => {
  const app = atlas.nodes.find((n) => n.kind === 'app');
  assert.ok(app);
  assert.equal(app.parentId, null);

  // src holds four folders, so it must not collapse into any one of them.
  const src = byId.get('module:src');
  assert.ok(src, 'src module exists');
  assert.equal(src.parentId, app.id);

  for (const node of atlas.nodes) {
    if (node.parentId) assert.ok(byId.has(node.parentId), `${node.id} has a real parent`);
  }
  for (const edge of atlas.edges) {
    assert.ok(byId.has(edge.fromId), `${edge.id} starts somewhere real`);
    assert.ok(byId.has(edge.toId), `${edge.id} ends somewhere real`);
  }
});

test('rolls edges up to whatever level is on screen', () => {
  const level = graph.getLevel('module:src');
  const names = level.nodes.map((n) => n.name).sort();
  assert.deepEqual(names, ['api', 'components', 'lib', 'models']);

  const edge = level.edges.find((e) => e.fromId === 'module:src/api' && e.toId === 'module:src/models');
  assert.ok(edge, 'api → models should be one aggregated arrow');
  assert.ok(edge.weight >= 1);

  // Nothing on screen may point at something that is not on screen.
  const visible = new Set(level.nodes.map((n) => n.id));
  for (const e of level.edges) {
    assert.ok(visible.has(e.fromId) && visible.has(e.toId));
  }
});

test('answers "what is this and what uses it" for any node', () => {
  const view = graph.getNode(find('type', 'User').id);
  assert.ok(view);
  assert.equal(view.node.name, 'User');
  assert.ok(view.breadcrumb.length >= 3, 'breadcrumb walks back to the app');
  assert.equal(view.breadcrumb[0].kind, 'app');
  assert.ok(view.incomingTotal >= 3);
});

test('search finds things by name and by path', () => {
  assert.ok(graph.search('User').some((n) => n.name === 'User'));
  assert.ok(graph.search('format').some((n) => n.path === 'src/lib/format.ts'));
  assert.equal(graph.search('').length, 0);
});

test('every node carries the metadata later milestones need', () => {
  for (const node of atlas.nodes) {
    assert.ok(node.hash, `${node.id} has a content hash`);
    assert.ok(['static', 'docs', 'ai'].includes(node.provenance));
    assert.ok(typeof node.zone === 'string');
  }
  assert.equal(atlas.meta.formatVersion, 2);
  assert.deepEqual(atlas.meta.frameworks.sort(), ['Express', 'React']);
  assert.equal(atlas.meta.stats.files, 4);
});
