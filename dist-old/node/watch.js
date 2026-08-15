/**
 * @fileoverview The file-system watcher behind `--watch`.
 *
 * Node's own recursive `fs.watch` rather than a watcher library: it works on every
 * platform App Atlas supports, and adding a dependency to a tool whose whole pitch is
 * `npx app-atlas` is a cost paid by every user forever.
 *
 * The rules it follows are the boring ones that make live rebuilds bearable — ignore
 * anything that isn't source, wait for the editor to stop typing, and never run two
 * rebuilds at once.
 */
import fs from 'node:fs';
import path from 'node:path';
import { toPosix } from './util/paths.js';
/** Directory names that are never worth reacting to, at any depth. */
const IGNORED_DIRS = new Set([
    'node_modules',
    '.git',
    '.app-atlas',
    'dist',
    'build',
    'out',
    '.next',
    '.nuxt',
    '.svelte-kit',
    '.turbo',
    '.vercel',
    '.venv',
    'venv',
    'coverage',
    'vendor',
    '__pycache__',
]);
const WATCHED_EXTENSIONS = new Set([
    '.ts',
    '.tsx',
    '.mts',
    '.cts',
    '.js',
    '.jsx',
    '.mjs',
    '.cjs',
    '.py',
    '.prisma',
]);
/** Files that are not source but change the answer anyway. */
const WATCHED_FILES = new Set([
    'package.json',
    'tsconfig.json',
    'jsconfig.json',
    'vercel.json',
    '.env.example',
    'middleware.ts',
]);
export function watchProject(options) {
    const root = path.resolve(options.root);
    const quietMs = options.quietMs ?? 250;
    let pending = new Set();
    let timer = null;
    let running = false;
    let closed = false;
    const flush = () => {
        timer = null;
        if (closed || running || pending.size === 0)
            return;
        const batch = [...pending].sort();
        pending = new Set();
        running = true;
        void options
            .onChange(batch)
            .catch((err) => options.onError?.(err))
            .finally(() => {
            running = false;
            // Anything saved while that ran is still waiting.
            if (pending.size > 0)
                schedule();
        });
    };
    const schedule = () => {
        if (timer)
            clearTimeout(timer);
        timer = setTimeout(flush, quietMs);
    };
    const watcher = fs.watch(root, { recursive: true }, (_event, filename) => {
        if (closed || !filename)
            return;
        const relPath = toPosix(String(filename));
        if (!isInteresting(relPath))
            return;
        pending.add(relPath);
        schedule();
    });
    watcher.on('error', (err) => options.onError?.(err));
    return {
        close() {
            closed = true;
            if (timer)
                clearTimeout(timer);
            watcher.close();
        },
    };
}
/** Cheap enough to run on every file-system event, which is the only requirement. */
export function isInteresting(relPath) {
    const segments = relPath.split('/');
    for (let i = 0; i < segments.length - 1; i++) {
        if (IGNORED_DIRS.has(segments[i]))
            return false;
    }
    const name = segments[segments.length - 1];
    if (!name || name.startsWith('.#') || name.endsWith('~'))
        return false;
    return WATCHED_FILES.has(name) || WATCHED_EXTENSIONS.has(path.posix.extname(name).toLowerCase());
}
//# sourceMappingURL=watch.js.map