#!/usr/bin/env node
/**
 * @fileoverview The `app-atlas` command line.
 *
 * Three ways in, all doing the least surprising thing:
 *   app-atlas [dir]          analyze, then open the map
 *   app-atlas analyze [dir]  analyze only
 *   app-atlas serve [dir]    open the map from a previous analysis
 */
import path from 'node:path';
import { Command } from 'commander';
import pc from 'picocolors';
import open from 'open';
import { analyzeProject, TOOL_VERSION } from './analyze/index.js';
import type { Atlas } from './model/types.js';
import { atlasDbPath, atlasJsonPath, loadAtlas, persistAtlas } from './model/store.js';
import { startServer } from './server/index.js';

interface SharedOptions {
  port: string;
  open: boolean;
  refs: boolean;
  maxFiles: string;
  json?: string;
  quiet: boolean;
}

const program = new Command();

program
  .name('app-atlas')
  .description('Understand any app — including the one your AI built.')
  .version(TOOL_VERSION)
  .argument('[dir]', 'project directory to analyze', '.')
  .option('-p, --port <number>', 'port for the local server', '4477')
  .option('--no-open', "don't open a browser")
  .option('--no-refs', 'skip the symbol-reference pass (faster on very large repos)')
  .option('--max-files <number>', 'maximum number of source files to analyze', '5000')
  .option('--json <path>', 'also write the JSON export to this path')
  .option('-q, --quiet', 'less output', false)
  .action(async (dir: string, options: SharedOptions) => {
    const atlas = await runAnalysis(dir, options);
    await runServer(dir, atlas, options);
  });

program
  .command('analyze')
  .description('analyze a project and write its atlas to disk')
  .argument('[dir]', 'project directory to analyze', '.')
  .option('--no-refs', 'skip the symbol-reference pass (faster on very large repos)')
  .option('--max-files <number>', 'maximum number of source files to analyze', '5000')
  .option('--json <path>', 'also write the JSON export to this path')
  .option('-q, --quiet', 'less output', false)
  .action(async (dir: string, options: SharedOptions) => {
    await runAnalysis(dir, options);
  });

program
  .command('serve')
  .description('serve an atlas that has already been analyzed')
  .argument('[dir]', 'project directory', '.')
  .option('-p, --port <number>', 'port for the local server', '4477')
  .option('--no-open', "don't open a browser")
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
    const documented = s.files > 0 ? Math.round((s.documentedFiles / s.files) * 100) : 0;
    console.log(
      pc.dim(
        `  ${documented}% of files have a docstring App Atlas can read (${s.documentedFiles}/${s.files}). ` +
          `Run 'app-atlas init' in M3 to teach your agent to write them.`,
      ),
    );
    console.log('');
    console.log(pc.dim(`  atlas    ${path.relative(process.cwd(), dbPath) || dbPath}`));
    console.log(pc.dim(`  export   ${path.relative(process.cwd(), jsonPath) || jsonPath}`));
    console.log(pc.dim(`  analyzed in ${((Date.now() - started) / 1000).toFixed(1)}s`));
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
  const handle = await startServer({ atlas, port: Number(options.port ?? 4477) || 4477 });
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

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error('');
  console.error(pc.red(`App Atlas failed: ${(err as Error).message}`));
  if (process.env.APP_ATLAS_DEBUG) console.error(err);
  process.exitCode = 1;
});

export { atlasDbPath, atlasJsonPath };
