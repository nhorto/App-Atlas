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
  /**
   * Classes only: the names this class body hands to `Depends(...)`, its own
   * `__init__` included. A controller's auth is written here and nowhere near the
   * routes it declares.
   */
  depends?: string[];
  fields?: PyField[];
  /**
   * Classes only: the table this model maps to, from a literal `__tablename__`.
   *
   * The one thing that ties a model class to the table its queries name — mealie's
   * `User` class declares `__tablename__ = "users"` — and absent whenever the class is
   * not an ORM model or builds its name at run time.
   */
  tableName?: string | null;
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
  /**
   * The function this was written inside, or null for module and class level.
   *
   * URLs only. `url = "https://api.opsgenie.com/v2/alerts"` on the line above the
   * request is how a great deal of real code names an address, and the scope is what
   * stops two functions that both call it `url` from lending each other theirs.
   */
  scope?: string | null;
  /**
   * Another name this one stands for: `url = self.URL % account`. Function scope only,
   * and followed exactly one hop — enough for the way an address is threaded through a
   * method, and short of a constant-folding pass nothing here needs.
   */
  alias?: string;
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

/** One entry of a Django URLconf list: a route, or an `include()` handing off to another. */
export interface PyUrlEntry {
  line: number;
  /** `path`, `re_path` or the legacy `url`. */
  call: string;
  /** The segment as written, or null when it was not a readable literal. */
  route: string | null;
  /** The segment when it was written as a name — `path(prefix, include(…))`. */
  routeName: string | null;
  /** An f-string gave up only its literal half. */
  partial: boolean;
  /** `include(api_urls)` — a list in this same file. */
  includeList: string | null;
  /** `include("hc.front.urls")` — another module's `urlpatterns`. */
  includeModule: string | null;
  isInclude: boolean;
  /** The view as written: `views.checks`. Null when the entry names no handler. */
  view: string | null;
}

/** A module-level list Django assembles URLs from: `urlpatterns`, and its helper lists. */
export interface PyUrlList {
  var: string;
  line: number;
  entries: PyUrlEntry[];
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
  urlLists?: PyUrlList[];
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
  /**
   * Set only when this cell is not Python — a `%%bash` body, a shell command, an
   * install line written without its `!`. It says why the cell would not parse, and it
   * means nothing inside the cell reached the map. The cell still occupies its lines,
   * so every other cell's numbers are unaffected.
   */
  unread?: string;
}

export interface PyPayload {
  version: number;
  python?: string;
  error?: string;
  files: PyFile[];
}
