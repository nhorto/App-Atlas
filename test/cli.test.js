/**
 * @fileoverview A command-line door reads like a command (#88).
 *
 * The repo this came from is script-heavy: 104 of its 105 ways in are command-line entry
 * points, and `## Also runs on its own` printed the same string on both sides of the
 * em-dash a hundred and three times —
 *
 *     - **cli** scripts/_audit/census.py — `scripts/_audit/census.py`
 *
 * — because the door had no name and the path stood in for one. A section that says
 * nothing a hundred times is a section a reader learns to skip past, and everything
 * below it goes with it.
 *
 * Two separate fixes and one guard. An HTTP door reads `POST /api/users`; a CLI door now
 * reads the command somebody types. A folder of near-identical scripts becomes a shape
 * with a count. And the folding must *not* fire on a handful — `scripts/release` has two
 * in it, and hiding those would cost the reader something they wanted to see.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyzeProject, AtlasGraph, renderAtlasMarkdown } from '../dist/node/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const result = await analyzeProject(path.join(here, 'fixtures', 'pycli'), { cache: 'off' });

const readable = result.atlas.meta.languages.includes('python');
const skip = readable ? false : 'no Python 3.9+ on this machine';

const doors = result.atlas.nodes.filter((node) => node.kind === 'endpoint' && node.meta.endpointKind === 'cli');
const markdown = renderAtlasMarkdown(new AtlasGraph(result.atlas));
const section = markdown.slice(markdown.indexOf('## Also runs on its own')).split('\n##')[0];

// ---------------------------------------------------------------------------
// The name is a name
// ---------------------------------------------------------------------------

test('a manifest that names the command wins', { skip }, () => {
  // `[project.scripts] estimate = "toolkit.cli:main"` means the thing you type is
  // `estimate`. The path is an implementation detail and belongs where the file goes on
  // an HTTP row, not where the address goes.
  const declared = doors.find((door) => door.meta.sites?.[0]?.path === 'toolkit/cli.py');
  assert.equal(declared.meta.route, 'estimate');
  assert.match(section, /- \*\*cli\*\* estimate — `toolkit\/cli\.py`/);
});

test('a loose script is named by the command that runs it', { skip }, () => {
  const bump = doors.find((door) => door.meta.sites?.[0]?.path === 'scripts/release/bump_version.py');
  assert.equal(bump.meta.route, 'python scripts/release/bump_version.py');
});

test('the path is printed once, not twice', { skip }, () => {
  // The whole of the original complaint. Nothing in the section may say the same path
  // on both sides of a dash.
  for (const line of section.split('\n').filter((text) => text.startsWith('- '))) {
    const match = /`([^`]+\.py)`/.exec(line);
    if (!match) continue;
    const rest = line.slice(0, line.indexOf(match[0]));
    assert.ok(!rest.includes(match[1]), `says its path twice: ${line}`);
  }
});

// ---------------------------------------------------------------------------
// A hundred siblings are a shape
// ---------------------------------------------------------------------------

test('a folder of near-identical scripts folds into one line with a count', { skip }, () => {
  assert.match(section, /- \*\*cli\*\* 9 scripts under `scripts\/verify`, run one at a time/);
  // Named, not merely counted: a group the reader cannot check is a group they cannot
  // trust, and the count is what says the list was folded rather than truncated.
  assert.match(section, /`census_probe\.py`, `columns_probe\.py`, `crews_probe\.py`, and 6 more/);
});

test('a handful is still a list', { skip }, () => {
  // Two release scripts, below the threshold, both spelled out. Folding here would hide
  // something a reader would rather have seen listed — which is the failure this
  // threshold exists to prevent.
  assert.match(section, /- \*\*cli\*\* python scripts\/release\/bump_version\.py/);
  assert.match(section, /- \*\*cli\*\* python scripts\/release\/tag_release\.py/);
  assert.ok(!/scripts under `scripts\/release`/.test(section), section);
});

test('folding is a way of writing the list, not a way of shortening it', { skip }, () => {
  // Every script is still its own door in the atlas. The folding is the renderer's, and
  // a count that quietly dropped nine doors would be the falsehood, not the fix.
  assert.equal(doors.length, 12);
});
