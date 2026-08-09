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
import { classifyZone } from './zones.js';

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
  return (await findWorkspace(root)).scopes;
}

/**
 * The same answer, plus what was left out of it — for the one caller that prints the
 * list and therefore owes the reader an account of what is not in it (#185).
 */
export async function findWorkspace(root: string): Promise<{ scopes: Scope[]; hiddenTests: number }> {
  const byDir = new Map<string, Scope>();

  const globs = workspaceGlobs(root);
  if (globs.length > 0) {
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

    for (const manifest of found.map(toPosix).sort()) {
      const dir = path.posix.dirname(manifest);
      if (dir === '.' || byDir.has(dir)) continue;
      byDir.set(dir, describeScope(root, dir));
    }
  }

  // A .NET solution is a monorepo, declared in a different file format (#98).
  for (const scope of dotnetScopes(root)) {
    if (!byDir.has(scope.dir)) byDir.set(scope.dir, scope);
  }

  const declared = [...byDir.values()];
  // A test fixture is a declared workspace member and is not an app (#185). nuxt's
  // `pnpm-workspace.yaml` lists `test/fixtures/*`, which is how pnpm links them for the
  // test run and how the switcher came to offer 43 entries, 33 of them fixtures and
  // seventeen of those a single file each — the six packages somebody ships buried in a
  // list four-fifths noise. #174 settled this one level down (a package of tests is not
  // code other code imports) and `describesTheApp()` has kept test-zone findings out of
  // the merge all along; scope discovery simply never asked.
  //
  // Never down to nothing: a repo whose only packages are fixtures still gets them,
  // because an empty switcher on a repo that has packages is the worse answer — the
  // same floor `scopes.length < 2` draws below.
  const shipped = declared.filter((scope) => classifyZone(`${scope.dir}/package.json`) !== 'test');
  const scopes = shipped.length > 0 ? shipped : declared;
  const hiddenTests = declared.length - scopes.length;

  // One package in a workspace is not a monorepo worth a switcher.
  if (scopes.length < 2) return { scopes: [], hiddenTests: 0 };

  // Measured against *every* declared scope, hidden ones included. A dropped fixture's
  // files are still owned by that fixture — counting them as leftovers the root has
  // would hand them straight back through `includeTheRootWhenItIsTheProject`, which is
  // the fix undoing itself one function later.
  const files = await measure(root, declared);
  const all = includeTheRootWhenItIsTheProject(root, scopes, files);
  return { scopes: leadWithTheMainApp(all.sort(byKindThenName), files), hiddenTests };
}

/** Where files belong that no declared package claims. */
const ROOT = '.';

/**
 * Adds the repo itself as a scope when most of the code is not in any package.
 *
 * A `workspaces` list describes the packages, not the repo. Sentry declares three —
 * `api-docs` and two eslint plugins, sixty files between them — and its actual
 * application, several thousand Python files at the root, is in none of them. The
 * switcher offered those three and nothing else, so the whole tool reported on 60 files
 * of tooling and called it Sentry, in six tenths of a second, with no warning that
 * anything had been left out.
 *
 * Only when the leftovers outweigh every package. A root that owns less than its
 * smallest package owns a build script and a config file, and a scope for those would
 * be one more wrong thing in the list rather than one less.
 */
function includeTheRootWhenItIsTheProject(root: string, scopes: Scope[], files: Map<string, number>): Scope[] {
  const outside = files.get(ROOT) ?? 0;
  const biggest = Math.max(0, ...scopes.map((scope) => files.get(scope.dir) ?? 0));
  if (outside <= biggest) return scopes;

  const pkg = readJson(path.join(root, 'package.json'));
  const declared = typeof pkg?.name === 'string' ? pkg.name : null;
  return [
    {
      id: 'root',
      name: (declared ?? path.basename(root)).replace(/^@[^/]+\//, ''),
      dir: ROOT,
      // Whatever the manifests say, a repo whose own code outweighs all its packages is
      // the thing somebody means when they name the project.
      kind: 'app',
    },
    ...scopes,
  ];
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
 * How many source files each scope owns, and how many no package claims at all.
 *
 * One walk for the whole repo rather than one per package, and each file counted
 * against the *longest* directory that contains it, so a package nested inside another
 * package's tree is not counted twice. What is left over is charged to `.`, which is
 * what says whether the repo is its packages or has an application of its own.
 *
 * Deliberately not kept on the `Scope`. It is a rougher number than the one the CLI
 * prints beside each app — no gitignore, no `--max-files` — and two numbers with the
 * same name that disagree is the sort of small dishonesty this tool cannot afford.
 * Ordering is all it is for.
 */
async function measure(root: string, scopes: Scope[]): Promise<Map<string, number>> {
  const dirs = [...scopes].sort((a, b) => b.dir.length - a.dir.length);
  const counts = new Map<string, number>(dirs.map((scope) => [scope.dir, 0]));
  counts.set(ROOT, 0);

  const files = await fg([SOURCE_GLOB], {
    cwd: root,
    dot: false,
    onlyFiles: true,
    followSymbolicLinks: false,
    suppressErrors: true,
    ignore: DEFAULT_IGNORES,
  });

  for (const file of files.map(toPosix)) {
    const owner = dirs.find((scope) => file.startsWith(`${scope.dir}/`));
    counts.set(owner ? owner.dir : ROOT, (counts.get(owner ? owner.dir : ROOT) ?? 0) + 1);
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

/**
 * The projects a .NET repo declares, each its own scope (#98).
 *
 * A solution's split *is* the architecture — `Api → Store → Core`, arrows one way,
 * enforced by the compiler — and flattened into one map the single most useful fact
 * about the codebase is the one thing you cannot see. It also mixes archetypes: the
 * merged map has to pick one verdict for a service, a CLI and a library, and whichever
 * it picks is wrong for the other two.
 *
 * The `.sln` is read where one exists, because it says which projects are in the
 * solution at all; a repo with bare `.csproj` files scattered and no solution gets a
 * scope per project file instead. Either way a single-project repo produces one scope,
 * and one scope is below the switcher's threshold — a repo with one `.csproj` at the
 * root does not gain a switcher it has no use for.
 */
function dotnetScopes(root: string): Scope[] {
  const out: Scope[] = [];

  const describe = (projectFile: string): Scope | null => {
    const rel = toPosix(path.relative(root, projectFile));
    const dir = path.posix.dirname(rel);
    // A project at the repo root is the ordinary single-project shape, not a monorepo.
    if (dir === '.' || rel.startsWith('..')) return null;
    const name = path.posix.basename(rel).replace(/\.(cs|fs|vb)proj$/i, '');
    const text = readText(projectFile);
    // `<OutputType>Exe</OutputType>`, or the web/worker SDKs: .NET's ways of writing
    // "this is a thing you run". Everything else is code other projects reference.
    const runs =
      /<OutputType>\s*(Exe|WinExe)\s*<\/OutputType>/i.test(text) ||
      /Sdk\s*=\s*"Microsoft\.NET\.Sdk\.(Web|Worker|BlazorWebAssembly)/i.test(text);
    return {
      id: dir.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'root',
      name,
      dir,
      kind: runs ? 'app' : 'library',
    };
  };

  // The solution file, searched shallowly — `connector/Glance.sln` is the normal shape
  // for a repo whose .NET half lives in a subdirectory.
  const solutions: string[] = [];
  const scan = (dir: string, depth: number) => {
    if (depth > 2 || solutions.length > 8) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (/^(node_modules|\.git|bin|obj|packages|dist|build)$/i.test(entry.name)) continue;
        scan(path.join(dir, entry.name), depth + 1);
      } else if (/\.sln$/i.test(entry.name)) {
        solutions.push(path.join(dir, entry.name));
      }
    }
  };
  scan(root, 0);

  if (solutions.length > 0) {
    for (const sln of solutions) {
      const slnDir = path.dirname(sln);
      for (const match of readText(sln).matchAll(/^Project\("[^"]*"\)\s*=\s*"[^"]+",\s*"([^"]+)"/gim)) {
        const projectPath = match[1].replace(/\\/g, '/');
        // A solution also lists solution *folders*, whose "path" is just a name.
        if (!/\.(cs|fs|vb)proj$/i.test(projectPath)) continue;
        const scope = describe(path.resolve(slnDir, projectPath));
        if (scope && !out.some((s) => s.dir === scope.dir)) out.push(scope);
      }
    }
    return out;
  }

  // No solution: every project file is a scope, found with the same shallow walk the
  // signals reader uses.
  const projects: string[] = [];
  const scanProjects = (dir: string, depth: number) => {
    if (depth > 3 || projects.length > 100) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (/^(node_modules|\.git|bin|obj|packages|dist|build)$/i.test(entry.name)) continue;
        scanProjects(path.join(dir, entry.name), depth + 1);
      } else if (/\.(cs|fs|vb)proj$/i.test(entry.name)) {
        projects.push(path.join(dir, entry.name));
      }
    }
  };
  scanProjects(root, 0);
  for (const project of projects.sort()) {
    const scope = describe(project);
    if (scope && !out.some((s) => s.dir === scope.dir)) out.push(scope);
  }
  return out;
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
