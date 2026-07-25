#!/usr/bin/env node
/**
 * @fileoverview The `app-atlas` command line.
 *
 * Three ways in, all doing the least surprising thing:
 *   app-atlas [dir]          analyze, then open the map
 *   app-atlas analyze [dir]  analyze only
 *   app-atlas serve [dir]    open the map from a previous analysis
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
import { AtlasGraph } from './model/graph.js';
import type { Atlas, AtlasStats } from './model/types.js';
import { markStaleDocs } from './model/staleness.js';
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
    .option('--no-ai', 'skip plain-English descriptions — docstrings and compiler facts only')
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
    .option('--fresh', 're-read every file instead of reusing the last run')
    .option('--scope <name>', 'in a monorepo, analyze only this app')
    .option('--watch', 'keep watching, and update the map when the code changes')
    .option('--json <path>', 'also write the JSON export to this path')
    .option('-q, --quiet', 'less output', false),
).action(async (dir: string, options: SharedOptions) => {
  const { atlas, scopes } = await runAnalysis(dir, options);
  const handle = await runServer(dir, atlas, scopes, options);
  if (options.watch) startWatching(dir, handle, options, atlas.meta.stats);
});

withAiOptions(
  program
    .command('analyze')
    .description('analyze a project and write its atlas to disk')
    .argument('[dir]', 'project directory to analyze', '.')
    .option('--no-refs', 'skip the symbol-reference pass (faster on very large repos)')
    .option('--max-files <number>', 'maximum number of source files to analyze', '5000')
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

    const markdown = renderAtlasMarkdown(new AtlasGraph(atlas), { toolVersion: TOOL_VERSION });
    if (options.stdout) {
      process.stdout.write(markdown);
      return;
    }

    const target = path.resolve(root, typeof options.md === 'string' ? options.md : 'ATLAS.md');
    fs.writeFileSync(target, markdown, 'utf8');

    const relative = path.relative(process.cwd(), target) || target;
    const size = Math.round(Buffer.byteLength(markdown) / 102.4) / 10;
    console.log('');
    console.log(`  ${pc.green('wrote')}  ${relative} ${pc.dim(`(${size} KB)`)}`);
    console.log('');
    console.log(pc.dim('  Point your coding agent at it — one line in CLAUDE.md or AGENTS.md:'));
    console.log(pc.dim(`    Read ${path.basename(target)} before changing code. It is the map of this app.`));
    console.log('');
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
      const relative = path.relative(root, result.path) || result.path;
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
    onProgress?: (stage: string, done: number, total: number) => void;
  },
): Promise<{ atlas: Atlas; words: EnrichReport | null; dbPath: string; jsonPath: string }> {
  const { atlas } = await analyzeProject(root, {
    maxFiles: Number(options.maxFiles ?? 5000) || 5000,
    followReferences: options.refs !== false,
    cache: options.fresh ? 'refresh' : 'use',
    onProgress: run.onProgress,
  });

  // Set before anything is written, so the name on disk is the name in the switcher.
  if (run.name) atlas.meta.name = run.name;

  // The docstrings the repo already has are in the atlas by now. Everything below
  // fills the gaps they leave — and, on a repeat run, mostly just reads the cache.
  markStaleDocs(loadAtlas(root), atlas);
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
  const { dbPath, jsonPath } = persistAtlas(root, atlas, options.json);
  return { atlas, words, dbPath, jsonPath };
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
  // and its atlas end up beside it exactly as they would in a repo of its own.
  const target = scopes.length === 1 ? path.join(root, scopes[0].dir) : root;
  const atlas = await runSingleAnalysis(target, options);
  return { atlas, scopes: [] };
}

async function runSingleAnalysis(root: string, options: SharedOptions): Promise<Atlas> {
  const quiet = Boolean(options.quiet);
  const started = Date.now();
  const interactive = Boolean(process.stdout.isTTY);
  let lastStage = '';
  let hintShown = false;
  const { atlas, words, dbPath, jsonPath } = await produceAtlas(root, options, {
    quiet,
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
    console.log('');
    console.log(`  ${pad(s.files)} files       ${pad(s.functions)} functions`);
    console.log(`  ${pad(s.modules)} folders     ${pad(s.types)} types`);
    console.log(`  ${pad(s.imports)} imports     ${pad(s.references)} references`);
    console.log('');
    console.log(`  ${pad(s.endpoints)} ${plural(s.endpoints, 'way in', 'ways in').padEnd(12)}${pad(s.services)} ${plural(s.services, 'service', 'services')}`);
    console.log(`  ${pad(s.stores)} ${plural(s.stores, 'data store', 'data stores').padEnd(12)}${pad(s.envVars)} ${plural(s.envVars, 'env variable', 'env variables')}`);
    // The one number worth interrupting for.
    if (s.routes > 0) {
      const line =
        s.unprotectedRoutes === 0
          ? `  every one of the ${s.routes} routes has an auth check`
          : `  ${s.unprotectedRoutes} of ${s.routes} routes have no auth check App Atlas can see`;
      console.log(s.unprotectedRoutes > 0 ? pc.yellow(line) : pc.green(line));
    }
    console.log('');
    const documented = s.files > 0 ? Math.round((s.documentedFiles / s.files) * 100) : 0;
    console.log(
      pc.dim(
        `  ${documented}% of files have a docstring App Atlas can read (${s.documentedFiles}/${s.files}). ` +
          `Run ${pc.cyan('app-atlas init')} to teach your agent to write them.`,
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
    console.log(pc.dim(`  atlas    ${path.relative(process.cwd(), dbPath) || dbPath}`));
    console.log(pc.dim(`  export   ${path.relative(process.cwd(), jsonPath) || jsonPath}`));
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
    console.log(pc.dim(`  atlas    ${path.relative(process.cwd(), scopesPath(root)) || scopesPath(root)}`));
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
  return s.unprotectedRoutes > 0
    ? `${line}  ${pc.yellow(`${s.unprotectedRoutes} of ${s.routes} routes unprotected`)}`
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
function startWatching(dir: string, handle: ServerHandle, options: SharedOptions, from: AtlasStats): void {
  const root = path.resolve(dir);
  console.log(pc.dim('    Watching for changes — the map updates itself.'));
  console.log('');

  let previous = from;
  const watcher = watchProject({
    root,
    onChange: async (paths) => {
      const started = Date.now();
      const { atlas } = await produceAtlas(root, options, { quiet: true, neverAsk: true });
      handle.update(atlas);

      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      console.log(`  ${pc.green('↻')} ${describeChange(paths)} ${pc.dim(`· ${seconds}s`)}`);

      // The number this tool exists to surface. Someone watching their agent work
      // should hear about a new open door the moment it appears, not next Tuesday.
      const before = previous;
      previous = atlas.meta.stats;
      if (atlas.meta.stats.unprotectedRoutes > before.unprotectedRoutes) {
        const added = atlas.meta.stats.unprotectedRoutes - before.unprotectedRoutes;
        console.log(
          pc.yellow(`    ${added} new ${plural(added, 'route has', 'routes have')} no auth check App Atlas can see.`),
        );
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
