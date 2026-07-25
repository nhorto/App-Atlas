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
import { BACKEND_IDS } from './enrich/backends/index.js';
import { describeRun, writeTheWords } from './enrich/session.js';
import { renderAtlasMarkdown } from './export/markdown.js';
import { initConventions } from './init.js';
import { AtlasGraph } from './model/graph.js';
import type { Atlas } from './model/types.js';
import { markStaleDocs } from './model/staleness.js';
import { atlasDbPath, atlasJsonPath, loadAtlas, persistAtlas } from './model/store.js';
import { startServer } from './server/index.js';

interface SharedOptions {
  port: string;
  open: boolean;
  refs: boolean;
  maxFiles: string;
  json?: string;
  quiet: boolean;
  fresh?: boolean;
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
    .option('--json <path>', 'also write the JSON export to this path')
    .option('-q, --quiet', 'less output', false),
).action(async (dir: string, options: SharedOptions) => {
  const atlas = await runAnalysis(dir, options);
  await runServer(dir, atlas, options);
});

withAiOptions(
  program
    .command('analyze')
    .description('analyze a project and write its atlas to disk')
    .argument('[dir]', 'project directory to analyze', '.')
    .option('--no-refs', 'skip the symbol-reference pass (faster on very large repos)')
    .option('--max-files <number>', 'maximum number of source files to analyze', '5000')
    .option('--fresh', 're-read every file instead of reusing the last run')
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
    const atlas = loadAtlas(root);
    if (!atlas) {
      console.error(pc.red(`No atlas found in ${pc.bold(root)}.`));
      console.error(`Run ${pc.cyan('app-atlas analyze')} there first.`);
      process.exitCode = 1;
      return;
    }
    await runServer(dir, atlas, options);
  });

program
  .command('export')
  .description('write ATLAS.md — a compact map of your app for coding agents')
  .argument('[dir]', 'project directory', '.')
  .option('--md [path]', 'where to write it (default: ATLAS.md in the project)')
  .option('--stdout', 'print it instead of writing a file')
  .action((dir: string, options: { md?: string | boolean; stdout?: boolean }) => {
    const root = path.resolve(dir);
    const atlas = loadAtlas(root);
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

async function runAnalysis(dir: string, options: SharedOptions): Promise<Atlas> {
  const root = path.resolve(dir);
  const quiet = Boolean(options.quiet);

  if (!quiet) {
    console.log('');
    console.log(`${pc.bold(pc.cyan('App Atlas'))} ${pc.dim(`v${TOOL_VERSION}`)}`);
    console.log(pc.dim(`Reading ${root}`));
    console.log('');
  }

  const started = Date.now();
  const interactive = Boolean(process.stdout.isTTY);
  let lastStage = '';
  let hintShown = false;
  const { atlas } = await analyzeProject(root, {
    maxFiles: Number(options.maxFiles ?? 5000) || 5000,
    followReferences: options.refs !== false,
    cache: options.fresh ? 'refresh' : 'use',
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
    quiet,
    onProgress: (stage, done, total) => {
      if (quiet) return;
      if (interactive) process.stdout.write(`\r${pc.dim('·')} ${stage} ${done}/${total}${' '.repeat(12)}`);
      if (done >= total) process.stdout.write(interactive ? '\n' : `${pc.dim('·')} ${stage} (${total})\n`);
    },
  });

  // Descriptions were written and stale docstrings flagged after the counting was
  // done, so the numbers are counted again rather than left subtly wrong.
  atlas.meta.stats = computeStats(atlas.nodes, atlas.edges);

  const { dbPath, jsonPath } = persistAtlas(root, atlas, options.json);

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

async function runServer(dir: string, atlas: Atlas, options: SharedOptions): Promise<void> {
  const handle = await startServer({
    atlas,
    port: Number(options.port ?? 4477) || 4477,
    ai: {
      enabled: options.ai !== false,
      backendId: options.aiBackend,
      model: options.aiModel,
    },
  });
  console.log(`  ${pc.green('▸')} ${pc.bold('Your atlas is at')} ${pc.cyan(handle.url)}`);
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
