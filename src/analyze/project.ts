/**
 * @fileoverview Project discovery.
 *
 * Works out what we are looking at before any parsing happens: the app's name, its
 * source files (honouring .gitignore), its tsconfig, and a first guess at the
 * frameworks in play. Deliberately cheap — no compiler is started here.
 */
import fs from 'node:fs';
import path from 'node:path';
import fg from 'fast-glob';
import ignoreFactory from 'ignore';
import type { Zone } from '../model/types.js';
import { goFrameworkFor } from './generic/go/frameworks.js';
import { extOf, relPosix, toPosix } from '../util/paths.js';
import { readSignals } from './signals.js';
import type { ProjectSignals } from './signals.js';
import { isWorker } from './wrangler.js';
import { classifyZone } from './zones.js';

export interface SourceFileRef {
  absPath: string;
  relPath: string;
  zone: Zone;
}

export interface ProjectInfo {
  root: string;
  name: string;
  tsConfigPath: string | null;
  packageJson: Record<string, unknown> | null;
  files: SourceFileRef[];
  frameworks: string[];
  /** What the config files say: routers, crons, the database engine, `.env.example`. */
  signals: ProjectSignals;
  /**
   * Workspace globs, if this looks like a monorepo.
   *
   * No warning goes with them any more. It used to say per-app scopes were still to
   * come, and it was printed at the top of a run that had just listed the apps by name
   * — a warning that contradicts the screen it is on teaches the reader to skip the
   * warnings, which is where the real ones live.
   */
  workspaces: string[];
  /** Extra patterns the caller asked to leave out. Part of the cache fingerprint. */
  ignored: string[];
  /**
   * Files in a format that imports modules and that no analyzer here reads — a Vue,
   * Svelte or Astro component. Counted, never parsed.
   *
   * They are counted at all because of what their absence does to a question phrased as
   * an absence. A `.vue` file's whole job is to import the code it renders; when twenty
   * of them are invisible, twenty files' worth of links are missing from the import
   * graph and whatever they imported looks as though nothing points at it. Gitea's
   * `ViewFileTreeStore.ts` is imported by two `.vue` files and by nothing else.
   */
  unreadFormats: { ext: string; count: number }[];
  warnings: string[];
}

export interface DiscoverOptions {
  maxFiles: number;
  extraIgnores?: string[];
  /**
   * The directory the user actually asked about, when this run has narrowed to one app
   * inside it. Defaults to the root being discovered, which is the answer for every
   * ordinary repo.
   *
   * Only the deployment files read it. A `docker-compose.yml` describes the whole stack
   * and sits at the top of the repo, so a run that has focused on `backend/` must still
   * be able to see it — while every file this project *parses* stays inside the app, as
   * it must. Never derived by walking upwards: if somebody names `./backend` on the
   * command line, `./backend` is the boundary.
   */
  repoRoot?: string;
}

export const SOURCE_GLOB = '**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs,py,pyi,ipynb,go}';

/**
 * Single-file component formats: a module in every sense except that nothing here can
 * parse one. Counted so that anything reading the import graph knows how much of it is
 * missing. Deliberately not `.mdx`, which is prose that occasionally imports a component
 * rather than code that always does.
 */
const UNREAD_FORMAT_GLOB = '**/*.{vue,svelte,astro}';

export const DEFAULT_IGNORES = [
  '**/node_modules/**',
  '**/.git/**',
  '**/.app-atlas/**',
  '**/dist/**',
  '**/build/**',
  '**/out/**',
  '**/.next/**',
  '**/.nuxt/**',
  '**/.svelte-kit/**',
  '**/.turbo/**',
  '**/.vercel/**',
  '**/.venv/**',
  '**/venv/**',
  '**/coverage/**',
  '**/vendor/**',
  '**/__pycache__/**',
  '**/.ipynb_checkpoints/**',
  '**/*.min.js',
  '**/*.bundle.js',
];

/** Package-name → friendly framework label. First-pass detection only; M2 adds real plugins. */
const FRAMEWORK_SIGNALS: Record<string, string> = {
  next: 'Next.js',
  '@sveltejs/kit': 'SvelteKit',
  '@remix-run/react': 'Remix',
  '@remix-run/node': 'Remix',
  '@react-router/dev': 'React Router',
  react: 'React',
  'react-native': 'React Native',
  vue: 'Vue',
  svelte: 'Svelte',
  '@angular/core': 'Angular',
  express: 'Express',
  fastify: 'Fastify',
  hono: 'Hono',
  '@nestjs/core': 'NestJS',
  '@trpc/server': 'tRPC',
  '@prisma/client': 'Prisma',
  'drizzle-orm': 'Drizzle',
  mongoose: 'Mongoose',
  kysely: 'Kysely',
  '@supabase/supabase-js': 'Supabase',
  'next-auth': 'NextAuth',
  '@clerk/nextjs': 'Clerk',
  stripe: 'Stripe',
  openai: 'OpenAI',
  '@anthropic-ai/sdk': 'Anthropic',
  resend: 'Resend',
  electron: 'Electron',
  vite: 'Vite',
};

/** Distribution name (as written in requirements.txt) → friendly framework label. */
const PYTHON_FRAMEWORKS: Record<string, string> = {
  fastapi: 'FastAPI',
  flask: 'Flask',
  django: 'Django',
  quart: 'Quart',
  sanic: 'Sanic',
  starlette: 'Starlette',
  celery: 'Celery',
  sqlalchemy: 'SQLAlchemy',
  sqlmodel: 'SQLModel',
  pydantic: 'Pydantic',
  streamlit: 'Streamlit',
  'djangorestframework': 'Django REST Framework',
};


export async function discoverProject(rootInput: string, options: DiscoverOptions): Promise<ProjectInfo> {
  const root = path.resolve(rootInput);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`Not a directory: ${root}`);
  }

  const warnings: string[] = [];
  const packageJson = readJson(path.join(root, 'package.json'));
  const name =
    (typeof packageJson?.name === 'string' && packageJson.name.trim()) || path.basename(root) || 'app';

  const tsConfigPath = findTsConfig(root);
  const signals = readSignals(root, packageJson, options.repoRoot ? path.resolve(options.repoRoot) : root);
  const workspaces = readWorkspaces(root, packageJson);

  const found = await fg(SOURCE_GLOB, {
    cwd: root,
    absolute: false,
    dot: false,
    onlyFiles: true,
    followSymbolicLinks: false,
    suppressErrors: true,
    ignore: [...DEFAULT_IGNORES, ...(options.extraIgnores ?? [])],
  });

  const filtered = applyGitignore(root, found.map(toPosix)).sort((a, b) => a.localeCompare(b));

  const components = await fg(UNREAD_FORMAT_GLOB, {
    cwd: root,
    absolute: false,
    dot: false,
    onlyFiles: true,
    followSymbolicLinks: false,
    suppressErrors: true,
    ignore: [...DEFAULT_IGNORES, ...(options.extraIgnores ?? [])],
  });
  const unreadFormats = countByExtension(applyGitignore(root, components.map(toPosix)));

  let relPaths = filtered;
  if (relPaths.length > options.maxFiles) {
    warnings.push(
      `Found ${relPaths.length} source files; analyzing the first ${options.maxFiles}. Raise the cap with --max-files.`,
    );
    relPaths = relPaths.slice(0, options.maxFiles);
  }

  const files: SourceFileRef[] = relPaths.map((relPath) => ({
    relPath,
    absPath: path.join(root, relPath),
    zone: classifyZone(relPath),
  }));

  return {
    root,
    name,
    tsConfigPath,
    packageJson,
    files,
    frameworks: detectFrameworks(packageJson, signals),
    signals,
    workspaces,
    ignored: options.extraIgnores ?? [],
    unreadFormats,
    warnings,
  };
}

/** `['a.vue', 'b.vue', 'c.svelte']` → `[{ ext: '.vue', count: 2 }, …]`, commonest first. */
function countByExtension(relPaths: string[]): { ext: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const relPath of relPaths) {
    const ext = extOf(relPath);
    counts.set(ext, (counts.get(ext) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([ext, count]) => ({ ext, count }))
    .sort((a, b) => b.count - a.count || a.ext.localeCompare(b.ext));
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Prefers the root tsconfig; falls back to a common nested location. */
function findTsConfig(root: string): string | null {
  for (const candidate of ['tsconfig.json', 'jsconfig.json', 'src/tsconfig.json']) {
    const p = path.join(root, candidate);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function readWorkspaces(root: string, pkg: Record<string, unknown> | null): string[] {
  const out: string[] = [];
  const ws = pkg?.workspaces;
  if (Array.isArray(ws)) out.push(...ws.filter((w): w is string => typeof w === 'string'));
  else if (ws && typeof ws === 'object' && Array.isArray((ws as { packages?: unknown }).packages)) {
    out.push(...((ws as { packages: unknown[] }).packages.filter((w) => typeof w === 'string') as string[]));
  }
  const pnpm = path.join(root, 'pnpm-workspace.yaml');
  if (fs.existsSync(pnpm)) {
    const text = fs.readFileSync(pnpm, 'utf8');
    for (const line of text.split('\n')) {
      const m = /^\s*-\s*['"]?([^'"\n]+?)['"]?\s*$/.exec(line);
      if (m) out.push(m[1]);
    }
  }
  return [...new Set(out)];
}

function detectFrameworks(pkg: Record<string, unknown> | null, signals: ProjectSignals): string[] {
  const out = new Set<string>();
  if (pkg) {
    const deps = {
      ...(pkg.dependencies as Record<string, string> | undefined),
      ...(pkg.devDependencies as Record<string, string> | undefined),
    };
    for (const [dep, label] of Object.entries(FRAMEWORK_SIGNALS)) {
      if (deps[dep]) out.add(label);
    }
  }
  // Config files know things package.json does not: which Next.js router is in use,
  // and whether anything is scheduled.
  if (signals.nextAppDir) out.add('Next.js App Router');
  if (signals.nextPagesDir && !signals.nextAppDir) out.add('Next.js Pages Router');
  if (signals.expoRouterDir) out.add('Expo Router');
  if (signals.crons.length > 0) out.add('Vercel Cron');
  // A wrangler config is the only place a Cloudflare deploy is written down; the
  // dependency list often does not mention it at all.
  if (signals.workers.some(isWorker)) out.add('Cloudflare Workers');
  if (signals.workers.some((w) => w.isPages)) out.add('Cloudflare Pages');
  for (const [dep, label] of Object.entries(PYTHON_FRAMEWORKS)) {
    if (signals.pythonPackages.has(dep)) out.add(label);
  }
  for (const module of signals.goModules) {
    const label = goFrameworkFor(module);
    if (label) out.add(label);
  }
  return [...out].sort();
}

/**
 * Applies the repo's root .gitignore. Generated code is the single biggest source of
 * noise in these maps, and .gitignore is the most reliable signal for it.
 */
function applyGitignore(root: string, relPaths: string[]): string[] {
  const gitignorePath = path.join(root, '.gitignore');
  if (!fs.existsSync(gitignorePath)) return relPaths;
  try {
    const matcher = ignoreFactory().add(fs.readFileSync(gitignorePath, 'utf8'));
    return relPaths.filter((p) => !matcher.ignores(p));
  } catch {
    return relPaths;
  }
}

/** Convenience for callers that only have an absolute path. */
export function toRelative(root: string, absPath: string): string {
  return relPosix(root, absPath);
}
