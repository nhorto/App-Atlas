/** The value stamped on nodes read by a grammar rather than a compiler. */
export const GRAMMAR_TIER = 'tree-sitter';
/**
 * What to tell the reader about the weaker tier, or null when nothing in this atlas came
 * from it.
 */
export function grammarTier(nodes) {
    const languages = new Set();
    for (const node of nodes) {
        if (node.meta.tier === GRAMMAR_TIER && node.language)
            languages.add(node.language);
    }
    if (languages.size === 0)
        return null;
    const sorted = [...languages].sort();
    const display = list(sorted.map(label));
    return {
        languages: sorted,
        display,
        sentence: `${display} ${sorted.length === 1 ? 'was' : 'were'} read with a tree-sitter grammar rather than a compiler. ` +
            'Structure, doors and checks come from the source as written; which declaration a name refers to is matched ' +
            'by name rather than resolved, so links between files are marked likely.',
    };
}
/** `go` → `Go`. A table now that there is more than one exception to title-casing. */
const LABELS = { go: 'Go', csharp: 'C#', rust: 'Rust' };
function label(id) {
    return LABELS[id] ?? id.charAt(0).toUpperCase() + id.slice(1);
}
/** "a", "a and b", "a, b and c" — this ends up in a sentence on screen. */
function list(items) {
    if (items.length <= 1)
        return items[0] ?? '';
    return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}
//# sourceMappingURL=tiers.js.map