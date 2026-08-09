/**
 * @fileoverview End-to-end tests for the generic tier's Rust plugin (#85).
 *
 * One fixture, shaped like the repo that asked for this: a Cargo workspace holding an
 * engine crate and a Tauri shell, with a vendored crate and a `target/` directory that
 * must never reach the map. The things a desktop app's engine needs read are the things
 * asserted here — the module graph `mod` and `use` spell out, `pub` as the visibility
 * rule, `#[tauri::command]` as a door, sqlx as the data story, and doc comments that
 * survive the attributes sitting between them and their items.
 *
 * Nothing here needs a Rust toolchain. The grammar is a WebAssembly file this repo
 * ships, so these run identically on a machine that has never had rustc on it — which
 * is the whole argument for the tier.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyzeProject, AtlasGraph, buildBoundaryView, buildInsights, grammarTier, renderAtlasMarkdown } from '../dist/node/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, 'fixtures', 'rustengine');

const { atlas } = await analyzeProject(FIXTURE, { followReferences: true, cache: 'off' });
const graph = new AtlasGraph(atlas);

const file = (relPath) => atlas.nodes.find((n) => n.kind === 'file' && n.path === relPath);
const find = (kind, name) => atlas.nodes.find((n) => n.kind === kind && n.name === name);
const importEdges = atlas.edges.filter((e) => e.kind === 'imports');
const importEdge = (from, to) =>
  importEdges.find((e) => e.fromId === `file:${from}` && e.toId === `file:${to}`);

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

test('reads Rust without a Rust toolchain anywhere on the machine', () => {
  assert.deepEqual(atlas.meta.languages, ['rust']);
  assert.deepEqual(atlas.meta.warnings, [], 'a clean fixture should produce no warnings');
  const paths = atlas.nodes.filter((n) => n.kind === 'file').map((n) => n.path).sort();
  assert.deepEqual(paths, [
    'app/src-tauri/src/commands.rs',
    'app/src-tauri/src/main.rs',
    'engine/src/lib.rs',
    'engine/src/modules/estimating.rs',
    'engine/src/modules/mod.rs',
    'engine/src/modules/report.rs',
  ]);
});

test('vendored crates and the target directory never reach the map', () => {
  // The repo this issue came from carries 77 files of somebody else's MySQL driver in
  // vendor/. Absent because Rust was unread was the bug; present would be a worse one.
  assert.equal(file('vendor/sqlx-mysql/src/lib.rs') ?? null, null);
  assert.equal(file('engine/target/debug/build/probe.rs') ?? null, null);
});

test('structs, enums and traits arrive with their fields, every node marked grammar-tier', () => {
  const row = find('type', 'EstimateRow');
  assert.deepEqual(row.meta.fields.map((f) => f.name), ['job', 'hours', 'notes']);
  assert.equal(row.meta.tier, 'tree-sitter');

  const stage = find('type', 'Stage');
  assert.deepEqual(stage.meta.fields.map((f) => f.name), ['Draft', 'Approved'], 'variants are the shape');

  const estimator = find('type', 'Estimator');
  assert.deepEqual(estimator.meta.fields.map((f) => f.name), ['estimate'], 'a trait requires its methods');
});

test('a method lives under the type its impl block names', () => {
  const total = find('function', 'total');
  assert.equal(total.meta.ownerName, 'EstimateRow');
  assert.equal(total.parentId, find('type', 'EstimateRow').id);
});

test('visibility is read from the word pub, not from the name', () => {
  assert.equal(find('function', 'load_estimates').meta.isExported, true);
  // #[test] functions inside `mod tests` write no `pub` and stay private.
  assert.equal(find('function', 'overhead_is_applied').meta.isExported, false);

  const row = find('type', 'EstimateRow');
  const fieldNamed = (name) => row.meta.fields.find((f) => f.name === name);
  assert.equal(fieldNamed('job').optional, false);

  const files = file('engine/src/modules/estimating.rs');
  assert.deepEqual(files.meta.exportedNames, ['EstimateRow', 'Estimator', 'Stage', 'load_estimates', 'save_estimate']);
});

// ---------------------------------------------------------------------------
// The module graph — what mod and use spell out
// ---------------------------------------------------------------------------

test('mod declarations are the include they are: lib.rs → mod.rs → the modules', () => {
  assert.ok(importEdge('engine/src/lib.rs', 'engine/src/modules/mod.rs'), 'pub mod modules;');
  assert.ok(importEdge('engine/src/modules/mod.rs', 'engine/src/modules/estimating.rs'));
  assert.ok(importEdge('engine/src/modules/mod.rs', 'engine/src/modules/report.rs'));
  assert.ok(importEdge('app/src-tauri/src/main.rs', 'app/src-tauri/src/commands.rs'), 'mod commands;');
});

test('a use through crate:: reaches its file, and the edge says likely', () => {
  const edge = importEdge('engine/src/modules/report.rs', 'engine/src/modules/estimating.rs');
  assert.ok(edge, 'use crate::modules::estimating::{…} links the two files');
  assert.equal(edge.confidence, 'likely', 'a name matched a name; this tier never claims more');
});

test('a name brought in by use resolves where it is used, function to function', () => {
  const build = find('function', 'build');
  const called = atlas.edges.filter((e) => e.kind === 'references' && e.fromId === build.id);
  assert.ok(
    called.some((e) => e.toId === find('function', 'load_estimates').id),
    'build() calls load_estimates through a use, and the reference edge follows it',
  );
});

test('external crates are the dependency list, with the toolchain left out', () => {
  const estimating = file('engine/src/modules/estimating.rs');
  assert.deepEqual(estimating.meta.externalImports, ['serde', 'sqlx']);
  // `std::env::var` is the standard library; nobody thinks of std as a dependency.
  const commands = file('app/src-tauri/src/commands.rs');
  assert.ok(!commands.meta.externalImports.includes('std'));
});

// ---------------------------------------------------------------------------
// The words
// ---------------------------------------------------------------------------

test('doc comments survive the attributes between them and their items', () => {
  // `/// One estimate…` sits above `#[derive(Debug, Serialize)]`, which is a sibling
  // of the struct rather than part of it — the shape that loses the doc in a naive
  // line-above rule.
  assert.equal(find('type', 'EstimateRow').summary, 'One estimate, as the dashboard consumes it.');
  assert.equal(find('type', 'EstimateRow').summarySource, 'docs');
  assert.equal(find('function', 'load_dashboard').summary, 'Everything the dashboard needs on open.');
  assert.equal(find('function', 'load_estimates').summary, 'Loads every estimate for one job.');
  assert.equal(find('function', 'total').summary, 'Hours with the overhead factor applied.');
});

test('a file is described by its //! block, and only by that', () => {
  assert.equal(
    file('engine/src/lib.rs').summary,
    'The estimating engine: the in-process rewrite of the Python data-gen.',
  );
  assert.equal(
    file('app/src-tauri/src/commands.rs').summary,
    'The commands the webview can invoke — the app’s doors into the engine.'.replace('’', "'"),
  );
  // main.rs has a //! header; nothing in it may borrow a function's /// instead.
  assert.equal(file('app/src-tauri/src/main.rs').summary, 'The desktop shell: wires the webview to the engine.');
});

// ---------------------------------------------------------------------------
// The boundary — doors, data, config
// ---------------------------------------------------------------------------

test('#[tauri::command] is a door, and a helper beside it is not', () => {
  const commands = atlas.nodes.filter((n) => n.kind === 'endpoint' && n.meta.endpointKind === 'ipc');
  assert.deepEqual(commands.map((n) => n.name).sort(), ['load_dashboard', 'save_note', 'view_reload']);
  for (const command of commands) {
    assert.equal(command.meta.framework, 'Tauri');
  }
  // The attribute with arguments still counts: #[tauri::command(rename_all = …)].
  assert.ok(commands.some((n) => n.name === 'save_note'));
});

test('the bare #[command] counts, because that is how Rust is written (#195)', () => {
  // `use tauri::{command}` then `#[command]` is the *common* spelling, and matching
  // only the qualified path recognised this fixture's own habit and missed real apps:
  // lencx/ChatGPT writes eleven commands this way and reported no doors at all.
  const commands = atlas.nodes.filter((n) => n.kind === 'endpoint' && n.meta.endpointKind === 'ipc');
  assert.ok(commands.some((n) => n.name === 'view_reload'), commands.map((n) => n.name).join(', '));
});

test("another crate's #[command] is not a Tauri door", () => {
  // clap defines one too. The import is the evidence, and `#[clap::command]` has none
  // of it — a rule that read every bare attribute would be guessing, not reading.
  const names = atlas.nodes
    .filter((n) => n.kind === 'endpoint' && n.meta.endpointKind === 'ipc')
    .map((n) => n.name);
  assert.ok(!names.includes('cli_entry'), names.join(', '));
});

test('commands never enter the auth count — the caller is the app itself', () => {
  const insights = buildInsights(graph);
  const routes = insights.auth.routes.map((r) => r.name);
  assert.ok(!routes.includes('load_dashboard') && !routes.includes('save_note'),
    'an ipc door in the auth table would be a false alarm about a door no stranger can reach');
});

test('the boundary view files commands beside the screens, under their own family', () => {
  const view = buildBoundaryView(graph);
  const commands = view.inputs.find((group) => group.family === 'commands');
  assert.ok(commands, `expected a commands card, got ${view.inputs.map((g) => g.family).join(', ')}`);
  assert.equal(commands.name, 'Commands your screens call');
  assert.deepEqual(commands.members.map((e) => e.name).sort(), ['load_dashboard', 'save_note', 'view_reload']);
  // No open-door count on the card: these are not doors a stranger can knock on, and a
  // number there would read as one.
  assert.equal(commands.openCount ?? undefined, undefined);
});

test('sqlx queries name their table, and the direction is read out of the SQL', () => {
  const store = atlas.nodes.find((n) => n.kind === 'store');
  assert.ok(store, 'the database is on the map');
  assert.equal(store.meta.client, 'sqlx');
  assert.deepEqual(store.meta.tables, ['estimates']);

  const reads = atlas.edges.filter((e) => e.kind === 'reads-from');
  const writes = atlas.edges.filter((e) => e.kind === 'writes-to');
  assert.equal(reads.length, 1, 'SELECT is a read');
  assert.equal(writes.length, 1, 'INSERT is a write');
  assert.equal(reads[0].fromId, find('function', 'load_estimates').id);
  assert.equal(writes[0].fromId, find('function', 'save_estimate').id);
});

test('std::env::var is the config inventory, labelled as the runtime that reads it', () => {
  const env = atlas.nodes.find((n) => n.kind === 'endpoint' && n.meta.endpointKind === 'env');
  assert.ok(env);
  assert.equal(env.meta.framework, 'Rust');
  assert.deepEqual(env.meta.vars.map((v) => v.name), ['FABIS_DATABASE_URL']);
});

test('Cargo.toml names the frameworks, however the dependency is spelled', () => {
  // `tauri = "2"` is a plain key; sqlx in the app crate is a `[dependencies.sqlx]`
  // section. Both spellings must reach the gate or the detectors sleep through them.
  assert.deepEqual(atlas.meta.frameworks, ['Tauri', 'sqlx']);
});

// ---------------------------------------------------------------------------
// The trade, stated
// ---------------------------------------------------------------------------

test('the export says Rust was read by grammar, not by a compiler', () => {
  const tier = grammarTier(atlas.nodes);
  assert.ok(tier);
  assert.equal(tier.display, 'Rust');
  const markdown = renderAtlasMarkdown(graph, { toolVersion: 'test' });
  assert.match(markdown, /Rust (was|were) read with a tree-sitter grammar/);
});

test('a repo with no Rust in it is untouched', async () => {
  const sample = (await analyzeProject(path.join(here, 'fixtures', 'sample'), { followReferences: true, cache: 'off' })).atlas;
  assert.ok(!sample.meta.languages.includes('rust'));
  assert.ok(sample.nodes.every((n) => n.language !== 'rust'));
  assert.equal(grammarTier(sample.nodes), null);
});
