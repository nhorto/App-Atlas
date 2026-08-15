/**
 * @fileoverview The Atlas data model.
 *
 * Deliberately language-agnostic: every language plugin emits these same nodes and
 * edges, so the UI, the exporters and (later) the AI enricher never need to know
 * whether a fact came from TypeScript, Python or anything else.
 *
 * See SPEC.md section 5.4.
 */
export const FORMAT_VERSION = 3;
/** Node kinds a user can drill into on the canvas. */
export const CONTAINER_KINDS = new Set([
    'app',
    'zone',
    'module',
    'file',
    'type',
]);
/** The two containers every boundary node hangs off. */
export const INBOUND_ID = 'zone:inbound';
export const OUTBOUND_ID = 'zone:outbound';
export function makeAppId(name) {
    return `app:${name}`;
}
export function makeModuleId(dirPath) {
    return `module:${dirPath === '' ? '.' : dirPath}`;
}
export function makeFileId(relPath) {
    return `file:${relPath}`;
}
export function makeFunctionId(relPath, name, disambiguator = '') {
    return `func:${relPath}#${name}${disambiguator}`;
}
export function makeTypeId(relPath, name, disambiguator = '') {
    return `type:${relPath}#${name}${disambiguator}`;
}
export function makeEdgeId(kind, fromId, toId) {
    return `${kind}|${fromId}|${toId}`;
}
/** `key` must already identify the door uniquely (e.g. `POST /api/users`). */
export function makeEndpointId(kind, key) {
    return `endpoint:${kind}:${key}`;
}
export function makeServiceId(name) {
    return `service:${name.toLowerCase()}`;
}
export function makeStoreId(key) {
    return `store:${key.toLowerCase()}`;
}
//# sourceMappingURL=types.js.map