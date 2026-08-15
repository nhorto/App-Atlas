/**
 * @fileoverview Loading tree-sitter, and the grammars it reads with.
 *
 * The runtime and every grammar are WebAssembly, which is the whole reason this tier can
 * exist. The native tree-sitter bindings would mean a compiler toolchain on the machine of
 * anyone who typed `npx app-atlas`, and a build that can fail on install is not something
 * to put in front of somebody who has half an hour before a meeting.
 *
 * Everything in here is lazy. A repo with no Go in it never loads a byte of any of it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
/**
 * Where an asset might be. The first entry is where the build puts it; the second is
 * where it lives in the repo, so the tier also works when run from source.
 */
function resolveAsset(...segments) {
    const candidates = [
        path.join(here, ...segments),
        path.join(here, '..', '..', '..', '..', ...segments),
        path.join(here, '..', '..', '..', '..', 'vendor', ...segments),
    ];
    for (const candidate of candidates) {
        if (fs.existsSync(candidate))
            return candidate;
    }
    return null;
}
let parserModule = null;
let initialized = null;
/**
 * Starts the WebAssembly runtime, once per process.
 *
 * Rejects rather than throws synchronously, and the caller is expected to turn that into
 * a warning and a stack of shallow file nodes. A missing parser means we know less about
 * this repo; it does not mean the run failed.
 */
async function runtime() {
    if (parserModule)
        return parserModule;
    initialized ??= (async () => {
        const mod = await import('web-tree-sitter');
        await mod.Parser.init();
        parserModule = mod;
        return mod;
    })();
    return initialized;
}
const languages = new Map();
const queries = new Map();
/** The compiled grammar for one language, cached for the life of the process. */
export async function loadLanguage(id) {
    const cached = languages.get(id);
    if (cached)
        return cached;
    const mod = await runtime();
    const file = resolveAsset('grammars', `tree-sitter-${id}.wasm`);
    if (!file)
        throw new Error(`the ${id} grammar is missing from this install (tree-sitter-${id}.wasm)`);
    const language = await mod.Language.load(fs.readFileSync(file));
    languages.set(id, language);
    return language;
}
/**
 * The compiled query for one language. Separate from the grammar because a query is text
 * we wrote and a grammar is a binary we vendored, and when a query is wrong the error
 * should say which of the two is at fault.
 */
export async function loadQuery(id) {
    const cached = queries.get(id);
    if (cached)
        return cached;
    const mod = await runtime();
    const language = await loadLanguage(id);
    const file = resolveAsset('queries', `${id}.scm`);
    if (!file)
        throw new Error(`the ${id} query file is missing from this install (${id}.scm)`);
    let query;
    try {
        query = new mod.Query(language, fs.readFileSync(file, 'utf8'));
    }
    catch (err) {
        // A query that will not compile is our bug, not the repo's, and it would otherwise
        // surface as "this Go file has no functions in it".
        throw new Error(`queries/${id}.scm does not compile against tree-sitter-${id}: ${err.message}`);
    }
    queries.set(id, query);
    return query;
}
/**
 * Parses one file. Returns null when the source is larger than tree-sitter's limit or the
 * parse produced nothing — both of which are "we could not read this", not a crash.
 */
export async function parseSource(id, source) {
    const mod = await runtime();
    const language = await loadLanguage(id);
    const parser = new mod.Parser();
    try {
        parser.setLanguage(language);
        const tree = parser.parse(source);
        if (!tree)
            return null;
        return { tree, root: tree.rootNode };
    }
    finally {
        parser.delete();
    }
}
//# sourceMappingURL=runtime.js.map