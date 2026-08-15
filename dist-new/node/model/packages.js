/**
 * @fileoverview One hop up the installed dependency tree, for traces that die below it.
 *
 * A pasted JavaScript stack almost never ends in a package the project chose. It ends in
 * `@supabase/auth-js`, `postgrest-js`, `undici`, `ws` — something a library the project
 * *did* choose brought along. Answering "nothing here imports that" is true and close to
 * useless: the reader knows they never typed it, and what they want is the name of the
 * dependency of theirs that did.
 *
 * That is a fact, not a guess, and it is written down: the parent's own `package.json`
 * declares it. So the lookup is a lookup, in keeping with everything else this feature
 * does — no inference about which library "probably" pulled something in.
 *
 * Only one hop is offered. Two would let a chain of intermediates put a package on the
 * screen that the reader has no relationship with at all, and the honest answer at that
 * depth is that the trace has left this project behind.
 *
 * Reading files is kept here rather than in `errortrace.ts` for the reason source maps
 * are: the tracer stays a pure function of the graph and the paste, and everything that
 * touches a disk arrives through an interface it can be handed, or not handed at all.
 */
import fs from 'node:fs';
import path from 'node:path';
/** An index that answers from nothing: what a caller with no `node_modules` gets. */
export const NO_PACKAGES = { dependents: () => [] };
/**
 * Read declared dependencies out of the `node_modules` beside a project.
 *
 * Manifests are read once each and remembered, because a trace asks about the same
 * handful of packages repeatedly and a missing one is worth remembering too.
 */
export function installedPackages(root) {
    const manifests = new Map();
    const declaredBy = (name) => {
        const held = manifests.get(name);
        if (held)
            return held;
        let all = {};
        try {
            // A package name is a path segment by construction; anything with `..` in it did
            // not come from an import specifier this tool wrote down.
            if (!/^(?:@[\w.-]+\/)?[\w.-]+$/.test(name))
                throw new Error('not a package name');
            const file = path.join(root, 'node_modules', ...name.split('/'), 'package.json');
            const json = JSON.parse(fs.readFileSync(file, 'utf8'));
            all = { ...json.dependencies, ...json.peerDependencies, ...json.optionalDependencies };
        }
        catch {
            // Not installed, not readable, not JSON — all the same answer: it declares nothing
            // this can see. A trace is not worth failing over a manifest.
        }
        manifests.set(name, all);
        return all;
    };
    return {
        dependents(packageName, among) {
            return among.filter((candidate) => candidate !== packageName && packageName in declaredBy(candidate));
        },
    };
}
//# sourceMappingURL=packages.js.map