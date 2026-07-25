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

export interface CronSignal {
  schedule: string;
  /** The URL the scheduler hits. */
  route: string;
  /** Which file declared it. */
  source: string;
}

export interface PrismaSignal {
  /** `postgresql`, `mysql`, `sqlite`, `mongodb`… */
  provider: string;
  models: string[];
  path: string;
}

export interface ProjectSignals {
  /** Every declared dependency, dev included — used to gate framework detectors. */
  packages: Set<string>;
  /** Repo-relative directory of the Next.js App Router, if there is one. */
  nextAppDir: string | null;
  /** Repo-relative directory of the Next.js Pages Router, if there is one. */
  nextPagesDir: string | null;
  crons: CronSignal[];
  prisma: PrismaSignal | null;
  /** Variable names documented in `.env.example` and friends. */
  envExample: Set<string>;
  envExamplePath: string | null;
}

export function readSignals(root: string, packageJson: Record<string, unknown> | null): ProjectSignals {
  const packages = readPackages(packageJson);
  return {
    packages,
    nextAppDir: packages.has('next') ? firstExistingDir(root, ['app', 'src/app']) : null,
    nextPagesDir: packages.has('next') ? firstExistingDir(root, ['pages', 'src/pages']) : null,
    crons: readVercelCrons(root),
    prisma: readPrismaSchema(root),
    ...readEnvExample(root),
  };
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
 * Pulls the engine and the model names out of `schema.prisma`. Prisma users get the
 * name of their actual database for free, instead of a generic "Database" box.
 */
function readPrismaSchema(root: string): PrismaSignal | null {
  const candidates = ['prisma/schema.prisma', 'schema.prisma', 'src/prisma/schema.prisma'];
  for (const candidate of candidates) {
    const file = path.join(root, candidate);
    if (!fs.existsSync(file)) continue;
    try {
      const text = fs.readFileSync(file, 'utf8');
      const provider = /datasource\s+\w+\s*\{[^}]*?provider\s*=\s*"([^"]+)"/s.exec(text)?.[1] ?? 'sql';
      const models: string[] = [];
      for (const match of text.matchAll(/^\s*model\s+(\w+)\s*\{/gm)) models.push(match[1]);
      return { provider, models: models.sort(), path: candidate };
    } catch {
      return null;
    }
  }
  return null;
}

/** The variables the author meant you to set — the yardstick for the secrets badge. */
function readEnvExample(root: string): { envExample: Set<string>; envExamplePath: string | null } {
  const names = new Set<string>();
  for (const candidate of ['.env.example', '.env.sample', '.env.template', '.env.defaults']) {
    const file = path.join(root, candidate);
    if (!fs.existsSync(file)) continue;
    try {
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
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
