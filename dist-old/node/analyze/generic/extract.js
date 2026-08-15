import { loadQuery, parseSource } from './runtime.js';
/** Files past this size are skipped rather than parsed. Generated code, usually. */
const MAX_BYTES = 2_000_000;
export async function extractFile(dialect, relPath, source) {
    const file = {
        path: relPath,
        language: dialect.id,
        ok: false,
        error: null,
        doc: null,
        loc: source.split(/\r?\n/).length,
        namespace: null,
        imports: [],
        defs: [],
        calls: [],
        bindings: [],
        constants: [],
        uses: [],
        qualifiedUses: [],
        hasErrors: false,
    };
    if (source.length > MAX_BYTES) {
        file.error = `it is ${Math.round(source.length / 1_000_000)} MB, past the ${MAX_BYTES / 1_000_000} MB the parser will take`;
        return file;
    }
    let parsed;
    try {
        parsed = await parseSource(dialect.id, source);
    }
    catch (err) {
        file.error = err.message;
        return file;
    }
    if (!parsed) {
        file.error = 'the parser returned no tree for it';
        return file;
    }
    try {
        const query = await loadQuery(dialect.id);
        read(file, dialect, query.matches(parsed.root), parsed.root, source);
        // Declared on `Dialect` since the tier was built and wired when C# arrived — the
        // first language whose visibility is a keyword the query vocabulary has no capture
        // for. Runs last, over a file that is otherwise finished, so a dialect can correct
        // what it knows better rather than having to express it in `.scm`.
        dialect.finish?.(file, parsed.root, source);
        file.ok = true;
        file.hasErrors = parsed.root.hasError;
    }
    catch (err) {
        file.error = err.message;
    }
    finally {
        parsed.tree.delete();
    }
    return file;
}
// ---------------------------------------------------------------------------
// Reading the matches
// ---------------------------------------------------------------------------
function read(file, dialect, matches, root, source) {
    // Definitions first and everything else second: the rest of this function answers
    // "which definition is this inside", and it cannot until they all exist.
    const defs = [];
    const rest = [];
    for (const match of matches) {
        const caps = capturesOf(match);
        const func = caps.get('def.func');
        const type = caps.get('def.type');
        if (func) {
            const name = caps.get('def.func.name');
            if (name)
                defs.push(newDef('function', func, name, caps.get('def.func.owner'), caps.get('def.func.returns'), dialect));
            continue;
        }
        if (type) {
            const name = caps.get('def.type.name');
            if (name)
                defs.push(newDef('type', type, name, null, null, dialect));
            continue;
        }
        if (caps.has('namespace')) {
            file.namespace = caps.get('namespace').text;
            continue;
        }
        rest.push(match);
    }
    // Two definitions can share a start when a query matches the same node twice; the
    // wider one wins so that containment still reads innermost-last.
    defs.sort((a, b) => a.startIndex - b.startIndex || b.endIndex - a.endIndex);
    file.defs = defs;
    const enclosing = new Ranges(defs);
    for (const match of rest) {
        const caps = capturesOf(match);
        const param = caps.get('def.param');
        if (param) {
            const owner = enclosing.at(param.startIndex);
            const name = caps.get('def.param.name');
            const type = caps.get('def.param.type');
            if (owner && name)
                owner.params.push({ name: name.text, type: type ? collapse(type.text) : '' });
            continue;
        }
        const field = caps.get('def.field');
        if (field) {
            const owner = enclosing.at(field.startIndex);
            const name = caps.get('def.field.name');
            const type = caps.get('def.field.type');
            if (owner && name) {
                owner.fields.push({ name: name.text, type: type ? collapse(type.text) : '', exported: dialect.exported(name.text) });
            }
            continue;
        }
        const imported = caps.get('import');
        if (imported) {
            const pathNode = caps.get('import.path');
            if (!pathNode)
                continue;
            const module = dialect.unquote(pathNode.text);
            const alias = caps.get('import.alias')?.text ?? null;
            file.imports.push({ module, alias, local: alias ?? dialect.localName(module), line: lineOf(imported) });
            continue;
        }
        const call = caps.get('call');
        if (call) {
            const fn = caps.get('call.fn');
            if (!fn)
                continue;
            const callee = collapse(fn.text);
            const dot = callee.lastIndexOf('.');
            file.calls.push({
                callee,
                method: dot === -1 ? callee : callee.slice(dot + 1),
                receiver: dot === -1 ? null : callee.slice(0, dot),
                args: argsOf(caps.get('call.args'), dialect),
                line: lineOf(call),
                scope: scopeName(enclosing.at(call.startIndex)),
                startIndex: call.startIndex,
                endIndex: call.endIndex,
            });
            continue;
        }
        const bind = caps.get('bind');
        if (bind) {
            appendBindings(file, dialect, bind, caps.get('bind.name'), caps.get('bind.value'), enclosing);
            continue;
        }
        const constName = caps.get('const.name');
        const constValue = caps.get('const.value');
        if (constName && constValue) {
            file.constants.push({ name: constName.text, value: dialect.unquote(constValue.text), line: lineOf(constName) });
        }
    }
    attachDocs(file, dialect, root);
    attachUses(file, dialect, root, enclosing);
}
/**
 * One match's captures, last one wins.
 *
 * An optional capture that did not match is simply absent, which is what makes
 * `(package_identifier)? @import.alias` work: the same pattern covers `import "net/http"`
 * and `import mw "…/middleware"` without two nearly identical rules that would both fire
 * on the aliased one.
 */
function capturesOf(match) {
    const out = new Map();
    for (const capture of match.captures)
        out.set(capture.name, capture.node);
    return out;
}
function newDef(kind, node, name, owner, returns, dialect) {
    return {
        kind,
        name: name.text,
        owner: owner?.text ?? null,
        line: lineOf(node),
        endLine: node.endPosition.row + 1,
        startIndex: node.startIndex,
        endIndex: node.endIndex,
        doc: null,
        params: [],
        returns: returns ? collapse(returns.text) : '',
        exported: dialect.exported(name.text),
        decorators: [],
        bases: [],
        fields: [],
        uses: [],
        qualifiedUses: [],
    };
}
/**
 * A binding is `name = value`, but half the languages that have it also let you write
 * `a, b := f()`. Both sides are flattened and paired up positionally; when the counts
 * disagree — which is what a multiple-return call looks like — every name is recorded
 * against the one value, because `rows, err := db.Query(sql)` really does mean that
 * `rows` came out of a query.
 */
function appendBindings(file, dialect, bind, nameNode, valueNode, enclosing) {
    if (!nameNode || !valueNode)
        return;
    const names = flatten(nameNode);
    const values = flatten(valueNode);
    if (names.length === 0 || values.length === 0)
        return;
    const line = lineOf(bind);
    const scope = scopeName(enclosing.at(bind.startIndex));
    for (let i = 0; i < names.length; i++) {
        const name = names[i];
        if (name.text === '_')
            continue;
        const value = values.length === names.length ? values[i] : values[0];
        const callee = calleeOf(value, dialect);
        file.bindings.push({
            name: name.text,
            callee,
            arg: firstStringArg(value, dialect),
            line,
            scope,
        });
    }
}
/** An `expression_list` and friends stand in for their children; anything else is itself. */
function flatten(node) {
    return node.type.endsWith('_list') ? node.namedChildren.filter((n) => Boolean(n)) : [node];
}
/**
 * The dotted callee of an expression, when the expression is a call. `chi.NewRouter()`
 * gives `chi.NewRouter`; `&Server{}` gives nothing, and nothing is the honest answer.
 */
function calleeOf(node, dialect) {
    const call = dialect.calls.has(node.type) ? node : node.descendantsOfType([...dialect.calls])[0];
    if (!call)
        return '';
    const fn = call.childForFieldName('function') ?? call.namedChildren[0];
    return fn ? collapse(fn.text) : '';
}
function firstStringArg(node, dialect) {
    for (const type of dialect.strings) {
        const found = node.descendantsOfType(type)[0];
        if (found)
            return dialect.unquote(found.text);
    }
    return null;
}
/**
 * Sees through a node that exists only to hold one other node.
 *
 * C# is the reason: `[HttpGet("{id}")]` puts an `attribute_argument` around its string,
 * so an argument list that plainly holds a route template reads as one unknown thing.
 * Written as a general rule rather than a C# special case because every grammar has a
 * few of these — a parenthesised expression is the same shape — and "an argument that is
 * a wrapper around one expression *is* that expression" is true in all of them.
 *
 * Bounded, and it never unwraps a node the dialect has already named: a string literal
 * with one child is a string literal, not whatever is inside it.
 */
function unwrap(node, dialect) {
    let current = node;
    for (let depth = 0; depth < 3; depth++) {
        if (dialect.strings.has(current.type) || dialect.numbers.has(current.type))
            return current;
        if (dialect.names.has(current.type) || dialect.functions.has(current.type))
            return current;
        if (current.namedChildCount !== 1)
            return current;
        const only = current.namedChild(0);
        if (!only)
            return current;
        current = only;
    }
    return current;
}
function argsOf(list, dialect) {
    if (!list)
        return [];
    const out = [];
    for (const raw of list.namedChildren) {
        if (!raw)
            continue;
        const arg = unwrap(raw, dialect);
        if (dialect.strings.has(arg.type))
            out.push({ t: 'str', v: dialect.unquote(arg.text) });
        else if (dialect.numbers.has(arg.type))
            out.push({ t: 'num', v: arg.text });
        else if (dialect.functions.has(arg.type)) {
            out.push({
                t: 'func',
                startIndex: arg.startIndex,
                endIndex: arg.endIndex,
                line: lineOf(arg),
                endLine: arg.endPosition.row + 1,
            });
        }
        else if (dialect.names.has(arg.type))
            out.push({ t: 'name', v: collapse(arg.text) });
        else if (dialect.calls.has(arg.type)) {
            const callee = calleeOf(arg, dialect);
            out.push(callee ? { t: 'call', v: callee } : { t: 'other' });
        }
        else
            out.push({ t: 'other' });
    }
    return out;
}
// ---------------------------------------------------------------------------
// Documentation and identifiers
// ---------------------------------------------------------------------------
/**
 * The comment block sitting immediately above each definition, and the one at the very
 * top of the file.
 *
 * "Immediately above" means the comment ends on the line before the definition starts,
 * with no blank line between. Everybody's convention, and the only way to tell a
 * docstring from a note about the code twenty lines up.
 */
function attachDocs(file, dialect, root) {
    // Every comment in the file, not only the ones at the top level.
    //
    // Go declares everything at the top level, so the cheaper walk was right for as long
    // as Go was the only language here. C# puts every method and property *inside* a class
    // body, and its `/// <summary>` with them — which read top-level-only meant 0 of 1161
    // functions in a real 209-file desktop app had a description, in a repo where 151
    // files are documented.
    //
    // Collecting more comments cannot attach a wrong one: a doc is still only the block
    // whose last line sits immediately above the declaration.
    const commentTypes = new Set(Array.isArray(dialect.comment) ? dialect.comment : [dialect.comment]);
    const comments = root.descendantsOfType([...commentTypes]);
    if (comments.length === 0 && file.defs.length === 0)
        return;
    // A node that ends at column 0 really ended on the line before — tree-sitter-rust's
    // comments swallow their trailing newline, which put every one of them "ending" on
    // the line of the thing below and made no doc in the language ever attach.
    const byEndLine = new Map();
    for (const comment of comments) {
        const endLine = comment.endPosition.column === 0 ? comment.endPosition.row : comment.endPosition.row + 1;
        byEndLine.set(endLine, comment);
    }
    /** Walks up through contiguous comment lines and joins them. */
    const blockAbove = (line) => {
        const parts = [];
        for (let above = line - 1; byEndLine.has(above); above = byEndLine.get(above).startPosition.row) {
            const comment = byEndLine.get(above);
            parts.unshift(...comment.text.split(/\r?\n/).map((l) => dialect.uncomment(l)));
        }
        const text = parts.join(' ').replace(/\s+/g, ' ').trim();
        return text ? text : null;
    };
    for (const def of file.defs)
        def.doc = blockAbove(def.line);
    // The file's own doc is the block above whatever it declares first — a Go package
    // clause, an import, a function. Anything lower down is a comment about that thing.
    const first = root.namedChildren.find((n) => Boolean(n) && !commentTypes.has(n.type));
    if (first)
        file.doc = blockAbove(first.startPosition.row + 1);
}
/**
 * Which names each definition mentions, and which the file mentions outside any of them.
 *
 * Bare identifiers only. `s.ListOrders` is a useful thing to hand a router and a useless
 * thing to look up in a table of declarations, and the reference pass is a table lookup.
 */
function attachUses(file, dialect, root, enclosing) {
    collect(file, root, enclosing, [...dialect.identifiers], (def, names) => (def.uses = names), (names) => (file.uses = names));
    collect(file, root, enclosing, [...dialect.qualified], (def, names) => (def.qualifiedUses = names), (names) => (file.qualifiedUses = names));
}
/**
 * Every name of the given node types, filed under whichever definition contains it.
 *
 * Nested dotted names are left in rather than deduplicated: `s.db.Query` yields both
 * itself and `s.db`, and neither has an import in front of it, so both are dropped at
 * resolution time. Filtering here would mean deciding what a dotted name means, which is
 * the one thing this file is not allowed to know.
 */
function collect(file, root, enclosing, types, onDef, onFile) {
    if (types.length === 0)
        return;
    const atFile = new Set();
    const perDef = new Map();
    for (const node of root.descendantsOfType(types)) {
        if (!node)
            continue;
        const name = collapse(node.text);
        if (!name || name === '_')
            continue;
        const owner = enclosing.at(node.startIndex);
        if (!owner) {
            atFile.add(name);
            continue;
        }
        let set = perDef.get(owner);
        if (!set)
            perDef.set(owner, (set = new Set()));
        set.add(name);
    }
    for (const def of file.defs) {
        const set = perDef.get(def);
        if (!set)
            continue;
        // A definition naming itself is not a reference to anything.
        set.delete(def.name);
        onDef(def, [...set].sort());
    }
    onFile([...atFile].sort());
}
// ---------------------------------------------------------------------------
// Containment
// ---------------------------------------------------------------------------
/**
 * Which definition a character offset falls inside, innermost first.
 *
 * Definitions are sorted by where they start, so the innermost one containing a position
 * is the last one to have started before it. That holds for every language whose
 * declarations nest properly, which is all of them.
 */
class Ranges {
    defs;
    constructor(defs) {
        this.defs = defs;
    }
    at(index) {
        let lo = 0;
        let hi = this.defs.length - 1;
        let found = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (this.defs[mid].startIndex <= index) {
                found = mid;
                lo = mid + 1;
            }
            else
                hi = mid - 1;
        }
        for (let i = found; i >= 0; i--) {
            const def = this.defs[i];
            if (def.endIndex >= index)
                return def;
        }
        return null;
    }
}
/** The name the rest of the pipeline knows a definition by: `Server.ListOrders`. */
export function scopeName(def) {
    if (!def)
        return null;
    return def.owner ? `${def.owner}.${def.name}` : def.name;
}
// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------
/** `http.\n  HandleFunc` and `http.HandleFunc` are the same callee. */
function collapse(text) {
    return text.replace(/\s+/g, '');
}
function lineOf(node) {
    return node.startPosition.row + 1;
}
//# sourceMappingURL=extract.js.map