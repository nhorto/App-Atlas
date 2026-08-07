/**
 * @fileoverview What a tree-sitter parse is flattened into.
 *
 * Deliberately the same shape as `py/types.ts`: a list of definitions, a list of imports,
 * a list of calls with their arguments, and the local names bound to calls. That shape is
 * already known to be enough to find doors, guards, stores and outbound traffic, because
 * the Python detectors find all four from nothing else.
 *
 * Nothing here is language-specific and nothing here is interpreted. Every field is what
 * the source literally said, so a detector reading it cannot accidentally depend on Go.
 */

/** One argument, tagged with what kind of thing it was. */
export type GValue =
  | { t: 'str'; v: string }
  | { t: 'num'; v: string }
  /** An identifier or a dotted path: `handler`, `s.ListOrders`, `middleware.Logger`. */
  | { t: 'name'; v: string }
  /**
   * A call handed straight to another call. Half the middleware in Go is written
   * `r.Use(AuthRequired())` rather than `r.Use(AuthRequired)`, and the two mean the same
   * thing to the reader, so the callee is carried the same way a name is.
   */
  | { t: 'call'; v: string }
  /** A function written inline. Its body is in `calls` like any other code. */
  | { t: 'func'; startIndex: number; endIndex: number }
  | { t: 'other' };

export interface GCall {
  /** The callee as written, whitespace collapsed: `r.Get`, `http.HandleFunc`. */
  callee: string;
  /** The last segment on its own: `Get`, `HandleFunc`. */
  method: string | null;
  /** Everything before the last segment: `r`, `http`, `s.db`. Null for a bare call. */
  receiver: string | null;
  args: GValue[];
  line: number;
  /** The definition this call sits inside, by name. Null at file scope. */
  scope: string | null;
  /**
   * Character offsets, so a call can be told whether it is inside a particular function
   * literal. `r.Route("/admin", func(sub){ sub.Use(RequireAdmin) })` puts a check inside
   * an argument, and the only thing connecting the two is that one contains the other.
   */
  startIndex: number;
  endIndex: number;
}

export interface GParam {
  name: string;
  /** As written, pointers and packages included: `*http.Request`. */
  type: string;
}

export interface GField {
  name: string;
  type: string;
  exported: boolean;
}

export interface GDef {
  kind: 'function' | 'type';
  name: string;
  /**
   * What the definition hangs off: a Go receiver type, a class in another language.
   * Null for a plain function.
   */
  owner: string | null;
  line: number;
  endLine: number;
  startIndex: number;
  endIndex: number;
  doc: string | null;
  params: GParam[];
  /** The return type as written, or an empty string when there is none. */
  returns: string;
  /** Whether other packages can see it, by whatever rule the language uses. */
  exported: boolean;
  /**
   * Attributes or decorators written on the definition, as written, whitespace
   * collapsed: `tauri::command`, `derive(Debug,Serialize)`. Empty for languages that
   * have none or whose dialect does not collect them. A detector reads these the way
   * the C# one reads attribute-shaped calls — `#[tauri::command]` is the whole evidence
   * that a Rust function is a door.
   */
  decorators: string[];
  /**
   * What a type declares it extends or implements, by name — `BackgroundService` from
   * `class Sync : BackgroundService`. Base names only, type arguments stripped, because
   * a detector matches them against a closed list of framework types and
   * `IHandler<Order>` is `IHandler` to that question. Empty for functions, and for
   * languages whose dialect does not collect them.
   */
  bases: string[];
  /** Struct, class or interface members. */
  fields: GField[];
  /** Every bare identifier mentioned inside, for the reference pass to resolve. */
  uses: string[];
  /**
   * Every dotted name mentioned inside, as written: `store.ListOrders`. A call into
   * another package has no other spelling, so without these the reference pass would
   * stop at the file it started in — and following a handler into the layer underneath
   * it is most of what the map is for.
   */
  qualifiedUses: string[];
}

export interface GImport {
  /** The module as written: `net/http`, `github.com/go-chi/chi/v5`. */
  module: string;
  /** The alias, when one was written. */
  alias: string | null;
  /**
   * The name code in this file actually types — the alias, or the last segment of the
   * path. This is what a call's receiver has to be matched against.
   */
  local: string;
  line: number;
}

/** `r := chi.NewRouter()` — a local name and the call that produced it. */
export interface GBinding {
  name: string;
  /** Dotted callee of the right-hand side, or '' when it was not a call. */
  callee: string;
  /** Its first literal string argument, when it had one. */
  arg: string | null;
  line: number;
  scope: string | null;
}

/** A name bound to a string literal: `const APIPrefix = "/api/v1"`. */
export interface GConst {
  name: string;
  value: string;
  line: number;
}

export interface GenericFile {
  path: string;
  /** The language plugin id that read it: `go`. */
  language: string;
  ok: boolean;
  error: string | null;
  /** The file's own doc comment, when the language has such a thing. */
  doc: string | null;
  loc: number;
  /** The namespace the file declares — a Go `package` clause. */
  namespace: string | null;
  imports: GImport[];
  defs: GDef[];
  calls: GCall[];
  bindings: GBinding[];
  constants: GConst[];
  /** Identifiers mentioned at file scope. */
  uses: string[];
  /** Dotted names mentioned at file scope. */
  qualifiedUses: string[];
  /**
   * Whether the parser hit syntax it could not fit into the grammar. The file is still
   * read — tree-sitter recovers — but a reader deserves to know that what follows may be
   * partial rather than merely uneventful.
   */
  hasErrors: boolean;
}
