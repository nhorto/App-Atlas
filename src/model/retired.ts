/**
 * @fileoverview Code that says, in writing, that it is no longer the live path.
 *
 * A repo that has been through a rewrite keeps the old lane on disk — under `_archive/`,
 * or with a docstring opening `DEPRECATED 2026-04-30 — replaced by …`. App Atlas read
 * those files, counted them among the app's own, and let the architecture prose build an
 * end-to-end flow through them. Naming a retired module beside a current one is worse
 * than naming neither, because a reader takes it as current.
 *
 * The evidence is the author's own words, never a guess about what a file looks like:
 * a folder they named, or a sentence they wrote at the top of the file. Nothing here
 * infers retirement from a file being unimported, or small, or old — those are facts
 * about a graph, and this is a claim about intent.
 *
 * These files stay in the atlas. Dropping them would be its own confident falsehood: a
 * backstop somebody still runs by hand would simply vanish. They are marked, kept out of
 * the places that answer "how does this app work", and counted out loud.
 */
import type { AtlasNode } from './types.js';

/**
 * Folder names that mean "not the live path", as a whole path segment.
 *
 * `legacy` and `old` are deliberately absent. Legacy code is very often still the thing
 * running in production — that is most of what makes it legacy — and marking it retired
 * would be exactly the confident falsehood this file exists to prevent. A repo that means
 * it has `_archive`, `deprecated` or `parked` available and generally uses one.
 */
const RETIRED_FOLDERS = new Set(['archive', 'archived', 'deprecated', 'parked', 'attic', 'graveyard', 'retired', 'obsolete']);

/** How a file opens when its author is telling you not to use it. */
const RETIRED_OPENING = /^\s*(deprecated|obsolete|retired|superseded|no longer used|do not use)\b/i;

/** The JSDoc/TSDoc tag, which the TypeScript compiler understands as the same statement. */
const RETIRED_TAG = /@deprecated\b/i;

export interface RetiredVerdict {
  /** What the reader is shown as the reason — the author's own signal, in short form. */
  because: string;
}

/**
 * Whether a node's own text or location says it has been retired, and on what evidence.
 *
 * Returns `null` for everything else, so a caller can treat the common case as free.
 */
export function retirementOf(node: AtlasNode): RetiredVerdict | null {
  // A folder node's path ends in a folder, a file node's ends in a file. `archive.py` is
  // a module that archives things; `archive/` is where things are put to stop running.
  const folder = retiredFolder(node.path, node.kind === 'module');
  if (folder) return { because: `it is under ${folder}/` };

  // Only a docstring counts. A summary the enricher wrote is a sentence about the file,
  // not a statement by its author, and letting generated text establish a fact would put
  // the two layers the wrong way round.
  if (node.summarySource !== 'docs' || !node.summary) return null;
  if (RETIRED_OPENING.test(node.summary)) return { because: 'its own docstring says so' };
  if (RETIRED_TAG.test(node.summary)) return { because: 'it is marked @deprecated' };
  return null;
}

/** Convenience for the many callers that only need the yes or no. */
export function isRetired(node: AtlasNode): boolean {
  return retirementOf(node) !== null;
}

/**
 * The retired folder a path sits in, named as written.
 *
 * Leading underscores are stripped before matching, because `_archive` and `archive` are
 * the same intention and the underscore is only there to sort it out of the way.
 */
function retiredFolder(path: string | null, pathIsAFolder: boolean): string | null {
  if (!path) return null;
  const parts = path.split('/');
  // For a file the last part is the file itself, and `archive.py` is a module that
  // archives things rather than a thing that has been archived. For a folder node the
  // last part is the folder, so a top-level `archive/` has nowhere else to be found.
  const segments = pathIsAFolder ? parts : parts.slice(0, -1);
  for (const part of segments) {
    if (RETIRED_FOLDERS.has(part.replace(/^_+/, '').toLowerCase())) return part;
  }
  return null;
}
