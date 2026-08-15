/**
 * @fileoverview Files a framework runs itself, and files a manifest names as a way in.
 *
 * Both answer the same question, asked by whatever wants to know whether a file nobody
 * imports is abandoned: *is there a reason nothing in this repo points at it?* A
 * Next.js `layout.tsx` is never imported by anything, and neither is the `bin` script a
 * package.json declares — in both cases something outside the source tree reaches in by
 * name, and reporting either as unused would be telling somebody to delete the file
 * their app starts from.
 *
 * Everything here is gated on a declaration the project made: the dependency is
 * installed, the directory exists, the manifest field is filled in. Nothing is
 * recognised on the strength of its filename alone, because a folder called `app` in a
 * repo with no router in it is just a folder.
 *
 * The answers are stamped onto the file nodes by the orchestrator, in the same way the
 * auth package is, so `src/model` reads a plain field rather than importing a detector
 * and the fact survives into `atlas.json` for anything reading it later.
 */
import { baseNameOf } from '../util/paths.js';
/**
 * The directories a file-routing framework has claimed in this project.
 *
 * Read straight off the signals, which only fill these in when the framework's own
 * package is a dependency *and* the directory is really there. Every file underneath
 * one is the framework's to run — not only the `page.tsx` the route detectors turn into
 * a door, but the layouts, templates, error boundaries and loading states beside it,
 * none of which anything imports and all of which are load-bearing.
 */
function routeDirectories(signals) {
    const out = [];
    const add = (dir, framework) => {
        if (dir && !out.some((entry) => entry.dir === dir))
            out.push({ dir, framework });
    };
    add(signals.nextAppDir, 'Next.js App Router');
    add(signals.nextPagesDir, 'Next.js Pages Router');
    add(signals.expoRouterDir, 'Expo Router');
    add(signals.svelteKitRoutesDir, 'SvelteKit');
    add(signals.remixRoutesDir, 'Remix');
    return out;
}
/**
 * Fixed filenames a framework looks for by name, in the order a reader would name them.
 *
 * These are the ones that sit *outside* the route tree: the request hook, the root
 * document, the client and server entry points. Each is keyed on the package that has
 * to be installed for the convention to mean anything, which is the same gate every
 * boundary detector in this project uses.
 */
const NAMED_FILES = [
    {
        package: 'next',
        framework: 'Next.js',
        paths: [
            'middleware.ts', 'middleware.js', 'src/middleware.ts', 'src/middleware.js',
            'instrumentation.ts', 'instrumentation.js', 'src/instrumentation.ts', 'src/instrumentation.js',
        ],
    },
    {
        package: '@sveltejs/kit',
        framework: 'SvelteKit',
        paths: [
            'src/hooks.server.ts', 'src/hooks.server.js', 'src/hooks.client.ts', 'src/hooks.client.js',
            'src/hooks.ts', 'src/hooks.js', 'src/service-worker.ts', 'src/service-worker.js',
        ],
    },
    {
        package: 'expo',
        framework: 'Expo',
        // The registered entry point of every Expo app, run by the native shell.
        paths: ['App.tsx', 'App.js', 'App.jsx', 'index.ts', 'index.js', 'src/App.tsx', 'src/App.js'],
    },
];
/**
 * Remix and React Router put four files beside their route tree that the framework
 * loads by name. They hang off the routes directory rather than off the repo root, so
 * they are worked out from the signal instead of being listed above.
 */
function remixEntries(signals) {
    const dir = signals.remixRoutesDir;
    if (!dir)
        return [];
    const parent = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '';
    const prefix = parent ? `${parent}/` : '';
    return ['root', 'entry.client', 'entry.server', 'routes'].flatMap((name) => ['ts', 'tsx', 'js', 'jsx'].map((ext) => `${prefix}${name}.${ext}`));
}
/**
 * Which framework runs this file itself, or null when none of them does.
 *
 * `null` is the ordinary answer and the safe one: it only means nothing here recognised
 * the file, and every caller treats that as "no reason found" rather than as proof there
 * is none.
 */
export function frameworkOwnerOf(relPath, signals) {
    for (const { dir, framework } of routeDirectories(signals)) {
        if (relPath === dir || relPath.startsWith(`${dir}/`))
            return framework;
    }
    for (const entry of NAMED_FILES) {
        if (!signals.packages.has(entry.package))
            continue;
        if (entry.paths.includes(relPath))
            return entry.framework;
    }
    const remix = remixEntries(signals);
    if (remix.includes(relPath))
        return 'Remix';
    return null;
}
/**
 * The manifest field that names this file as a way in, or null when none does.
 *
 * Matching is deliberately generous. A manifest points at built output — `main` is
 * `dist/index.js` and the source it came from is `src/index.ts` — and resolving that
 * properly would mean running somebody's bundler config. So a file also counts as named
 * when it shares a bare filename with an entry point, which over-matches: a repo whose
 * `main` is `index.js` will treat every unimported `index.ts` in it as declared.
 *
 * That is the right direction to be wrong in. This answer is only ever used to *keep a
 * file out* of a list of files nothing points at, so being too generous costs a mention
 * and being too strict costs somebody their entry point.
 */
export function declaredEntryFor(relPath, entryPoints) {
    const stem = stemOf(relPath);
    for (const entry of entryPoints) {
        if (entry.path === relPath)
            return entry.field;
        if (stem && stemOf(entry.path) === stem)
            return entry.field;
    }
    return null;
}
/** `dist/index.d.ts` → `index`. The name a build step keeps and an extension it does not. */
function stemOf(relPath) {
    const base = baseNameOf(relPath);
    const cut = base.indexOf('.');
    if (cut <= 0)
        return '';
    const stem = base.slice(0, cut);
    // A bare `index` matches half the files in a TypeScript repo and would silence
    // barrels that really are abandoned, but a barrel is also the single most likely
    // thing a `main` field points at. Kept, deliberately, on the same reasoning as above.
    return stem;
}
//# sourceMappingURL=owned.js.map