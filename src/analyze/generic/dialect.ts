/**
 * @fileoverview What a language has to say about itself, beyond its grammar.
 *
 * A tree-sitter grammar answers "what shape is this file". It does not answer "does a
 * capital letter mean other packages can see this name", or "is `//` a comment or a
 * division". Those are the questions left over once the query file has done its work, and
 * they are the entire per-language cost of this tier.
 *
 * The defaults below are written to be right for most grammars, so a new language usually
 * overrides one or two fields and inherits the rest. If a dialect ever grows past a
 * screenful, that is the signal that something belongs in the query file instead.
 */
import type { Node } from 'web-tree-sitter';
import type { GenericFile } from './ir.js';

export interface Dialect {
  /** Matches the plugin id and the grammar file name: `go` → `tree-sitter-go.wasm`. */
  id: string;
  displayName: string;
  /** File extensions this dialect claims, with the dot. */
  extensions: string[];
  /**
   * Files to leave alone even though the extension matches — generated code, and the
   * language's own vendored dependencies. Matched against the repo-relative path.
   */
  skip?: RegExp[];

  /** Whether a declared name is visible outside its own file or package. */
  exported(name: string): boolean;

  /** Node types whose text is a string literal. */
  strings: Set<string>;
  /** Node types whose text is a number. */
  numbers: Set<string>;
  /** Node types that are a name or a dotted path — the things a call can be handed. */
  names: Set<string>;
  /**
   * Node types that are a bare name and nothing else. Separate from `names` because
   * `s.ListOrders` is a fine thing to hand to a router and a useless thing to look up in
   * a table of declarations.
   */
  identifiers: Set<string>;
  /**
   * Node types for a dotted path. `store.Get` is the only spelling a call into another
   * package has, so without these the reference pass stops at the file it starts in.
   */
  qualified: Set<string>;
  /** Node types for a function written inline. */
  functions: Set<string>;
  /** Node type for a comment. */
  comment: string;

  /** Turns a string literal node's text into the string it denotes. */
  unquote(text: string): string;

  /**
   * The name code in this file types to reach an unaliased import.
   *
   * Usually the last segment of the path, and usually that is right. Go is the reason
   * this is overridable: `github.com/go-chi/chi/v5` is typed `chi`, because the major
   * version is part of the *path* and not part of the *name* — and a reader who takes
   * the last segment concludes the file imported something called `v5` and then finds no
   * routes anywhere in the repo.
   */
  localName(module: string): string;
  /** Strips the comment markers from one comment line. */
  uncomment(text: string): string;

  /**
   * Anything the language knows that the query file could not express, run once the rest
   * of the file has been read. Go uses it for the package clause; most languages will not
   * need it at all.
   */
  finish?(file: GenericFile, root: Node, source: string): void;
}

/** The parts most grammars spell the same way. Spread into a dialect and override. */
export const DEFAULTS = {
  strings: new Set(['string', 'string_literal', 'interpreted_string_literal', 'raw_string_literal']),
  numbers: new Set(['int_literal', 'float_literal', 'integer', 'float', 'number']),
  names: new Set(['identifier', 'field_identifier', 'type_identifier', 'selector_expression', 'attribute']),
  identifiers: new Set(['identifier', 'type_identifier', 'field_identifier']),
  qualified: new Set(['selector_expression', 'qualified_type', 'attribute']),
  functions: new Set(['func_literal', 'function_literal', 'lambda', 'closure', 'arrow_function']),
  comment: 'comment',

  /** Drops one layer of quotes or backticks, and nothing else. */
  unquote(text: string): string {
    const first = text[0];
    if (!first) return text;
    if ((first === '"' || first === "'" || first === '`') && text.endsWith(first) && text.length >= 2) {
      return text.slice(1, -1);
    }
    return text;
  },

  /** The last path segment. Right for most languages, and the starting point for Go. */
  localName(module: string): string {
    const parts = module.split('/').filter(Boolean);
    return parts[parts.length - 1] ?? module;
  },

  /** Strips a line's comment markers — slashes, hashes, or a block comment's fences. */
  uncomment(text: string): string {
    return text
      .replace(/^\/\*+/, '')
      .replace(/\*+\/$/, '')
      .replace(/^\s*(\/\/+|#+|\*)\s?/, '')
      .trim();
  },
} satisfies Partial<Dialect>;
