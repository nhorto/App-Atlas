/** Set on a node's meta when its docstring predates its current implementation. */
export const STALE_DOCS_KEY = 'docsStale';
/**
 * Compares a fresh atlas against the one on disk and marks docstrings that have been
 * overtaken by their code. Does nothing on a first analysis, when there is nothing to
 * compare against — one snapshot cannot tell you what changed.
 */
export function markStaleDocs(previous, next) {
    if (!previous)
        return;
    const before = new Map(previous.nodes.map((node) => [node.id, node]));
    for (const node of next.nodes) {
        if (node.summarySource !== 'docs' || !node.docHash)
            continue;
        const old = before.get(node.id);
        if (!old || !old.docHash)
            continue;
        // A rewritten docstring is a fresh claim about the code, whatever it says.
        if (old.docHash !== node.docHash)
            continue;
        const bodyChanged = Boolean(old.bodyHash && node.bodyHash && old.bodyHash !== node.bodyHash);
        if (bodyChanged || old.meta?.[STALE_DOCS_KEY] === true) {
            node.meta = { ...node.meta, [STALE_DOCS_KEY]: true };
        }
    }
}
export function isStaleDoc(node) {
    return node.meta?.[STALE_DOCS_KEY] === true;
}
export function countStaleDocs(nodes) {
    return nodes.reduce((total, node) => total + (isStaleDoc(node) ? 1 : 0), 0);
}
//# sourceMappingURL=staleness.js.map