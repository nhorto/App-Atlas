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
  cleanLabel,
  cleanParagraph,
  cleanSentence,
  enrichAtlas,
  initConventions,
  markStaleDocs,
  parseJsonReply,
  analyzeProject,
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

test('rejects a folder label that just re-spells the folder name', () => {
  assert.equal(cleanLabel('User accounts', 'auth'), 'User accounts');
  assert.equal(cleanLabel('components', 'components'), null);
  assert.equal(cleanLabel('a very long label that nobody could fit on a card at all', 'x'), null);
});

test('keeps a paragraph whole', () => {
  const text = 'Your app takes web requests. It stores them. It charges cards.';
  assert.equal(cleanParagraph(text), text);
  assert.equal(cleanParagraph('too short'), null);
});

test('a paragraph full of filenames is not broken at the dots', () => {
  // The dot in `importer.py` is not the end of a sentence. Splitting on every full stop
  // and rejoining with a space turned it into `importer. py`, and doubled the space
  // after the real sentence ends.
  const text =
    'Data comes in through scripts/importer/importer.py and scripts/importer/cutlist_importer.py, ' +
    'which read incoming cut lists. Probe scripts like scripts/api/wprobe.py and ' +
    'scripts/reserve-poc/pfprobe.py query the PowerFab system. The exporter writes to disk.';
  const cleaned = cleanParagraph(text);
  assert.match(cleaned, /importer\.py/, 'a filename keeps its extension attached');
  assert.ok(!/\.\s+(py|js|ts|sql)\b/.test(cleaned), 'no `importer. py`');
  assert.ok(!/\s{2,}/.test(cleaned), 'a real sentence break is one space, never two');
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
