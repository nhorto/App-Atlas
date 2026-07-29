/**
 * @fileoverview What `extract.py` sends back.
 *
 * These mirror the JSON the extractor prints, one interface per shape, so that the
 * only place the two languages have to agree is right here. Nothing in this file
 * interprets anything: every field is what the source literally said.
 */

/** One argument or annotation, tagged with what kind of thing it was. */
export type PyValue =
  | { t: 'str'; v: string; partial?: boolean }
  | { t: 'num'; v: string }
  | { t: 'name'; v: string }
  | { t: 'list'; items: PyValue[] }
  | { t: 'other' };

export interface PyCall {
  /** Dotted callee: `app.get`, `os.getenv`, `requests.post`. */
  callee: string;
  /**
   * The last segment on its own. `Path(out).write_text(t)` has a call in the middle of
   * its chain, so `callee` is only `Path()` and the verb is missing from it.
   */
  method?: string | null;
  args: PyValue[];
  kwargs: Record<string, PyValue>;
  line: number;
  /** The top-level function or method this sits inside, if any. */
  scope?: string | null;
  /** Only on decorators: the decorator exactly as written. */
  text?: string;
}

export interface PyParam {
  name: string;
  type: string;
  /** The default as written. `Depends(get_current_user)` lives here, not in `type`. */
  default?: string;
  optional: boolean;
  rest: boolean;
}

export interface PyField {
  name: string;
  type: string;
  optional: boolean;
}

export interface PyDef {
  kind: 'function' | 'class';
  name: string;
  /** The class a method belongs to. */
  owner?: string | null;
  line: number;
  endLine: number;
  doc: string | null;
  isAsync?: boolean;
  params?: PyParam[];
  returns?: string;
  bases?: string[];
  fields?: PyField[];
  methods?: PyDef[];
  decorators: PyCall[];
  /**
   * Line where this function turns an unauthenticated caller away — a 401 or 403 it
   * raises or returns. What makes a dependency a check rather than a fetch, read from
   * the code rather than from the function's name.
   */
  rejects?: number | null;
  /** Every identifier mentioned inside, for the reference pass to resolve. */
  uses: string[];
}

export interface PyImport {
  /** The module as written: `app.db`, or `db` for `from .db import x`. */
  module: string;
  /** Leading dots on a relative import. 0 for an absolute one. */
  level: number;
  /** `[exported name, local name]` pairs from `from x import a as b`. */
  names: [string, string][];
  alias: string | null;
  line: number;
}

/**
 * A module-level name bound to something with a `Depends(...)` in it —
 * `CurrentUser = Annotated[User, Depends(get_current_user)]`.
 *
 * The route that uses it writes only `current_user: CurrentUser`, so this is the only
 * place the check is visible at all.
 */
export interface PyAlias {
  name: string;
  /** Every function handed to a `Depends(...)` inside the value. */
  depends: string[];
  line: number;
}

/**
 * A module-level router: `locked = LockedRouter(prefix="/admin")`.
 *
 * Which router a route hangs off decides which dependencies reach it, and one file
 * having both a locked router and an open one is ordinary.
 */
export interface PyRouter {
  /** The variable, which is what a route decorator will name. */
  var: string;
  /** What built it: `APIRouter`, `UserAPIRouter`. */
  callee: string;
  /** Whether a `prefix=` was passed at all — separate from whether we could read it. */
  hasPrefix?: boolean;
  /** The prefix when it was written as a literal. */
  prefix?: string | null;
  /** The prefix when it was written as a name: `prefix=settings.API_V1_STR`. */
  prefixName?: string | null;
  line: number;
}

/**
 * A module- or class-level name bound to a string that starts with `/` —
 * `API_V1_STR: str = "/api/v1"`.
 *
 * Collected only so that a `prefix=` written as a name can still be turned into the
 * address it stands for.
 */
export interface PyConstant {
  name: string;
  value: string;
  line: number;
}

/**
 * `conn = pymysql.connect(...)` — a local name and the call that produced it.
 *
 * The Python half of what `ctx.locals` is for the TypeScript detectors: it says what a
 * receiver *is*, so `conn.execute(...)` can be told apart from every other `.execute`.
 */
export interface PyBinding {
  name: string;
  /** Dotted callee of the right-hand side: `pymysql.connect`, `conn.cursor`. */
  callee: string;
  /** Its first literal string argument — the database file, or the connection URL. */
  arg: string | null;
  line: number;
}

/** `os.environ["KEY"]` and friends — a read that is a subscript, not a call. */
export interface PySubscript {
  base: string;
  key: string;
  line: number;
  scope: string | null;
}

export interface PyFile {
  path: string;
  ok: boolean;
  error: string | null;
  doc?: string | null;
  loc?: number;
  imports?: PyImport[];
  defs?: PyDef[];
  calls?: PyCall[];
  subscripts?: PySubscript[];
  aliases?: PyAlias[];
  bindings?: PyBinding[];
  routers?: PyRouter[];
  constants?: PyConstant[];
  uses?: string[];
  /** Line of a module-level `if __name__ == "__main__":` — this file is meant to be run. */
  main?: number | null;
  /** Notebooks only: which range of the flattened source came from which cell. */
  cells?: PyNotebookCell[];
  /** Notebooks only: the code cells joined — the text every line number refers to. */
  source?: string;
}

/**
 * One cell of a notebook, and the lines it occupies in the flattened source. "Line 412"
 * means nothing to someone looking at a stack of cells; "cell 12" is the address they
 * can actually navigate to.
 */
export interface PyNotebookCell {
  type: string;
  index: number;
  startLine: number;
  endLine: number;
}

export interface PyPayload {
  version: number;
  python?: string;
  error?: string;
  files: PyFile[];
}
