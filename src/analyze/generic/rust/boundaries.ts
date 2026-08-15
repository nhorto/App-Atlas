/**
 * @fileoverview Where a Rust crate is open, and where its data goes.
 *
 * Small on purpose, and gated the way every detector here is gated: on a dependency the
 * manifest actually declares. The three families are the ones the repo that asked for
 * this plugin needed (#85) — `#[tauri::command]` as a door, sqlx for the data story,
 * and the environment variables the code reads. Everything else a Rust service might
 * do (axum routes, reqwest calls) is left absent rather than guessed at, because an
 * invented box on the map is worse than a missing one.
 */
import type { CodeSite } from '../../../model/types.js';
import type { BoundaryFinding } from '../../boundaries/types.js';
import { readSqlStatement } from '../../sql.js';
import type { BoundaryInput } from '../languages.js';
import type { GCall, GenericFile } from '../ir.js';
import { detectRocketBoundaries } from './rocket.js';

/** The sqlx entry points whose first argument is the SQL, macro and function alike. */
const SQLX_QUERY = /^sqlx::(query|query_as|query_scalar|query_unchecked|query_as_unchecked|raw_sql)$/;

export function detectRustBoundaries(input: BoundaryInput): BoundaryFinding[] {
  const { file, signals } = input;
  const findings: BoundaryFinding[] = [];

  /** The site of a call, filed under the function it sits in. */
  const at = (call: GCall, snippet?: string): CodeSite => ({
    path: file.path,
    line: call.line,
    nodeId: input.nodeIdForScope(call.scope),
    ...(snippet ? { snippet } : {}),
  });

  if (signals.cargoPackages.has('tauri')) detectCommands(input, findings);
  // The manifest is the gate, not the file. Rocket arrives through `#[macro_use] extern
  // crate rocket;` at the crate root, so the file holding the routes imports nothing to
  // key on — which is where #195's rule for Tauri does not transfer (#257).
  if (signals.cargoPackages.has('rocket')) detectRocketBoundaries(input, findings);
  if (signals.cargoPackages.has('sqlx')) detectSqlx(file, findings, at);
  detectEnv(file, findings, at);

  return findings;
}

/**
 * `#[tauri::command]` — the door between a desktop app's webview and its Rust.
 *
 * Not an HTTP route and never counted as one: the caller is the app's own interface,
 * not a stranger on the internet, so these carry no auth verdict — badging one "no
 * auth check" would be the false alarm the C# desktop work exists to avoid. They are
 * still doors in every other sense, and a map without them shows an engine nothing
 * can reach.
 */
function detectCommands(input: BoundaryInput, findings: BoundaryFinding[]): void {
  // Both spellings, and the bare one is the *common* one (#195). Rust imports the macro
  // and uses the short name — `use tauri::{command, AppHandle}` then `#[command]` — so
  // matching only the qualified path recognised the form this tier's fixture happens to
  // write and missed the form real apps do. lencx/ChatGPT has eleven commands and was
  // reported as a Tauri app with no ways in at all, which is the sentence the docstring
  // above exists to prevent.
  //
  // The import is the gate, exactly as narrow as the qualified path was: clap and
  // several other crates define a `#[command]` of their own, and one of those without
  // `use tauri::command` above it proves nothing.
  //
  // Unaliased only. `use tauri::command as tcmd` would be the same fact under another
  // name, but the import record keeps the local name and not the leaf it renamed, so
  // there is nothing here to tell that apart from any other tauri import — and reading
  // every name a file imports from tauri as a command attribute is how a rule stops
  // being about evidence. Renaming this macro is close to unheard of; a missed door is
  // the cheaper side of that trade.
  const importsCommand = input.file.imports.some(
    (imp) => (imp.module === 'tauri' || imp.module.startsWith('tauri.')) && imp.local === 'command' && !imp.alias,
  );
  const isCommand = (attr: string): boolean => {
    const name = attr.split('(')[0].trim();
    return name === 'tauri::command' || (importsCommand && name === 'command');
  };

  for (const def of input.file.defs) {
    if (def.kind !== 'function') continue;
    if (!def.decorators.some(isCommand)) continue;

    findings.push({
      type: 'endpoint',
      endpointKind: 'ipc',
      key: `ipc ${def.name}`,
      name: def.name,
      method: null,
      route: def.name,
      framework: 'Tauri',
      writes: false,
      guards: [],
      site: { path: input.file.path, line: def.line, nodeId: input.nodeIdForScope(def.name) },
      handlerId: input.nodeIdForName(def.owner ? `${def.owner}.${def.name}` : def.name),
    });
  }
}

/**
 * sqlx calls, with the direction and the table read out of the SQL itself.
 *
 * `sqlx::query("…")` and `sqlx::query!("…")` arrive as the same callee — the macro is
 * captured as the call it is spelled like — so one rule covers both. A call whose SQL
 * is built elsewhere still proves the database is used; only the arrow is missing,
 * and inventing one would put a write on a screen somebody reads to find out what
 * writes.
 */
function detectSqlx(
  file: GenericFile,
  findings: BoundaryFinding[],
  at: (call: GCall, snippet?: string) => CodeSite,
): void {
  for (const call of file.calls) {
    if (!SQLX_QUERY.test(call.callee)) continue;
    const sql = firstString(call);
    const statement = sql ? readSqlStatement(sql) : null;
    findings.push({
      type: 'store',
      key: 'sqlx',
      name: 'Database',
      client: 'sqlx',
      storeKind: 'sql',
      table: statement?.table ?? null,
      operation: statement?.operation ?? null,
      site: at(call, `${call.callee}(…)`),
    });
  }
}

/**
 * `std::env::var("KEY")`, however the path was shortened, and the `env!` macros.
 *
 * The macro form is compile-time and the function form is runtime, and the reader's
 * question — what does this app need set? — does not care about the difference.
 */
function detectEnv(
  file: GenericFile,
  findings: BoundaryFinding[],
  at: (call: GCall, snippet?: string) => CodeSite,
): void {
  for (const call of file.calls) {
    const isVar = /(^|::)env::(var|var_os)$/.test(call.callee);
    const isMacro = call.callee === 'env' || call.callee === 'option_env';
    if (!isVar && !isMacro) continue;
    const name = firstString(call);
    if (!name) continue;
    findings.push({ type: 'env', name, site: at(call, `${call.callee}${isMacro ? '!' : ''}("${name}")`) });
  }
}

function firstString(call: GCall): string | null {
  for (const arg of call.args) {
    if (arg.t === 'str') return arg.v;
  }
  return null;
}
