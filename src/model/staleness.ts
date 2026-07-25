/**
 * @fileoverview Catching documentation that no longer describes its code.
 *
 * The classic failure of any docs-first tool is inheriting the stale comment problem:
 * someone writes `/** Sends the welcome email *​/`, the function is rewritten to do
 * something else, and the comment sits there being confidently wrong forever. A tool
 * that reads docstrings verbatim would repeat that lie on a card, next to compiler
 * facts, with nothing to distinguish them.
 *
 * Bodies and docstrings are hashed separately (see util/hash.ts), so the case is
 * detectable: between two analyses the body changed and the docstring did not.
 *
 * The flag is **sticky**, which is the part worth being careful about. Staleness is
 * detected by comparing consecutive runs, so a docstring that went stale three
 * analyses ago looks unchanged now — comparing only the latest pair would quietly
 * forgive it. Once raised, the flag survives every run until the docstring itself is
 * rewritten, which is the only event that can actually resolve it.
 */
import type { Atlas, AtlasNode } from './types.js';

/** Set on a node's meta when its docstring predates its current implementation. */
export const STALE_DOCS_KEY = 'docsStale';

/**
 * Compares a fresh atlas against the one on disk and marks docstrings that have been
 * overtaken by their code. Does nothing on a first analysis, when there is nothing to
 * compare against — one snapshot cannot tell you what changed.
 */
export function markStaleDocs(previous: Atlas | null, next: Atlas): void {
  if (!previous) return;
  const before = new Map(previous.nodes.map((node) => [node.id, node]));

  for (const node of next.nodes) {
    if (node.summarySource !== 'docs' || !node.docHash) continue;
    const old = before.get(node.id);
    if (!old || !old.docHash) continue;

    // A rewritten docstring is a fresh claim about the code, whatever it says.
    if (old.docHash !== node.docHash) continue;

    const bodyChanged = Boolean(old.bodyHash && node.bodyHash && old.bodyHash !== node.bodyHash);
    if (bodyChanged || old.meta?.[STALE_DOCS_KEY] === true) {
      node.meta = { ...node.meta, [STALE_DOCS_KEY]: true };
    }
  }
}

export function isStaleDoc(node: AtlasNode): boolean {
  return node.meta?.[STALE_DOCS_KEY] === true;
}

export function countStaleDocs(nodes: AtlasNode[]): number {
  return nodes.reduce((total, node) => total + (isStaleDoc(node) ? 1 : 0), 0);
}
