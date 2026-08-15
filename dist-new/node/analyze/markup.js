/**
 * @fileoverview XAML, and the screens a desktop app is made of (#103).
 *
 * A WinUI or WPF window is *instantiated by its markup*. `<Window x:Class="…">` names a
 * `partial class` whose other half is the `.xaml.cs` beside it, and nothing in any C#
 * file ever constructs it — so a map built from the code alone shows an application
 * whose own windows are reached by nothing, and reports **0 ways in** for a program
 * whose entire purpose is a dashboard somebody opens.
 *
 * Read as a config file rather than as a language, on the same reasoning as
 * `wrangler.ts` and `compose.ts`: the useful content is four attributes, and the
 * findings it produces are ones the merge layer already understands. There is a
 * tree-sitter grammar for XAML and it would give the whole document; the whole document
 * is not what is missing.
 *
 * What is deliberately *not* claimed: a `UserControl` is a component and not a screen, a
 * `ResourceDictionary` is styling, and a binding that names a property is recorded as a
 * mention rather than as a guarantee that the property exists.
 */
import fs from 'node:fs';
import path from 'node:path';
import { makeEdgeId, makeFileId } from '../model/types.js';
import { hashParts, hashText } from '../util/hash.js';
/** Root elements that are a thing a person looks at, and the ones that are not. */
const SCREEN_ROOTS = new Set(['Window', 'Page', 'ContentDialog', 'NavigationPage', 'Shell', 'Form']);
/**
 * Attributes whose value is a method in the code-behind.
 *
 * Matched by the shape of the name rather than a list, because every control in every
 * toolkit invents its own events — `SelectionChanged`, `ItemClick`, `PointerEntered`,
 * `RangeChanged`. What they share is a value that is a bare method name, which is the
 * test that matters: a binding is `{…}` and a literal is not a C# identifier.
 */
const HANDLER_VALUE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Attributes that are never a handler however their value looks. */
const NOT_A_HANDLER = new Set([
    'x:Class', 'x:Name', 'x:Key', 'x:Uid', 'Name', 'Title', 'Text', 'Content', 'Header',
    'Tag', 'Style', 'Foreground', 'Background', 'Glyph', 'Symbol', 'Icon', 'Source',
    'PaneDisplayMode', 'Orientation', 'Visibility', 'HorizontalAlignment', 'VerticalAlignment',
    'TargetType', 'Property', 'Value', 'Path', 'ElementName', 'Mode', 'Placement',
]);
/** Files past this size are skipped. A XAML file this big is generated. */
const MAX_BYTES = 1_000_000;
/** How many markup files to read. A repo past this is not a desktop app. */
const MAX_FILES = 500;
export function readMarkupFiles(root, relPaths) {
    const out = [];
    for (const relPath of relPaths.slice(0, MAX_FILES)) {
        let text;
        try {
            const stat = fs.statSync(path.join(root, relPath));
            if (stat.size > MAX_BYTES)
                continue;
            text = fs.readFileSync(path.join(root, relPath), 'utf8');
        }
        catch {
            continue;
        }
        const read = readMarkup(relPath, text);
        if (read)
            out.push(read);
    }
    return out;
}
/** Everything worth having out of one XAML document. */
export function readMarkup(relPath, text) {
    // The first element that is not a processing instruction or a comment.
    const withoutComments = text.replace(/<!--[\s\S]*?-->/g, ' ');
    const rootMatch = /<([A-Za-z_][\w.]*(?::[A-Za-z_][\w.]*)?)[\s>]/.exec(withoutComments.replace(/<\?[\s\S]*?\?>/g, ' '));
    if (!rootMatch)
        return null;
    const root = rootMatch[1].includes(':') ? rootMatch[1].slice(rootMatch[1].indexOf(':') + 1) : rootMatch[1];
    const className = /\bx:Class\s*=\s*"([^"]+)"/.exec(text)?.[1] ?? null;
    const handlers = [];
    for (const match of text.matchAll(/\b([A-Za-z_][\w:.]*)\s*=\s*"([^"{}]*)"/g)) {
        const [, attribute, value] = match;
        if (NOT_A_HANDLER.has(attribute) || attribute.startsWith('xmlns'))
            continue;
        if (!HANDLER_VALUE.test(value))
            continue;
        // A handler is a method, and every convention in .NET writes one with a capital.
        // A lowercase value here is a keyword — `Auto`, `Stretch`, `Collapsed` — of which
        // there are hundreds and none of them is code.
        if (!/^[A-Z]/.test(value))
            continue;
        if (!handlers.includes(value))
            handlers.push(value);
    }
    const bindings = [];
    for (const match of text.matchAll(/\{(?:x:Bind|Binding)\s+([A-Za-z_][\w.]*)/g)) {
        const name = match[1].split('.')[0];
        if (name && !bindings.includes(name))
            bindings.push(name);
    }
    const comment = /<!--([\s\S]*?)-->/.exec(text)?.[1] ?? null;
    const doc = comment ? comment.replace(/\s+/g, ' ').trim() : null;
    return {
        path: relPath,
        className,
        root,
        isScreen: SCREEN_ROOTS.has(root),
        handlers,
        bindings,
        doc: doc && doc.length > 0 ? doc : null,
        loc: text.split(/\r?\n/).length,
    };
}
/**
 * The screen's name, as a reader would say it.
 *
 * `Glance.App.Dashboard.WeekPage` is a namespace and a class; the class is the thing
 * somebody opens and the namespace is where it lives.
 */
export function screenName(file) {
    if (file.className)
        return file.className.slice(file.className.lastIndexOf('.') + 1);
    return path.posix.basename(file.path).replace(/\.[^.]+$/, '');
}
/** The namespace half of an `x:Class`, for matching it to the file that declares it. */
export function classNamespace(className) {
    const dot = className.lastIndexOf('.');
    return dot === -1 ? '' : className.slice(0, dot);
}
// ---------------------------------------------------------------------------
// Into the atlas
// ---------------------------------------------------------------------------
/**
 * Markup files as nodes, and the edges that connect them to the code they complete.
 *
 * Runs after the language plugins, because every edge here points at something they
 * declared: the `partial class` half of a window, and the methods its buttons call.
 */
export function buildMarkupNodes(files, code) {
    if (files.length === 0)
        return { nodes: [], edges: [], findings: [], filePaths: [] };
    // `x:Class` is a namespace and a class name, and a C# file records the namespace it
    // declares — so the pair identifies the code-behind exactly, without matching on the
    // filename convention that usually but not always holds.
    const namespaceOfFile = new Map();
    for (const node of code) {
        if (node.kind === 'file' && node.path && typeof node.meta.namespace === 'string') {
            namespaceOfFile.set(node.path, node.meta.namespace);
        }
    }
    const typeAt = new Map();
    for (const node of code) {
        if (node.kind !== 'type' || !node.path)
            continue;
        const key = `${namespaceOfFile.get(node.path) ?? ''}.${node.name}`;
        if (!typeAt.has(key))
            typeAt.set(key, node);
    }
    const methodsOfOwner = new Map();
    for (const node of code) {
        if (node.kind !== 'function')
            continue;
        const owner = String(node.meta.ownerName ?? '');
        if (!owner)
            continue;
        const list = methodsOfOwner.get(owner);
        if (list)
            list.push(node);
        else
            methodsOfOwner.set(owner, [node]);
    }
    const nodes = [];
    const edges = [];
    const findings = [];
    for (const file of files) {
        const fileId = makeFileId(file.path);
        nodes.push(markupFileNode(file, fileId));
        const behind = file.className ? typeAt.get(file.className) : undefined;
        // The markup instantiates the class. This is the edge the whole file exists for:
        // without it the code-behind of every window in the app is reached by nothing.
        if (behind) {
            edges.push({
                id: makeEdgeId('references', fileId, behind.id),
                kind: 'references',
                fromId: fileId,
                toId: behind.id,
                weight: 1,
                // `x:Class` names the type outright and the compiler enforces the pairing.
                confidence: 'certain',
                provenance: 'static',
                meta: { via: 'x:Class' },
            });
        }
        // A method named by an event attribute is called by the framework and by nothing
        // else, which is exactly why it looks unreferenced without this.
        const behindMethods = behind ? (methodsOfOwner.get(behind.name) ?? []) : [];
        for (const handler of file.handlers) {
            const method = behindMethods.find((node) => node.name === handler);
            if (!method)
                continue;
            edges.push({
                id: makeEdgeId('references', fileId, method.id),
                kind: 'references',
                fromId: fileId,
                toId: method.id,
                weight: 1,
                provenance: 'static',
                // The attribute names a method on the class the markup completes, and one of
                // that class's methods has that name. Not resolved — the toolkit decides at run
                // time whether the signature fits — which is what `likely` is for.
                confidence: 'likely',
                meta: { via: 'event handler' },
            });
        }
        if (!file.isScreen)
            continue;
        findings.push({
            type: 'endpoint',
            endpointKind: 'screen',
            key: `screen ${file.className ?? file.path}`,
            name: screenName(file),
            method: null,
            route: null,
            framework: 'XAML',
            writes: false,
            guards: [],
            site: { path: file.path, line: 1, nodeId: fileId },
            handlerId: behind?.id ?? null,
        });
    }
    return { nodes, edges, findings, filePaths: files.map((file) => file.path) };
}
function markupFileNode(file, id) {
    const doc = file.doc;
    return {
        id,
        kind: 'file',
        name: path.posix.basename(file.path),
        label: null,
        parentId: null,
        language: 'xaml',
        path: file.path,
        startLine: 1,
        endLine: file.loc,
        // Markup is what a person looks at, whatever folder it sits in.
        zone: 'ui',
        summary: doc,
        summarySource: doc ? 'docs' : null,
        docHash: doc ? hashText(doc) : null,
        bodyHash: null,
        hash: hashParts('markup', file.path, file.root, String(file.handlers.length)),
        provenance: doc ? 'docs' : 'static',
        meta: {
            ext: '.xaml',
            loc: file.loc,
            externalImports: [],
            exportedNames: [],
            functionCount: 0,
            typeCount: 0,
            /** The root element, which is what says whether this is a screen. */
            markupRoot: file.root,
            ...(file.className ? { completes: file.className } : {}),
        },
    };
}
//# sourceMappingURL=markup.js.map