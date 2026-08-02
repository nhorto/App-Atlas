/**
 * @fileoverview Code that says it is no longer part of the app (#87).
 *
 * A dashboard that has been through two rewrites keeps the old lanes on disk. Six files
 * under `_archive/` open by declaring themselves dead — "DEPRECATED 2026-04-30 —
 * replaced by …, do not run as part of the pipeline" — and App Atlas read that
 * docstring, printed it verbatim, and went on counting the file among the app's 238.
 * `parked/` was worse: the generated overview built one of the app's two headline data
 * flows through a folder called `parked`.
 *
 * The cost lands on exactly the person this tool is for. Someone briefing a customer on
 * Monday cannot tell which lane is live, and the map's whole job was to tell them.
 * Naming a retired module beside a current one is worse than naming neither, because it
 * reads as current.
 *
 * **Marked, never dropped.** Deleting these files from the graph is its own confident
 * falsehood: a backstop somebody still runs by hand would vanish, and the reader would
 * have no way to discover that it exists. So they stay, they carry the words that
 * disqualified them, and the count says how many there are. What they lose is the right
 * to be described as architecture — the prose and "where to look first" are answers
 * about the live app, and a retired file is not part of that answer.
 *
 * Two kinds of evidence, both facts about the file rather than guesses about its name:
 * the folder it sits in, and the first line it writes about itself.
 */
import type { AtlasNode } from '../model/types.js';

/**
 * Directories whose name says the code in them was set aside.
 *
 * Deliberately short, and deliberately not `archive`, `old`, `legacy` or `backup` on
 * their own: a Next.js app can ship `app/api/archive/route.ts`, and dropping a real
 * door because a folder is called `archive` is a far worse error than counting a dead
 * one. What is left is either explicitly parked or wears the underscore that says
 * "not part of the build" — and both are unambiguous enough to act on.
 *
 * powerfab-dashboard reported 111 ways in, among them every retired script in
 * `scripts/categories/_archive/` and `parked/`. A door somebody cannot use is not a
 * way in, and a count that includes them is a count nobody can act on.
 */
export const PARKED_SEGMENT =
  /^(_archive[d]?|_old|_deprecated|_legacy|_unused|_bak|_backup|_graveyard|_parked|_attic|parked|graveyard|attic|deprecated)$/i;

export function isParked(path: string): boolean {
  if (!path) return false;
  return path.split('/').some((segment) => PARKED_SEGMENT.test(segment));
}

/**
 * A file that opens by saying it is retired.
 *
 * Only the *first* line, or an explicit `@deprecated` tag. A docstring that mentions
 * deprecation halfway through is usually describing what the file replaced, and reading
 * that as a self-declaration would retire the very code that superseded the dead lane.
 */
const RETIRED_OPENING = /^\s*(?:[*#/\s-]*)?(deprecated|obsolete|retired|superseded|do not use)\b/i;
const DEPRECATED_TAG = /(^|\s)@deprecated\b/i;

/** The folder segment that disqualified a path, for the reader to check against. */
function parkedSegment(path: string): string | null {
  return path.split('/').find((segment) => PARKED_SEGMENT.test(segment)) ?? null;
}

/** The first line of a docstring with the comment furniture taken off. */
function firstLine(summary: string): string {
  const line = summary.split(/\r?\n/).find((text) => text.trim().length > 0) ?? '';
  return line.replace(/^[\s*#/-]+/, '').trim();
}

export interface RetiredInfo {
  /** What said so — the folder it sits in, or the file's own opening line. */
  evidence: 'path' | 'docstring';
  /** The exact words that disqualified it, so a reader can check the call. */
  says: string;
}

/** How much of a self-declaration to keep. Enough to read, not enough to reflow a page. */
const MAX_SAYS = 160;

/** Whether this file declares itself retired, and on what evidence. */
export function retirementOf(node: AtlasNode): RetiredInfo | null {
  if (node.kind !== 'file' || !node.path) return null;
  // A fixture under `test/fixtures/…/parked/` is not somebody's retired lane, it is the
  // material a test is made of — and this repo's own map is the case that shows it,
  // since the fixture proving this rule works lives in a folder called `parked`. Test
  // code is already outside the architecture description and outside "where to look
  // first", so it has nothing here to lose and only a count to distort.
  if (node.zone === 'test') return null;

  const segment = parkedSegment(node.path);
  if (segment) return { evidence: 'path', says: segment };

  const summary = node.summary;
  if (!summary) return null;
  const opening = firstLine(summary);
  if (RETIRED_OPENING.test(opening) || DEPRECATED_TAG.test(summary)) {
    const says = DEPRECATED_TAG.test(summary) && !RETIRED_OPENING.test(opening) ? '@deprecated' : opening;
    return { evidence: 'docstring', says: says.slice(0, MAX_SAYS) };
  }
  return null;
}

/**
 * Stamps every retired file, in one pass, for every language at once.
 *
 * Runs over finished file nodes rather than inside a plugin, because the two pieces of
 * evidence — the path and the file's own docstring — are things every plugin has
 * already recorded. A Go file and a Python file get the same treatment without either
 * analyzer knowing this rule exists.
 */
export function markRetiredFiles(nodes: AtlasNode[]): number {
  let count = 0;
  for (const node of nodes) {
    const retired = retirementOf(node);
    if (!retired) continue;
    (node.meta as Record<string, unknown>).retired = retired;
    count++;
  }
  return count;
}

/** Whether a node has been stamped by the pass above. */
export function isRetired(node: { meta?: Record<string, unknown> }): boolean {
  return Boolean(node.meta?.retired);
}
