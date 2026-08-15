/**
 * @fileoverview Content hashing.
 *
 * Hashes are the backbone of incremental re-analysis (M5) and the AI summary cache
 * (M3): unchanged code keeps its hash, so it is never re-analyzed and never re-billed.
 * Bodies and docstrings are hashed separately so we can detect stale documentation.
 */
import { createHash } from 'node:crypto';
/** Short, stable content hash. 16 hex chars is ample for per-repo identity. */
export function hashText(text) {
    return createHash('sha256').update(normalize(text)).digest('hex').slice(0, 16);
}
/** Hash of several parts, order-sensitive. */
export function hashParts(...parts) {
    return hashText(parts.map((p) => p ?? '').join('\0'));
}
/**
 * Normalizes line endings and trailing whitespace so that a Windows/Unix checkout of
 * the same code produces the same hash.
 */
function normalize(text) {
    return text.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '');
}
//# sourceMappingURL=hash.js.map