/**
 * @fileoverview Project-level signals: the facts that live in config files, not code.
 *
 * A surprising amount of an app's boundary is declared outside the source: cron
 * schedules in `vercel.json`, the database engine in `schema.prisma`, the intended
 * configuration in `.env.example`. Reading them costs milliseconds and tells us
 * things no amount of AST walking would.
 *
 * Everything here is best-effort and non-fatal — a malformed config file must never
 * stop the analysis.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseSqlMigrations, type SqlPolicy, type SqlTable } from './sql.js';

export interface CronSignal {
  schedule: string;
  /** The URL the scheduler hits. */
  route: string;
  /** Which file declared it. */
  source: string;
}

/** One column of one table, as the schema declares it. */
export interface SchemaField {
  name: string;
  /** The type as written, `[]` and `?` included. */
  type: string;
  optional: boolean;
  list: boolean;
  /** The model this field points at, when its type names one. */
  relationTo: string | null;
  isId: boolean;
  isUnique: boolean;
}

export interface SchemaModel {
  name: string;
  fields: SchemaField[];
  /** A `///` comment above the model — Prisma's own docstring convention. */
  doc: string | null;
  /** 1-based line of the `model X {` that opens it. */
  line: number;
  endLine: number;
}

export interface PrismaSignal {
  /** `postgresql`, `mysql`, `sqlite`, `mongodb`… */
  provider: string;
  models: string[];
  /** The same models with their columns — what the type explorer draws. */
  tables: SchemaModel[];
  path: string;
  lineCount: number;
}

/** Tables read out of SQL migration files — the schema, for projects without Prisma. */
export interface SqlSchemaSignal {
  tables: SqlTable[];
  /** Policies on tables no migration created (`storage.objects` on Supabase). */
  orphanPolicies: SqlPolicy[];
  /** Every migration file read, repo-relative, in the order applied. */
  files: string[];
}

export interface ProjectSignals {
  /** Every declared dependency, dev included — used to gate framework detectors. */
  packages: Set<string>;
  /**
   * Python dependencies, lowercased, kept separate from the npm ones. Merging them
   * would let `redis` in a requirements file switch on a JavaScript detector, and an
   * invented box on the map is worse than a missing one.
   */
  pythonPackages: Set<string>;
  /** Which file the Python dependencies came from, if any. */
  pythonManifest: string | null;
  /** Repo-relative directory of the Next.js App Router, if there is one. */
  nextAppDir: string | null;
  /** Repo-relative directory of the Next.js Pages Router, if there is one. */
  nextPagesDir: string | null;
  crons: CronSignal[];
  prisma: PrismaSignal | null;
  sqlSchema: SqlSchemaSignal | null;
  /** Variable names documented in `.env.example` and friends. */
  envExample: Set<string>;
  envExamplePath: string | null;
}

export function readSignals(root: string, packageJson: Record<string, unknown> | null): ProjectSignals {
  const packages = readPackages(packageJson);
  const prisma = readPrismaSchema(root);
  return {
    packages,
    nextAppDir: packages.has('next') ? firstExistingDir(root, ['app', 'src/app']) : null,
    nextPagesDir: packages.has('next') ? firstExistingDir(root, ['pages', 'src/pages']) : null,
    crons: readVercelCrons(root),
    prisma,
    // When Prisma is present its migrations are generated from schema.prisma, so
    // reading both would declare every table twice.
    sqlSchema: readSqlSchema(root, prisma !== null),
    ...readPythonPackages(root),
    ...readEnvExample(root),
  };
}

/** The migration folders projects actually use. Checked, not globbed — a glob over an
 * unknown repo can wander into gigabytes of vendored code for three .sql files. */
const MIGRATION_DIRS = [
  'supabase/migrations',
  'migrations',
  'db/migrations',
  'database/migrations',
  'sql/migrations',
  'drizzle',
  'drizzle/migrations',
  'prisma/migrations',
];

const MAX_MIGRATION_FILES = 400;

/**
 * Reads the schema out of SQL migrations, replayed in filename order — which is
 * application order, because every migration tool timestamps its filenames precisely
 * so that lexical order is run order.
 */
export function readSqlSchema(root: string, hasPrisma: boolean): SqlSchemaSignal | null {
  const files: { path: string; text: string }[] = [];
  for (const dir of MIGRATION_DIRS) {
    if (hasPrisma && dir === 'prisma/migrations') continue;
    const abs = path.join(root, dir);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true, recursive: true });
    } catch {
      continue;
    }
    const sqlFiles = entries
      .filter((e) => e.isFile() && e.name.endsWith('.sql'))
      .map((e) => path.join(e.parentPath, e.name))
      .sort()
      .slice(0, MAX_MIGRATION_FILES);
    for (const absFile of sqlFiles) {
      try {
        files.push({
          path: path.relative(root, absFile).split(path.sep).join('/'),
          text: fs.readFileSync(absFile, 'utf8'),
        });
      } catch {
        // A single unreadable migration must not cost the rest of the schema.
      }
    }
  }
  if (files.length === 0) return null;

  const parsed = parseSqlMigrations(files);
  if (parsed.tables.length === 0 && parsed.orphanPolicies.length === 0) return null;
  return { tables: parsed.tables, orphanPolicies: parsed.orphanPolicies, files: files.map((f) => f.path) };
}

/**
 * Python dependencies, from whichever manifest the project uses.
 *
 * Deliberately a lexer rather than a parser: `requirements.txt` has no grammar worth
 * the name, and pyproject.toml would cost a TOML dependency to read three lines out of.
 * All that is needed is the set of distribution names, and a line-by-line read of
 * either file gets that right.
 */
function readPythonPackages(root: string): { pythonPackages: Set<string>; pythonManifest: string | null } {
  const packages = new Set<string>();
  let manifest: string | null = null;

  for (const name of ['requirements.txt', 'requirements-dev.txt', 'requirements/base.txt']) {
    const file = path.join(root, name);
    if (!fs.existsSync(file)) continue;
    manifest ??= name;
    for (const line of splitLines(readText(file))) {
      const stripped = line.split('#')[0].trim();
      if (!stripped || stripped.startsWith('-')) continue;
      const match = /^([A-Za-z0-9._-]+)/.exec(stripped);
      if (match) packages.add(normalizeDistribution(match[1]));
    }
  }

  const pyproject = path.join(root, 'pyproject.toml');
  if (fs.existsSync(pyproject)) {
    manifest ??= 'pyproject.toml';
    // Covers both spellings: PEP 621 `dependencies = ["fastapi>=0.1"]` and Poetry's
    // `[tool.poetry.dependencies]` table of `fastapi = "^0.1"`.
    for (const line of splitLines(readText(pyproject))) {
      const quoted = /^\s*["']([A-Za-z0-9._-]+)\s*[<>=!~\[;]/.exec(line);
      if (quoted) packages.add(normalizeDistribution(quoted[1]));
      const bare = /^\s*["']?([A-Za-z0-9._-]+)["']?\s*=\s*["{]/.exec(line);
      if (bare && bare[1].toLowerCase() !== 'python') packages.add(normalizeDistribution(bare[1]));
      const plain = /^\s*["']([A-Za-z0-9._-]+)["']\s*,?\s*$/.exec(line);
      if (plain) packages.add(normalizeDistribution(plain[1]));
    }
  }

  const pipfile = path.join(root, 'Pipfile');
  if (fs.existsSync(pipfile)) {
    manifest ??= 'Pipfile';
    for (const line of splitLines(readText(pipfile))) {
      const match = /^\s*["']?([A-Za-z0-9._-]+)["']?\s*=\s*/.exec(line);
      if (match && match[1].toLowerCase() !== 'python_version') packages.add(normalizeDistribution(match[1]));
    }
  }

  return { pythonPackages: packages, pythonManifest: manifest };
}

/** PyPI treats `-`, `_` and `.` as the same character, and so does everyone else. */
function normalizeDistribution(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, '-');
}

function readPackages(pkg: Record<string, unknown> | null): Set<string> {
  const names = new Set<string>();
  if (!pkg) return names;
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const deps = pkg[field];
    if (deps && typeof deps === 'object') {
      for (const name of Object.keys(deps as Record<string, unknown>)) names.add(name);
    }
  }
  return names;
}

function firstExistingDir(root: string, candidates: string[]): string | null {
  for (const candidate of candidates) {
    const full = path.join(root, candidate);
    try {
      if (fs.statSync(full).isDirectory()) return candidate;
    } catch {
      /* not there */
    }
  }
  return null;
}

/** `vercel.json` is where Vercel apps declare their scheduled work. */
function readVercelCrons(root: string): CronSignal[] {
  const out: CronSignal[] = [];
  for (const name of ['vercel.json', 'now.json']) {
    const file = path.join(root, name);
    if (!fs.existsSync(file)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { crons?: unknown };
      if (!Array.isArray(parsed.crons)) continue;
      for (const entry of parsed.crons) {
        if (!entry || typeof entry !== 'object') continue;
        const { path: route, schedule } = entry as { path?: unknown; schedule?: unknown };
        if (typeof route === 'string' && typeof schedule === 'string') {
          out.push({ route, schedule, source: name });
        }
      }
    } catch {
      /* a broken vercel.json is not our problem to report */
    }
  }
  return out;
}

/**
 * Pulls the engine, the models and their columns out of `schema.prisma`. Prisma users
 * get the name of their actual database for free instead of a generic "Database" box —
 * and, since M4, the tables themselves as shapes the type explorer can draw.
 *
 * A hand-rolled line reader rather than a real Prisma parser: the block syntax is
 * simple, the dependency is not worth it, and anything unrecognised is skipped rather
 * than allowed to fail the analysis.
 */
function readPrismaSchema(root: string): PrismaSignal | null {
  const candidates = ['prisma/schema.prisma', 'schema.prisma', 'src/prisma/schema.prisma'];
  for (const candidate of candidates) {
    const file = path.join(root, candidate);
    if (!fs.existsSync(file)) continue;
    try {
      const text = fs.readFileSync(file, 'utf8');
      const provider = /datasource\s+\w+\s*\{[^}]*?provider\s*=\s*"([^"]+)"/s.exec(text)?.[1] ?? 'sql';
      const tables = readPrismaModels(text);
      return {
        provider,
        models: tables.map((table) => table.name).sort(),
        tables,
        path: candidate,
        lineCount: splitLines(text).length,
      };
    } catch {
      return null;
    }
  }
  return null;
}

/** Scalars Prisma defines itself. Anything else naming a model is a relation. */
const PRISMA_SCALARS = new Set([
  'String',
  'Boolean',
  'Int',
  'BigInt',
  'Float',
  'Decimal',
  'DateTime',
  'Json',
  'Bytes',
  'Unsupported',
]);

/**
 * Splits on either line ending. A checkout on Windows leaves `\r` at the end of every
 * line, and a `$`-anchored pattern silently matches nothing against it — which reads
 * as "this schema has no documentation" rather than as the bug it is.
 */
function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

/** A config file that will not open tells us nothing, which is not an error. */
function readText(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function readPrismaModels(text: string): SchemaModel[] {
  const lines = splitLines(text);
  const models: SchemaModel[] = [];
  let current: SchemaModel | null = null;
  let pendingDoc: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    // `///` is Prisma's docstring. It is read verbatim, exactly like a JSDoc comment,
    // so a documented schema never needs a generated description.
    const docLine = /^\s*\/\/\/\s?(.*)$/.exec(lines[i]);
    if (docLine) {
      pendingDoc.push(docLine[1].trim());
      continue;
    }

    const line = lines[i].replace(/\/\/.*$/, '').trim();

    if (!current) {
      const open = /^model\s+(\w+)\s*\{/.exec(line);
      if (open) {
        const doc = pendingDoc.join(' ').trim();
        current = { name: open[1], fields: [], doc: doc || null, line: i + 1, endLine: i + 1 };
      }
      pendingDoc = [];
      continue;
    }

    if (line === '}') {
      current.endLine = i + 1;
      models.push(current);
      current = null;
      continue;
    }

    // `@@index([userId])` and friends describe the table, not a column.
    if (line.startsWith('@@') || line === '') continue;

    const field = /^(\w+)\s+([\w.]+)(\[\])?(\?)?(.*)$/.exec(line);
    if (!field) continue;
    const [, name, baseType, list, optional, attributes] = field;
    current.fields.push({
      name,
      type: `${baseType}${list ?? ''}${optional ?? ''}`,
      optional: Boolean(optional),
      list: Boolean(list),
      relationTo: PRISMA_SCALARS.has(baseType) ? null : baseType,
      isId: /@id\b/.test(attributes),
      isUnique: /@unique\b/.test(attributes),
    });
  }

  // An enum-typed column is not a relation. Only a type that names another table is,
  // and that can only be known once every model has been read.
  const known = new Set(models.map((model) => model.name));
  for (const model of models) {
    for (const field of model.fields) {
      if (field.relationTo && !known.has(field.relationTo)) field.relationTo = null;
    }
  }

  return models;
}

/** The variables the author meant you to set — the yardstick for the secrets badge. */
function readEnvExample(root: string): { envExample: Set<string>; envExamplePath: string | null } {
  const names = new Set<string>();
  for (const candidate of ['.env.example', '.env.sample', '.env.template', '.env.defaults']) {
    const file = path.join(root, candidate);
    if (!fs.existsSync(file)) continue;
    try {
      for (const line of splitLines(fs.readFileSync(file, 'utf8'))) {
        const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
        if (match) names.add(match[1]);
      }
      return { envExample: names, envExamplePath: candidate };
    } catch {
      /* keep looking */
    }
  }
  return { envExample: names, envExamplePath: null };
}
