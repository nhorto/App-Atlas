/**
 * @fileoverview What `--ignore` means, in one place.
 *
 * `--ignore 'test/fixtures/**'` is a claim about the repository, not about one scan of
 * it: the paths it names are meant to be out of view for everything the atlas says. The
 * source scan honoured it from the start, because fast-glob takes an `ignore` list and
 * does the work. The signal readers did not — each one walks the tree itself — so a
 * `Cargo.toml` under an ignored fixture still wrote "Actix Web, Diesel" into the *Built
 * with* line, and a wrangler config under one still put three Cloudflare data stores and
 * a route answering every URL on the map, cited to a file the reader had asked not to
 * see. That is the worst shape this tool's output takes: a fact whose only evidence is a
 * path the reader was told was not being read.
 *
 * So the patterns are compiled once, here, and every reader that turns a path on disk
 * into a sentence in the atlas consults the same matcher.
 *
 * `picomatch` rather than a hand-rolled glob or the `ignore` package already in the tree:
 * it is the engine fast-glob compiles its own `ignore` list with, by way of micromatch,
 * and agreeing with the source scan *exactly* is the entire point. A second dialect would
 * mean `--ignore 'examples'` leaving out a directory's manifests while keeping its code,
 * which is a quieter wrong answer than the one this fixes.
 */
import path from 'node:path';
import picomatch from 'picomatch';
import { toPosix } from '../util/paths.js';
/**
 * Build output, dependencies and caches: never this app, whoever is asking. Applied to
 * every scan, so a caller's `--ignore` only ever adds to it.
 */
export const DEFAULT_IGNORES = [
    '**/node_modules/**',
    '**/.git/**',
    '**/.app-atlas/**',
    '**/dist/**',
    '**/build/**',
    '**/out/**',
    '**/.next/**',
    '**/.nuxt/**',
    '**/.svelte-kit/**',
    '**/.turbo/**',
    '**/.vercel/**',
    '**/.venv/**',
    '**/venv/**',
    '**/coverage/**',
    '**/vendor/**',
    '**/__pycache__/**',
    '**/.ipynb_checkpoints/**',
    '**/*.min.js',
    '**/*.bundle.js',
];
/**
 * The matcher for one run, rooted at the directory the patterns are written against.
 *
 * That root is the app being analyzed, because that is the directory `--ignore` globs
 * are relative to — the same `cwd` the source scan hands fast-glob. A path outside it is
 * not something a pattern written against it can describe, and is never ignored: a
 * Compose file above a scoped app is read on purpose (see `readComposePorts`), and
 * silently dropping it here would take fourteen real doors off a map to obey a glob that
 * never mentioned them.
 */
export function buildIgnoreMatcher(root, extra = []) {
    const patterns = [...DEFAULT_IGNORES, ...extra];
    // `dot: true` is what fast-glob compiles an `ignore` entry with, so `**/dist/**`
    // leaves out `.cache/dist/app.js` here exactly as it does there.
    const tests = patterns.map((pattern) => picomatch(pattern, { dot: true }));
    const base = path.resolve(root);
    return {
        patterns,
        ignores(absPath) {
            const rel = path.relative(base, absPath);
            if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel))
                return false;
            return tests.some((test) => test(toPosix(rel)));
        },
    };
}
//# sourceMappingURL=ignores.js.map