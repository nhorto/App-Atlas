/**
 * @fileoverview What Rust says about itself that its grammar does not.
 *
 * Bigger than Go's dialect and for one reason: Rust's module system is spelled in the
 * language rather than on disk. A Go import names a directory and a C# `using` names a
 * namespace; a Rust `use crate::modules::estimating` names *a file*, found by walking
 * the module path from the crate root — and a `use` is a recursive tree of groups,
 * globs and aliases that the flat `@import.path` capture cannot hold. So imports are
 * read here, off the tree, and resolved to the namespace-per-file scheme the shared
 * linker already speaks.
 *
 * The file's namespace is derived from its path — `engine/src/modules/estimating.rs`
 * is the module `modules::estimating` of the crate rooted at `engine/src` — because
 * that is Cargo's own layout rule, and the one repo in a thousand that overrides it
 * loses likely-grade links, not facts.
 */
import type { Node } from 'web-tree-sitter';
import { DEFAULTS } from '../dialect.js';
import type { Dialect } from '../dialect.js';
import type { GDef, GImport, GenericFile } from '../ir.js';

/**
 * Rust the toolchain wrote or vendored, not the app.
 *
 * `target/` is Cargo's build directory, and build scripts generate `.rs` into it on
 * every compile. `vendor/` is where `cargo vendor` puts a copy of every dependency —
 * the issue that asked for this plugin found 77 files of somebody else's MySQL driver
 * there, absent from the map only because Rust was unread (#85).
 */
const GENERATED = [/(^|\/)target\//, /(^|\/)vendor\//];

/** Crates that ship with the toolchain. Nobody thinks of `std` as a dependency. */
const TOOLCHAIN_CRATES = new Set(['std', 'core', 'alloc', 'proc_macro', 'test']);

/** The definition node types, for reading visibility and attributes off the tree. */
const DEF_TYPES = [
  'function_item',
  'function_signature_item',
  'struct_item',
  'enum_item',
  'trait_item',
  'union_item',
  'type_item',
];

export const rustDialect: Dialect = {
  ...DEFAULTS,
  id: 'rust',
  displayName: 'Rust',
  extensions: ['.rs'],
  skip: GENERATED,

  // One namespace is one file (`modules::estimating` *is* estimating.rs), which is
  // what lets a `mod` or `use` edge exist without the C#-style name-by-name gate.
  scope: 'namespace',
  namespaceIsAFile: true,

  /**
   * Never right on its own — Rust writes visibility as the keyword `pub`, and `finish`
   * reads it off every declaration. Stays pessimistic for the window in which it is the
   * only answer, exactly as the C# dialect does: a name alone cannot tell you whether
   * somebody typed `pub`, and claiming otherwise is the thing this tier must not do.
   */
  exported: () => false,

  /** Internal imports are dotted namespace keys; an external one is a bare crate name. */
  externalImport: (module) => !module.includes('.') && !TOOLCHAIN_CRATES.has(module),

  /** `engine/src.modules.estimating` → `estimating`; `sqlx` → `sqlx`. */
  localName(module) {
    const parts = module.split('.').filter(Boolean);
    return parts[parts.length - 1] ?? module;
  },

  strings: new Set(['string_literal', 'raw_string_literal']),
  numbers: new Set(['integer_literal', 'float_literal']),
  names: new Set(['identifier', 'field_identifier', 'type_identifier', 'scoped_identifier', 'scoped_type_identifier']),
  identifiers: new Set(['identifier', 'type_identifier', 'field_identifier']),
  qualified: new Set(['scoped_identifier', 'scoped_type_identifier']),
  functions: new Set(['closure_expression']),
  calls: new Set(['call_expression', 'macro_invocation']),
  comment: ['line_comment', 'block_comment'],

  /**
   * One layer of quotes, with Rust's raw-string fence taken off first: `r#"…"#` and
   * `br##"…"##` both mean the characters between the quotes, and a route or a SQL
   * statement written raw is the same address it would be written plain.
   */
  unquote(text) {
    const raw = /^[br]{0,2}(#*)"([\s\S]*)"\1$/.exec(text);
    if (raw) return raw[2];
    if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) return text.slice(1, -1);
    return text;
  },

  /** `///`, `//!`, and the block fences. The doc text is what is left. */
  uncomment(text) {
    return text
      .replace(/^\s*\/\*[*!]?/, '')
      .replace(/\*+\/\s*$/, '')
      .replace(/^\s*\/\/[/!]?\s?/, '')
      .replace(/^\s*\*\s?/, '')
      .trim();
  },

  finish(file: GenericFile, root: Node): void {
    const { crateRoot, ownNamespace } = placeOf(file.path);
    file.namespace = ownNamespace;

    // A Rust file documents itself with `//!`, and with nothing else — the generic
    // "block above the first item" rule lands on whatever `///` happens to sit above
    // the first function and hands the file that function's description. Recomputed
    // here from the markers, including down to null: no `//!` means no file doc, not
    // somebody else's.
    file.doc = innerDoc(root);

    readImports(file, root, crateRoot, ownNamespace);
    const byStart = definitionsByStart(root);
    readVisibilityAndAttributes(file, byStart);
    reattachDocs(file, root, byStart);

    // The reference pass splits qualified names on dots, so Rust's `::` becomes the
    // separator every other language here already uses. Done last, so nothing above
    // has to know which spelling it is looking at.
    file.qualifiedUses = file.qualifiedUses.map(dotted);
    for (const def of file.defs) def.qualifiedUses = def.qualifiedUses.map(dotted);
  },
};

function dotted(path: string): string {
  return path.replace(/::/g, '.');
}

/** The `//!` block at the top of the file — Rust's own spelling of a module doc. */
function innerDoc(root: Node): string | null {
  const parts: string[] = [];
  for (const child of root.namedChildren) {
    if (!child) continue;
    if (child.type !== 'line_comment' && child.type !== 'block_comment') break;
    if (!/^(\/\/!|\/\*!)/.test(child.text)) continue;
    parts.push(...child.text.split(/\r?\n/).map((line) => rustDialect.uncomment(line)));
  }
  const text = parts.join(' ').replace(/\s+/g, ' ').trim();
  return text ? text : null;
}

/**
 * Where a file sits in the module system, read from its path.
 *
 * Cargo's layout rule: a crate's code lives under `src/`, `lib.rs` and `main.rs` are
 * the crate root, `foo.rs` and `foo/mod.rs` are both the module `foo`. The crate is
 * identified by its `src` directory's path, which is unique per crate in a workspace
 * and needs no manifest to compute. A file outside any `src/` — a `build.rs`, an
 * integration test — is its own tiny root, which is also what Cargo says it is.
 */
function placeOf(relPath: string): { crateRoot: string; ownNamespace: string } {
  const posix = relPath.replace(/\\/g, '/');
  let crateRoot: string;
  let rest: string;

  const srcAt = posix.lastIndexOf('/src/');
  if (srcAt !== -1) {
    crateRoot = posix.slice(0, srcAt + 4);
    rest = posix.slice(srcAt + 5);
  } else if (posix.startsWith('src/')) {
    crateRoot = 'src';
    rest = posix.slice(4);
  } else {
    const slash = posix.lastIndexOf('/');
    crateRoot = slash === -1 ? '.' : posix.slice(0, slash);
    rest = slash === -1 ? posix : posix.slice(slash + 1);
  }

  const segments = rest.replace(/\.rs$/, '').split('/').filter(Boolean);
  const last = segments[segments.length - 1];
  if (last === 'mod' || last === 'lib' || last === 'main') segments.pop();

  return { crateRoot, ownNamespace: segments.length ? `${crateRoot}.${segments.join('.')}` : crateRoot };
}

// ---------------------------------------------------------------------------
// Imports: `use` trees and `mod` declarations
// ---------------------------------------------------------------------------

/**
 * Every `use` and every bodyless `mod foo;`, resolved to the namespaces they name.
 *
 * A `use` inside an inline module resolves against that module's own path — `use
 * super::*` in a `#[cfg(test)] mod tests` names the file it sits in, not the file
 * above it — so the enclosing `mod` chain is walked before anything else is.
 *
 * Paths that start with a bare crate name are recorded as that crate, one segment,
 * external. That includes the 2015-style spelling of a local top-level module, which
 * cannot be told from a crate without the file list this hook does not have; the cost
 * is a missing likely-edge in old-edition code, not a wrong one.
 */
function readImports(file: GenericFile, root: Node, crateRoot: string, ownNamespace: string): void {
  const imports: GImport[] = [];

  const add = (segments: string[], alias: string | null, line: number, container: string) => {
    if (segments.length === 0) return;
    const head = segments[0]!;
    let resolved: string[] | null = null;

    if (head === 'crate') resolved = [crateRoot, ...segments.slice(1)];
    else if (head === 'self') resolved = [container, ...segments.slice(1)];
    else if (head === 'super') {
      let base = container;
      let index = 0;
      while (segments[index] === 'super') {
        const dot = base.lastIndexOf('.');
        // `super` above the crate root names nothing in this repo.
        if (dot === -1) return;
        base = base.slice(0, dot);
        index++;
      }
      resolved = [base, ...segments.slice(index)];
    }

    if (resolved) {
      const module = resolved.filter(Boolean).join('.');
      const lastSegment = segments[segments.length - 1]!;
      imports.push({ module, alias, local: alias ?? lastSegment, line });
      return;
    }

    // A bare head is an external crate. Everything after it is that crate's business.
    if (TOOLCHAIN_CRATES.has(head)) return;
    imports.push({ module: head, alias, local: alias ?? segments[segments.length - 1]!, line });
  };

  /** `a::b::{c, d as e, self, f::*}` → one entry per leaf. */
  const expand = (node: Node, prefix: string[], line: number, container: string): void => {
    switch (node.type) {
      case 'identifier':
      case 'crate':
      case 'super':
      case 'self':
      case 'metavariable':
        add([...prefix, node.text], null, line, container);
        return;
      case 'self_parameter':
        return;
      case 'scoped_identifier': {
        const segments = node.text.split('::').map((s) => s.trim()).filter(Boolean);
        add([...prefix, ...segments], null, line, container);
        return;
      }
      case 'use_as_clause': {
        const path = node.childForFieldName('path');
        const alias = node.childForFieldName('alias');
        if (!path) return;
        const segments = path.text.split('::').map((s) => s.trim()).filter(Boolean);
        add([...prefix, ...segments], alias?.text ?? null, line, container);
        return;
      }
      case 'scoped_use_list': {
        const path = node.childForFieldName('path');
        const list = node.childForFieldName('list');
        const segments = path ? path.text.split('::').map((s) => s.trim()).filter(Boolean) : [];
        if (list) expand(list, [...prefix, ...segments], line, container);
        return;
      }
      case 'use_list': {
        for (const child of node.namedChildren) if (child) expand(child, prefix, line, container);
        return;
      }
      case 'use_wildcard': {
        // `use a::b::*` imports the module itself, which is exactly the edge to draw.
        const segments = node.text.replace(/::\*$/, '').replace(/^\*$/, '').split('::').map((s) => s.trim()).filter(Boolean);
        if (segments.length > 0) add(segments, null, line, container);
        return;
      }
      default: {
        // `use foo;` arrives as whatever single node the grammar gave the path.
        const segments = node.text.split('::').map((s) => s.trim()).filter(Boolean);
        if (segments.length > 0) add(segments, null, line, container);
      }
    }
  };

  for (const use of root.descendantsOfType('use_declaration')) {
    if (!use) continue;
    const argument = use.childForFieldName('argument') ?? use.namedChildren.find((n) => Boolean(n) && n.type !== 'visibility_modifier');
    if (!argument) continue;
    expand(argument, [], use.startPosition.row + 1, containerOf(use, ownNamespace));
  }

  // `mod foo;` with no body is the module system's own import: it says foo's file is
  // part of this crate, included here. With a body it declares the module inline and
  // imports nothing.
  for (const mod of root.descendantsOfType('mod_item')) {
    if (!mod || mod.childForFieldName('body')) continue;
    const name = mod.childForFieldName('name');
    if (!name) continue;
    const container = containerOf(mod, ownNamespace);
    imports.push({
      module: `${container}.${name.text}`,
      alias: null,
      local: name.text,
      line: mod.startPosition.row + 1,
    });
  }

  file.imports = imports;
}

/** The module path of the inline `mod` blocks a node sits inside, deepest last. */
function containerOf(node: Node, ownNamespace: string): string {
  const chain: string[] = [];
  for (let current = node.parent; current; current = current.parent) {
    if (current.type === 'mod_item') {
      const name = current.childForFieldName('name');
      if (name) chain.unshift(name.text);
    }
  }
  return chain.length ? `${ownNamespace}.${chain.join('.')}` : ownNamespace;
}

// ---------------------------------------------------------------------------
// Visibility, attributes, and the docs the attributes displaced
// ---------------------------------------------------------------------------

function definitionsByStart(root: Node): Map<number, Node> {
  const out = new Map<number, Node>();
  for (const node of root.descendantsOfType(DEF_TYPES)) {
    if (node) out.set(node.startIndex, node);
  }
  return out;
}

/** Whether a declaration wrote `pub` — the word alone, not `pub(crate)` or narrower. */
function isPub(node: Node): boolean {
  for (const child of node.namedChildren) {
    if (child?.type === 'visibility_modifier') return child.text === 'pub';
  }
  return false;
}

/**
 * Reads `pub` and `#[…]` off every declaration.
 *
 * Visibility is a keyword the capture vocabulary has no name for, same as C#'s — and
 * `pub(crate)` deliberately does not count, because "exported" here means visible
 * outside the crate and rounding a crate-private name up is the direction this tool
 * never rounds. Attributes become the definition's decorators, which is the whole
 * evidence that a function is a `#[tauri::command]` door.
 */
function readVisibilityAndAttributes(file: GenericFile, byStart: Map<number, Node>): void {
  for (const def of file.defs) {
    const node = byStart.get(def.startIndex);
    if (!node) continue;

    def.exported = isPub(node);

    const decorators: string[] = [];
    for (let prev = node.previousNamedSibling; prev; prev = prev.previousNamedSibling) {
      if (prev.type !== 'attribute_item') break;
      decorators.unshift(prev.text.replace(/^#\[|\]$/g, '').replace(/\s+/g, ''));
    }
    def.decorators = decorators;

    // A field's own `pub` is on the field; a trait's requirements and an enum's
    // variants are as visible as the thing that declares them.
    if (def.kind === 'type') {
      const perField = new Map<string, boolean>();
      for (const decl of node.descendantsOfType('field_declaration')) {
        const name = decl?.childForFieldName('name');
        if (decl && name) perField.set(name.text, isPub(decl));
      }
      for (const field of def.fields) {
        field.exported = perField.get(field.name) ?? def.exported;
      }
    }
  }
}

/**
 * Finds the doc comment an attribute pushed out of reach.
 *
 * The generic pass attaches the comment block ending on the line above a definition.
 * Rust writes `/// doc` *above* `#[derive(…)]`, and the attribute is a sibling of the
 * item rather than part of it — so every derived struct and every `#[tauri::command]`
 * had its documentation sitting two lines up, unattached. Walked here off the real
 * sibling chain, where attributes are visible and skippable.
 */
function reattachDocs(file: GenericFile, root: Node, byStart: Map<number, Node>): void {
  const isComment = (node: Node | null): node is Node =>
    Boolean(node && (node.type === 'line_comment' || node.type === 'block_comment'));
  // This grammar's comments swallow their trailing newline, so one that "ends" at
  // column 0 of a row really ended on the row before.
  const endRowOf = (node: Node): number =>
    node.endPosition.column === 0 ? node.endPosition.row - 1 : node.endPosition.row;

  for (const def of file.defs) {
    if (def.doc) continue;
    const node = byStart.get(def.startIndex);
    if (!node) continue;

    let cursor = node.previousNamedSibling;
    let expectRow = node.startPosition.row;
    while (cursor && cursor.type === 'attribute_item' && endRowOf(cursor) + 1 === expectRow) {
      expectRow = cursor.startPosition.row;
      cursor = cursor.previousNamedSibling;
    }
    if (!isComment(cursor) || endRowOf(cursor) + 1 !== expectRow) continue;

    const parts: string[] = [];
    let comment: Node | null = cursor;
    while (isComment(comment)) {
      // Only doc comments document; an ordinary `//` above a `///` block is a note to
      // the maintainer, and the doc markers are how Rust tells the two apart.
      if (!/^(\/\/[/!]|\/\*[*!])/.test(comment.text)) break;
      parts.unshift(...comment.text.split(/\r?\n/).map((line) => rustDialect.uncomment(line)));
      const above: Node | null = comment.previousNamedSibling;
      if (!isComment(above) || endRowOf(above) + 1 !== comment.startPosition.row) break;
      comment = above;
    }
    const text = parts.join(' ').replace(/\s+/g, ' ').trim();
    if (text) def.doc = text;
  }
}
