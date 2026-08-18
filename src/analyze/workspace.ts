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
import { DEFAULT_IGNORES } from './ignores.js';
import { SOURCE_GLOB } from './project.js';
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
 *
 * The hidden scopes come back whole rather than as a count, because a reader who names
 * one explicitly (`--scope fixture-basic`) has out-argued the heuristic and should get
 * what they asked for. A rule about what is *worth listing* has no business deciding
 * what somebody may look at.
 */
export async function findWorkspace(root: string): Promise<{ scopes: Scope[]; hidden: Scope[] }> {
  const byDir = new Map<string, Scope>();
  const manifests = new Map<string, Record<string, unknown> | null>();

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
      const pkg = readJson(path.join(root, dir, 'package.json'));
      manifests.set(dir, pkg);
      byDir.set(dir, describeScope(root, dir, pkg));
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
  const imported = namesTheWorkspaceImports(root, declared, manifests);
  const fixtures = new Set(
    declared.filter((scope) => isTestFixture(scope, manifests.get(scope.dir) ?? null, imported)).map((s) => s.dir),
  );
  // What is inside a fixture is that fixture's material. vite declares 278 members; 136
  // of them are the fake npm packages its playground fixtures resolve against —
  // `playground/external/dep-that-imports`, `playground/resolve/exports-legacy-fallback/dir`
  // — each a package.json of three lines, none of them saying "test" in a name because
  // the whole point is to look like an ordinary dependency to the resolver being tested.
  // The fixture above them already said it, once, and saying it once is enough.
  const roots = [...fixtures];
  for (const scope of declared) {
    if (roots.some((dir) => scope.dir.startsWith(`${dir}/`))) fixtures.add(scope.dir);
  }
  const shipped = declared.filter((scope) => !fixtures.has(scope.dir));
  const scopes = shipped.length > 0 ? shipped : declared;
  const hidden = shipped.length > 0 ? declared.filter((scope) => !shipped.includes(scope)) : [];

  // One package in a workspace is not a monorepo worth a switcher.
  if (scopes.length < 2) return { scopes: [], hidden: [] };

  // Measured against *every* declared scope, hidden ones included. A dropped fixture's
  // files are still owned by that fixture — counting them as leftovers the root has
  // would hand them straight back through `includeTheRootWhenItIsTheProject`, which is
  // the fix undoing itself one function later.
  const files = await measure(root, declared);
  const all = includeTheRootWhenItIsTheProject(root, scopes, files);
  return { scopes: leadWithTheMainApp(all.sort(byKindThenName), files), hidden };
}

/**
 * The words a package name uses when the package exists to be tested against.
 *
 * Whole segments only, so `ab-testing` and `contest` are not swept up by a rule about
 * `test`. Matched against the package's declared name as well as its directory, because
 * `@vitejs/test-alias` says it in the name and `packages/bruno-tests` says it in the
 * path, and neither repo says it in both.
 */
const TEST_NAME = /(^|[-._/])(tests?|e2e|fixtures?|testbench)([-._/]|$)/i;

/** The manifest fields that are one package saying it needs another. */
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

/**
 * Every package name anything in this workspace declares a dependency on.
 *
 * The root manifest counts: a repo that pulls a package in at the top has still said it
 * needs it. A package listing *itself* would keep itself off the fixture list, which is
 * the harmless direction — the answer to a broken manifest is to show the package, not
 * to hide it.
 */
function namesTheWorkspaceImports(
  root: string,
  declared: Scope[],
  manifests: Map<string, Record<string, unknown> | null>,
): Set<string> {
  const names = new Set<string>();
  const add = (pkg: Record<string, unknown> | null) => {
    if (!pkg) return;
    for (const field of DEPENDENCY_FIELDS) {
      const deps = pkg[field];
      if (deps && typeof deps === 'object') for (const name of Object.keys(deps)) names.add(name);
    }
  };

  add(readJson(path.join(root, 'package.json')));
  for (const scope of declared) add(manifests.get(scope.dir) ?? null);
  return names;
}

/**
 * Whether a declared workspace member exists to be tested against rather than shipped.
 *
 * Two ways to say it, because real repositories say it two ways. The path is the one
 * #185 settled — nuxt's `test/fixtures/*`, directus's `tests/e2e` — and it is the
 * stronger signal, needing nothing else.
 *
 * The name is the one bruno needed (#289). `packages/bruno-tests` is the fixture server
 * bruno's own suite calls against: 18 runtime dependencies, a real entry point, 46
 * genuine Express routes, and a headline reading "41 of 46 routes unprotected" sitting
 * in the switcher beside the four scopes where that number means something. Nothing in
 * #174's rule can reach it — that rule is about a package *of tests*, and this is a
 * package tests are *pointed at* — and nothing in #185's, because the path says
 * `packages/` like every other member.
 *
 * A name alone would be a guess, so it is never enough on its own. The second fact is
 * that nothing in the workspace imports it, and the two together were measured across
 * eight monorepos before being written down. They separate the fixtures —
 * `packages/bruno-tests`, vite's ~70 `playground/@vitejs/test-*`, turborepo's
 * `lockfile-tests`, grafana's four `test-plugins/*` — from the test-named packages that
 * are real code somebody imports: `@grafana/e2e-selectors` (published to npm),
 * `@grafana/test-utils`, `@turbo/test-utils`, `@immich/e2e-auth-server`. Every one of
 * those eight is depended on by a sibling; not one of the fixtures is.
 *
 * A member with no `package.json` — a `pyproject.toml` member, a `.csproj` project — is
 * never hidden on its name, because in an ecosystem whose dependency lists we do not
 * read, "nothing imports it" is not a fact we found. It is a fact we failed to look for.
 */
function isTestFixture(scope: Scope, pkg: Record<string, unknown> | null, imported: Set<string>): boolean {
  if (classifyZone(`${scope.dir}/package.json`) === 'test') return true;

  const name = typeof pkg?.name === 'string' ? pkg.name : null;
  if (!name) return false;
  if (!TEST_NAME.test(name) && !TEST_NAME.test(path.posix.basename(scope.dir))) return false;
  return !imported.has(name);
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

function describeScope(root: string, dir: string, pkg: Record<string, unknown> | null): Scope {
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
