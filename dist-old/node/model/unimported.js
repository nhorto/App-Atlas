/**
 * @fileoverview Files nothing else in this app imports (issue #46).
 *
 * Somebody who let an agent build for a weekend very often has two or three abandoned
 * attempts sitting in the tree, and no way at all to tell them from the code that runs.
 * The reference graph already knows: if nothing imports a file, nothing imports it.
 *
 * Three decisions shape everything below, and all three are the same decision.
 *
 * **The claim is a fact, not a verdict.** "Nothing in this app imports it" is something
 * a reader can check with one search. "Dead code" is a conclusion about what they should
 * do next, and this file never reaches it. Getting that wrong tells somebody to delete
 * working code, which is worse by a wide margin than saying nothing at all.
 *
 * **The unit is the file, not the export.** An export is used through a barrel, through
 * an alias, through a re-export chain three modules long; a file is imported or it is
 * not, and the edge saying so is written by the compiler. The finer question is more
 * useful and cannot be answered honestly with what is here.
 *
 * **The step is one step.** A file imported only by another file on this list stays off
 * it. Walking further would mean reachability from a set of roots, and a set of roots
 * that misses one entry point condemns everything under it — the single most expensive
 * mistake this feature could make.
 *
 * And before any of that, six questions that stop the answer being given at all — the
 * reference pass was skipped, a component format went unparsed, an alias would not
 * resolve, the run covered one app inside a bigger repo, the project is a library, or
 * the atlas predates any of this being recorded. Each is a case where the absence of an
 * edge says something about where App Atlas looked rather than about the code, which is
 * exactly the shape of `exposure.ts`'s refusal to report "no routes found" for a Python
 * project read without an interpreter. On the eighteen repositories this was measured
 * against, six of them were refused and every refusal was the right call.
 */
import { makeFileId } from './types.js';
/**
 * File extensions nothing imports because nothing can.
 *
 * A notebook is run cell by cell, a schema and a migration are read by their own tool,
 * and a `.d.ts` is picked up by the compiler without anybody writing an import. Listing
 * any of them would be reporting a convention working correctly.
 */
const NOT_IMPORTABLE = new Set(['.ipynb', '.prisma', '.sql']);
/** Enough to act on. Past this the list stops being read and starts being scrolled. */
const MAX_FILES = 40;
const MAX_NAMES = 6;
/**
 * The one caveat that is true of every answer this file ever gives.
 *
 * Static analysis cannot see a module loaded from a computed path, a handler a registry
 * looks up by string, or a `getattr` in Python. It never will. So the sentence has to
 * survive being wrong about those, which means it can be an invitation to look and it
 * can never be an instruction to delete.
 */
const ALWAYS = 'a file reached by a computed path, by a name built from a string, or from a document App Atlas does not ' +
    'parse — an MDX page, an HTML template — is invisible here, so this is a list to check, not a list to delete';
/**
 * Which files nothing else in this app imports.
 *
 * Takes nodes, edges and meta rather than a graph so the analyzer could ask the same
 * question before a graph exists, and so nothing in `src/model` has to import upwards.
 */
export function findUnimported(nodes, edges, meta) {
    const refusal = refuseToAnswer(meta) ?? refuseOnBrokenLinks(nodes);
    if (refusal) {
        return {
            answered: false,
            because: refusal,
            headline: null,
            files: [],
            total: 0,
            considered: 0,
            caveats: [ALWAYS],
        };
    }
    const used = filesInUse(nodes, edges);
    const candidates = [];
    let considered = 0;
    let unread = 0;
    for (const node of nodes) {
        if (node.kind !== 'file' || !node.path)
            continue;
        if (node.meta.unread) {
            unread++;
            continue;
        }
        if (!worthAsking(node))
            continue;
        considered++;
        if (used.has(node.id))
            continue;
        candidates.push(describe(node));
    }
    // Biggest first. A three-line file nobody imports is a leftover; a four-hundred-line
    // one is a weekend somebody has forgotten about, and that is the one worth the words.
    candidates.sort((a, b) => b.loc - a.loc || a.path.localeCompare(b.path));
    return {
        answered: true,
        because: null,
        headline: headlineFor(candidates.length, considered),
        files: candidates.slice(0, MAX_FILES),
        total: candidates.length,
        considered,
        caveats: caveatsFor(candidates.length, unread, meta),
    };
}
/**
 * The one sentence, in three states that are three different pieces of news.
 *
 * Zero *candidates* is not zero *findings*: a repo of notebooks weighs nothing up at
 * all, and "every one of the 0 source files here is imported" is the kind of sentence
 * that makes a reader stop believing the ones around it.
 */
function headlineFor(found, considered) {
    if (found > 0) {
        return found === 1
            ? 'one file in this app is imported by nothing else in it'
            : `${found.toLocaleString('en-US')} files in this app are imported by nothing else in it`;
    }
    if (considered === 0) {
        return ('there was nothing here to ask about: every file is a notebook, a test, a config file, a declared way ' +
            'in, or one a framework runs itself');
    }
    return (`every one of the ${considered.toLocaleString('en-US')} source ${considered === 1 ? 'file' : 'files'} here ` +
        'is imported by something else in the app, declared as a way in, or run by a framework convention');
}
/**
 * Why this question cannot be answered at all, or null when it can.
 *
 * Every one of these is a case where a missing edge means App Atlas did not look rather
 * than that nothing is there. Answering anyway would produce a table that is confident,
 * specific, and completely wrong — the worst output this tool has.
 */
function refuseToAnswer(meta) {
    if (!meta.coverage) {
        return ('this atlas was written by a version of App Atlas that did not record whether it traced who uses what, ' +
            'so there is no way to tell "nothing imports this" from "nobody looked". Re-run `app-atlas analyze`');
    }
    if (!meta.coverage.references) {
        return ('the symbol-reference pass was skipped for this run (`--no-refs`), so App Atlas never traced who uses ' +
            'what. Every file in the repo would look unused, which says nothing about the code');
    }
    const unreadable = meta.coverage.unreadFormats ?? [];
    if (unreadable.length > 0) {
        // Gitea's `ViewFileTreeStore.ts` is imported by two `.vue` files and by nothing
        // else. There is no way from inside the graph to know which files those twenty
        // components pointed at, so the only honest answer covers all of them.
        const named = unreadable
            .map((entry) => `${entry.count} ${entry.ext} ${entry.count === 1 ? 'file' : 'files'}`)
            .join(' and ');
        return (`this project contains ${named}, which App Atlas does not parse. Each one can import the code it ` +
            'renders, so an unknown number of links between files are missing from the graph');
    }
    if (!meta.coverage.wholeRepo) {
        return ('this run mapped one app inside a larger repo, so the packages that import this one were never read. ' +
            'A file used only by a sibling would look abandoned, and App Atlas cannot tell the difference from here');
    }
    if (meta.archetype?.archetype === 'library') {
        return ('this project is code other code imports, so its files are meant to be used from outside this repo — ' +
            'somewhere App Atlas cannot see. Nothing here is evidence that a file is unused');
    }
    return null;
}
/**
 * Whether the import graph is missing links between this project's own files.
 *
 * A path alias — `@/lib/db`, `~/utils` — is resolved by a tsconfig or a bundler config,
 * and when that config sits somewhere this run never looked the alias resolves to
 * nothing and the link vanishes. On PocketBase, a single `ui/jsconfig.json` one
 * directory below the analysis root was the difference between fourteen page files
 * being correctly linked from their router and fourteen page files being reported as
 * abandoned. There is no way to tell from inside which files those broken links pointed
 * at, so the only honest answer is none of them.
 *
 * The suggestion at the end is the actual fix, and it is a real one: the app that owns
 * the config is the directory to point App Atlas at.
 */
function refuseOnBrokenLinks(nodes) {
    const specifiers = new Set();
    for (const node of nodes) {
        if (node.kind !== 'file')
            continue;
        // A test's aliases resolve through the same config the app's do, so one failing in
        // a test and not in the app takes a fixture built on purpose to do it — which is
        // exactly what this repository has in `test/fixtures/`, and a project must not be
        // silenced by its own test data.
        if (node.zone === 'test')
            continue;
        for (const specifier of node.meta.unresolvedImports ?? []) {
            specifiers.add(specifier);
            if (specifiers.size >= 3)
                break;
        }
    }
    if (specifiers.size === 0)
        return null;
    const shown = [...specifiers].sort().slice(0, 2).map((s) => `\`${s}\``).join(' and ');
    return (`App Atlas could not resolve import paths like ${shown} — they are aliases whose mapping is in a config ` +
        'file this run did not read, so links between files in this project are missing from the graph. Point ' +
        'App Atlas at the directory that owns that config and ask again');
}
/**
 * Every file something in this atlas points at.
 *
 * Four kinds of pointing, and each is a fact the analyzer already recorded rather than a
 * rule invented here: an import, a symbol reference that crosses a file boundary, a door
 * standing in front of a handler, and a check that a door leans on. The last two matter
 * most — a route file and the middleware protecting it are both reached by the framework
 * and never by an import.
 */
function filesInUse(nodes, edges) {
    const used = new Set();
    const fileOf = new Map();
    for (const node of nodes) {
        if (node.path)
            fileOf.set(node.id, node.kind === 'file' ? node.id : makeFileId(node.path));
    }
    for (const edge of edges) {
        switch (edge.kind) {
            case 'imports':
                // A test importing something counts. Code its tests exercise and nothing else is
                // a different finding from code nothing touches at all, and reporting the two
                // together would put a well-tested helper next to an abandoned draft.
                used.add(edge.toId);
                break;
            case 'references': {
                const from = fileOf.get(edge.fromId);
                const to = fileOf.get(edge.toId);
                if (to && to !== from)
                    used.add(to);
                break;
            }
            case 'exposed-by': {
                // The code behind a door. Usually in the door's own file, but a route registered
                // in one file and handled in another is exactly the case this catches.
                const to = fileOf.get(edge.toId);
                if (to)
                    used.add(to);
                break;
            }
            case 'protected-by':
                // The file holding the check. Middleware is reached by the framework and by
                // nothing else, and it is the most consequential file in a lot of repos.
                used.add(edge.toId);
                break;
            default:
                break;
        }
    }
    // A door's own file, and every file its detector saw it in. Read off the node rather
    // than off an edge because a door with no handler we could name still has an address.
    for (const node of nodes) {
        if (node.kind !== 'endpoint')
            continue;
        if (node.path)
            used.add(makeFileId(node.path));
        for (const site of node.meta.sites ?? []) {
            if (site.path)
                used.add(makeFileId(site.path));
        }
    }
    return used;
}
/**
 * Whether "does anything import this?" is even a sensible question about this file.
 *
 * Everything excluded here is excluded because the answer is *no* for a reason that has
 * nothing to do with the code being abandoned: a test is run by a runner, a config file
 * is read by a build tool, a Next.js layout is rendered by Next.js, a `bin` script is
 * started by whoever typed its name.
 */
function worthAsking(node) {
    if (node.zone === 'test' || node.zone === 'config')
        return false;
    const meta = node.meta;
    // A file that exports nothing was never going to be imported by anything: it is a
    // script somebody runs, an entry point a bundler is pointed at, or a module included
    // for its side effects. `web/src/main.tsx` is all three at once and is named in an
    // HTML file this analyzer does not read. Requiring an export is what turns the finding
    // from "nothing points here" into the sharper and more useful "this file offers names
    // to a caller that does not exist".
    if ((meta.exportedNames ?? []).length === 0)
        return false;
    if (typeof meta.frameworkOwned === 'string')
        return false;
    if (typeof meta.declaredEntry === 'string')
        return false;
    // In Go, `package main` *is* the declaration that a file is a program. It is the one
    // thing in the language nothing may import, and the analyzer already records it.
    if (meta.namespace === 'main')
        return false;
    const path = node.path ?? '';
    if (path.endsWith('.d.ts'))
        return false;
    if (NOT_IMPORTABLE.has(String(meta.ext ?? '')))
        return false;
    // `__init__.py`, `__main__.py`: Python's own names for a package marker and a module
    // meant to be run with `python -m`. Neither is imported by path.
    if (/(^|\/)__[a-z_]+__\.pyi?$/.test(path))
        return false;
    return true;
}
/** What the answer leaves out, in the order somebody should read it. */
function caveatsFor(found, unread, meta) {
    const caveats = [ALWAYS];
    if (found > 1) {
        caveats.push('a file that only the files above import is not itself listed — this is one step, not a sweep, ' +
            'so start at the top and work outwards');
    }
    if (unread > 0) {
        caveats.push(`App Atlas could not read ${unread} ${unread === 1 ? 'file' : 'files'}; if one of them imports ` +
            'something listed here, it is not really unimported');
    }
    if (meta.stats.references === 0 && meta.stats.imports === 0) {
        caveats.push('no links between files were found at all, which usually means the analysis saw very little');
    }
    return caveats;
}
function describe(node) {
    const meta = node.meta;
    return {
        id: node.id,
        path: node.path ?? node.name,
        zone: node.zone,
        loc: Number(meta.loc ?? 0),
        exportedNames: (meta.exportedNames ?? []).slice(0, MAX_NAMES),
        summary: node.summary,
        summarySource: node.summarySource,
    };
}
//# sourceMappingURL=unimported.js.map