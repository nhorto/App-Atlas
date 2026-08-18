/**
 * @fileoverview What kind of thing is this repo?
 *
 * The five views were built for a web app, and until now every project got them in
 * that order whether or not it had a web boundary to show. A Python scripts repo would
 * open on a nearly-empty diagram of doors it does not have, while the question it
 * actually has — how do these files fit together — sat two tabs away.
 *
 * So before any view is chosen, the atlas says what it is looking at. The archetype is
 * a fact derived from signals we already collect: the doors the boundary detectors
 * found, the zones the files fell into, and the frameworks the manifests declare. No
 * model is involved, and every verdict carries the signals that produced it, because a
 * wrong guess that shows its reasoning is a bug report and a wrong guess that hides it
 * is a mystery.
 *
 * What the archetype is allowed to do is deliberately narrow: it changes which view
 * opens first, which tabs are emphasized, and how an empty view explains itself. It
 * never hides a view, and it never changes a fact. Bespoke per-framework screens are
 * the thing this is designed to avoid — one atlas, one set of lenses, different
 * emphasis.
 */
import { backbonePhrase, unreadBackbone } from '../model/coverage.js';
import type { Archetype, ArchetypeVerdict, AtlasNode, EndpointMeta } from '../model/types.js';
import type { ProjectInfo } from './project.js';
import { frameworksWithoutRouteReader } from './routereaders.js';

/** Doors a stranger on a network can knock on. */
const NETWORK_DOORS = new Set(['http-route', 'server-action', 'webhook', 'realtime']);

/** Frameworks whose presence means someone is meant to look at this with their eyes. */
const UI_FRAMEWORKS = new Set([
  'React',
  'React Native',
  'Vue',
  'Svelte',
  'Angular',
  // An Ember application routes in the browser and renders into one page, which is the
  // shape the SPA branch below exists for. Ghost's admin reaches that branch today only
  // because a few React panes are embedded in it; the next Ember admin without one is
  // filed as a library and handed its own components as a public API (#293).
  //
  // An addon is the false positive to watch, and it declares `ember-source` too —
  // every one of them lists it to build and test against. What keeps addons out is the
  // branch's third condition, not this table: an addon has a `main`, and an app that is
  // only ever built and served does not.
  'Ember',
  'Next.js',
  'Next.js App Router',
  'Next.js Pages Router',
  'Expo Router',
  'Streamlit',
  'Electron',
]);

/**
 * Libraries whose file I/O is somebody working through a dataset rather than an app
 * keeping state. Read off the stores the data detectors found, which is why this
 * archetype could not exist until they could see a `pd.read_csv`.
 */
const ANALYSIS_CLIENTS = new Set(['pandas', 'polars', 'NumPy', 'joblib', 'PyTorch']);

/**
 * Command-line doors somebody designed, as opposed to a file that merely can be run.
 *
 * An argument parser is an interface: someone wrote down the flags. `__main__` is a
 * Python idiom that also appears at the bottom of library modules nobody runs, so it
 * cannot outrank a repo that declares itself a package.
 */
const DECLARED_CLI = new Set(['argparse', 'Click', 'Typer', 'Node']);

export interface ArchetypeInput {
  project: ProjectInfo;
  nodes: AtlasNode[];
}

export function classifyArchetype({ project, nodes }: ArchetypeInput): ArchetypeVerdict {
  // Before every other rule, because every other rule reads the files we parsed — and
  // when most of the repository is in a language nothing here parses, those rules are
  // classifying the sliver, not the app. huginn (469 Ruby files, 18 read) was filed
  // under "A collection of code — no doors and nothing exported", which is true of the
  // sliver and wildly false of the Rails application it belongs to (#171).
  const backbone = unreadBackbone(project.unreadLanguages, project.files.length);
  if (backbone) {
    return {
      archetype: 'unknown',
      label: 'Mostly a language App Atlas cannot read',
      because: [
        `${backbonePhrase(backbone)} this tool does not parse`,
        // Grouped like the phrase above it, which is the whole reason this line exists:
        // the two numbers are read against each other and one of them is now five digits.
        `only ${project.files.length.toLocaleString('en-US')} ${project.files.length === 1 ? 'file' : 'files'} could be read`,
      ],
    };
  }

  const doors = countDoors(nodes);
  const uiFrameworks = project.frameworks.filter((name) => UI_FRAMEWORKS.has(name));
  // A template is an interface file. It was not one before, because this asked only
  // about files an analyzer had *parsed*, and no analyzer parses a template — so a
  // server-rendered app could never answer yes however many pages it served, and
  // Django, Flask+Jinja and Rails all landed on "a service other things call" by
  // construction. healthchecks has 130 of them behind a login (item 43).
  const templates = project.templateFiles.length;
  const hasUiFiles = templates > 0 || project.files.some((file) => file.zone === 'ui');
  const bin = readBin(project.packageJson);
  const exported = countExports(nodes);

  const because: string[] = [];

  // Every branch below that finds no network door ends its reasoning with the same
  // clause, and that clause is a claim. It is only earned when somebody looked: a crate
  // declaring Rocket has not been shown to answer no URL, it has been not-asked, and
  // the difference is the whole of #257. The archetype itself is unchanged — a crate
  // that builds an executable is still something you run — because the evidence for
  // *that* is Cargo's own and does not depend on the route question at all.
  const unreadFrameworks = frameworksWithoutRouteReader(project.frameworks);
  const noUrl =
    unreadFrameworks.length > 0
      ? `${unreadFrameworks.join(', ')} declared, whose routes App Atlas does not read`
      : 'nothing answers a URL';

  // A screen is a way a person gets in, so a file-routed native app counts here even
  // though nothing in it answers a URL.
  if (doors.network > 0 || doors.screen > 0) {
    const wantsEyes = doors.screen > 0 || hasUiFiles || uiFrameworks.length > 0;
    if (wantsEyes) {
      if (doors.screen > 0) because.push(plural(doors.screen, 'screen'));
      if (doors.network > 0) because.push(plural(doors.network, 'way in over the network', 'ways in over the network'));
      if (uiFrameworks.length > 0) because.push(uiFrameworks.join(', '));
      // Named, because it is the evidence a reader is most likely to want to check —
      // and because the sentence it replaces said the opposite outright.
      else if (templates > 0) because.push(plural(templates, 'page it renders', 'pages it renders'));
      return verdict('web-app', 'An app with a front end', because);
    }
    because.push(plural(doors.network, 'way in over the network', 'ways in over the network'));
    if (project.frameworks.length > 0) because.push(project.frameworks.slice(0, 3).join(', '));
    because.push('no interface files');
    return verdict('service', 'A service other things call', because);
  }

  // No network doors and nobody looking at it. The remaining question is what the code
  // is *for*, and a repo whose inputs are datasets answers it before the others do:
  // a notebook is not a script that happens to run, and its functions are not an API.
  const analysis = readsDatasets(nodes, project);
  if (analysis.length > 0) {
    because.push(...analysis);
    if (doors.declaredCli > 0) because.push(plural(doors.declaredCli, 'command-line entry point'));
    return verdict('analysis', 'Code that turns data into answers', because);
  }

  // A single-page app routes in the browser, so it has no door on the file system and
  // nothing above catches it. `full-stack-fastapi-template`'s React frontend was filed
  // under "Code other code imports", with two hundred and thirty-five of its own
  // components listed as the public API nobody imports.
  //
  // What keeps a component library out is the manifest: `packages/ui` says where to
  // import it from, and an app that is only ever built and served does not.
  if (uiFrameworks.length > 0 && hasUiFiles && !project.signals.declaresAPackage) {
    because.push(uiFrameworks.join(', '));
    because.push('routes in the browser, not on the file system');
    return verdict('web-app', 'An app with a front end', because);
  }

  // Otherwise: does this run, or does it get imported? A designed command line settles
  // it outright.
  // `<OutputType>WinExe</OutputType>` is .NET's `bin` field: a line somebody wrote
  // saying this project builds a thing you run rather than a thing you reference.
  //
  // Without it, a 209-file WinUI desktop app came out as "Code other code imports" and
  // was handed a public API of 154 of its own window classes — because it exports names
  // and answers no URL, which is every desktop application ever written.
  const executables = [...(project.signals.dotnetOutputTypes ?? [])].filter((type) => /^(Win)?Exe$/i.test(type));
  // Cargo's version of the same line. Without it a Rust workspace answers no URL, has
  // no `bin` in a package.json it does not have, and exports `pub` items because that
  // is the only way one crate can see another — so it landed on `library` and handed
  // back 971 of its own internals as a public API (#140).
  const crates = [...(project.signals.cargoBinaries ?? [])];

  if (doors.declaredCli > 0 || bin.length > 0 || executables.length > 0 || crates.length > 0) {
    if (doors.declaredCli > 0) because.push(plural(doors.declaredCli, 'command-line entry point'));
    if (bin.length > 0) because.push(`${plural(bin.length, 'command')} in package.json`);
    if (executables.length > 0) because.push('a .NET project that builds an executable');
    if (crates.length > 0) {
      because.push(
        crates.length === 1
          ? 'a crate that builds an executable'
          : `${crates.length} crates that build an executable`,
      );
    }
    if (doors.scheduled > 0) because.push(plural(doors.scheduled, 'scheduled job'));
    because.push(noUrl);
    return verdict('pipeline', 'Something you run', because);
  }

  if (doors.scheduled > 0) {
    because.push(plural(doors.scheduled, 'scheduled job'));
    because.push(noUrl);
    return verdict('pipeline', 'Something you run', because);
  }

  // `if __name__ == "__main__":` says a file *can* be run. So can the two files in
  // `psf/requests` that have one left over from debugging, which was enough to file the
  // most-imported library in Python under "Something you run". A manifest that says
  // "install me and import me" is a decision somebody wrote down, and it outranks an
  // idiom. Without one, a folder of runnable scripts is exactly what this is.
  if (doors.runnableFiles > 0 && !project.signals.declaresAPackage) {
    because.push(plural(doors.runnableFiles, 'file you run directly', 'files you run directly'));
    because.push(noUrl);
    return verdict('pipeline', 'Something you run', because);
  }

  // A test suite exports helpers to its own specs, not an API (#174). immich-e2e — 80
  // files of Playwright and vitest — took the library branch below and published 72 of
  // its fixture generators as "ways in" on the workspace summary, a number that spends
  // the credibility the real ones need. The evidence is the manifest, read the way the
  // SPA rule above reads it, and all three facts are required because each alone
  // describes real packages: no runtime dependencies (everything it needs is dev), a
  // test runner among what it does need, and no entry point that exists — immich-e2e's
  // `main: index.js` names a file the package does not contain, and an entry point
  // that is not there declares nothing.
  if (exported > 0 && isTestSuite(project)) {
    because.push('no runtime dependencies, and a test runner among the dev ones');
    because.push('no entry point another package could import');
    return verdict('unknown', 'A test suite', because);
  }

  if (exported > 0) {
    // Files, not names — `countExports` counts modules on purpose, and "28 exported
    // names" sat one line under a headline reading "118 names in its public API".
    because.push(plural(exported, 'file other code can import', 'files other code can import'));
    if (doors.runnableFiles > 0) because.push(plural(doors.runnableFiles, 'file you can also run directly', 'files you can also run directly'));
    // Not "no doors of any kind": a library's exported names *become* doors a moment
    // from now, and the screen that says so is the same screen this sentence sits on.
    because.push(noUrl);
    return verdict('library', 'Code other code imports', because);
  }

  // Nothing decisive. Say so rather than picking the nearest neighbour: the map is
  // still true, and claiming to know what this is would be the first lie in it.
  if (project.files.length > 0) because.push(plural(project.files.length, 'source file'));
  because.push('no doors and nothing exported');
  return verdict('unknown', 'A collection of code', because);
}

/** The runners whose presence in devDependencies is the point of a test package. */
const TEST_RUNNERS = ['@playwright/test', 'vitest', 'jest', 'cypress', 'mocha', 'ava', 'tap', 'karma'];

/** See the call site — all three facts, because each alone describes real packages. */
function isTestSuite(project: ProjectInfo): boolean {
  const manifest = project.packageJson;
  if (!manifest) return false;
  const deps = Object.keys((manifest.dependencies as Record<string, unknown> | undefined) ?? {});
  if (deps.length > 0) return false;
  const devDeps = Object.keys((manifest.devDependencies as Record<string, unknown> | undefined) ?? {});
  if (!devDeps.some((name) => TEST_RUNNERS.includes(name))) return false;

  // `exports` and `bin` can be objects with many shapes; their presence is a claim in
  // itself and enough to disqualify. `main` is a single path — cheap to hold to its
  // word: an npm-init default pointing at nothing is not an entry point.
  if (manifest.exports !== undefined || manifest.bin !== undefined || manifest.types !== undefined) return false;
  const main = typeof manifest.main === 'string' ? manifest.main.replace(/^\.\//, '') : null;
  if (main && project.files.some((file) => file.relPath === main)) return false;
  return true;
}

interface DoorCounts {
  network: number;
  screen: number;
  /** A command line somebody designed: an argument parser, or a declared `bin`. */
  declaredCli: number;
  /** A file that merely can be run — `if __name__ == "__main__":` and nothing more. */
  runnableFiles: number;
  scheduled: number;
}

function countDoors(nodes: AtlasNode[]): DoorCounts {
  const counts: DoorCounts = { network: 0, screen: 0, declaredCli: 0, runnableFiles: 0, scheduled: 0 };
  for (const node of nodes) {
    if (node.kind !== 'endpoint') continue;
    const meta = node.meta as unknown as EndpointMeta;
    const kind = meta.endpointKind;
    if (NETWORK_DOORS.has(kind)) counts.network++;
    else if (kind === 'screen') counts.screen++;
    else if (kind === 'cli') {
      if (DECLARED_CLI.has(meta.framework)) counts.declaredCli++;
      else counts.runnableFiles++;
    } else if (kind === 'cron' || kind === 'queue' || kind === 'worker') counts.scheduled++;
  }
  return counts;
}

/**
 * Whether this repo's inputs are datasets, and the evidence for saying so.
 *
 * Two signals, either of which is enough. A notebook *is* an analysis — nobody writes
 * one to ship it. And a store the code reads whose client is pandas or NumPy is a
 * dataset going in, which is the thing this archetype exists to put on the left-hand
 * side of the boundary screen.
 *
 * The read matters. A library that writes a CSV is not doing analysis; one that opens
 * somebody's data and works through it is.
 */
function readsDatasets(nodes: AtlasNode[], project: ProjectInfo): string[] {
  // A repo that ships as a package is what its manifest says it is. The notebook in it
  // is a demo, and the CSV it reads is an example — neither is what the code is for.
  if (project.signals.declaresAPackage) return [];

  const because: string[] = [];

  const notebooks = project.files.filter((file) => file.relPath.endsWith('.ipynb')).length;
  if (notebooks > 0) because.push(plural(notebooks, 'notebook'));

  const clients = new Set<string>();
  for (const node of nodes) {
    if (node.kind !== 'store') continue;
    const meta = node.meta as { client?: unknown; reads?: unknown };
    if (typeof meta.client !== 'string' || !ANALYSIS_CLIENTS.has(meta.client)) continue;
    if (typeof meta.reads === 'number' && meta.reads > 0) clients.add(meta.client);
  }
  if (clients.size > 0) because.push(`reads data files with ${[...clients].sort().join(', ')}`);

  return because.length > 0 ? because : [];
}

/**
 * Exports are counted over files rather than functions, because a library is a set of
 * modules someone imports and one module re-exporting forty names is still one door.
 */
function countExports(nodes: AtlasNode[]): number {
  let total = 0;
  for (const node of nodes) {
    if (node.kind !== 'file') continue;
    const names = (node.meta as { exportedNames?: string[] }).exportedNames;
    if (names && names.length > 0) total++;
  }
  return total;
}

function readBin(pkg: Record<string, unknown> | null): string[] {
  const bin = pkg?.bin;
  if (typeof bin === 'string') return [bin];
  if (bin && typeof bin === 'object') return Object.keys(bin as Record<string, unknown>);
  return [];
}

function verdict(archetype: Archetype, label: string, because: string[]): ArchetypeVerdict {
  return { archetype, label, because };
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
