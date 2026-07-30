/**
 * @fileoverview Tests for the words layer (SPEC.md 5.5).
 *
 * Every test here runs against a stub backend. That is not only about speed and not
 * needing a key — it is the only way to assert the properties that matter, because
 * they are all about what happens when a model misbehaves: returns keys nobody asked
 * about, refuses, wraps its JSON in a fence, or tries to overwrite something a human
 * wrote. A real model would pass these most of the time, which is exactly what makes
 * it useless as a test.
 *
 * The assertions that matter most are the ones about restraint: a generated sentence
 * must never displace a docstring, an unasked-for key must never reach the atlas, and
 * nothing may be spent without being approved.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  atlasDbPath,
  AtlasStore,
  cleanLabel,
  cleanParagraph,
  cleanSentence,
  enrichAtlas,
  initConventions,
  markStaleDocs,
  parseJsonReply,
  analyzeProject,
  writeTheWords,
} from '../dist/node/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, 'fixtures', 'boundary');

/**
 * Answers whatever it was asked, by reading the `[1] [2] [3]` keys back out of the
 * prompt. Batching means the runner decides how many items land in one request, and a
 * stub with hard-coded keys would silently stop covering half of them.
 */
function stubBackend(overrides = {}) {
  const calls = [];
  return {
    id: 'stub',
    label: 'Stub',
    billing: overrides.billing ?? 'subscription',
    pricing: overrides.pricing,
    concurrency: 4,
    calls,
    probe: async () => ({ ok: true }),
    run: async (request) => {
      calls.push(request);
      if (overrides.reply) return { text: overrides.reply(request) };

      if (/one paragraph/.test(request.user)) {
        return { text: 'Your app takes in web requests and stores them in Postgres. It also charges cards.' };
      }

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

async function freshAtlas() {
  const { atlas } = await analyzeProject(FIXTURE, { followReferences: true, cache: 'off' });
  return atlas;
}

// ---------------------------------------------------------------------------
// The ladder
// ---------------------------------------------------------------------------

test('describes the app, names the folders, and captions the files', async () => {
  const atlas = await freshAtlas();
  const backend = stubBackend();

  const report = await enrichAtlas({ atlas, backend, cache: new Map() });

  const app = atlas.nodes.find((n) => n.kind === 'app');
  assert.match(app.summary, /takes in web requests/);
  assert.equal(app.summarySource, 'ai');

  const labelledFolders = atlas.nodes.filter((n) => n.kind === 'module' && n.label);
  assert.ok(labelledFolders.length > 0, 'folders should get plain-English names');

  const describedFiles = atlas.nodes.filter((n) => n.kind === 'file' && n.summarySource === 'ai');
  assert.ok(describedFiles.length > 0, 'files without docstrings should get a sentence');
  assert.ok(report.described > 0);
  assert.equal(report.failedRequests, 0);
});

test('a generated sentence never displaces a docstring', async () => {
  const atlas = await freshAtlas();
  const documented = atlas.nodes.filter((n) => n.kind === 'file' && n.summarySource === 'docs');
  assert.ok(documented.length > 0, 'the fixture needs at least one documented file');
  const before = documented.map((n) => ({ id: n.id, summary: n.summary }));

  await enrichAtlas({ atlas, backend: stubBackend(), cache: new Map() });

  for (const { id, summary } of before) {
    const after = atlas.nodes.find((n) => n.id === id);
    assert.equal(after.summarySource, 'docs', `${id} should still be described by its own docstring`);
    assert.equal(after.summary, summary);
  }
});

test('never sends a file that already has a docstring', async () => {
  const atlas = await freshAtlas();
  const backend = stubBackend();
  await enrichAtlas({ atlas, backend, cache: new Map() });

  const documentedPaths = atlas.nodes
    .filter((n) => n.kind === 'file' && n.summarySource === 'docs')
    .map((n) => n.path);
  const everythingAsked = backend.calls.map((c) => c.user).join('\n');

  for (const filePath of documentedPaths) {
    assert.ok(
      !everythingAsked.includes(`[1] ${filePath}`) && !new RegExp(`^\\[\\d+\\] ${escapeRe(filePath)}$`, 'm').test(everythingAsked),
      `${filePath} already has a description and should not have been sent`,
    );
  }
});

// ---------------------------------------------------------------------------
// Not paying twice
// ---------------------------------------------------------------------------

test('a second pass over unchanged code sends nothing', async () => {
  const first = await freshAtlas();
  const backend = stubBackend();
  const report = await enrichAtlas({ atlas: first, backend, cache: new Map() });
  assert.ok(backend.calls.length > 0);

  // The same code, analyzed again, with what the first pass paid for.
  const second = await freshAtlas();
  const again = stubBackend();
  const cachedReport = await enrichAtlas({ atlas: second, backend: again, cache: report.additions });

  assert.equal(again.calls.length, 0, 'nothing should be sent when every answer is cached');
  assert.equal(cachedReport.pendingItems, 0);
  assert.ok(cachedReport.reusedFromCache > 0);

  const app = second.nodes.find((n) => n.kind === 'app');
  assert.match(app.summary, /takes in web requests/, 'the cached text should still be applied');
});

test('--no-ai keeps the words already written instead of throwing them away', async () => {
  // Someone analyzes once with a backend, then re-runs offline — on a plane, in CI,
  // or just to save a call. The second run must not strip the plain-English names
  // back to folder names: those words are already paid for and sitting on disk.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-noai-'));
  try {
    fs.cpSync(FIXTURE, dir, { recursive: true });
    const { atlas: first } = await analyzeProject(dir, { followReferences: true, cache: 'off' });
    const report = await enrichAtlas({ atlas: first, backend: stubBackend(), cache: new Map() });

    const store = AtlasStore.open(atlasDbPath(dir));
    store.writeExplanations(report.additions);
    store.close();

    const { atlas: second } = await analyzeProject(dir, { followReferences: true, cache: 'off' });
    assert.equal(second.nodes.find((n) => n.kind === 'app').summary, null, 'a bare analysis has no words yet');

    const offline = await writeTheWords({ root: dir, atlas: second, enabled: false, quiet: true });
    assert.ok(offline.reusedFromCache > 0, 'the cache should be applied even with AI off');
    assert.match(second.nodes.find((n) => n.kind === 'app').summary, /takes in web requests/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('reports what is missing without starting a backend', async () => {
  const atlas = await freshAtlas();
  const report = await enrichAtlas({ atlas, backend: null, cache: new Map() });

  assert.ok(report.pendingItems > 0);
  assert.equal(report.backend, 'cache');
  assert.equal(atlas.nodes.find((n) => n.kind === 'app').summary, null);
});

// ---------------------------------------------------------------------------
// Nothing invented survives
// ---------------------------------------------------------------------------

test('drops keys nobody asked about, and refusals', async () => {
  const atlas = await freshAtlas();
  const backend = stubBackend({
    reply: (request) => {
      if (/one paragraph/.test(request.user)) return "I'm sorry, I can't help with that.";
      const wantsName = request.user.includes('"name"');
      // One real answer, one refusal, and one key that was never in the prompt.
      return wantsName
        ? '```json\n{"1": {"name": "Real Name", "text": "A real description"}, "999": {"name": "Ghost", "text": "Invented"}}\n```'
        : '{"1": "A real description", "999": "Invented file that does not exist"}';
    },
  });

  await enrichAtlas({ atlas, backend, cache: new Map() });

  const app = atlas.nodes.find((n) => n.kind === 'app');
  assert.equal(app.summary, null, 'a refusal must not become the description of the app');

  const invented = atlas.nodes.filter((n) => (n.summary ?? '').includes('Invented'));
  assert.deepEqual(invented, [], 'no node should carry text from a key we never sent');

  const real = atlas.nodes.filter((n) => n.summary === 'A real description');
  assert.ok(real.length > 0, 'the fenced JSON should still have been read');
});

test('accepts a reply keyed by path instead of by number', async () => {
  // What Codex actually did the first time this ran against a real backend: it
  // ignored the requested numeric keys and used the file path, because the path is
  // the most human-looking identifier on the line. Both are things we put in the
  // prompt, so both are safe to accept — and refusing one throws away a good answer.
  const atlas = await freshAtlas();
  const backend = stubBackend({
    reply: (request) => {
      if (/one paragraph/.test(request.user)) return 'Your app does a number of things for its users every day.';
      const entries = [...request.user.matchAll(/^\[\d+\] (.+)$/gm)].map((m) => m[1].trim());
      const wantsName = request.user.includes('"name"');
      const body = {};
      for (const path of entries) {
        body[path] = wantsName ? { name: 'By Path', text: `Keyed by path: ${path}` } : `Keyed by path: ${path}`;
      }
      return JSON.stringify(body);
    },
  });

  await enrichAtlas({ atlas, backend, cache: new Map() });

  const described = atlas.nodes.filter((n) => (n.summary ?? '').startsWith('Keyed by path:'));
  assert.ok(described.length > 0, 'a path-keyed reply should still be understood');

  // And it must still land on the right node, not just on some node.
  for (const node of described) {
    assert.ok(
      node.summary.endsWith(node.path ?? node.meta.dirPath),
      `${node.id} got a description meant for ${node.summary}`,
    );
  }
});

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

test('asks before spending on a metered backend, and stops if told no', async () => {
  const atlas = await freshAtlas();
  const backend = stubBackend({ billing: 'metered', pricing: { inputPerMillion: 3, outputPerMillion: 15 } });
  let seen = null;

  const report = await enrichAtlas({
    atlas,
    backend,
    cache: new Map(),
    confirm: async (estimate) => {
      seen = estimate;
      return false;
    },
  });

  assert.ok(seen, 'a metered backend must ask');
  assert.ok(seen.items > 0 && seen.requests > 0);
  assert.ok(seen.costUsd > 0, 'the estimate needs a number in it');
  assert.equal(report.declined, true);
  assert.equal(backend.calls.length, 0, 'nothing may be sent after a refusal');
  assert.equal(atlas.nodes.find((n) => n.kind === 'app').summary, null);
});

test('never interrupts for a subscription the user already pays for', async () => {
  const atlas = await freshAtlas();
  const backend = stubBackend({ billing: 'subscription' });
  let asked = false;

  await enrichAtlas({
    atlas,
    backend,
    cache: new Map(),
    confirm: async () => {
      asked = true;
      return true;
    },
  });

  assert.equal(asked, false, 'a free-at-the-margin backend must not prompt');
  assert.ok(backend.calls.length > 0, 'and it should still do the work');
});

// ---------------------------------------------------------------------------
// Stale docstrings
// ---------------------------------------------------------------------------

test('flags a docstring whose code changed underneath it, and remembers', () => {
  const node = (docHash, bodyHash, meta = {}) => ({
    id: 'file:src/a.ts',
    kind: 'file',
    summarySource: 'docs',
    summary: 'Sends the welcome email',
    docHash,
    bodyHash,
    meta,
  });
  const atlasOf = (n) => ({ meta: {}, nodes: [n], edges: [] });

  // Body changed, docstring did not.
  const second = atlasOf(node('doc-1', 'body-2'));
  markStaleDocs(atlasOf(node('doc-1', 'body-1')), second);
  assert.equal(second.nodes[0].meta.docsStale, true);

  // Nothing changes on the next run — the flag must survive, or a docstring that
  // went stale two analyses ago would quietly be forgiven.
  const third = atlasOf(node('doc-1', 'body-2'));
  markStaleDocs(second, third);
  assert.equal(third.nodes[0].meta.docsStale, true);

  // The docstring is rewritten: a fresh claim about the code, so the flag clears.
  const fourth = atlasOf(node('doc-2', 'body-2'));
  markStaleDocs(third, fourth);
  assert.notEqual(fourth.nodes[0].meta.docsStale, true);
});

test('says nothing about staleness on a first analysis', () => {
  const atlas = { meta: {}, nodes: [{ id: 'f', kind: 'file', summarySource: 'docs', docHash: 'd', bodyHash: 'b', meta: {} }], edges: [] };
  markStaleDocs(null, atlas);
  assert.notEqual(atlas.nodes[0].meta.docsStale, true);
});

// ---------------------------------------------------------------------------
// Reading a model's reply
// ---------------------------------------------------------------------------

test('reads JSON out of whatever wrapping it arrives in', () => {
  assert.deepEqual(parseJsonReply('```json\n{"1":"hi"}\n```'), { 1: 'hi' });
  assert.deepEqual(parseJsonReply('Sure! Here it is:\n{"1":"hi"}'), { 1: 'hi' });
  assert.equal(parseJsonReply('no json here'), null);
  assert.equal(parseJsonReply('[1,2,3]'), null);
});

test('trims a description to one sentence and refuses a failure message', () => {
  assert.equal(cleanSentence('Sends the welcome email. Then it logs the result.'), 'Sends the welcome email');
  assert.equal(cleanSentence('"Quoted description."'), 'Quoted description');
  // A dot inside a filename or a version number does not end a sentence.
  assert.equal(
    cleanSentence('Reads config from next.config.js and applies it'),
    'Reads config from next.config.js and applies it',
  );
  assert.equal(cleanSentence('Pins the api to v1.2 for older clients'), 'Pins the api to v1.2 for older clients');
  assert.equal(cleanSentence('Not logged in · Please run /login'), null);
  assert.equal(cleanSentence('I cannot determine what this does'), null);
  assert.equal(cleanSentence(''), null);
  assert.equal(cleanSentence(42), null);
});

/**
 * powerfab-dashboard's summary read "01_list_tables. py", "02_describe_tables. py" —
 * four times in one paragraph. A model wraps its own output, the wrap lands mid-token,
 * and collapsing whitespace turns the newline into a space. A reader who cannot read
 * code has no way to tell that from a real file name.
 */
test('a filename split across a line break is put back together', () => {
  assert.equal(
    cleanSentence('Runs 01_list_tables. py and writes the result'),
    'Runs 01_list_tables.py and writes the result',
  );
  assert.equal(
    cleanParagraph('Your app dumps the schema with 06_full_schema_dump. py and writes JSON into docs for the dashboard.'),
    'Your app dumps the schema with 06_full_schema_dump.py and writes JSON into docs for the dashboard.',
  );
  // `pymysql` is a word that starts with an extension and is not one. Welding it on
  // would invent the file `None.pymysql`, which is the same failure in reverse.
  assert.equal(
    cleanSentence("Formats a date as 'YYYY-MM-DD' or None. pymysql hands back a date"),
    "Formats a date as 'YYYY-MM-DD' or None. pymysql hands back a date",
  );
});

/**
 * Found by re-running powerfab-dashboard against a live model.
 *
 * The model wrote fourteen script names correctly — `analyze.py, ask_compare.py,
 * compare.py, …`. What reached the screen was `analyze. py, ask_compare. py` and then
 * nothing: a 198-character paragraph cut off mid-list. Splitting on every full stop
 * counted each filename's dot as the end of a sentence, so the six-sentence cap fired
 * after six *filenames*, and rejoining the pieces with a space put one inside each name.
 *
 * Both halves of the damage came from us. The repair for a model's hard-wrapped
 * filename runs before this and could not have helped: there was nothing wrong with the
 * text when it arrived.
 */
test('a filename full of dots is not six sentences', () => {
  const listing =
    'Your app runs Python entry points — analyze.py, ask_compare.py, compare.py, ' +
    'cross_model.py, flag.py, floor.py, judge.py and report.py — which score the ' +
    'prototype. The bulk of the work sits in two folders.';
  const out = cleanParagraph(listing);
  assert.equal(out, listing, 'nothing was cut and no filename was broken open');
  assert.ok(!/\w\.\s+py\b/.test(out), out);
});

test('a real paragraph is still capped at the sentence it says to cap at', () => {
  const seven = Array.from({ length: 7 }, (_, i) => `Sentence number ${i + 1} says a thing.`).join(' ');
  const out = cleanParagraph(seven, 3);
  assert.equal(out, 'Sentence number 1 says a thing. Sentence number 2 says a thing. Sentence number 3 says a thing.');
});

test('rejects a folder label that just re-spells the folder name', () => {
  assert.equal(cleanLabel('User accounts', 'auth'), 'User accounts');
  assert.equal(cleanLabel('components', 'components'), null);
  assert.equal(cleanLabel('a very long label that nobody could fit on a card at all', 'x'), null);
});

/**
 * The paragraph and the diagram are drawn from the same list and shown one above the
 * other, so a company in one and not the other is visible to the reader before it is
 * visible to us. Nothing here changes a box — a generated sentence is not evidence —
 * but a lead this specific belongs in the run report.
 */
test('a company in the prose that no detector found is reported as a lead', async () => {
  const atlas = await freshAtlas();
  const backend = stubBackend({
    reply: (request) =>
      /one paragraph/.test(request.user)
        ? 'Your app takes web requests, charges cards through Stripe and mails receipts with SendGrid, then files everything away.'
        : '{}',
  });

  const report = await enrichAtlas({ atlas, backend, cache: new Map() });
  // The fixture does call Stripe, so that one is agreement, not a lead.
  assert.ok(!report.contradictions.includes('Stripe'), report.contradictions.join(', '));
  assert.ok(report.contradictions.includes('SendGrid'), report.contradictions.join(', '));
});

test('a company the tool has never heard of is a word, not a lead', async () => {
  const atlas = await freshAtlas();
  const backend = stubBackend({
    reply: (request) =>
      /one paragraph/.test(request.user)
        ? 'Your app takes web requests and files them away in the usual places for later.'
        : '{}',
  });

  const report = await enrichAtlas({ atlas, backend, cache: new Map() });
  assert.deepEqual(report.contradictions, []);
});

test('keeps a paragraph whole', () => {
  const text = 'Your app takes web requests. It stores them. It charges cards.';
  assert.equal(cleanParagraph(text), text);
  assert.equal(cleanParagraph('too short'), null);
});

// ---------------------------------------------------------------------------
// The ecosystem loop
// ---------------------------------------------------------------------------

test('init writes conventions once, and leaves what was already there', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-init-'));
  try {
    // A repo with no agent instructions gets the file with the broadest support.
    const created = initConventions(dir);
    assert.equal(created.length, 1);
    assert.equal(created[0].action, 'created');
    assert.ok(created[0].path.endsWith('AGENTS.md'));

    const second = initConventions(dir);
    assert.equal(second[0].action, 'unchanged');
    const body = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
    assert.equal(body.match(/app-atlas:conventions/g).length, 2, 'the block must not stack up');
    assert.match(body, /@fileoverview/);

    // An existing file keeps its own contents, and ours goes underneath.
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# House rules\n\nAlways run the tests.\n');
    const updated = initConventions(dir, 'CLAUDE.md');
    assert.equal(updated[0].action, 'updated');
    const claude = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8');
    assert.match(claude, /^# House rules/);
    assert.match(claude, /Always run the tests/);
    assert.match(claude, /Documentation conventions/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function escapeRe(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
