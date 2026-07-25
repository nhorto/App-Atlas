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
- Never guess. If the facts do not say what something does, describe what it plainly is and stop. A vague true sentence beats a confident wrong one.
- No openers ("This file is responsible for…"), no praise, no restating the name. Start with the verb or the noun that matters.
- Present tense, second person for the app as a whole ("your app"), no first person.`;

/** Keeps a confused reply from turning into a paragraph in a card. */
const ONE_LINE = 'One sentence, at most 18 words, no trailing period.';

export interface AppFacts {
  name: string;
  frameworks: string[];
  fileCount: number;
  topFolders: { path: string; files: number; zone: string }[];
  waysIn: string[];
  services: string[];
  stores: string[];
  /** Docstrings the repo already has — the best evidence available, and free. */
  existingDocs: string[];
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
    'Main folders:',
    ...facts.topFolders.map((f) => `- ${f.path || '(root)'} — ${f.files} files, mostly ${f.zone}`),
    '',
    facts.waysIn.length > 0 ? `Ways data gets in: ${facts.waysIn.join(', ')}` : 'No inbound routes found.',
    facts.stores.length > 0 ? `Data is stored in: ${facts.stores.join(', ')}` : 'No data store found.',
    facts.services.length > 0 ? `Outside services it talks to: ${facts.services.join(', ')}` : '',
  ].filter(Boolean);

  if (facts.existingDocs.length > 0) {
    lines.push('', "Descriptions the developers wrote themselves, for context:", ...facts.existingDocs.map((d) => `- ${d}`));
  }

  return {
    system: VOICE,
    user: `${lines.join('\n')}

Write one paragraph, 3 to 5 sentences, telling the owner of this app what it takes in, what it does with it, and where that data ends up. Name the real routes, tables and companies above rather than talking in general terms. No heading, no bullet points, no markdown.`,
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

/**
 * Folders get a plain-English *name* as well as a description, because the map shows
 * `src/lib/hooks` and the reader wants "Data loading". Both come back in one request:
 * the name and the sentence are the same judgement, and splitting them doubles cost.
 */
export function moduleBatchRequest(items: LabelItem[]): EnrichRequest {
  return {
    system: VOICE,
    user: `Here are folders from one codebase. For each, give a short plain-English name and one sentence saying what lives there.

${items.map(describe).join('\n\n')}

Reply with JSON only — no markdown fence, no commentary. Key each answer by the number in square brackets, as a string:
{"1": {"name": "Two or three words, title case", "text": "${ONE_LINE}"}, "2": {…}}

The name is what a non-developer would call this part of the app ("User accounts", "Checkout", "Shared helpers"). Do not just re-spell the folder name.`,
    maxOutputTokens: 90 * items.length + 200,
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

function describe(item: LabelItem): string {
  const lines = [`[${item.key}] ${item.path}`, `  role: ${item.zone}`];
  if (item.contains.length > 0) lines.push(`  contains: ${item.contains.join(', ')}`);
  if (item.responsibilities.length > 0) lines.push(`  handles: ${item.responsibilities.join(', ')}`);
  return lines.join('\n');
}
