/**
 * @fileoverview How each language in this atlas was actually read.
 *
 * TypeScript gets a type checker and Python gets the interpreter's own parser. A language
 * in the generic tier gets a tree-sitter grammar and nothing else — real syntax, no
 * resolution — and every node it produced says so in `meta.tier`.
 *
 * This exists so that the difference reaches the reader. The header of `ATLAS.md` used to
 * say facts came from "each language's own parser and type checker", which stopped being
 * true the day a grammar could answer for a language, and a tool whose header overstates
 * its own evidence has no business badging anybody's routes.
 */
import type { AtlasNode } from './types.js';

/** The value stamped on nodes read by a grammar rather than a compiler. */
export const GRAMMAR_TIER = 'tree-sitter';

export interface TierNote {
  /** Languages read by grammar alone, sorted, as they appear on nodes: `go`. */
  languages: string[];
  /** The same, capitalised for a sentence: `Go`. */
  display: string;
  /** One sentence saying what that costs, for wherever the tool explains itself. */
  sentence: string;
}

/**
 * What to tell the reader about the weaker tier, or null when nothing in this atlas came
 * from it.
 */
export function grammarTier(nodes: readonly AtlasNode[]): TierNote | null {
  const languages = new Set<string>();
  for (const node of nodes) {
    if (node.meta.tier === GRAMMAR_TIER && node.language) languages.add(node.language);
  }
  if (languages.size === 0) return null;

  const sorted = [...languages].sort();
  const display = list(sorted.map(label));
  return {
    languages: sorted,
    display,
    sentence:
      `${display} ${sorted.length === 1 ? 'was' : 'were'} read with a tree-sitter grammar rather than a compiler. ` +
      'Structure, doors and checks come from the source as written; which declaration a name refers to is matched ' +
      'by name rather than resolved, so links between files are marked likely.',
  };
}

/** `go` → `Go`. A table now that there is more than one exception to title-casing. */
const LABELS: Record<string, string> = { go: 'Go', csharp: 'C#' };

function label(id: string): string {
  return LABELS[id] ?? id.charAt(0).toUpperCase() + id.slice(1);
}

/** "a", "a and b", "a, b and c" — this ends up in a sentence on screen. */
function list(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}
