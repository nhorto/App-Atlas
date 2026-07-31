/**
 * @fileoverview What we actually ask for.
 *
 * Two rules shape every prompt here.
 *
 * First, the model is never asked what the code *is* — the compiler already answered
 * that. It is asked what the code is *for*. Everything it needs is handed to it as
 * facts, so it is writing a caption for a photograph rather than describing a room it
 * has been told about.
 *
 * Second, it is never asked to invent structure. It labels nodes we found; it does not
 * propose new ones, group things we did not group, or name folders that do not exist.
 * Anything it returns that we did not ask about is dropped (see validate.ts).
 */
import type { Group, GroupDoor } from '../model/groups.js';
import type { EnrichRequest } from './types.js';

/**
 * The audience is someone who ships software without reading it. That is a real
 * constraint on the writing, not a disclaimer: "authenticates the request" is jargon,
 * "checks you are logged in" is the same fact in words they own.
 */
const VOICE = `You write plain-English descriptions of code for people who ship software but cannot read code.

Rules:
- Say what a thing is FOR, not what the syntax does. "Checks a password against the database" beats "async function that queries a table".
- Plain words. A term is allowed only if the reader would meet it in their own product: a URL, a table name, a company like Stripe, a page they can click.
- Use the facts given. They came from a compiler and are correct. Do not contradict them.
- Never add detail the facts do not have. If they say "Database", write "the database" — not Postgres, not MySQL. If they name no company, name none. Being more specific than the facts is the one way to be confidently wrong.
- A blank in the facts means nobody could see it, not that it is absent. "No data store found" does not license "it stores nothing".
- A URL path and its method are one fact, not two. Write a path with the method the facts give it ("POST /api/orders"), or write the path on its own. Never pair a path with a method the facts did not put beside it.
- Never guess. If the facts do not say what something does, describe what it plainly is and stop. A vague true sentence beats a confident wrong one.
- No openers ("This file is responsible for…"), no praise, no restating the name. Start with the verb or the noun that matters.
- Present tense, second person for the app as a whole ("your app"), no first person.`;

/** Keeps a confused reply from turning into a paragraph in a card. */
const ONE_LINE = 'One sentence, at most 18 words, no trailing period.';

export interface AppFacts {
  name: string;
  frameworks: string[];
  fileCount: number;
  /**
   * The parts of the codebase and which of them hands off to which (issue #49).
   *
   * The arrows are the point. A list of folders lets a model write "the app has an `api`
   * folder and a `lib` folder", which the reader could see for themselves; the arrows are
   * what let it write "every route goes through one shared folder, and that folder is
   * where Stripe is called" — a sentence about how the app is put together.
   */
  groups: GroupOutline[];
  waysIn: string[];
  services: string[];
  stores: string[];
  /** Docstrings the repo already has — the best evidence available, and free. */
  existingDocs: string[];
}

/** One part of the codebase as the overview sees it: how big, what role, what it feeds. */
export interface GroupOutline {
  path: string;
  files: number;
  zone: string;
  /** Paths of the groups it hands off to, heaviest first. */
  handsOffTo: string[];
}

/**
 * The paragraph under the boundary diagram (SPEC.md 6.1): what goes in, what happens,
 * what comes out. It is the first sentence a new reader gets about their own app, so
 * it is the one place we spend a whole request on a single node.
 */
export function overviewRequest(facts: AppFacts): EnrichRequest {
  const lines: string[] = [
    `App name: ${facts.name}`,
    facts.frameworks.length > 0 ? `Built with: ${facts.frameworks.join(', ')}` : '',
    `Size: ${facts.fileCount} source files`,
    '',
    'The parts of the codebase, and which part hands off to which:',
    ...facts.groups.map((group) => {
      const where = `- ${group.path || 'the repo root'} — ${countOf(group.files, 'file')}, mostly ${group.zone}`;
      return group.handsOffTo.length > 0 ? `${where}; hands off to ${group.handsOffTo.join(', ')}` : where;
    }),
    '',
    facts.waysIn.length > 0
      ? `Ways data gets in: ${facts.waysIn.join(', ')}`
      : 'No way in was detected. That may mean there is none, or that we could not see it.',
    facts.stores.length > 0
      ? `Data is stored in: ${facts.stores.join(', ')}`
      : 'No data store was detected. That may mean there is none, or that we could not see it. Do not name one.',
    facts.services.length > 0
      ? `Outside services it talks to: ${facts.services.join(', ')}`
      : 'No outside service was detected. That may mean there are none, or that we could not see them. Do not name one.',
  ].filter(Boolean);

  if (facts.existingDocs.length > 0) {
    lines.push('', "Descriptions the developers wrote themselves, for context:", ...facts.existingDocs.map((d) => `- ${d}`));
  }

  return {
    system: VOICE,
    user: `${lines.join('\n')}

Write one paragraph, 3 to 5 sentences, telling the owner of this app what it takes in, what it does with it, and where that data ends up.

At least one sentence must follow the handoffs above end to end — where a request arrives, which parts it passes through, and what it reaches on the far side. That path is the thing the reader cannot work out from a folder listing, and it is why the handoffs were given to you.

Name the real routes, tables and companies above rather than talking in general terms — and name only those. The lists above are everything we found; this paragraph sits directly under a diagram drawn from the same lists, and a company in your sentence that is not in the diagram makes the reader distrust both. No heading, no bullet points, no markdown.`,
    maxOutputTokens: 400,
  };
}

export interface LabelItem {
  /** Short key used in the reply, so long node ids never have to survive a round trip. */
  key: string;
  path: string;
  zone: string;
  /** Whatever we know: file names inside a folder, exports inside a file. */
  contains: string[];
  /** Endpoints, stores and services this thing is responsible for. */
  responsibilities: string[];
}

/** One group, with the short key its answer comes back under. */
export interface GroupItem {
  key: string;
  group: Group;
}

/**
 * Groups get a plain-English *name* as well as a description, because the map shows
 * `src/lib/hooks` and the reader wants "Data loading". Both come back in one request:
 * the name and the sentence are the same judgement, and splitting them doubles cost.
 *
 * What changed for #49 is not the ask, it is the material. Each group arrives with what it
 * holds, what it owns and — the part that was missing — which groups it hands off to and
 * which hand off to it. A folder on its own affords one kind of sentence: "helpers live
 * here". A folder that eleven route handlers go through on their way to Stripe affords a
 * different one, and it is the second that is worth paying for.
 */
export function groupBatchRequest(items: GroupItem[]): EnrichRequest {
  return {
    system: VOICE,
    user: `Here are the parts of one codebase. For each, give a short plain-English name and one sentence saying what it does for the app.

${items.map(describeGroup).join('\n\n')}

Write about each part as a part: what it is responsible for, and how it sits between the parts named beside it. "Where the shared database client lives, used by every route handler" is the kind of sentence wanted; "contains utility files" is not.

Reply with JSON only — no markdown fence, no commentary. Key each answer by the number in square brackets, as a string:
{"1": {"name": "Two or three words, title case", "text": "${ONE_LINE}"}, "2": {…}}

The name is what a non-developer would call this part of the app ("User accounts", "Checkout", "Shared helpers"). Do not just re-spell the folder name.`,
    maxOutputTokens: 110 * items.length + 200,
  };
}

/** Files only need the sentence — the file name is already meaningful on screen. */
export function fileBatchRequest(items: LabelItem[]): EnrichRequest {
  return {
    system: VOICE,
    user: `Here are files from one codebase. For each, say what it is for.

${items.map(describe).join('\n\n')}

Reply with JSON only — no markdown fence, no commentary. Key each answer by the number in square brackets, as a string:
{"1": "${ONE_LINE}", "2": "${ONE_LINE}"}`,
    maxOutputTokens: 60 * items.length + 200,
  };
}

export interface SymbolFacts {
  name: string;
  kind: string;
  path: string;
  signature?: string;
  /** The source of this one function or type. Sent only for the on-click tier. */
  source?: string;
  usedBy: string[];
  uses: string[];
}

/**
 * The detail-panel tier, generated only when someone clicks. This is the one request
 * that gets to see real source, because a function's purpose genuinely is not
 * recoverable from its signature — and because the user asked for exactly this one.
 */
export function symbolRequest(facts: SymbolFacts): EnrichRequest {
  const lines = [
    `${facts.kind}: ${facts.name}`,
    `File: ${facts.path}`,
    facts.signature ? `Signature: ${facts.signature}` : '',
    facts.uses.length > 0 ? `Uses: ${facts.uses.join(', ')}` : '',
    facts.usedBy.length > 0 ? `Used by: ${facts.usedBy.join(', ')}` : '',
    facts.source ? `\nSource:\n${facts.source}` : '',
  ].filter(Boolean);

  return {
    system: VOICE,
    user: `${lines.join('\n')}

Write 2 to 3 sentences for someone who has to decide whether this matters to them: what it does, when it runs, and what would break without it. Plain prose, no markdown, no code blocks.`,
    maxOutputTokens: 300,
  };
}

/**
 * One group, written out as facts.
 *
 * The care here is all in the doors. A door with an empty guard list is not the same fact
 * as a door we have looked at and found open, and the difference is the whole reason
 * `openKind` exists: on the FastAPI template every route comes back with no guard because
 * the guard is in a file the analyzer could not read. Printing those as "no check found"
 * and stopping would be handing over the premise for "your API is unprotected".
 *
 * The reasons are collected and printed once rather than repeated after all twenty-three
 * routes, which is both cheaper and easier to write from.
 */
function describeGroup(item: GroupItem): string {
  const group = item.group;
  const role = group.otherZones.length > 0 ? `${group.zone}, some ${group.otherZones.join(' and ')}` : group.zone;
  const lines = [
    `[${item.key}] ${group.path || 'the repo root'}`,
    `  size: ${countOf(group.fileCount, 'file')}, mostly ${role}`,
  ];

  if (group.members.length > 0) lines.push(`  holds: ${andMore(group.members, group.fileCount)}`);

  if (group.doors.length > 0) {
    lines.push(`  ways in: ${andMore(group.doors.map(doorLine), group.doorCount)}`);
    // Scoped to the doors that actually carry a reason, and no further. Saying this about
    // the group as a whole would extend one door's excuse to every other door in it — on
    // the fixture that meant a deliberately-open server action inheriting "it is a page,
    // do not call it unprotected", which is the true finding suppressed by a false one.
    if (group.doors.some((door) => openNote(door))) {
      lines.push(
        '  where a reason is given in brackets, a check may well exist where we could not see it — do not call those unprotected. The ones with no reason are the ones we looked at and found nothing on.',
      );
    }
  }

  // A library's surface is worth a sentence; a hundred names is worth a number. See the
  // all-or-nothing rule on `Group.publicApi`.
  if (group.publicApi.length > 0) lines.push(`  other code can import: ${group.publicApi.join(', ')}`);
  else if (group.publicApiCount > 0) lines.push(`  exports ${group.publicApiCount} names for other code to import`);

  if (group.stores.length > 0) lines.push(`  stores data in: ${group.stores.join(', ')}`);
  if (group.services.length > 0) lines.push(`  calls out to: ${group.services.join(', ')}`);
  if (group.dependsOn.length > 0) lines.push(`  hands off to: ${group.dependsOn.map(linkName).join(', ')}`);
  if (group.usedBy.length > 0) lines.push(`  used by: ${group.usedBy.map(linkName).join(', ')}`);

  return lines.join('\n');
}

/**
 * The reason rides on the door, and is deliberately repeated rather than collapsed.
 *
 * Twenty-three routes that all import the same unreadable file print the same clause
 * twenty-three times, which is a real cost in tokens. Hoisting it to one line per group
 * would save them, and it is the same move that was wrong a moment ago: the moment one
 * door in the group has a different reason, or none, a hoisted clause covers a door it
 * was never true of. That trade is tokens against the one mistake this tool must not make.
 */
function doorLine(door: GroupDoor): string {
  if (door.guards.length > 0) return `${door.name} (checked by ${door.guards.join(' and ')})`;
  const note = openNote(door);
  return note ? `${door.name} (no check found — ${note})` : `${door.name} (no check found)`;
}

/** The analyzer's own words for why a door has no guard on it, when it has any. */
function openNote(door: GroupDoor): string | null {
  if (door.guards.length > 0) return null;
  if (door.openBecause) return door.openBecause;
  if (door.openKind === 'page') return 'they are pages, which are meant to be public';
  if (door.openKind === 'auth-mount') return 'a mount guards them and we could not tie the mount to the route';
  return null;
}

function linkName(link: { toPath: string }): string {
  return link.toPath || 'the repo root';
}

/** "1 file", "8 files" — a prompt asking for careful prose should be written carefully. */
function countOf(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function andMore(items: string[], total: number): string {
  const rest = total - items.length;
  return rest > 0 ? `${items.join(', ')}, and ${rest} more` : items.join(', ');
}

function describe(item: LabelItem): string {
  const lines = [`[${item.key}] ${item.path}`, `  role: ${item.zone}`];
  if (item.contains.length > 0) lines.push(`  contains: ${item.contains.join(', ')}`);
  if (item.responsibilities.length > 0) lines.push(`  handles: ${item.responsibilities.join(', ')}`);
  return lines.join('\n');
}
