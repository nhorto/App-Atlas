/**
 * The door as it should be written when its head is unread.
 *
 * `discriminators` are what tell two same-named doors apart, and are joined into the key
 * in the order given — a null is kept as an empty segment rather than dropped, so a door
 * that has the thing and a door that does not can never key alike. `label` is the name in
 * the parenthesis: `POST …` on its own sends a reader searching, and the parenthesis is
 * the way back to the code.
 */
export function unreadHead(finding, discriminators, label) {
    const method = finding.method ?? 'ANY';
    const tail = finding.route ?? '';
    const parts = discriminators.map((part) => part ?? '').join('#');
    return {
        ...finding,
        key: `${method} ${finding.site.path}#${parts}${tail}`,
        name: `${method} …${tail}${label ? ` (${label})` : ''}`,
        route: null,
    };
}
/**
 * The discriminators and label for a door whose prefix was supposed to arrive from a
 * mount that never turned up, or that the detector knows was never written down.
 *
 * The router and the handler, because one function answering two mounts is two doors —
 * and a closure has no handler id, so the line stands in for it. This is the default for
 * any detector that has nothing more specific: file plus line is unique per declaration,
 * which is the weakest thing that still keeps strangers apart.
 */
export function unreadFromSite(finding) {
    const handler = finding.handlerId?.startsWith('func:') === true
        ? finding.handlerId.slice(finding.handlerId.lastIndexOf('#') + 1)
        : null;
    return unreadHead(finding, [finding.routerVar ?? null, finding.handlerId ?? `L${finding.site.line}`], handler);
}
//# sourceMappingURL=address.js.map