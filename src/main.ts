/**
 * @fileoverview The `app-atlas` command line.
 *
 * Reached through `cli.ts`, which is the published bin and runs the two checks that
 * have to happen before any import of ours — the Node floor and Node's own SQLite
 * warning. Nothing here may be imported statically from there.
 *
 * Six ways in, all doing the least surprising thing:
 *   app-atlas [dir]          analyze, then open the map
 *   app-atlas analyze [dir]  analyze only
 *   app-atlas serve [dir]    open the map from a previous analysis
 *   app-atlas export [dir]   write ATLAS.md for a coding agent
 *   app-atlas mcp [dir]      answer a coding agent over the Model Context Protocol
 *   app-atlas init [dir]     teach the user's agent to write docstrings
 *
 * A monorepo runs the same pipeline once per app; `--watch` runs it again on every
 * save. Both go through `produceAtlas`, so a rebuild can never disagree with a first
 * run about what the code says.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import pc from 'picocolors';
import open from 'open';
import { analyzeProject, computeStats, TOOL_VERSION } from './analyze/index.js';
import { findScopes } from './analyze/workspace.js';
import type { Scope } from './analyze/workspace.js';
import { BACKEND_IDS } from './enrich/backends/index.js';
import type { EnrichReport } from './enrich/index.js';
import { describeRun, writeTheWords } from './enrich/session.js';
import { renderAtlasMarkdown } from './export/markdown.js';
import { initConventions } from './init.js';
import { describeChanges, diffAtlas } from './model/changes.js';
import type { ChangeNote } from './model/changes.js';
import { authHeadline } from './model/exposure.js';
import { AtlasGraph } from './model/graph.js';
import type { Atlas, DoorChange } from './model/types.js';
import { markStaleDocs } from './model/staleness.js';
import { startMcpServer } from './mcp/index.js';
import { ignoreAtlasDirectory, isTrackedByGit } from './util/git.js';
import { displayPath } from './util/paths.js';
import { grammarTier } from './model/tiers.js';
import { atlasDbPath, atlasJsonPath, loadAtlas, persistAtlas, readScopes, scopesPath, writeScopes } from './model/store.js';
import { startServer } from './server/index.js';
import type { ScopeAtlas, ServerHandle } from './server/index.js';
import { watchProject } from './watch.js';

interface SharedOptions {
  port: string;
  open: boolean;
  refs: boolean;
  maxFiles: string;
  json?: string;
  quiet: boolean;
  ignore?: string[];
  fresh?: boolean;
  watch?: boolean;
  scope?: string;
  ai: boolean;
  aiBackend?: string;
  aiModel?: string;
  aiMaxFiles?: string;
  aiYes?: boolean;
  refreshAi?: boolean;
}

/** Flags for the words layer, shared by the default command and `analyze`. */
function withAiOptions(command: Command): Command {
  return command
    // Deliberately not `--ai <backend>`: commander reads `--no-ai` as the negation of
    // an `ai` option, so the two would fight over the same destination.
    .option('--no-ai', "don't write new descriptions — keeps the ones already written")
    .option('--ai-backend <id>', `which backend to use: ${BACKEND_IDS.join(', ')}`, 'auto')
    .option('--ai-model <name>', "override the backend's default model")
    .option('--ai-max-files <number>', 'cap on files described in one pass', '400')
    .option('--ai-yes', 'approve metered API spending in advance (for scripts)')
    .option('--refresh-ai', 'discard cached descriptions and write them again');
}

const program = new Command();

// The default command and the subcommands deliberately share flag names (`--port`,
// `--json`, `-q`). Without this, commander treats the shared ones as global and
// `app-atlas serve . --port 5000` silently keeps the default.
program.enablePositionalOptions();

withAiOptions(
  program
    .name('app-atlas')
    .description('Understand any app — including the one your AI built.')
    .version(TOOL_VERSION)
    .argument('[dir]', 'project directory to analyze', '.')
    .option('-p, --port <number>', 'port for the local server', '4477')
    .option('--no-open', "don't open a browser")
    .option('--no-refs', 'skip the symbol-reference pass (faster on very large repos)')
    .option('--max-files <number>', 'maximum number of source files to analyze', '5000')
    .option('--ignore <glob...>', 'leave these paths out — example apps, vendored code')
    .option('--fresh', 're-read every file instead of reusing the last run')
    .option('--scope <name>', 'in a monorepo, analyze only this app')
    .option('--watch', 'keep watching, and update the map when the code changes')
    .option('--json <path>', 'also write the JSON export to this path')
    .option('-q, --quiet', 'less output', false),
).action(async (dir: string, options: SharedOptions) => {
  const { atlas, scopes } = await runAnalysis(dir, options);
  const handle = await runServer(dir, atlas, scopes, options);
  if (options.watch) startWatching(dir, handle, options);
});

withAiOptions(
  program
    .command('analyze')
    .description('analyze a project and write its atlas to disk')
    .argument('[dir]', 'project directory to analyze', '.')
    .option('--no-refs', 'skip the symbol-reference pass (faster on very large repos)')
    .option('--max-files <number>', 'maximum number of source files to analyze', '5000')
    .option('--ignore <glob...>', 'leave these paths out — example apps, vendored code')
    .option('--fresh', 're-read every file instead of reusing the last run')
    .option('--scope <name>', 'in a monorepo, analyze only this app')
    .option('--json <path>', 'also write the JSON export to this path')
    .option('-q, --quiet', 'less output', false),
).action(async (dir: string, options: SharedOptions) => {
  await runAnalysis(dir, options);
});

program
  .command('serve')
  .description('serve an atlas that has already been analyzed')
  .argument('[dir]', 'project directory', '.')
  .option('-p, --port <number>', 'port for the local server', '4477')
  .option('--no-open', "don't open a browser")
  // Only the explain-on-click flags matter here; there is no pass to run or cap.
  .option('--no-ai', "don't offer to explain things on click")
  .option('--ai-backend <id>', `which backend to use: ${BACKEND_IDS.join(', ')}`, 'auto')
  .option('--ai-model <name>', "override the backend's default model")
  .action(async (dir: string, options: SharedOptions) => {
    const root = path.resolve(dir);

    // A workspace keeps one atlas per app, beside the app. The manifest at the root is
    // what turns those separate analyses back into one switcher.
    const scopes: ScopeAtlas[] = [];
    for (const scope of readScopes(root)) {
      const found = loadAtlas(path.join(root, scope.dir));
      if (found) scopes.push({ scope, atlas: found });
    }

    const atlas = scopes[0]?.atlas ?? loadAtlas(root);
    if (!atlas) {
      console.error(pc.red(`No atlas found in ${pc.bold(root)}.`));
      console.error(`Run ${pc.cyan('app-atlas analyze')} there first.`);
      process.exitCode = 1;
      return;
    }
    await runServer(dir, atlas, scopes, options);
  });

program
  .command('export')
  .description('write ATLAS.md — a compact map of your app for coding agents')
  .argument('[dir]', 'project directory', '.')
  .option('--md [path]', 'where to write it (default: ATLAS.md in the project)')
  .option('--stdout', 'print it instead of writing a file')
  .option('--scope <name>', 'in a monorepo, export this app')
  .action((dir: string, options: { md?: string | boolean; stdout?: boolean; scope?: string }) => {
    const root = path.resolve(dir);
    // In a workspace the root has no atlas of its own, so the named app — or the first
    // one — is what an agent asking "what is this repo" should be handed.
    const known = readScopes(root);
    const picked = options.scope ? known.find((s) => s.id === options.scope || s.name === options.scope) : known[0];
    const atlas = picked ? loadAtlas(path.join(root, picked.dir)) : loadAtlas(root);
    if (!atlas) {
      console.error(pc.red(`No atlas found in ${pc.bold(root)}.`));
      console.error(`Run ${pc.cyan('app-atlas analyze')} there first.`);
      process.exitCode = 1;
      return;
    }

    // Where it is going has to be settled before it is written, because a map somebody
    // commits says less than one they keep to themselves (issue #69). `--stdout` is
    // never shared: it goes to whoever typed the command.
    const target = path.resolve(root, typeof options.md === 'string' ? options.md : 'ATLAS.md');
    const shared = options.stdout ? false : isTrackedByGit(target);

    const markdown = renderAtlasMarkdown(new AtlasGraph(atlas), { toolVersion: TOOL_VERSION, shared });
    if (options.stdout) {
      process.stdout.write(markdown);
      return;
    }

    fs.writeFileSync(target, markdown, 'utf8');

    const relative = displayPath(target);
    const size = Math.round(Buffer.byteLength(markdown) / 102.4) / 10;
    console.log('');
    console.log(`  ${pc.green('wrote')}  ${relative} ${pc.dim(`(${size} KB)`)}`);
    console.log('');
    console.log(pc.dim('  Point your coding agent at it — one line in CLAUDE.md or AGENTS.md:'));
    console.log(pc.dim(`    Read ${path.basename(target)} before changing code. It is the map of this app.`));
    console.log('');
  });

program
  .command('mcp')
  .description('answer a coding agent over the Model Context Protocol, on stdin and stdout')
  .argument('[dir]', 'project directory', '.')
  .action(async (dir: string) => {
    // Deliberately silent, and deliberately not an analysis. Under stdio transport
    // stdout carries the protocol and nothing else, and a client that starts its servers
    // at the beginning of a session will not wait forty seconds for a first answer — so
    // this reads the atlas `analyze` already wrote, and says so when there is not one.
    await startMcpServer({ root: path.resolve(dir) });
  });

program
  .command('init')
  .description("write App Atlas's docstring conventions into your agent instructions")
  .argument('[dir]', 'project directory', '.')
  .option('--file <name>', 'write to one specific file instead of the ones found')
  .action((dir: string, options: { file?: string }) => {
    const root = path.resolve(dir);
    const results = initConventions(root, options.file);

    console.log('');
    for (const result of results) {
      const relative = displayPath(result.path, root);
      const verb =
        result.action === 'created' ? pc.green('created') : result.action === 'updated' ? pc.cyan('updated') : pc.dim('already up to date');
      console.log(`  ${verb}  ${relative}`);
    }
    console.log('');
    console.log(pc.dim('  Your coding agent will now document as it builds, and App Atlas'));
    console.log(pc.dim('  reads those docstrings verbatim — free, and better than a guess.'));
    console.log('');
  });

/**
 * Analyze, write whatever words are available, save. Shared by the first run and by
 * every `--watch` rebuild, so the two can never drift into producing different atlases.
 */
async function produceAtlas(
  root: string,
  options: SharedOptions,
  run: {
    quiet: boolean;
    neverAsk?: boolean;
    /** What to call this app, when the workspace has a better name than package.json. */
    name?: string;
    /**
     * The directory the user named, when `root` is one app we picked out of it. This is
     * the only place that knows the difference, because it is the only place the user's
     * own argument survives: everything below has already been narrowed.
     */
    repoRoot?: string;
    onProgress?: (stage: string, done: number, total: number) => void;
  },
): Promise<{ atlas: Atlas; words: EnrichReport | null; dbPath: string; jsonPath: string; ignoredNow: boolean }> {
  const { atlas } = await analyzeProject(root, {
    maxFiles: Number(options.maxFiles ?? 5000) || 5000,
    ignore: options.ignore,
    followReferences: options.refs !== false,
    cache: options.fresh ? 'refresh' : 'use',
    repoRoot: run.repoRoot,
    onProgress: run.onProgress,
  });

  // Set before anything is written, so the name on disk is the name in the switcher.
  if (run.name) atlas.meta.name = run.name;

  // The atlas the last successful run left behind, read before this one overwrites it.
  // It is the baseline for both of the questions that need two snapshots to answer:
  // which docstrings the code has outgrown, and what moved since Tuesday.
  const previous = loadAtlas(root);

  // The docstrings the repo already has are in the atlas by now. Everything below
  // fills the gaps they leave — and, on a repeat run, mostly just reads the cache.
  markStaleDocs(previous, atlas);
  const words = await writeTheWords({
    root,
    atlas,
    enabled: options.ai !== false,
    backendId: options.aiBackend,
    model: options.aiModel,
    maxFiles: Number(options.aiMaxFiles ?? 400) || 400,
    refresh: Boolean(options.refreshAi),
    assumeYes: Boolean(options.aiYes),
    neverAsk: run.neverAsk,
    quiet: run.quiet,
    onProgress: run.onProgress,
  });

  // Descriptions were written and stale docstrings flagged after the counting was
  // done, so the numbers are counted again rather than left subtly wrong.
  atlas.meta.stats = computeStats(atlas.nodes, atlas.edges);

  // Worked out here and stamped onto the atlas rather than recomputed by each screen,
  // because `export` and `serve` run in later processes by which time the baseline has
  // been overwritten — and because the summary, the brief and the web app saying
  // different things about the same week would be worse than saying nothing.
  atlas.meta.changes = diffAtlas(previous, atlas);

  const { dbPath, jsonPath } = persistAtlas(root, atlas, options.json);
  // After the write, not before: a run that failed to produce a map has no business
  // editing anybody's `.gitignore`.
  const ignoredNow = ignoreAtlasDirectory(root);
  return { atlas, words, dbPath, jsonPath, ignoredNow };
}

interface AnalysisOutcome {
  /** The atlas the map opens on. */
  atlas: Atlas;
  /** Every app in the workspace, or empty for an ordinary repo. */
  scopes: ScopeAtlas[];
}

async function runAnalysis(dir: string, options: SharedOptions): Promise<AnalysisOutcome> {
  const root = path.resolve(dir);
  const quiet = Boolean(options.quiet);

  if (!quiet) {
    console.log('');
    console.log(`${pc.bold(pc.cyan('App Atlas'))} ${pc.dim(`v${TOOL_VERSION}`)}`);
    console.log(pc.dim(`Reading ${root}`));
    console.log('');
  }

  const found = await findScopes(root);
  const scopes = options.scope ? found.filter((s) => s.id === options.scope || s.name === options.scope) : found;
  if (options.scope && scopes.length === 0) {
    const names = found.map((s) => s.id).join(', ') || 'none';
    throw new Error(`No app called "${options.scope}" in this workspace. Found: ${names}`);
  }
  if (scopes.length > 1) return runWorkspaceAnalysis(root, scopes, options);

  // One app in a workspace is still one app: analyze it where it lives, so its cache
  // and its atlas end up beside it exactly as they would in a repo of its own. The
  // directory the user named goes with it, because the deployment file describing that
  // app's stack is normally above it — narrowing the code must not narrow the repo.
  const target = scopes.length === 1 ? path.join(root, scopes[0].dir) : root;
  const atlas = await runSingleAnalysis(target, options, root);
  return { atlas, scopes: [] };
}

async function runSingleAnalysis(root: string, options: SharedOptions, repoRoot: string = root): Promise<Atlas> {
  const quiet = Boolean(options.quiet);
  const started = Date.now();
  const interactive = Boolean(process.stdout.isTTY);
  let lastStage = '';
  let hintShown = false;
  const { atlas, words, dbPath, jsonPath, ignoredNow } = await produceAtlas(root, options, {
    quiet,
    repoRoot,
    onProgress: (stage, done, total) => {
      if (quiet) return;
      const finished = total > 0 && done >= total;

      // Big repos are slow on the first pass; say so rather than looking hung.
      if (!hintShown && stage === 'Reading files' && total > 800 && options.refs !== false) {
        hintShown = true;
        console.log(
          pc.dim(`  ${total} files — the first pass takes a minute. Use --no-refs for a quicker structural map.`),
        );
      }

      if (!interactive) {
        // Piped output has no cursor to rewind, so report each stage exactly once.
        if (finished && stage !== lastStage) {
          lastStage = stage;
          console.log(`${pc.dim('·')} ${stage}${total > 1 ? ` (${total})` : ''}`);
        }
        return;
      }
      const suffix = total > 1 ? ` ${done}/${total}` : '';
      process.stdout.write(`\r${pc.dim('·')} ${stage}${suffix}${' '.repeat(12)}`);
      if (finished && stage !== lastStage) {
        lastStage = stage;
        process.stdout.write('\n');
      }
    },
  });

  if (!quiet) {
    const s = atlas.meta.stats;
    console.log('');
    console.log(pc.bold(`  ${atlas.meta.name}`));
    if (atlas.meta.frameworks.length > 0) {
      console.log(pc.dim(`  ${atlas.meta.frameworks.join(' · ')}`));
    }
    // Said before the numbers, not after, because it is a statement about what all of
    // them are worth.
    const tier = grammarTier(atlas.nodes);
    if (tier) console.log(pc.dim(`  ${tier.display} read by grammar, not by a compiler — links between files are likely, not certain.`));
    // Above the counts, because "what did it do to my app since Tuesday" is the question
    // somebody who let an agent write code all weekend came here with. The counts are
    // the answer to a question they already know the shape of.
    printChanges(atlas.meta.changes);
    console.log('');
    console.log(`  ${pad(s.files)} files       ${pad(s.functions)} functions`);
    console.log(`  ${pad(s.modules)} folders     ${pad(s.types)} types`);
    console.log(`  ${pad(s.imports)} imports     ${pad(s.references)} references`);
    console.log('');
    console.log(`  ${pad(s.endpoints)} ${plural(s.endpoints, 'way in', 'ways in').padEnd(12)}${pad(s.services)} ${plural(s.services, 'service', 'services')}`);
    console.log(`  ${pad(s.stores)} ${plural(s.stores, 'data store', 'data stores').padEnd(12)}${pad(s.envVars)} ${plural(s.envVars, 'env variable', 'env variables')}`);
    // The one number worth interrupting for — and the caveats that keep it honest.
    const auth = authHeadline(s);
    if (auth) {
      console.log(auth.tone === 'warn' ? pc.yellow(`  ${auth.headline}`) : pc.green(`  ${auth.headline}`));
      for (const caveat of auth.caveats) console.log(pc.dim(`  ${caveat}`));
    }
    console.log('');
    // Nobody writes a docstring in a file a generator rewrites, so counting those in the
    // denominator scores a repo on work it must not do (#126). One package read 0% while
    // its hand-written files were a small minority of the count.
    const generated = s.generatedFiles ?? 0;
    const ownFiles = Math.max(0, s.files - generated);
    const documented = ownFiles > 0 ? Math.round((s.documentedFiles / ownFiles) * 100) : 0;
    // The percentage is worth printing at every level; the instruction is not. A repo
    // that documents every file was told to go and learn how to document files (#124),
    // which is the tool failing to read its own number directly under the auth headline
    // — the one sentence here that most needs believing. Silence is the reward.
    const nudge =
      s.documentedFiles < ownFiles ? ` Run ${pc.cyan('app-atlas init')} to teach your agent to write them.` : '';
    const aside = generated > 0 ? `, ${generated} generated ${plural(generated, 'file', 'files')} aside` : '';
    console.log(
      pc.dim(
        `  ${documented}% of files have a docstring App Atlas can read (${s.documentedFiles}/${ownFiles}${aside}).${nudge}`,
      ),
    );
    if (s.staleDocs > 0) {
      console.log(
        pc.yellow(
          `  ${s.staleDocs} ${plural(s.staleDocs, 'docstring describes', 'docstrings describe')} code that has changed since it was written.`,
        ),
      );
    }
    for (const line of words ? describeRun(words) : []) console.log(pc.dim(line));
    console.log('');
    console.log(pc.dim(`  atlas    ${displayPath(dbPath)}`));
    console.log(pc.dim(`  export   ${displayPath(jsonPath)}`));
    // Writing into somebody's repo without saying so is the thing to avoid here, and
    // that applies to `.gitignore` as much as to `.app-atlas/` (#113).
    if (ignoredNow) console.log(pc.dim(`  added .app-atlas/ to .gitignore — the map is local to this machine`));
    const pace = atlas.meta.incremental;
    const skipped = pace && pace.reused > 0 ? `, ${pace.reused} unchanged since the last run` : '';
    console.log(pc.dim(`  analyzed in ${((Date.now() - started) / 1000).toFixed(1)}s${skipped}`));
    for (const warning of atlas.meta.warnings.slice(0, 5)) {
      console.log(pc.yellow(`  ! ${warning}`));
    }
    if (atlas.meta.warnings.length > 5) {
      console.log(pc.yellow(`  ! ...and ${atlas.meta.warnings.length - 5} more warnings`));
    }
    console.log('');
  }

  return atlas;
}

/** Enough named doors to act on; past this the list stops being read and starts being scrolled. */
const MAX_DOORS_PRINTED = 6;

/**
 * What moved since the last run, printed above the numbers.
 *
 * Doors are named individually under the sentence that is about them, because "2 new
 * routes have no auth check" sends somebody hunting through a table and the whole point
 * of this block is that they should not have to. Everything else stays a count.
 */
function printChanges(changes: Atlas['meta']['changes']): void {
  const report = describeChanges(changes);
  if (!report) return;

  console.log('');
  const paint = report.tone === 'warn' ? pc.yellow : report.tone === 'ok' ? pc.green : pc.dim;
  printNote(report.headline, paint);
  for (const line of report.lines) printNote(line, pc.dim);
}

function printNote(note: ChangeNote, paint: (text: string) => string): void {
  console.log(paint(`  ${note.text}`));
  for (const door of note.doors.slice(0, MAX_DOORS_PRINTED)) {
    console.log(paint(`    ${doorLine(door)}`));
  }
  const hidden = note.doors.length - MAX_DOORS_PRINTED;
  if (hidden > 0) console.log(paint(`    ...and ${hidden} more`));
}

/** "POST /api/reset  writes data  src/api/reset.ts:12" — the name, the stakes, where to look. */
function doorLine(door: DoorChange): string {
  const where = door.path ? `${door.path}${door.line ? `:${door.line}` : ''}` : '';
  return [door.name, door.writes ? 'writes data' : '', where].filter(Boolean).join('  ');
}

/**
 * A monorepo becomes one atlas per app rather than one atlas of everything (SPEC.md
 * 5.6). That is a readability decision before a technical one: a single map of six apps
 * is exactly the hairball this tool exists to avoid, and "my web app" is how people
 * talk about their own repo anyway.
 *
 * Each app is analyzed in its own directory, so its cache and its atlas sit beside it
 * and running `app-atlas apps/web` on its own is the same operation. Only the manifest
 * at the root knows they are related.
 */
async function runWorkspaceAnalysis(
  root: string,
  scopes: Scope[],
  options: SharedOptions,
): Promise<AnalysisOutcome> {
  const quiet = Boolean(options.quiet);
  const started = Date.now();
  const apps = scopes.filter((s) => s.kind === 'app').length;

  if (!quiet) {
    console.log(
      `  ${pc.bold(String(scopes.length))} ${plural(scopes.length, 'package', 'packages')} in this workspace` +
        (apps > 0 && apps < scopes.length ? pc.dim(`, ${apps} of them ${plural(apps, 'an app', 'apps')}`) : ''),
    );
    console.log('');
  }

  const results: ScopeAtlas[] = [];
  const failures: string[] = [];
  const width = Math.max(...scopes.map((s) => s.name.length));

  for (const scope of scopes) {
    try {
      const { atlas } = await produceAtlas(path.join(root, scope.dir), options, {
        quiet: true,
        neverAsk: true,
        name: scope.name,
        repoRoot: root,
      });
      results.push({ scope, atlas });
      if (!quiet) console.log(`  ${pc.bold(scope.name.padEnd(width))}  ${scopeLine(atlas)}`);
    } catch (err) {
      // One package that will not parse must not cost someone the other five.
      failures.push(`${scope.name}: ${(err as Error).message}`);
      if (!quiet) console.log(`  ${pc.bold(scope.name.padEnd(width))}  ${pc.yellow('could not be read')}`);
    }
  }

  if (results.length === 0) throw new Error(`None of the packages could be analyzed. ${failures[0] ?? ''}`);

  writeScopes(
    root,
    results.map(({ scope }) => scope),
  );

  if (!quiet) {
    console.log('');
    console.log(pc.dim(`  atlas    ${displayPath(scopesPath(root))}`));
    console.log(pc.dim(`  analyzed in ${((Date.now() - started) / 1000).toFixed(1)}s`));
    for (const failure of failures) console.log(pc.yellow(`  ! ${failure}`));
    console.log('');
  }

  return { atlas: results[0].atlas, scopes: results };
}

/** One line per app: size, doors, and the number worth interrupting for. */
function scopeLine(atlas: Atlas): string {
  const s = atlas.meta.stats;
  const parts = [`${s.files} ${plural(s.files, 'file', 'files')}`];
  if (s.endpoints > 0) parts.push(`${s.endpoints} ${plural(s.endpoints, 'way in', 'ways in')}`);
  if (s.services > 0) parts.push(`${s.services} ${plural(s.services, 'service', 'services')}`);

  const line = pc.dim(parts.join(pc.dim(' · ')));
  if (s.routes === 0) return line;
  // Short enough for a table, and never greener than the truth: a repo whose checks
  // are hidden in a file we could not parse must not read as a clean bill of health.
  const unlinked = s.unlinkedRoutes ?? 0;
  const assessed = Math.max(0, s.routes - unlinked);
  // …nor one whose handlers were never followed. With every route set aside, all three
  // counts below are zero and the green sentence would be the only one left (#139).
  if (assessed === 0) {
    return `${line}  ${pc.yellow(`${s.routes} ${plural(s.routes, 'route', 'routes')} not followed to a handler`)}`;
  }
  if (s.unprotectedRoutes > 0) {
    return `${line}  ${pc.yellow(`${s.unprotectedRoutes} of ${assessed} routes unprotected`)}`;
  }
  if (s.unreadableRoutes > 0) {
    return `${line}  ${pc.yellow(`${s.unreadableRoutes} of ${assessed} routes behind a file I could not read`)}`;
  }
  if (unlinked > 0) {
    return `${line}  ${pc.yellow(`${unlinked} of ${s.routes} routes not followed to a handler`)}`;
  }
  return s.publicRoutes > 0
    ? `${line}  ${pc.green('every route is checked or public on purpose')}`
    : `${line}  ${pc.green('every route checks who is calling')}`;
}

async function runServer(
  dir: string,
  atlas: Atlas,
  scopes: ScopeAtlas[],
  options: SharedOptions,
): Promise<ServerHandle> {
  const handle = await startServer({
    atlas,
    scopes,
    port: Number(options.port ?? 4477) || 4477,
    ai: {
      enabled: options.ai !== false,
      backendId: options.aiBackend,
      model: options.aiModel,
    },
  });
  console.log(`  ${pc.green('▸')} ${pc.bold('Your atlas is at')} ${pc.cyan(handle.url)}`);
  if (scopes.length > 1) {
    console.log(pc.dim(`    Switch between ${scopes.length} apps at the top of the page.`));
  }
  console.log(pc.dim('    Press Ctrl+C to stop.'));
  console.log('');

  if (options.open !== false) {
    try {
      await open(handle.url);
    } catch {
      /* a browser is a nicety, not a requirement */
    }
  }

  const shutdown = async () => {
    await handle.close().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return handle;
}

/**
 * Keeps the map honest while someone — or something — is editing the code.
 *
 * The rebuild is the same pipeline as a normal run, so nothing can drift; the cache
 * means it only re-reads what changed. The one difference is that it never stops to ask
 * about spending money: a question that appears mid-edit, over and over, is not consent.
 */
function startWatching(dir: string, handle: ServerHandle, options: SharedOptions): void {
  const root = path.resolve(dir);
  console.log(pc.dim('    Watching for changes — the map updates itself.'));
  console.log('');

  const watcher = watchProject({
    root,
    onChange: async (paths) => {
      const started = Date.now();
      const { atlas } = await produceAtlas(root, options, { quiet: true, neverAsk: true });
      handle.update(atlas);

      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      console.log(`  ${pc.green('↻')} ${describeChange(paths)} ${pc.dim(`· ${seconds}s`)}`);

      // Somebody watching their agent work should hear about a new open door the moment
      // it appears, not next Tuesday. Read off the same diff every other surface reads,
      // which also means naming the door rather than reporting that a total went up —
      // one route closing while another opens used to net out to silence.
      const doors = atlas.meta.changes?.doors;
      for (const door of doors?.newOpen ?? []) {
        console.log(pc.yellow(`    new, and nothing checks it: ${doorLine(door)}`));
      }
      for (const door of doors?.lostCheck ?? []) {
        console.log(pc.yellow(`    the auth check is gone from: ${doorLine(door)}`));
      }
    },
    onError: (err) => console.error(pc.yellow(`  ! Watching stopped working: ${err.message}`)),
  });

  process.on('SIGINT', () => watcher.close());
  process.on('SIGTERM', () => watcher.close());
}

/** "src/lib/db.ts and 2 more" — the first name is the useful part, the count is context. */
function describeChange(paths: string[]): string {
  if (paths.length === 0) return 'something changed';
  const [first, ...rest] = paths;
  return rest.length === 0 ? first : `${first} and ${rest.length} more`;
}

function pad(value: number): string {
  return String(value).padStart(5, ' ');
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error('');
  console.error(pc.red(`App Atlas failed: ${(err as Error).message}`));
  if (process.env.APP_ATLAS_DEBUG) console.error(err);
  process.exitCode = 1;
});

export { atlasDbPath, atlasJsonPath };
