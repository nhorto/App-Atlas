/**
 * @fileoverview Reading a declaration out of the file it lives in.
 *
 * Shared by the explain endpoint (which sends it to a model) and the walkthrough
 * drawer (which shows it to a person). Reading on demand rather than keeping every
 * function body in the atlas keeps the export small, and means what you see is
 * whatever is on disk right now rather than whatever was there at analysis time.
 */
import fs from 'node:fs';
import path from 'node:path';
/** Enough to explain one thing, capped so a single huge file cannot blow a budget. */
export const MAX_SOURCE_LINES = 220;
export const MAX_SOURCE_CHARS = 7000;
export function readSource(root, node, maxLines = MAX_SOURCE_LINES) {
    if (!node.path || !node.startLine)
        return null;
    const absolute = path.resolve(root, node.path);
    // Never read outside the analyzed project, whatever a node id claims.
    if (!absolute.startsWith(path.resolve(root)))
        return null;
    try {
        const lines = fs.readFileSync(absolute, 'utf8').split(/\r?\n/);
        const declaredEnd = node.endLine ?? node.startLine;
        const end = Math.min(declaredEnd, node.startLine + maxLines);
        const slice = lines.slice(node.startLine - 1, end).join('\n');
        const tooLong = slice.length > MAX_SOURCE_CHARS;
        return {
            path: node.path,
            startLine: node.startLine,
            endLine: end,
            code: tooLong ? `${slice.slice(0, MAX_SOURCE_CHARS)}\n…` : slice,
            truncated: tooLong || end < declaredEnd,
        };
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=source.js.map