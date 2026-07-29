/**
 * @fileoverview Finding the apps inside a monorepo.
 *
 * SPEC.md 5.6: one atlas per deployable app or package, with a switcher, rather than
 * one atlas of everything. That is a readability decision before it is a technical one
 * — a single map of six apps is the hairball this tool exists to avoid — and it matches
 * how people talk about their own repo: "my web app", "my API".
 *
 * Each scope keeps its cache in its own directory, so `app-atlas apps/web` inside a
 * monorepo is exactly the same operation as `app-atlas` in a single-app repo. Only the
 * manifest at the root knows they are related.
 */
import fs from 'node:fs';
import path from 'node:path';
import fg from 'fast-glob';
import { toPosix } from '../util/paths.js';
import { DEFAULT_IGNORES, SOURCE_GLOB } from './project.js';

export interface Scope {
  /** Stable id, derived from the directory: `apps-web`. Used in URLs and paths. */
  id: string;
  /** What to call it on screen. */
  name: string;
  /** Repo-relative directory, POSIX. */
  dir: string;
  /**
   * `app` is something that runs and can be deployed; `library` is shared code that
   * only exists to be imported. Apps come first in the switcher because they are what
   * someone means when they say "my project".
   */
  kind: 'app' | 'library';
}

/** Dependencies that mean "this thing runs" rather than "this thing is imported". */
const APP_DEPENDENCIES = new Set([
  'next',
  'react-dom',
  'vue',
  'svelte',
  '@angular/core',
  'express',
  'fastify',
  'hono',
  '@nestjs/core',
  'vite',
  'electron',
  'react-native',
  'expo',
  'astro',
  'remix',
  '@remix-run/node',
  'nuxt',
]);

const APP_SCRIPTS = ['dev', 'start', 'serve'];

/**
 * Every scope in a workspace, or an empty list when this is an ordinary single-app
 * repo. Callers treat "no scopes" and "one scope" the same way: analyze the root.
 */
export async function findScopes(root: string): Promise<Scope[]> {
  const globs = workspaceGlobs(root);
  if (globs.length === 0) return [];

  const found = await fg(
    globs.map((glob) => `${glob.replace(/\/$/, '')}/{package.json,pyproject.toml}`),
    {
      cwd: root,
      dot: false,
      onlyFiles: true,
      followSymbolicLinks: false,
      suppressErrors: true,
      ignore: ['**/node_modules/**', '**/.venv/**', '**/dist/**', '**/build/**'],
    },
  );

  const byDir = new Map<string, Scope>();
  for (const manifest of found.map(toPosix).sort()) {
    const dir = path.posix.dirname(manifest);
    if (dir === '.' || byDir.has(dir)) continue;
    byDir.set(dir, describeScope(root, dir));
  }

  const scopes = [...byDir.values()];
  // One package in a workspace is not a monorepo worth a switcher.
  if (scopes.length < 2) return [];

  return leadWithTheMainApp(scopes.sort(byKindThenName), await measure(root, scopes));
}

function byKindThenName(a: Scope, b: Scope): number {
  if (a.kind !== b.kind) return a.kind === 'app' ? -1 : 1;
  return a.name.localeCompare(b.name);
}

/**
 * Puts the biggest app first, and leaves everything else alphabetical.
 *
 * The landing scope is `scopes[0]` everywhere — the CLI, the server and the web app all
 * take the first one — so the order *is* the answer to "which of these is the project".
 * Alphabetical made cal.com open on `api-proxy`, 12 files of URL rewriting, while
 * `apps/web` sat 60 packages down the list and was never shown. Nobody arriving at a
 * repo of 113 packages means the first one alphabetically.
 *
 * Only one scope moves. A switcher sorted by size would be unpredictable to scan; a
 * switcher that is alphabetical after its first entry is not.
 */
function leadWithTheMainApp(scopes: Scope[], files: Map<string, number>): Scope[] {
  let best = -1;
  for (let i = 0; i < scopes.length; i++) {
    if (scopes[i].kind !== 'app') continue;
    if (best === -1 || (files.get(scopes[i].dir) ?? 0) > (files.get(scopes[best].dir) ?? 0)) best = i;
  }
  if (best <= 0) return scopes;
  return [scopes[best], ...scopes.slice(0, best), ...scopes.slice(best + 1)];
}

/**
 * How many source files each scope owns.
 *
 * One walk for the whole workspace rather than one per package, and each file counted
 * against the *longest* directory that contains it, so a package nested inside another
 * package's tree is not counted twice.
 *
 * Deliberately not kept on the `Scope`. It is a rougher number than the one the CLI
 * prints beside each app — no gitignore, no `--max-files` — and two numbers with the
 * same name that disagree is the sort of small dishonesty this tool cannot afford.
 * Ordering is all it is for.
 */
async function measure(root: string, scopes: Scope[]): Promise<Map<string, number>> {
  const dirs = [...scopes].sort((a, b) => b.dir.length - a.dir.length);
  const counts = new Map<string, number>(dirs.map((scope) => [scope.dir, 0]));

  const files = await fg(
    dirs.map((scope) => `${scope.dir}/${SOURCE_GLOB}`),
    { cwd: root, dot: false, onlyFiles: true, followSymbolicLinks: false, suppressErrors: true, ignore: DEFAULT_IGNORES },
  );

  for (const file of files.map(toPosix)) {
    const owner = dirs.find((scope) => file.startsWith(`${scope.dir}/`));
    if (owner) counts.set(owner.dir, (counts.get(owner.dir) ?? 0) + 1);
  }
  return counts;
}

/** Where the workspace says its packages live, whichever tool declared it. */
function workspaceGlobs(root: string): string[] {
  const globs = new Set<string>();

  const pkg = readJson(path.join(root, 'package.json'));
  const workspaces = pkg?.workspaces;
  if (Array.isArray(workspaces)) {
    for (const entry of workspaces) if (typeof entry === 'string') globs.add(entry);
  } else if (workspaces && typeof workspaces === 'object') {
    const packages = (workspaces as { packages?: unknown }).packages;
    if (Array.isArray(packages)) {
      for (const entry of packages) if (typeof entry === 'string') globs.add(entry);
    }
  }

  // pnpm keeps its list in YAML. Reading the two lines we need beats a YAML parser.
  const pnpm = path.join(root, 'pnpm-workspace.yaml');
  if (fs.existsSync(pnpm)) {
    let inPackages = false;
    for (const line of readText(pnpm).split(/\r?\n/)) {
      if (/^packages:\s*$/.test(line)) {
        inPackages = true;
        continue;
      }
      if (inPackages) {
        const item = /^\s*-\s*['"]?([^'"#]+?)['"]?\s*$/.exec(line);
        if (item) globs.add(item[1]);
        else if (/^\S/.test(line)) inPackages = false;
      }
    }
  }

  // uv and Poetry both spell their member list the same way inside pyproject.toml.
  const pyproject = path.join(root, 'pyproject.toml');
  if (fs.existsSync(pyproject)) {
    const text = readText(pyproject);
    const members = /members\s*=\s*\[([^\]]*)\]/m.exec(text);
    if (members) {
      for (const match of members[1].matchAll(/["']([^"']+)["']/g)) globs.add(match[1]);
    }
  }

  return [...globs].filter((glob) => !glob.startsWith('!'));
}

function describeScope(root: string, dir: string): Scope {
  const pkg = readJson(path.join(root, dir, 'package.json'));
  const pyproject = fs.existsSync(path.join(root, dir, 'pyproject.toml'));

  const declared = typeof pkg?.name === 'string' ? pkg.name : null;
  // `@acme/web` reads as "web" in a switcher; the scope prefix is the same on all of
  // them and so carries no information.
  const name = declared ? declared.replace(/^@[^/]+\//, '') : path.posix.basename(dir);

  return {
    id: dir.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'root',
    name,
    dir,
    kind: looksLikeApp(pkg, pyproject) ? 'app' : 'library',
  };
}

/**
 * An app runs; a library is only ever imported. The signals are deliberately loose,
 * because getting this wrong only changes the order of a list — nothing is hidden.
 */
function looksLikeApp(pkg: Record<string, unknown> | null, pyproject: boolean): boolean {
  if (!pkg) return pyproject;

  const deps = {
    ...(pkg.dependencies as Record<string, string> | undefined),
    ...(pkg.devDependencies as Record<string, string> | undefined),
  };
  for (const dep of Object.keys(deps)) {
    if (APP_DEPENDENCIES.has(dep)) return true;
  }

  const scripts = (pkg.scripts as Record<string, string> | undefined) ?? {};
  return APP_SCRIPTS.some((name) => typeof scripts[name] === 'string');
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readText(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}
