import { listDoors } from './flow.js';
import { NO_PACKAGES } from './packages.js';
import { looksBuilt } from './sourcemap.js';
/**
 * Every door on the map, by id. Built once per question rather than once per walk: a
 * dependency trace asks the same thing of eight files in a row.
 */
function doorIndex(graph) {
    const doorsById = new Map();
    for (const group of listDoors(graph).groups) {
        for (const door of group.doors)
            doorsById.set(door.id, door);
    }
    return doorsById;
}
/** What a stack frame's walk crosses: one function naming another, and nothing else. */
const REFERENCES_ONLY = new Set(['references']);
/**
 * What a file's walk crosses. `imports` as well, because a module that exports a constant
 * rather than a function has no reference edges pointing at it at all — nothing *calls*
 * `lib/supabase.js`, four screens simply import it — and a walk that only follows calls
 * reports it as reached by nobody. Importing a module runs it, so a door whose file
 * imports it does reach it, which is the claim being made and no more.
 */
const REFERENCES_AND_IMPORTS = new Set(['references', 'imports']);
/** How far back through the references to look for a way in. */
const MAX_BACK_HOPS = 6;
/** Ceiling on the backward walk, so a hub file cannot make this run away. */
const MAX_BACK_VISITED = 600;
/**
 * Read a pasted error and place it on the map.
 *
 * Takes the paste exactly as it arrives — a stack trace, a log excerpt with timestamps
 * around it, a screenshot's text — and ignores whatever is not a frame rather than
 * demanding a format.
 *
 * @param maps Where to look up frames that landed in build output. Without it a trace
 *   from a production bundle parses fine and places nothing, which is the honest answer
 *   but not a useful one.
 * @param installed Where to ask which of this project's own dependencies brought along
 *   the package a trace died in. Without it that question goes unanswered rather than
 *   guessed at, and a stack that ends in a transitive dependency stops at its name.
 */
export function traceError(graph, pasted, maps, installed = NO_PACKAGES) {
    const frames = parseFrames(pasted);
    const placed = frames.map((frame) => place(graph, frame, maps));
    const yours = placed.filter((found) => found.nodeId !== null);
    const origin = yours[0] ?? null;
    const back = origin?.nodeId ? doorsReaching(graph, origin.nodeId) : { doors: [], truncated: false };
    return {
        frames: placed,
        yours,
        languages: [...new Set(frames.map((frame) => frame.language))],
        origin,
        doors: back.doors,
        searchTruncated: back.truncated,
        parsedNothing: frames.length === 0,
        needsSourceMap: placed.some((found) => found.reason === 'minified'),
        intoDependency: origin ? null : reachIntoDependency(graph, placed, installed),
    };
}
// ---------------------------------------------------------------------------
// Reading the paste
// ---------------------------------------------------------------------------
/**
 * V8 and every JavaScript runtime that copies it:
 *   `at handler (/app/routes/users.ts:12:5)` · `at /app/x.js:3:1` · `at async f (…)`
 * The path group is lazy and the two numbers are anchored to the end, because paths on
 * Windows contain the same colon the line number is separated by.
 */
const JS_FRAME = /^\s*at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?\s*$/;
/** CPython: `  File "/app/api.py", line 42, in create_user` */
const PY_FRAME = /^\s*File\s+"(.+?)",\s+line\s+(\d+)(?:,\s+in\s+(.+?))?\s*$/;
/**
 * .NET: `at Shop.Api.Orders.Delete(Int32 id) in /src/Orders.cs:line 42`
 * Tried before the JavaScript pattern, which would otherwise claim the same line and
 * read `:line 42` as a path ending in `line`.
 */
const NET_FRAME = /^\s*at\s+(.+?)\s+in\s+(.+?):line\s+(\d+)\s*$/;
/** JVM: `at com.example.Shop.checkout(Shop.java:42)` — a file name, never a path. */
const JAVA_FRAME = /^\s*at\s+([\w$.]+)\(([\w$]+\.(?:java|kt)):(\d+)\)\s*$/;
/** Go's panic dump puts the location on its own tab-indented line under the call. */
const GO_LOCATION = /^\s*(\S*\.go):(\d+)(?:\s+\+0x[0-9a-f]+)?\s*$/;
const GO_CALL = /^(?:\s*)([\w./\-*()]+\.[\w*()]+)\((?:.*)\)\s*$/;
/**
 * Pull every frame out of a paste, whatever else is in it.
 *
 * Order matters: the .NET and Java shapes both begin `at ` and would be swallowed by
 * the JavaScript pattern, so they are tried first. Anything that matches nothing is
 * skipped without comment — a paste is usually mostly prose.
 */
export function parseFrames(pasted) {
    const frames = [];
    const lines = pasted.split(/\r?\n/);
    lines.forEach((raw, index) => {
        const net = NET_FRAME.exec(raw);
        if (net) {
            frames.push(frame(raw, net[2], net[3], null, net[1], 'dotnet', frames.length));
            return;
        }
        const java = JAVA_FRAME.exec(raw);
        if (java) {
            frames.push(frame(raw, java[2], java[3], null, java[1], 'java', frames.length));
            return;
        }
        const js = JS_FRAME.exec(raw);
        if (js) {
            frames.push(frame(raw, js[2], js[3], js[4], js[1] ?? null, 'javascript', frames.length));
            return;
        }
        const py = PY_FRAME.exec(raw);
        if (py) {
            frames.push(frame(raw, py[1], py[2], null, py[3] ?? null, 'python', frames.length));
            return;
        }
        const go = GO_LOCATION.exec(raw);
        if (go) {
            // Go prints the function on the line above the file it is in.
            const caller = GO_CALL.exec(lines[index - 1] ?? '');
            frames.push(frame(raw, go[1], go[2], null, caller?.[1] ?? null, 'go', frames.length));
        }
    });
    return frames;
}
function frame(raw, rawPath, line, column, functionName, language, order) {
    return {
        raw: raw.trim(),
        rawPath: rawPath.trim(),
        line: Number(line),
        column: column === null ? null : Number(column),
        functionName: functionName?.trim() || null,
        language,
        order,
    };
}
// ---------------------------------------------------------------------------
// Putting a frame on the map
// ---------------------------------------------------------------------------
/** Directories whose contents are somebody else's code, whatever the language. */
const VENDORED = [
    'node_modules/',
    'site-packages/',
    'dist-packages/',
    '/vendor/',
    'go/pkg/mod/',
    '.nuget/',
    '.cargo/registry/',
    '.pub-cache/',
    'Pods/',
];
/** Frames the runtime made up: not files anybody can open. */
const RUNTIME_ONLY = ['node:', '<anonymous>', 'native', 'internal/', 'unknown location', '[native code]'];
function place(graph, frame, maps) {
    const blank = {
        frame,
        nodeId: null,
        nodeName: null,
        nodeKind: null,
        path: null,
        sourceLine: null,
        reason: null,
        candidates: [],
        mappedFrom: null,
        nameDrifted: false,
    };
    const cleaned = cleanPath(frame.rawPath);
    if (RUNTIME_ONLY.some((mark) => cleaned.startsWith(mark) || cleaned === mark)) {
        return { ...blank, reason: 'runtime' };
    }
    if (VENDORED.some((mark) => cleaned.includes(mark)))
        return { ...blank, reason: 'dependency' };
    const built = looksBuilt(cleaned, frame.line, frame.column);
    // A frame that looks like build output goes through the map first. A repo that commits
    // its `dist/` would otherwise match the bundle by path and call that an answer, which
    // is a file in this project and still no use to anybody.
    if (maps && built) {
        const mapped = throughMap(graph, frame, cleaned, blank, maps);
        if (mapped)
            return mapped;
    }
    const direct = placeAt(graph, frame, blank, resolvePath(graph, cleaned), frame.line, frame.functionName);
    if (direct.nodeId)
        return direct;
    // Anything else the atlas cannot find is worth one look through the maps too: a build
    // that keeps its original directory layout leaves frames that look handwritten.
    if (maps && !built) {
        const mapped = throughMap(graph, frame, cleaned, blank, maps);
        if (mapped)
            return mapped;
    }
    // "No file matches that path" is misleading about a bundle — the file does exist, it
    // is just not one anybody wrote, and the fix is a build that emits maps.
    if (built && direct.reason === 'unknown-file')
        return { ...direct, reason: 'minified' };
    return direct;
}
/**
 * Place a frame through the source map the build wrote, or say it could not be.
 *
 * Returns null only when no map answered at all, so the caller can fall back. Once a map
 * has spoken its answer is the one reported, including when the source it names is not
 * a file this atlas holds — the map is better evidence than the frame's own path, and
 * quietly falling back to the bundle would hide that the mapping worked.
 */
function throughMap(graph, frame, cleaned, blank, maps) {
    const at = maps.lookup(cleaned, frame.line, frame.column);
    if (!at)
        return null;
    const origin = {
        bundlePath: cleaned,
        bundleLine: frame.line,
        bundleColumn: frame.column,
        mapPath: at.mapPath,
        source: at.source,
        line: at.line,
        name: at.name,
    };
    const from = { ...blank, mappedFrom: origin };
    return placeAt(graph, frame, from, resolvePath(graph, cleanPath(at.source)), at.line, at.name);
}
/** The shared half: a resolved path and a line, turned into whatever sits there. */
function placeAt(graph, frame, blank, matched, line, named) {
    if (matched.length === 0)
        return { ...blank, reason: 'unknown-file' };
    if (matched.length > 1)
        return { ...blank, reason: 'ambiguous', candidates: matched };
    const node = graph.nodeAt(matched[0], line);
    if (!node)
        return { ...blank, path: matched[0], sourceLine: line, reason: 'unknown-file' };
    return {
        ...blank,
        frame,
        nodeId: node.id,
        nodeName: node.name,
        nodeKind: node.kind === 'function' ? 'function' : 'file',
        path: matched[0],
        sourceLine: line,
        reason: null,
        candidates: [],
        nameDrifted: node.kind === 'function' && namesDisagree(named, node.name),
    };
}
/**
 * Whether the name the runtime printed and the name at that line are different things.
 *
 * Runtimes decorate the name with everything they know — `async`, the receiver, the
 * whole namespace — so only the last identifier is compared. Anonymous frames say
 * nothing to disagree with.
 */
function namesDisagree(printed, declared) {
    if (!printed)
        return false;
    const bare = printed
        .replace(/^(?:async|new|get|set)\s+/, '')
        .replace(/\(.*\)$/, '')
        .split(/[.#]/)
        .filter(Boolean)
        .pop();
    if (!bare || bare === '<anonymous>' || bare.startsWith('<'))
        return false;
    return bare !== declared;
}
/**
 * A frame's path, reduced to something comparable with the atlas.
 *
 * Traces carry the same file a dozen ways — `file:///`, a Windows drive, a webpack
 * prefix, a percent-encoded space — and none of that changes which file it is.
 */
export function cleanPath(raw) {
    let path = raw.trim();
    path = path.replace(/^\(+/, '').replace(/\)+$/, '');
    path = path.replace(/^(?:webpack-internal:\/\/\/|webpack:\/\/[^/]*\/?|rsc:\/\/[^/]*\/?)/, '');
    path = path.replace(/^file:\/\//, '');
    try {
        if (/%[0-9a-f]{2}/i.test(path))
            path = decodeURIComponent(path);
    }
    catch {
        // A malformed escape is not worth failing the whole paste over.
    }
    path = path.replace(/\\/g, '/');
    path = path.replace(/^[a-zA-Z]:\//, '/');
    path = path.replace(/[?#].*$/, '');
    return path;
}
/**
 * Which file in this repo a frame's path means — none, one, or several.
 *
 * An exact repo-relative hit is the easy case. Everything else is matched by the tail
 * of the path, because a trace from a container, a CI box or a colleague's laptop has
 * an absolute prefix that never existed here. Matching on the tail is also how a
 * single ambiguous answer happens — a JVM frame gives `Shop.java` and nothing else —
 * and that case returns every candidate rather than picking, because picking is how
 * this feature would send somebody to the wrong file.
 */
export function resolvePath(graph, cleaned) {
    const known = graph.filePaths();
    if (known.length === 0)
        return [];
    const withoutRoot = stripRoot(cleaned, graph.meta.root);
    const direct = new Set(known);
    if (direct.has(withoutRoot))
        return [withoutRoot];
    const tail = withoutRoot.replace(/^\/+/, '');
    if (direct.has(tail))
        return [tail];
    const hits = known.filter((path) => path === tail || path.endsWith(`/${tail}`));
    if (hits.length > 0)
        return dedupe(hits);
    // A bundled or aliased frame may only agree with the repo on the last segment or
    // two. Walk in from the left until something matches, so the longest agreement wins.
    const parts = tail.split('/').filter(Boolean);
    for (let start = 1; start < parts.length; start++) {
        const suffix = parts.slice(start).join('/');
        const found = known.filter((path) => path === suffix || path.endsWith(`/${suffix}`));
        if (found.length > 0)
            return dedupe(found);
    }
    return [];
}
function stripRoot(path, root) {
    const normalRoot = root.replace(/\\/g, '/').replace(/\/+$/, '');
    if (normalRoot && path.startsWith(`${normalRoot}/`))
        return path.slice(normalRoot.length + 1);
    return path;
}
function dedupe(values) {
    return [...new Set(values)].sort();
}
// ---------------------------------------------------------------------------
// When the whole trace is somebody else's code
// ---------------------------------------------------------------------------
/**
 * The package a vendored path is inside, or null when its layout does not say.
 *
 * Only the three ecosystems whose import specifiers this can be matched against are
 * read. A CocoaPod or a crate would parse just as easily and then match nothing, and a
 * package name with nowhere to look it up is worse than saying nothing at all.
 */
export function packageAt(cleaned) {
    // The *last* `node_modules` is the one that counts: a nested copy means the frame is
    // inside the nested package, not inside whatever vendored it.
    const npm = cleaned.lastIndexOf('node_modules/');
    if (npm !== -1)
        return npmPackage(cleaned.slice(npm + 'node_modules/'.length));
    for (const mark of ['site-packages/', 'dist-packages/']) {
        const at = cleaned.lastIndexOf(mark);
        if (at !== -1) {
            const first = cleaned.slice(at + mark.length).split('/').filter(Boolean)[0];
            // A flat module is a whole distribution: `site-packages/six.py` is `six`.
            return first ? first.replace(/\.py$/, '') : null;
        }
    }
    const gomod = cleaned.lastIndexOf('go/pkg/mod/');
    if (gomod !== -1)
        return goModule(cleaned.slice(gomod + 'go/pkg/mod/'.length));
    return null;
}
function npmPackage(rest) {
    const parts = rest.split('/').filter(Boolean);
    if (parts.length === 0)
        return null;
    if (!parts[0].startsWith('@'))
        return parts[0];
    return parts.length > 1 ? `${parts[0]}/${parts[1]}` : null;
}
/**
 * A module path out of the Go module cache: everything up to the segment carrying the
 * version, with the version dropped and the cache's escaping undone. The cache spells a
 * capital letter `!x`, because not every filesystem tells `A` and `a` apart.
 */
function goModule(rest) {
    const parts = rest.split('/').filter(Boolean);
    const versioned = parts.findIndex((part) => part.includes('@'));
    if (versioned === -1)
        return null;
    const path = [...parts.slice(0, versioned), parts[versioned].slice(0, parts[versioned].indexOf('@'))];
    const joined = path.join('/').replace(/!([a-z])/g, (_, letter) => letter.toUpperCase());
    return joined || null;
}
/** How many importing files to name before the rest become a count. */
const MAX_IMPORTERS_SHOWN = 8;
/**
 * Past this many importers, no file is named at all.
 *
 * Dogfooding decided this number. A React Native trace in a real app came back with the
 * first eight of a hundred and eighteen files that import `react-native` — alphabetical,
 * so the list began inside a `backup/` folder — and every one of them was a file the
 * reader would have to rule out by hand. Eight arbitrary names read as eight suspects.
 * A framework everything imports genuinely is not narrowed down by the trace, and the
 * count on its own says that without pretending otherwise.
 */
const TOO_MANY_IMPORTERS = 12;
/**
 * Answer "which of my own code reaches for that library" for a trace with nothing of the
 * reader's in it.
 *
 * Works outwards from the innermost frame, because a stack that passes through three
 * libraries died in the first one. The first frame naming a package that anything here
 * imports wins; if none of them do, the innermost readable package is still reported
 * with no importers, so the reader is told which library it was rather than nothing.
 */
function reachIntoDependency(graph, placed, installed) {
    const named = placed
        .filter((found) => found.reason === 'dependency')
        .map((found) => ({ frame: found.frame, packageName: packageAt(cleanPath(found.frame.rawPath)) }))
        .filter((entry) => entry.packageName !== null);
    if (named.length === 0)
        return null;
    const doorsById = doorIndex(graph);
    const imported = importedPackages(graph);
    // Two passes on purpose. A frame whose package this project imports outright is a
    // better answer than one reached through a parent, wherever in the stack it sits, so
    // every frame is tried the direct way before any of them is tried the indirect way.
    for (const entry of named) {
        const files = importersOf(graph, entry.packageName);
        if (files.length > 0)
            return assemble(graph, entry, null, files, doorsById);
    }
    for (const entry of named) {
        const parent = installed.dependents(entry.packageName, imported)[0];
        if (!parent)
            continue;
        const files = importersOf(graph, parent);
        if (files.length > 0)
            return assemble(graph, entry, parent, files, doorsById);
    }
    return { packageName: named[0].packageName, frame: named[0].frame, via: null, importers: [], total: 0 };
}
/**
 * Turn a package and the files importing it into the answer.
 *
 * Files a way in can reach are listed first, because a file nothing can reach is less
 * likely to have been running when the trace was taken — the only ordering here with a
 * reason behind it. Doors are worked out for the listed files alone: it is a graph walk
 * per declaration, and a hundred importers would pay for it without anything to show.
 */
function assemble(graph, entry, via, files, doorsById) {
    const listed = files.length > TOO_MANY_IMPORTERS
        ? []
        : files
            .map((file) => ({
            nodeId: file.id,
            path: file.path ?? '',
            doors: doorsReachingFile(graph, file, doorsById),
        }))
            .sort((a, b) => b.doors.length - a.doors.length || a.path.localeCompare(b.path))
            .slice(0, MAX_IMPORTERS_SHOWN);
    return { packageName: entry.packageName, frame: entry.frame, via, importers: listed, total: files.length };
}
/** Every package anything in this project imports — the only names a parent may be. */
function importedPackages(graph) {
    const out = new Set();
    for (const node of graph.nodesOfKind('file')) {
        const imports = node.meta?.externalImports;
        for (const name of imports ?? [])
            out.add(name);
    }
    return [...out].sort();
}
/**
 * Every way in that can reach anything declared in one file.
 *
 * Asked of the file *and* each of its declarations, because a reference edge lands on the
 * function it names rather than on the file around it — walking back from the file node
 * alone finds nothing and would report a thoroughly reachable module as reachable by
 * nobody. Nearest first, and a door found by two declarations is listed once, by its
 * shortest chain.
 *
 * Crossing `imports` as well is the other half of the same problem, and a real app found
 * it: `lib/supabase.js` exports a client and declares no functions, so it has no
 * declarations to ask about and nothing references it. Four screens import it, and the
 * answer on screen was "no way in reaches this file" — a confident negative about a
 * module the whole app runs through.
 */
function doorsReachingFile(graph, file, index) {
    const best = new Map();
    for (const target of [file, ...graph.childrenOf(file.id)]) {
        if (target !== file && target.kind !== 'function')
            continue;
        for (const reach of doorsReaching(graph, target.id, index, REFERENCES_AND_IMPORTS).doors) {
            const held = best.get(reach.door.id);
            if (!held || reach.hops < held.hops)
                best.set(reach.door.id, reach);
        }
    }
    return [...best.values()].sort((a, b) => a.hops - b.hops || rank(b.confidence) - rank(a.confidence) || a.door.name.localeCompare(b.door.name));
}
/**
 * Files importing a package, or a path inside it. The subpath match is what makes a Go
 * frame in `gin` findable from a file that imports `gin/binding`, and costs nothing on
 * the ecosystems that record the bare package name anyway.
 */
function importersOf(graph, packageName) {
    const prefix = `${packageName}/`;
    return graph
        .nodesOfKind('file')
        .filter((node) => {
        const imports = node.meta?.externalImports;
        return !!imports && imports.some((name) => name === packageName || name.startsWith(prefix));
    })
        .sort((a, b) => (a.path ?? '').localeCompare(b.path ?? ''));
}
// ---------------------------------------------------------------------------
// Walking back to the doors
// ---------------------------------------------------------------------------
/**
 * Every way in that can reach one piece of code, with the chain that proves it.
 *
 * Backwards along the same `references` edges the forward view follows, collecting a
 * door wherever one is attached to something on the way. All of them are returned,
 * nearest first: when four screens can reach the failing function, saying so is the
 * answer, and choosing one of them would be inventing a fact the code does not have.
 *
 * @param through Which edges the walk may cross. `references` alone for a stack frame,
 *   which asks about one function. A file-level question wants `imports` too — see
 *   `doorsReachingFile` for why leaving it out reported an unreachable module.
 */
export function doorsReaching(graph, targetId, index, through = REFERENCES_ONLY) {
    const doorsById = index ?? doorIndex(graph);
    const cameFrom = new Map();
    const weakest = new Map([[targetId, 'certain']]);
    const seen = new Set([targetId]);
    const found = new Map();
    let frontier = [targetId];
    let truncated = false;
    for (let hop = 0; hop <= MAX_BACK_HOPS && frontier.length > 0; hop++) {
        for (const id of frontier)
            collectDoors(graph, id, doorsById, found, cameFrom, weakest, targetId);
        const next = [];
        for (const id of frontier) {
            for (const edge of graph.edgesTo(id)) {
                if (!through.has(edge.kind) || seen.has(edge.fromId))
                    continue;
                const source = graph.getNodeById(edge.fromId);
                if (!source || (source.kind !== 'function' && source.kind !== 'file'))
                    continue;
                if (seen.size >= MAX_BACK_VISITED) {
                    truncated = true;
                    break;
                }
                seen.add(edge.fromId);
                cameFrom.set(edge.fromId, id);
                weakest.set(edge.fromId, weaker(weakest.get(id) ?? 'certain', edge.confidence));
                next.push(edge.fromId);
                // An `imports` edge joins two files, but a door hangs off the function inside
                // one — a screen is `exposed-by` `FeedbackScreen`, not by `feedback.js`. So
                // stepping into a file across an import also brings in what it declares, or the
                // walk arrives one node short of every door and reports none. Sound because the
                // import runs at module scope: loading anything in that file evaluates the
                // module this walk started from, whichever declaration was the entry.
                if (edge.kind !== 'imports' || source.kind !== 'file')
                    continue;
                for (const child of graph.childrenOf(edge.fromId)) {
                    if (child.kind !== 'function' || seen.has(child.id))
                        continue;
                    seen.add(child.id);
                    cameFrom.set(child.id, edge.fromId);
                    weakest.set(child.id, weakest.get(edge.fromId) ?? 'certain');
                    next.push(child.id);
                }
            }
        }
        frontier = next;
    }
    const doors = [...found.values()].sort((a, b) => a.hops - b.hops || rank(b.confidence) - rank(a.confidence) || a.door.name.localeCompare(b.door.name));
    return { doors, truncated };
}
function collectDoors(graph, id, doorsById, found, cameFrom, weakest, targetId) {
    for (const edge of graph.edgesTo(id)) {
        if (edge.kind !== 'exposed-by')
            continue;
        const door = doorsById.get(edge.fromId);
        if (!door || found.has(door.id))
            continue;
        // An exported name is a door *and* the function it stands for, so listing both puts
        // the same code on the chain twice — `HomeScreen → HomeScreen → index.js`. A route
        // door is not the same code as its handler (`/api/users` → `POST`) and both steps
        // earn their place, which is why this is a match on the code rather than on the kind.
        const walked = pathBack(cameFrom, id, targetId);
        const exposed = graph.getNodeById(id);
        const doubled = exposed?.name === door.name && exposed?.path === door.path;
        const chain = [door.id, ...(doubled ? walked.slice(1) : walked)];
        found.set(door.id, {
            door,
            via: chain,
            viaNames: nameChain(graph, chain),
            hops: chain.length - 1,
            confidence: weaker(weakest.get(id) ?? 'certain', edge.confidence),
        });
    }
}
/**
 * Name each step of a chain, keeping two steps apart when their names are not.
 *
 * A real app produced `/cellar → CellarScreen → cellar.js → cellar.js → supabase.js`.
 * Those are two different files — `app/(tabs)/cellar.js` and `lib/cellar.js` — and a
 * name repeated back to back reads as a bug in the tool rather than as two files that
 * happen to share a basename. Only the ambiguous steps grow a parent directory, because
 * lengthening every step to be safe would cost every chain its readability to fix the
 * few that need it.
 */
function nameChain(graph, chain) {
    const nodes = chain.map((step) => graph.getNodeById(step));
    const names = nodes.map((node, index) => node?.name ?? chain[index]);
    const seen = new Map();
    for (const name of names)
        seen.set(name, (seen.get(name) ?? 0) + 1);
    return names.map((name, index) => {
        if ((seen.get(name) ?? 0) < 2)
            return name;
        const path = nodes[index]?.path;
        if (!path)
            return name;
        const parts = path.split('/');
        return parts.length > 1 ? parts.slice(-2).join('/') : name;
    });
}
/** The route the walk took to get here, read back the way a reader would follow it. */
function pathBack(cameFrom, from, target) {
    const chain = [from];
    let at = from;
    while (at !== target) {
        const next = cameFrom.get(at);
        if (!next || chain.includes(next))
            break;
        chain.push(next);
        at = next;
    }
    return chain;
}
function weaker(a, b) {
    return rank(a) <= rank(b) ? a : b;
}
function rank(value) {
    return value === 'certain' ? 2 : value === 'likely' ? 1 : 0;
}
//# sourceMappingURL=errortrace.js.map