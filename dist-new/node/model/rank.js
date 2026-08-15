/**
 * @fileoverview Which files to read first, ranked rather than counted (issue #46).
 *
 * The overview used to sort by the number of edges touching a file. That counts
 * neighbours, which answers "what is busy" — a different question from "where do I start
 * reading", and the two come apart on exactly the files where it matters.
 *
 * **Which way importance flows, and why it is the opposite of the obvious one.** Textbook
 * PageRank over an import graph sends a file's score to the things it imports, so a file
 * ranks highly when much of the app depends on it. Built that way and measured, it
 * returns the leaves: on this repo `util/paths.ts` and three files of type declarations;
 * on a real Python service `enums.py`, `models.py` and `config.py`; on a recipe app a
 * `datetime.py` helper and a `guid.py`. All genuinely depended upon, and not one of them
 * a place to start reading — nobody understands an app by reading its type aliases.
 *
 * So the graph is reversed: a file collects score from what it *imports*, and ranks
 * highly when it pulls together things that themselves pull together things. That
 * surfaces the entry points and the modules that wire them up, which is what somebody
 * opening a codebase for the first time actually needs. Measured the same way, it returns
 * `analyze/index.ts` and `cli.ts` here, `api.py`, `main.py` and `cli.py` on that Python
 * service, and the route controllers and repository factory on the recipe app.
 *
 * Two exclusions, both facts about a file rather than guesses about its name:
 *
 *   - **A file that declares nothing of its own** is a pass-through — a barrel, an
 *     `index.ts` that re-exports its folder, a package entry point. It stays *in* the
 *     graph, so score still flows through it to whatever it re-exports, and it is dropped
 *     from the answer, because sending a reader there wastes the one click they were
 *     told to make. This is what keeps a barrel out, not PageRank itself: a file
 *     everything imports scores well whether or not it holds anything.
 *   - **Test files**, on both ends of every edge. A test imports a great deal on purpose,
 *     which under this direction makes it look exactly like an entry point — and a
 *     fixture is not where anybody's app lives. Two of them made the top ten before this
 *     rule existed.
 */
import { isRetired } from '../analyze/retired.js';
/** How much of a file's score it passes on rather than keeps. The usual 0.85. */
const DAMPING = 0.85;
/** Enough for the order to settle on repos far larger than anything this tool targets. */
const MAX_ROUNDS = 50;
/** Below this, another round cannot reorder anything a person would notice. */
const SETTLED = 1e-7;
/**
 * The files worth opening first, best first.
 *
 * Returns an empty list when no file imports another — a single-file script, or a
 * language tier that does not resolve imports. An arbitrary order would look like an
 * answer, and there isn't one.
 */
export function rankFiles(nodes, edges, limit = 10) {
    const files = new Map();
    for (const node of nodes) {
        if (node.kind === 'file' && node.zone !== 'test')
            files.set(node.id, node);
    }
    if (files.size === 0)
        return [];
    // Reversed on the way in: `A imports B` becomes an edge from B to A, so score travels
    // from a module to whatever pulls it in.
    const out = new Map();
    const importCount = new Map();
    let links = 0;
    for (const edge of edges) {
        if (edge.kind !== 'imports')
            continue;
        if (!files.has(edge.fromId) || !files.has(edge.toId))
            continue;
        if (edge.fromId === edge.toId)
            continue;
        const list = out.get(edge.toId);
        if (list)
            list.push(edge.fromId);
        else
            out.set(edge.toId, [edge.fromId]);
        importCount.set(edge.fromId, (importCount.get(edge.fromId) ?? 0) + 1);
        links++;
    }
    if (links === 0)
        return [];
    const ids = [...files.keys()];
    const n = ids.length;
    let score = new Map(ids.map((id) => [id, 1 / n]));
    for (let round = 0; round < MAX_ROUNDS; round++) {
        const next = new Map();
        // A node with nothing to pass to is a dead end its score cannot leave. Spreading it
        // over everything, rather than letting it evaporate, is what keeps the totals adding
        // up — otherwise the ranking quietly drains into whichever files sit at the bottom.
        let dangling = 0;
        for (const id of ids)
            if (!out.has(id))
                dangling += score.get(id);
        const base = (1 - DAMPING) / n + (DAMPING * dangling) / n;
        for (const id of ids)
            next.set(id, base);
        for (const [from, targets] of out) {
            const share = (DAMPING * score.get(from)) / targets.length;
            for (const to of targets)
                next.set(to, next.get(to) + share);
        }
        let drift = 0;
        for (const id of ids)
            drift += Math.abs(next.get(id) - score.get(id));
        score = next;
        if (drift < SETTLED)
            break;
    }
    return ids
        .filter((id) => holdsSomething(files.get(id)))
        // "Where to look first" is advice about the app somebody is working on. A file that
        // opens with "DEPRECATED — do not run as part of the pipeline" is the last place to
        // send them, and it stays *in* the graph above so score still flows through it (#87).
        .filter((id) => !isRetired(files.get(id)))
        // A file that imports nothing pulls nothing together, so by this ranking's own logic
        // it has nothing to say — it holds only the score every node starts with. Without
        // this the tail of a short list fills up with whatever sorts first among the files
        // that scored identically, which is an arbitrary answer wearing a ranked one's
        // clothes. A shorter list is the honest one.
        .filter((id) => (importCount.get(id) ?? 0) > 0)
        .sort((a, b) => score.get(b) - score.get(a) || a.localeCompare(b))
        .slice(0, limit)
        .map((id) => ({ node: files.get(id), imports: importCount.get(id) }));
}
/**
 * Whether a file has anything of its own for somebody to read.
 *
 * Counted rather than matched against a list of filenames, so a project whose barrels
 * are called `mod.ts`, `__init__.py` or `exports.go` gets the same treatment without
 * anybody adding it to a list.
 */
function holdsSomething(node) {
    const meta = node.meta;
    return (meta.functionCount ?? 0) + (meta.typeCount ?? 0) > 0;
}
//# sourceMappingURL=rank.js.map