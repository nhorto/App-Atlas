/**
 * @fileoverview Database tables read out of SQL migrations.
 *
 * Prisma users write their schema in one file and get the full Data view; everyone
 * else — Supabase, Drizzle SQL output, hand-rolled migration folders — states the
 * same facts in `CREATE TABLE` and gets nothing. This reads the DDL the way
 * `schema.prisma` is read: tables, columns, primary keys, foreign keys, replayed in
 * migration order so an `ALTER TABLE` lands on the table it amends.
 *
 * It also keeps what Prisma cannot say: `ENABLE ROW LEVEL SECURITY` and
 * `CREATE POLICY`, per table. On a Supabase app the client talks to Postgres
 * directly and RLS *is* the auth model, so "which tables have no policy" is a
 * security question, not a database question.
 *
 * This is a tolerant reader, not a SQL engine. It understands the statements that
 * declare shape and skips everything else (functions, triggers, indexes, grants)
 * without complaint. Output uses the same `SchemaModel`/`SchemaField` shapes as the
 * Prisma signal, so every view that draws declared tables draws these too.
 */
import type { SchemaField, SchemaModel } from './signals.js';

/** One `CREATE POLICY`, kept with the line that proves it. */
export interface SqlPolicy {
  name: string;
  /** `select` | `insert` | `update` | `delete` | `all` — what the policy covers. */
  command: string;
  path: string;
  line: number;
}

export interface SqlTable extends SchemaModel {
  /** The migration file that created the table. */
  path: string;
  /** Whether `ENABLE ROW LEVEL SECURITY` was ever run on it. */
  rlsEnabled: boolean;
  policies: SqlPolicy[];
}

export interface SqlSchemaResult {
  tables: SqlTable[];
  /**
   * Policies on tables no migration created — `storage.objects` on Supabase, or a
   * table owned by another service. Real facts with nowhere to hang; the security
   * view can still count them.
   */
  orphanPolicies: SqlPolicy[];
}

interface SqlFile {
  /** Repo-relative path, POSIX. */
  path: string;
  text: string;
}

/**
 * Replays migration files, in the order given, into the tables they declare.
 * Callers sort by path first — timestamped migration names make that the
 * application order.
 */
export function parseSqlMigrations(files: SqlFile[]): SqlSchemaResult {
  const tables = new Map<string, SqlTable>();
  const orphanPolicies: SqlPolicy[] = [];

  for (const file of files) {
    for (const stmt of statements(file.text)) {
      readStatement(stmt, file, tables, orphanPolicies);
    }
  }

  return { tables: [...tables.values()], orphanPolicies };
}

// --- statements ---------------------------------------------------------------

interface Statement {
  /** The statement with comments blanked out; offsets match the original text. */
  text: string;
  /** 1-based line where the statement starts. */
  line: number;
  /** 1-based line where it ends. */
  endLine: number;
}

/**
 * Splits on `;` while respecting the three ways SQL hides one: 'strings',
 * "identifiers", and $dollar$ quoting (which is how every plpgsql function body
 * arrives). Comments are blanked to spaces — same length, so line numbers and
 * paren-matching stay honest.
 */
function statements(raw: string): Statement[] {
  const text = blankComments(raw);
  const out: Statement[] = [];
  let start = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "'") i = skipSingleQuoted(text, i);
    else if (ch === '"') i = skipDoubleQuoted(text, i);
    else if (ch === '$') i = skipDollarQuoted(text, i);
    else if (ch === ';') {
      pushStatement(out, text, start, i);
      i += 1;
      start = i;
    } else i += 1;
  }
  pushStatement(out, text, start, text.length);
  return out;
}

function pushStatement(out: Statement[], text: string, start: number, end: number): void {
  const slice = text.slice(start, end);
  if (!slice.trim()) return;
  const lead = slice.length - slice.trimStart().length;
  out.push({
    text: slice.trim(),
    line: lineAt(text, start + lead),
    endLine: lineAt(text, end),
  });
}

function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text[i] === '\n') line += 1;
  return line;
}

/** Blanks `--` and `/* *​/` comments (nested, as Postgres allows) to spaces. */
function blankComments(text: string): string {
  const out = text.split('');
  let i = 0;
  let depth = 0;
  while (i < text.length) {
    const two = text.slice(i, i + 2);
    if (depth > 0) {
      if (two === '*/') {
        depth -= 1;
        out[i] = out[i + 1] = ' ';
        i += 2;
      } else {
        if (text[i] !== '\n') out[i] = ' ';
        i += 1;
      }
    } else if (two === '/*') {
      depth += 1;
      out[i] = out[i + 1] = ' ';
      i += 2;
    } else if (two === '--') {
      while (i < text.length && text[i] !== '\n') {
        out[i] = ' ';
        i += 1;
      }
    } else if (text[i] === "'") i = skipSingleQuoted(text, i);
    else if (text[i] === '"') i = skipDoubleQuoted(text, i);
    else if (text[i] === '$') i = skipDollarQuoted(text, i);
    else i += 1;
  }
  return out.join('');
}

function skipSingleQuoted(text: string, start: number): number {
  let i = start + 1;
  while (i < text.length) {
    if (text[i] === "'") {
      if (text[i + 1] === "'") i += 2; // '' escapes a quote
      else return i + 1;
    } else i += 1;
  }
  return i;
}

function skipDoubleQuoted(text: string, start: number): number {
  const end = text.indexOf('"', start + 1);
  return end === -1 ? text.length : end + 1;
}

function skipDollarQuoted(text: string, start: number): number {
  const open = /^\$[A-Za-z0-9_]*\$/.exec(text.slice(start));
  if (!open) return start + 1; // a lone `$`, e.g. in a default expression
  const close = text.indexOf(open[0], start + open[0].length);
  return close === -1 ? text.length : close + open[0].length;
}

// --- reading one statement ------------------------------------------------------

const CREATE_TABLE =
  /^create\s+(?:unlogged\s+|temporary\s+|temp\s+)?table\s+(?:if\s+not\s+exists\s+)?([^\s(]+)\s*\(/i;
const ALTER_TABLE = /^alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?([^\s(]+)\s+([\s\S]*)$/i;
const CREATE_POLICY = /^create\s+policy\s+("[^"]+"|\S+)\s+on\s+(\S+)([\s\S]*)$/i;
const DROP_TABLE = /^drop\s+table\s+(?:if\s+exists\s+)?([^\s,;]+)/i;
const COMMENT_ON = /^comment\s+on\s+table\s+(\S+)\s+is\s+'((?:[^']|'')*)'/i;

function readStatement(
  stmt: Statement,
  file: SqlFile,
  tables: Map<string, SqlTable>,
  orphanPolicies: SqlPolicy[],
): void {
  const create = CREATE_TABLE.exec(stmt.text);
  if (create) {
    const name = tableKey(create[1]);
    // `if not exists` semantics either way: the first declaration wins, later ones
    // are the migration idempotently re-running.
    if (tables.has(name)) return;
    const openParen = stmt.text.indexOf('(', create[0].length - 1);
    const body = parenBody(stmt.text, openParen);
    if (body === null) return;
    const table: SqlTable = {
      name,
      fields: [],
      doc: null,
      line: stmt.line,
      endLine: stmt.endLine,
      path: file.path,
      rlsEnabled: false,
      policies: [],
    };
    for (const entry of splitTopLevel(body)) readTableEntry(entry.trim(), table);
    tables.set(name, table);
    return;
  }

  const alter = ALTER_TABLE.exec(stmt.text);
  if (alter) {
    const table = tables.get(tableKey(alter[1]));
    if (table) readAlterations(alter[2], table);
    return;
  }

  const policy = CREATE_POLICY.exec(stmt.text);
  if (policy) {
    const command = /\bfor\s+(all|select|insert|update|delete)\b/i.exec(policy[3]);
    const record: SqlPolicy = {
      name: unquote(policy[1]),
      command: (command?.[1] ?? 'all').toLowerCase(),
      path: file.path,
      line: stmt.line,
    };
    const table = tables.get(tableKey(policy[2]));
    if (table) table.policies.push(record);
    else orphanPolicies.push(record);
    return;
  }

  const drop = DROP_TABLE.exec(stmt.text);
  if (drop) {
    tables.delete(tableKey(drop[1]));
    return;
  }

  const comment = COMMENT_ON.exec(stmt.text);
  if (comment) {
    const table = tables.get(tableKey(comment[1]));
    if (table) table.doc = comment[2].replace(/''/g, "'");
  }
}

/**
 * The clauses of one ALTER TABLE, comma-separated at the top level. Only the ones
 * that change shape or protection are read; the rest (SET, OWNER, VALIDATE…) are
 * someone else's business.
 */
function readAlterations(clauses: string, table: SqlTable): void {
  for (const raw of splitTopLevel(clauses)) {
    const clause = raw.trim();

    if (/^enable\s+row\s+level\s+security/i.test(clause)) {
      table.rlsEnabled = true;
    } else if (/^disable\s+row\s+level\s+security/i.test(clause)) {
      table.rlsEnabled = false;
    } else if (/^add\s+(?:column\s+)?(?:if\s+not\s+exists\s+)?/i.test(clause) && !/^add\s+constraint/i.test(clause)) {
      const def = clause.replace(/^add\s+(?:column\s+)?(?:if\s+not\s+exists\s+)?/i, '');
      if (!table.fields.some((f) => f.name === columnName(def))) readTableEntry(def, table);
    } else if (/^add\s+constraint/i.test(clause)) {
      readTableEntry(clause.replace(/^add\s+/i, ''), table);
    } else if (/^drop\s+column/i.test(clause)) {
      const name = clause.replace(/^drop\s+column\s+(?:if\s+exists\s+)?/i, '').split(/[\s,]/)[0];
      table.fields = table.fields.filter((f) => f.name !== unquote(name));
    } else {
      const retype = /^alter\s+(?:column\s+)?(\S+)\s+(?:set\s+data\s+)?type\s+([\s\S]+)$/i.exec(clause);
      if (retype) {
        const field = table.fields.find((f) => f.name === unquote(retype[1]));
        if (field) field.type = normalizeType(retype[2]);
      }
    }
  }
}

/** One entry of a CREATE TABLE body: a column definition or a table constraint. */
function readTableEntry(entry: string, table: SqlTable): void {
  if (!entry) return;

  const constraint = /^constraint\s+\S+\s+([\s\S]+)$/i.exec(entry);
  if (constraint) return readTableEntry(constraint[1].trim(), table);

  const pk = /^primary\s+key\s*\(([^)]*)\)/i.exec(entry);
  if (pk) {
    for (const col of pk[1].split(',')) {
      const field = table.fields.find((f) => f.name === unquote(col.trim()));
      if (field) {
        field.isId = true;
        field.optional = false;
      }
    }
    return;
  }

  const fk = /^foreign\s+key\s*\(([^)]*)\)\s*references\s+([^\s(]+)/i.exec(entry);
  if (fk) {
    const cols = fk[1].split(',').map((c) => unquote(c.trim()));
    if (cols.length === 1) {
      const field = table.fields.find((f) => f.name === cols[0]);
      if (field) field.relationTo = tableKey(fk[2]);
    }
    return;
  }

  const unique = /^unique\s*\(([^)]*)\)/i.exec(entry);
  if (unique) {
    const cols = unique[1].split(',').map((c) => unquote(c.trim()));
    if (cols.length === 1) {
      const field = table.fields.find((f) => f.name === cols[0]);
      if (field) field.isUnique = true;
    }
    return;
  }

  // Anything else opening with a keyword is a constraint flavour we do not read.
  if (/^(check|exclude|like)\b/i.test(entry)) return;

  const field = readColumn(entry);
  if (field) table.fields.push(field);
}

/**
 * Words that end the type and start the modifiers. `timestamp with time zone` and
 * `double precision` survive because neither `with` nor `precision` is in the list.
 */
const MODIFIER =
  /\b(not\s+null|null|default|primary\s+key|references|unique|check|constraint|generated|collate)\b/i;

/**
 * Migrations in one repo are written by several hands and several generators: `uuid`
 * in this file, `UUID` in that one, `TIMESTAMP WITH TIME ZONE` broken across lines in
 * a third. SQL does not care, but a wall of cards that shouts half its types does. A
 * quoted type is a real identifier, though — Postgres preserves its case, so we do too.
 */
function normalizeType(raw: string): string {
  const type = raw.trim().replace(/\s+/g, ' ');
  return type.includes('"') ? type : type.toLowerCase();
}

function readColumn(entry: string): SchemaField | null {
  const m = /^("[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)\s+([\s\S]+)$/.exec(entry);
  if (!m) return null;
  const name = unquote(m[1]);
  const rest = m[2];

  const cut = MODIFIER.exec(rest);
  const type = normalizeType(cut ? rest.slice(0, cut.index) : rest);
  const modifiers = cut ? rest.slice(cut.index) : '';
  if (!type) return null;

  const isId = /\bprimary\s+key\b/i.test(modifiers);
  const notNull = /\bnot\s+null\b/i.test(modifiers) || /\bgenerated\b[\s\S]*\bidentity\b/i.test(modifiers);
  const ref = /\breferences\s+([^\s(,]+)/i.exec(modifiers);

  return {
    name,
    type,
    optional: !notNull && !isId,
    list: false,
    relationTo: ref ? tableKey(ref[1]) : null,
    isId,
    isUnique: /\bunique\b/i.test(modifiers),
  };
}

// --- small helpers ----------------------------------------------------------------

/** The body between a `(` and its matching `)`, quote-aware. Null when unbalanced. */
function parenBody(text: string, openParen: number): string | null {
  let depth = 0;
  let i = openParen;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "'") i = skipSingleQuoted(text, i);
    else if (ch === '"') i = skipDoubleQuoted(text, i);
    else {
      if (ch === '(') depth += 1;
      if (ch === ')') {
        depth -= 1;
        if (depth === 0) return text.slice(openParen + 1, i);
      }
      i += 1;
    }
  }
  return null;
}

/** Splits on commas that sit outside every paren and quote. */
function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  while (i < body.length) {
    const ch = body[i];
    if (ch === "'") i = skipSingleQuoted(body, i);
    else if (ch === '"') i = skipDoubleQuoted(body, i);
    else {
      if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
      else if (ch === ',' && depth === 0) {
        parts.push(body.slice(start, i));
        start = i + 1;
      }
      i += 1;
    }
  }
  parts.push(body.slice(start));
  return parts;
}

/** The identifier that opens a column definition. */
function columnName(def: string): string {
  const m = /^("[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)/.exec(def.trim());
  return m ? unquote(m[1]) : '';
}

/** `public.page_views` → `page_views`; `"Weird Name"` kept as written. */
function tableKey(raw: string): string {
  const parts = raw.split('.');
  return unquote(parts[parts.length - 1]);
}

function unquote(raw: string): string {
  if (raw.startsWith('"') && raw.endsWith('"') && raw.length > 1) return raw.slice(1, -1);
  // Unquoted identifiers fold to lower case in Postgres, and the queries the
  // analyzer sees (`.from('page_views')`) use the folded form.
  return raw.toLowerCase();
}

// ---------------------------------------------------------------------------
// Statements, as opposed to schema
// ---------------------------------------------------------------------------

/** What a query does and to what, when a call passes the SQL as a string. */
export interface SqlStatement {
  operation: 'read' | 'write';
  /** The first table named, or `null` when the statement never spells one out. */
  table: string | null;
}

/**
 * Reads a query string well enough to say which way the data moved.
 *
 * `cur.execute(sql)` is how every DB-API client in Python is used, and the method name
 * alone says nothing — the verb is inside the string. Anything that is not recognisably
 * a statement returns `null` rather than a guess, because "this line touches the
 * database" is a claim, and an f-string that happens to start with a word is not
 * evidence for it.
 */
export function readSqlStatement(sql: string, complete = true): SqlStatement | null {
  const text = sql.trim();
  const verb = /^\(?\s*(select|insert|update|delete|replace|with|create|drop|alter|truncate)\b/i.exec(text);
  if (!verb) return null;
  const kind = verb[1].toLowerCase();
  const reads = kind === 'select' || kind === 'with';
  return { operation: reads ? 'read' : 'write', table: complete ? tableInStatement(text) : null };
}

/**
 * The first table a statement names — after `from`, `into`, `update` or `table`.
 *
 * Only called on a query we have in full. An f-string arrives with its holes closed up,
 * so `f"SELECT * FROM {table} LIMIT {n}"` reads as `SELECT * FROM  LIMIT` and this would
 * answer "limit" with a straight face. The verb survives that; the table does not.
 */
function tableInStatement(sql: string): string | null {
  const name = `("[^"]+"|\`[^\`]+\`|[A-Za-z_][\\w$]*(?:\\.[A-Za-z_][\\w$]*)*)`;
  const match =
    new RegExp(`\\bfrom\\s+${name}`, 'i').exec(sql) ??
    new RegExp(`\\binto\\s+${name}`, 'i').exec(sql) ??
    new RegExp(`\\b(?:update|table)\\s+(?:if\\s+(?:not\\s+)?exists\\s+)?${name}`, 'i').exec(sql);
  if (!match) return null;
  return qualifiedTable(match[1].replace(/`/g, '"'));
}

/** Schemas every database has, where `public.orders` and `orders` are the same table. */
const DEFAULT_SCHEMAS = new Set(['public', 'dbo', 'main']);

// ---------------------------------------------------------------------------
// The database's own bookkeeping
// ---------------------------------------------------------------------------

/** Schemas a database keeps for itself. Set by the vendors, not by any repo. */
const CATALOG_SCHEMAS = new Set([
  'information_schema', // ANSI, and honoured by MySQL, Postgres and SQL Server alike
  'pg_catalog',
  'pg_toast',
  'performance_schema', // MySQL
  'mysql', // MySQL's own grant tables
  'sys', // SQL Server's catalog, and MySQL's helper views over performance_schema
  'sysibm', // Db2
]);

/**
 * Oracle's dictionary views, spelled out rather than matched by prefix.
 *
 * Oracle writes these unqualified, so the only rule available is the shape of the
 * name — and `ALL_`/`USER_`/`DBA_` as a prefix rule would take `user_sessions` and
 * `user_accounts` out of the data model of every app that has one. Dropping a real
 * table is a worse failure than keeping a catalog row, so this is a list.
 */
const ORACLE_DICTIONARY = new Set([
  'all_tables', 'all_tab_columns', 'all_objects', 'all_constraints', 'all_indexes',
  'all_views', 'all_triggers', 'all_sequences', 'all_users',
  'user_tables', 'user_tab_columns', 'user_objects', 'user_constraints',
  'user_indexes', 'user_views', 'user_triggers', 'user_sequences',
  'dba_tables', 'dba_tab_columns', 'dba_objects', 'dba_constraints', 'dba_indexes',
  'dba_views', 'dba_users', 'dba_triggers',
]);

/**
 * The catalog a table name belongs to, or `null` for an ordinary table.
 *
 * A schema-dump script really does read `information_schema.columns`, and reading it
 * as a database read is correct. Filing it under the app's *data model* is not: it
 * lands in the same list as `estimates` and `productioncontroljobs`, and a reader
 * learning the domain from that page comes away believing there is a table called
 * `information_schema.routines`.
 *
 * So the read still counts and the table does not — see `collectStores`, which keeps
 * these apart rather than dropping them, because "this app inspects its own schema"
 * is a true and different fact about a codebase.
 */
export function catalogSchema(table: string): string | null {
  const parts = table.split('.').map((part) => unquote(part.trim()));
  const name = parts[parts.length - 1];
  if (!name) return null;

  if (parts.length > 1 && CATALOG_SCHEMAS.has(parts[parts.length - 2])) {
    return parts[parts.length - 2];
  }
  // Postgres and SQLite both reserve their prefix for the system, so no app owns one
  // of these — which matters because `pg_stat_activity` and `sqlite_master` are
  // almost always written without their schema.
  if (name.startsWith('pg_')) return 'pg_catalog';
  if (name.startsWith('sqlite_')) return 'sqlite';
  if (ORACLE_DICTIONARY.has(name)) return 'oracle dictionary';
  return null;
}

/**
 * `public.orders` → `orders`, but `information_schema.columns` keeps its schema.
 *
 * Dropping every qualifier turns the catalog a schema-dump script reads into a table
 * called `columns` sitting in the list beside the app's own — which invites the reader
 * to go looking for it.
 */
function qualifiedTable(raw: string): string | null {
  const parts = raw.split('.');
  const table = unquote(parts[parts.length - 1]);
  if (!table || !/^[a-z_][\w$]*$/i.test(table)) return null;
  if (parts.length === 1) return table;
  const schema = unquote(parts[parts.length - 2]);
  return DEFAULT_SCHEMAS.has(schema) ? table : `${schema}.${table}`;
}
