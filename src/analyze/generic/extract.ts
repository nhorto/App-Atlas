/**
 * @fileoverview One parse tree, one query, one flat record — for any language.
 *
 * This file never mentions a language. It knows a vocabulary of capture names, and a
 * `.scm` file per language says which pieces of that language's grammar answer to each
 * one. That is the whole seam: a new language costs a query file and a dialect, not an
 * analyzer.
 *
 * The capture vocabulary:
 *
 *   @def.func  @def.func.name  @def.func.owner  @def.func.returns
 *   @def.type  @def.type.name
 *   @def.param @def.param.name @def.param.type
 *   @def.field @def.field.name @def.field.type
 *   @import    @import.path    @import.alias
 *   @call      @call.fn        @call.args
 *   @bind      @bind.name      @bind.value
 *   @const     @const.name     @const.value
 *   @namespace
 *
 * Everything that needs to know *which definition something is inside* — a call's scope,
 * a struct's fields, the names a function mentions — is answered by character ranges
 * rather than by walking the tree, because containment is the one structural fact every
 * grammar spells the same way.
 */
import type { Node, QueryMatch } from 'web-tree-sitter';
import type { Dialect } from './dialect.js';
import type { GBinding, GCall, GConst, GDef, GField, GImport, GParam, GValue, GenericFile } from './ir.js';
import { loadQuery, parseSource } from './runtime.js';

/** Files past this size are skipped rather than parsed. Generated code, usually. */
const MAX_BYTES = 2_000_000;

export async function extractFile(dialect: Dialect, relPath: string, source: string): Promise<GenericFile> {
  const file: GenericFile = {
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
  } catch (err) {
    file.error = (err as Error).message;
    return file;
  }
  if (!parsed) {
    file.error = 'the parser returned no tree for it';
    return file;
  }

  try {
    const query = await loadQuery(dialect.id);
    read(file, dialect, query.matches(parsed.root), parsed.root, source);
    file.ok = true;
    file.hasErrors = parsed.root.hasError;
  } catch (err) {
    file.error = (err as Error).message;
  } finally {
    parsed.tree.delete();
  }

  return file;
}

// ---------------------------------------------------------------------------
// Reading the matches
// ---------------------------------------------------------------------------

function read(file: GenericFile, dialect: Dialect, matches: QueryMatch[], root: Node, source: string): void {
  // Definitions first and everything else second: the rest of this function answers
  // "which definition is this inside", and it cannot until they all exist.
  const defs: GDef[] = [];
  const rest: QueryMatch[] = [];

  for (const match of matches) {
    const caps = capturesOf(match);
    const func = caps.get('def.func');
    const type = caps.get('def.type');
    if (func) {
      const name = caps.get('def.func.name');
      if (name) defs.push(newDef('function', func, name, caps.get('def.func.owner'), caps.get('def.func.returns'), dialect));
      continue;
    }
    if (type) {
      const name = caps.get('def.type.name');
      if (name) defs.push(newDef('type', type, name, null, null, dialect));
      continue;
    }
    if (caps.has('namespace')) {
      file.namespace = caps.get('namespace')!.text;
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
      if (owner && name) owner.params.push({ name: name.text, type: type ? collapse(type.text) : '' });
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
      if (!pathNode) continue;
      const module = dialect.unquote(pathNode.text);
      const alias = caps.get('import.alias')?.text ?? null;
      file.imports.push({ module, alias, local: alias ?? dialect.localName(module), line: lineOf(imported) });
      continue;
    }

    const call = caps.get('call');
    if (call) {
      const fn = caps.get('call.fn');
      if (!fn) continue;
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
function capturesOf(match: QueryMatch): Map<string, Node> {
  const out = new Map<string, Node>();
  for (const capture of match.captures) out.set(capture.name, capture.node);
  return out;
}

function newDef(
  kind: GDef['kind'],
  node: Node,
  name: Node,
  owner: Node | null | undefined,
  returns: Node | null | undefined,
  dialect: Dialect,
): GDef {
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
    fields: [] as GField[],
    uses: [] as string[],
    qualifiedUses: [] as string[],
  };
}

/**
 * A binding is `name = value`, but half the languages that have it also let you write
 * `a, b := f()`. Both sides are flattened and paired up positionally; when the counts
 * disagree — which is what a multiple-return call looks like — every name is recorded
 * against the one value, because `rows, err := db.Query(sql)` really does mean that
 * `rows` came out of a query.
 */
function appendBindings(
  file: GenericFile,
  dialect: Dialect,
  bind: Node,
  nameNode: Node | undefined,
  valueNode: Node | undefined,
  enclosing: Ranges,
): void {
  if (!nameNode || !valueNode) return;
  const names = flatten(nameNode);
  const values = flatten(valueNode);
  if (names.length === 0 || values.length === 0) return;

  const line = lineOf(bind);
  const scope = scopeName(enclosing.at(bind.startIndex));
  for (let i = 0; i < names.length; i++) {
    const name = names[i]!;
    if (name.text === '_') continue;
    const value = values.length === names.length ? values[i]! : values[0]!;
    const callee = calleeOf(value);
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
function flatten(node: Node): Node[] {
  return node.type.endsWith('_list') ? node.namedChildren.filter((n): n is Node => Boolean(n)) : [node];
}

/**
 * The dotted callee of an expression, when the expression is a call. `chi.NewRouter()`
 * gives `chi.NewRouter`; `&Server{}` gives nothing, and nothing is the honest answer.
 */
function calleeOf(node: Node): string {
  const call = node.type.includes('call') ? node : node.descendantsOfType(['call_expression', 'call'])[0];
  if (!call) return '';
  const fn = call.childForFieldName('function') ?? call.namedChildren[0];
  return fn ? collapse(fn.text) : '';
}

function firstStringArg(node: Node, dialect: Dialect): string | null {
  for (const type of dialect.strings) {
    const found = node.descendantsOfType(type)[0];
    if (found) return dialect.unquote(found.text);
  }
  return null;
}

function argsOf(list: Node | undefined, dialect: Dialect): GValue[] {
  if (!list) return [];
  const out: GValue[] = [];
  for (const arg of list.namedChildren) {
    if (!arg) continue;
    if (dialect.strings.has(arg.type)) out.push({ t: 'str', v: dialect.unquote(arg.text) });
    else if (dialect.numbers.has(arg.type)) out.push({ t: 'num', v: arg.text });
    else if (dialect.functions.has(arg.type)) out.push({ t: 'func', startIndex: arg.startIndex, endIndex: arg.endIndex });
    else if (dialect.names.has(arg.type)) out.push({ t: 'name', v: collapse(arg.text) });
    else if (arg.type.includes('call')) {
      const callee = calleeOf(arg);
      out.push(callee ? { t: 'call', v: callee } : { t: 'other' });
    } else out.push({ t: 'other' });
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
function attachDocs(file: GenericFile, dialect: Dialect, root: Node): void {
  const comments = root.namedChildren.filter((n): n is Node => Boolean(n) && n.type === dialect.comment);
  if (comments.length === 0 && file.defs.length === 0) return;

  const byEndLine = new Map<number, Node>();
  for (const comment of comments) byEndLine.set(comment.endPosition.row + 1, comment);

  /** Walks up through contiguous comment lines and joins them. */
  const blockAbove = (line: number): string | null => {
    const parts: string[] = [];
    for (let above = line - 1; byEndLine.has(above); above = byEndLine.get(above)!.startPosition.row) {
      const comment = byEndLine.get(above)!;
      parts.unshift(...comment.text.split(/\r?\n/).map((l) => dialect.uncomment(l)));
    }
    const text = parts.join(' ').replace(/\s+/g, ' ').trim();
    return text ? text : null;
  };

  for (const def of file.defs) def.doc = blockAbove(def.line);

  // The file's own doc is the block above whatever it declares first — a Go package
  // clause, an import, a function. Anything lower down is a comment about that thing.
  const first = root.namedChildren.find((n) => Boolean(n) && n.type !== dialect.comment);
  if (first) file.doc = blockAbove(first.startPosition.row + 1);
}

/**
 * Which names each definition mentions, and which the file mentions outside any of them.
 *
 * Bare identifiers only. `s.ListOrders` is a useful thing to hand a router and a useless
 * thing to look up in a table of declarations, and the reference pass is a table lookup.
 */
function attachUses(file: GenericFile, dialect: Dialect, root: Node, enclosing: Ranges): void {
  collect(file, root, enclosing, [...dialect.identifiers], (def, names) => (def.uses = names), (names) => (file.uses = names));
  collect(
    file,
    root,
    enclosing,
    [...dialect.qualified],
    (def, names) => (def.qualifiedUses = names),
    (names) => (file.qualifiedUses = names),
  );
}

/**
 * Every name of the given node types, filed under whichever definition contains it.
 *
 * Nested dotted names are left in rather than deduplicated: `s.db.Query` yields both
 * itself and `s.db`, and neither has an import in front of it, so both are dropped at
 * resolution time. Filtering here would mean deciding what a dotted name means, which is
 * the one thing this file is not allowed to know.
 */
function collect(
  file: GenericFile,
  root: Node,
  enclosing: Ranges,
  types: string[],
  onDef: (def: GDef, names: string[]) => void,
  onFile: (names: string[]) => void,
): void {
  if (types.length === 0) return;
  const atFile = new Set<string>();
  const perDef = new Map<GDef, Set<string>>();

  for (const node of root.descendantsOfType(types)) {
    if (!node) continue;
    const name = collapse(node.text);
    if (!name || name === '_') continue;
    const owner = enclosing.at(node.startIndex);
    if (!owner) {
      atFile.add(name);
      continue;
    }
    let set = perDef.get(owner);
    if (!set) perDef.set(owner, (set = new Set()));
    set.add(name);
  }

  for (const def of file.defs) {
    const set = perDef.get(def);
    if (!set) continue;
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
  constructor(private readonly defs: GDef[]) {}

  at(index: number): GDef | null {
    let lo = 0;
    let hi = this.defs.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.defs[mid]!.startIndex <= index) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    for (let i = found; i >= 0; i--) {
      const def = this.defs[i]!;
      if (def.endIndex >= index) return def;
    }
    return null;
  }
}

/** The name the rest of the pipeline knows a definition by: `Server.ListOrders`. */
export function scopeName(def: GDef | null): string | null {
  if (!def) return null;
  return def.owner ? `${def.owner}.${def.name}` : def.name;
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/** `http.\n  HandleFunc` and `http.HandleFunc` are the same callee. */
function collapse(text: string): string {
  return text.replace(/\s+/g, '');
}

function lineOf(node: Node): number {
  return node.startPosition.row + 1;
}
