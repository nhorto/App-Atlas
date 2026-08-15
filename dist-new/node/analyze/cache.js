/**
 * @fileoverview The per-file analysis cache — what makes the second run fast.
 *
 * Everything one file contributes to the atlas (its nodes, the edges that start inside
 * it, its boundary findings, the offsets of its declarations) is stored under a hash of
 * that file's text. A file nobody has edited is never parsed again.
 *
 * Two properties make that safe rather than merely fast:
 *
 * - **A slice belongs to one file.** Every edge a file produces starts inside it — an
 *   import it wrote, a reference from one of its own functions — so slices restore in
 *   any order and never collide.
 * - **Editing a file also invalidates whatever imports it.** Renaming an export in
 *   `db.ts` changes the id its callers point at, and only re-reading those callers can
 *   notice. A reference cannot cross a module boundary without an import, so one hop
 *   back along the import graph is enough; it does not need to be transitive.
 *
 * Anything project-wide that could change an answer — the tool version, the analysis
 * flags, the dependency list the boundary detectors are gated on, what the config files
 * say — is folded into one fingerprint. When that moves, the whole cache is discarded,
 * because working out which files a new detector would have changed is harder than
 * simply reading them all again.
 */
import fs from 'node:fs';
import { AtlasStore, atlasDbPath } from '../model/store.js';
import { hashParts, hashText } from '../util/hash.js';
/**
 * Everything outside a single file that could change what analyzing it produces.
 * Deliberately blunt: the dependency list is in here because detectors are gated on it,
 * and the config signals are in here because a new cron in `vercel.json` becomes a door.
 */
export function fingerprintProject(project, toolVersion, options) {
    const deps = project.packageJson
        ? {
            ...project.packageJson.dependencies,
            ...project.packageJson.devDependencies,
        }
        : {};
    return hashParts(toolVersion, String(options.followReferences), String(options.detectBoundaries), 
    // Excluding a file this run does not just remove it — it can silently remove an
    // import edge from a file that stayed. Cheaper to start over than to reason about.
    JSON.stringify([...project.ignored].sort()), JSON.stringify(Object.keys(deps).sort()), JSON.stringify(project.signals), project.tsConfigPath ? readIfPresent(project.tsConfigPath) : '');
}
export class AnalysisCache {
    store;
    fingerprint;
    constructor(store, fingerprint) {
        this.store = store;
        this.fingerprint = fingerprint;
    }
    /** Opens the cache beside the atlas. Never throws: a broken cache is an empty one. */
    static open(root, fingerprint) {
        try {
            return new AnalysisCache(AtlasStore.open(atlasDbPath(root)), fingerprint);
        }
        catch {
            return null;
        }
    }
    /**
     * Decides what has to be read again. Hashing every file costs one pass over the
     * bytes; parsing one costs orders of magnitude more, so this trade is always worth
     * making — even on a first run, where it just finds nothing to reuse.
     */
    plan(files) {
        const hashes = new Map();
        for (const file of files) {
            hashes.set(file.relPath, hashFile(file.absPath));
        }
        const index = this.store.readSliceIndex(this.fingerprint);
        const present = new Set(files.map((f) => f.relPath));
        const stale = new Set();
        for (const file of files) {
            const cached = index.get(file.relPath);
            if (!cached || cached.hash !== hashes.get(file.relPath))
                stale.add(file.relPath);
        }
        // A file that vanished still invalidates whoever imported it.
        const gone = [...index.keys()].filter((relPath) => !present.has(relPath));
        const changed = new Set([...stale, ...gone]);
        for (const [relPath, entry] of index) {
            if (stale.has(relPath) || !present.has(relPath))
                continue;
            if (entry.imports.some((target) => changed.has(target)))
                stale.add(relPath);
        }
        const reusablePaths = files.map((f) => f.relPath).filter((relPath) => !stale.has(relPath));
        const payloads = this.store.readSlicePayloads(reusablePaths);
        const reusable = new Map();
        for (const relPath of reusablePaths) {
            const json = payloads.get(relPath);
            if (!json) {
                stale.add(relPath);
                continue;
            }
            try {
                reusable.set(relPath, JSON.parse(json));
            }
            catch {
                stale.add(relPath);
            }
        }
        return { reusable, stale, hashes };
    }
    /** Records this run's slices and forgets files that are no longer in the project. */
    save(slices, keep) {
        const rows = slices.map((slice) => ({
            relPath: slice.relPath,
            hash: slice.hash,
            imports: slice.imports,
            json: JSON.stringify(slice),
        }));
        this.store.writeSlices(this.fingerprint, rows, keep);
    }
    clear() {
        this.store.clearSlices();
    }
    close() {
        this.store.close();
    }
}
/** A file we cannot read is a file we have to try to read: an empty hash never matches. */
function hashFile(absPath) {
    try {
        return hashText(fs.readFileSync(absPath, 'utf8'));
    }
    catch {
        return '';
    }
}
function readIfPresent(file) {
    try {
        return fs.readFileSync(file, 'utf8');
    }
    catch {
        return '';
    }
}
//# sourceMappingURL=cache.js.map