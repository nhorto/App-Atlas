/**
 * @fileoverview The words layer.
 *
 * Turns an atlas of compiler facts into an atlas people can read, in the order
 * SPEC.md 5.5 lays out: docstrings the repo already has are used verbatim and cost
 * nothing, generated text fills only the gaps, and everything carries a label saying
 * which it is.
 *
 * Three properties this file exists to guarantee:
 *
 * - **Nothing is generated twice.** The cache key is the hash of the facts we send,
 *   so the same question always returns the same answer without paying again. That is
 *   a slightly stricter promise than "keyed by node hash": reformatting a file's
 *   internals does not change what its one-line description is derived from, so it
 *   does not re-bill either.
 *
 * - **Nothing is spent without permission.** The user is asked exactly once, before
 *   the first request, and only when the backend actually charges per token. A
 *   subscription they already pay for is free at the margin, so interrupting them for
 *   it is friction with nothing on the other side of the scale.
 *
 * - **Nothing invented survives.** The model is only ever asked about nodes we found.
 *   Keys we did not send are dropped, and every answer goes through validate.ts.
 */
import type { Atlas, AtlasNode, EndpointMeta, ServiceMeta, StoreMeta } from '../model/types.js';
import { hashParts } from '../util/hash.js';
import type { AppFacts, LabelItem } from './prompts.js';
import { fileBatchRequest, moduleBatchRequest, overviewRequest } from './prompts.js';
import type { CachedExplanation, EnrichBackend, EnrichTier, EnrichUsage } from './types.js';
import { estimateTokens, explanationKey } from './types.js';
import { cleanLabel, cleanParagraph, cleanSentence, parseJsonReply } from './validate.js';

/** Batch sizes. Big enough that an agent CLI's startup cost is amortised, small
 *  enough that one malformed reply loses a dozen descriptions rather than a hundred. */
const FILES_PER_REQUEST = 12;
const MODULES_PER_REQUEST = 8;

/** Ceilings, so pointing this at a huge repo cannot run away with someone's money. */
const DEFAULT_MAX_FILES = 400;
const MAX_MODULES = 40;

export interface CostEstimate {
  backend: EnrichBackend;
  /** Nodes that would be described. */
  items: number;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  /** Null when the backend has no published price for its model. */
  costUsd: number | null;
}

export interface EnrichOptions {
  atlas: Atlas;
  /**
   * Null means "apply what is cached and tell me what is still missing". Callers use
   * that first, so a project whose explanations are all cached never starts a backend
   * process at all — the common case on a second run costs nothing and takes no time.
   */
  backend: EnrichBackend | null;
  /** Everything generated on previous runs, by cache key. */
  cache: Map<string, CachedExplanation>;
  maxFiles?: number;
  /** Asked once, only for backends that bill per token. Returning false stops. */
  confirm?: (estimate: CostEstimate) => Promise<boolean>;
  onProgress?: (stage: string, done: number, total: number) => void;
}

export interface EnrichReport {
  backend: string;
  backendLabel: string;
  /** Still missing after the cache was applied. The reason to start a backend. */
  pendingItems: number;
  /** Nodes given a plain-English name. */
  labelled: number;
  /** Nodes given a generated description. */
  described: number;
  reusedFromCache: number;
  requests: number;
  failedRequests: number;
  /** Files past the cap, never sent. Reported so a limit is never silent. */
  filesSkipped: number;
  declined: boolean;
  usage: EnrichUsage;
  /** Newly generated explanations for the caller to persist. */
  additions: Map<string, CachedExplanation>;
}

export async function enrichAtlas(options: EnrichOptions): Promise<EnrichReport> {
  const { atlas, backend, cache } = options;
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;

  const report: EnrichReport = {
    backend: backend?.id ?? 'cache',
    backendLabel: backend?.label ?? 'cache',
    pendingItems: 0,
    labelled: 0,
    described: 0,
    reusedFromCache: 0,
    requests: 0,
    failedRequests: 0,
    filesSkipped: 0,
    declined: false,
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    additions: new Map(),
  };

  const byId = new Map(atlas.nodes.map((node) => [node.id, node]));
  const responsibilities = responsibilitiesByPath(atlas);

  // --- work out what needs saying ---------------------------------------------
  const appNode = atlas.nodes.find((node) => node.kind === 'app');
  const appFacts = appNode ? collectAppFacts(atlas) : null;
  const appHash = appFacts ? hashParts('overview', factSignature(appFacts)) : '';

  const moduleItems = collectModuleItems(atlas, byId, responsibilities);
  const { items: fileItems, skipped } = collectFileItems(atlas, responsibilities, maxFiles);
  report.filesSkipped = skipped;

  // --- spend nothing on anything we already have -------------------------------
  const pending = { overview: false, modules: [] as LabelItem[], files: [] as LabelItem[] };

  if (appNode && appFacts) {
    const hit = cache.get(explanationKey('overview', appHash));
    if (hit) {
      applySummary(appNode, hit.text);
      report.reusedFromCache++;
    } else {
      pending.overview = true;
    }
  }

  for (const item of moduleItems) {
    const hit = cache.get(explanationKey('module', item.hash));
    if (!hit) {
      pending.modules.push(item.item);
      continue;
    }
    const node = byId.get(item.item.key);
    if (node) applyModule(node, hit.text, report);
    report.reusedFromCache++;
  }

  for (const item of fileItems) {
    const hit = cache.get(explanationKey('file', item.hash));
    if (!hit) {
      pending.files.push(item.item);
      continue;
    }
    const node = byId.get(item.item.key);
    if (node) {
      applySummary(node, hit.text);
      report.described++;
    }
    report.reusedFromCache++;
  }

  const hashOf = new Map<string, string>();
  for (const entry of [...moduleItems, ...fileItems]) hashOf.set(entry.item.key, entry.hash);

  // --- build every request before spending anything -----------------------------
  // Everything is assembled first so the estimate shown to the user is the real one,
  // not a guess that a later batch could invalidate.
  const jobs: Job[] = [];
  if (pending.overview && appFacts && appNode) {
    jobs.push({
      tier: 'overview',
      nodeIds: [appNode.id],
      hashes: [appHash],
      paths: [''],
      request: overviewRequest(appFacts),
    });
  }
  for (const batch of chunk(pending.modules, MODULES_PER_REQUEST)) {
    jobs.push({
      tier: 'module',
      nodeIds: batch.map((i) => i.key),
      hashes: batch.map((i) => hashOf.get(i.key) ?? ''),
      paths: batch.map((i) => i.path),
      request: moduleBatchRequest(reKey(batch)),
    });
  }
  for (const batch of chunk(pending.files, FILES_PER_REQUEST)) {
    jobs.push({
      tier: 'file',
      nodeIds: batch.map((i) => i.key),
      hashes: batch.map((i) => hashOf.get(i.key) ?? ''),
      paths: batch.map((i) => i.path),
      request: fileBatchRequest(reKey(batch)),
    });
  }

  report.pendingItems = pending.modules.length + pending.files.length + (pending.overview ? 1 : 0);
  if (jobs.length === 0 || !backend) return report;

  // --- ask, but only when it costs -----------------------------------------------
  if (backend.billing === 'metered' && options.confirm) {
    const estimate = estimateFor(backend, jobs, pending.overview, pending.modules.length + pending.files.length);
    const approved = await options.confirm(estimate);
    if (!approved) {
      report.declined = true;
      return report;
    }
  }

  // --- generate --------------------------------------------------------------
  let done = 0;
  options.onProgress?.('Writing explanations', 0, jobs.length);

  await pool(jobs, backend.concurrency, async (job) => {
    const controller = new AbortController();
    try {
      const reply = await backend.run(job.request, controller.signal);
      report.requests++;
      accumulate(report.usage, reply.usage);
      applyReply(job, reply.text, byId, report);
    } catch {
      // One failed batch is a dozen missing sentences, not a failed analysis. The
      // static map is the product; the words are the polish on top of it.
      report.requests++;
      report.failedRequests++;
    } finally {
      done++;
      options.onProgress?.('Writing explanations', done, jobs.length);
    }
  });

  return report;
}

// ---------------------------------------------------------------------------
// Applying replies
// ---------------------------------------------------------------------------

interface Job {
  tier: EnrichTier;
  nodeIds: string[];
  /** Cache key per node, in the same order as `nodeIds`. */
  hashes: string[];
  /** The path shown in the prompt, also in that order. Accepted as a reply key. */
  paths: string[];
  request: { system: string; user: string; maxOutputTokens: number };
}

function applyReply(job: Job, text: string, byId: Map<string, AtlasNode>, report: EnrichReport): void {
  if (job.tier === 'overview') {
    const node = byId.get(job.nodeIds[0]);
    const paragraph = cleanParagraph(text);
    if (!node || !paragraph) return;
    applySummary(node, paragraph);
    remember(report, 'overview', node.id, job.hashes[0], paragraph);
    return;
  }

  const parsed = parseJsonReply(text);
  if (!parsed) return;

  for (let index = 0; index < job.nodeIds.length; index++) {
    // Replies are asked for by position, not by node id: a long id is one more thing
    // for a model to mangle, and a mangled one would silently attach a description to
    // the wrong box.
    //
    // The path is accepted as an alternate key because models reach for the most
    // human-looking identifier on the line no matter how the shape is specified. Both
    // are things we put in the prompt, so neither can smuggle in a node we never sent.
    const value = parsed[String(index + 1)] ?? parsed[job.paths[index]];
    if (value === undefined) continue;

    const node = byId.get(job.nodeIds[index]);
    const hash = job.hashes[index];
    if (!node || !hash) continue;

    if (job.tier === 'module') {
      const entry = value as { name?: unknown; text?: unknown };
      const stored = JSON.stringify({ name: entry?.name ?? null, text: entry?.text ?? null });
      if (applyModule(node, stored, report)) remember(report, 'module', node.id, hash, stored);
      continue;
    }

    const sentence = cleanSentence(value);
    if (!sentence) continue;
    applySummary(node, sentence);
    report.described++;
    remember(report, 'file', node.id, hash, sentence);
  }
}

/** Folders carry a name and a sentence, stored together so one cache hit restores both. */
function applyModule(node: AtlasNode, stored: string, report: EnrichReport): boolean {
  let entry: { name?: unknown; text?: unknown };
  try {
    entry = JSON.parse(stored) as { name?: unknown; text?: unknown };
  } catch {
    return false;
  }

  const label = cleanLabel(entry.name, node.name);
  const sentence = cleanSentence(entry.text);
  if (label) {
    node.label = label;
    report.labelled++;
  }
  if (sentence) {
    applySummary(node, sentence);
    report.described++;
  }
  return Boolean(label || sentence);
}

/**
 * A generated sentence never displaces a docstring. That is the ladder in one line:
 * the developer's own words outrank ours, always, whatever order things happen in.
 */
function applySummary(node: AtlasNode, text: string): void {
  if (node.summarySource === 'docs') return;
  node.summary = text;
  node.summarySource = 'ai';
  node.provenance = 'ai';
}

function remember(report: EnrichReport, tier: EnrichTier, nodeId: string, hash: string, text: string): void {
  report.additions.set(explanationKey(tier, hash), {
    nodeId,
    tier,
    hash,
    text,
    backend: report.backend,
    createdAt: new Date().toISOString(),
  });
}

// ---------------------------------------------------------------------------
// Gathering facts
// ---------------------------------------------------------------------------

/** What each file is on the hook for: the doors, stores and services it touches. */
function responsibilitiesByPath(atlas: Atlas): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const add = (path: string | undefined, what: string) => {
    if (!path) return;
    const list = map.get(path);
    if (list) {
      if (list.length < 8 && !list.includes(what)) list.push(what);
    } else {
      map.set(path, [what]);
    }
  };

  for (const node of atlas.nodes) {
    if (node.kind === 'endpoint') {
      const meta = node.meta as unknown as EndpointMeta;
      if (meta.endpointKind === 'env') continue;
      const what = meta.route ? `${meta.method ?? meta.endpointKind} ${meta.route}` : node.name;
      for (const site of meta.sites ?? []) add(site.path, what);
    } else if (node.kind === 'service') {
      const meta = node.meta as unknown as ServiceMeta;
      for (const site of meta.sites ?? []) add(site.path, `calls ${node.name}`);
    } else if (node.kind === 'store') {
      const meta = node.meta as unknown as StoreMeta;
      for (const site of meta.sites ?? []) add(site.path, `uses ${node.name}`);
    }
  }
  return map;
}

function collectAppFacts(atlas: Atlas): AppFacts {
  const waysIn: string[] = [];
  const services: string[] = [];
  const stores: string[] = [];

  for (const node of atlas.nodes) {
    if (node.kind === 'endpoint') {
      const meta = node.meta as unknown as EndpointMeta;
      if (meta.endpointKind === 'env') continue;
      if (waysIn.length < 14) waysIn.push(meta.route ? `${meta.method ?? meta.endpointKind} ${meta.route}` : node.name);
    } else if (node.kind === 'service' && services.length < 12) {
      services.push(node.name);
    } else if (node.kind === 'store' && stores.length < 8) {
      const meta = node.meta as unknown as StoreMeta;
      stores.push(meta.tables?.length ? `${node.name} (${meta.tables.slice(0, 6).join(', ')})` : node.name);
    }
  }

  const topFolders = atlas.nodes
    .filter((node) => node.kind === 'module' && (node.parentId ?? '').startsWith('app:'))
    .sort((a, b) => Number(b.meta.descendantFileCount ?? 0) - Number(a.meta.descendantFileCount ?? 0))
    .slice(0, 10)
    .map((node) => ({
      path: String(node.meta.dirPath ?? node.path ?? node.name),
      files: Number(node.meta.descendantFileCount ?? node.meta.fileCount ?? 0),
      zone: node.zone,
    }));

  // The repo's own docstrings are the best evidence there is, and they are free.
  const existingDocs = atlas.nodes
    .filter((node) => node.kind === 'file' && node.summarySource === 'docs' && node.summary)
    .slice(0, 8)
    .map((node) => `${node.path}: ${firstSentence(node.summary ?? '')}`);

  return {
    name: atlas.meta.name,
    frameworks: atlas.meta.frameworks,
    fileCount: atlas.meta.stats.files,
    topFolders,
    waysIn,
    services,
    stores,
    existingDocs,
  };
}

interface Keyed {
  item: LabelItem;
  hash: string;
}

function collectModuleItems(
  atlas: Atlas,
  byId: Map<string, AtlasNode>,
  responsibilities: Map<string, string[]>,
): Keyed[] {
  const children = new Map<string, AtlasNode[]>();
  for (const node of atlas.nodes) {
    if (!node.parentId) continue;
    const list = children.get(node.parentId);
    if (list) list.push(node);
    else children.set(node.parentId, [node]);
  }

  return atlas.nodes
    .filter((node) => node.kind === 'module')
    .sort((a, b) => Number(b.meta.descendantFileCount ?? 0) - Number(a.meta.descendantFileCount ?? 0))
    .slice(0, MAX_MODULES)
    .map((node) => {
      const kids = (children.get(node.id) ?? []).filter((k) => k.kind === 'file' || k.kind === 'module');
      const handles = new Set<string>();
      for (const kid of kids) {
        for (const what of responsibilities.get(kid.path ?? '') ?? []) {
          if (handles.size < 8) handles.add(what);
        }
      }
      const item: LabelItem = {
        key: node.id,
        path: String(node.meta.dirPath ?? node.path ?? node.name),
        zone: node.zone,
        contains: kids.slice(0, 14).map((k) => k.name),
        responsibilities: [...handles],
      };
      return { item, hash: hashParts('module', factSignature(item)) };
    })
    .filter((entry) => entry.item.contains.length > 0 && byId.has(entry.item.key));
}

/**
 * Files that need a sentence: the ones with no docstring of their own. Ranked by how
 * connected they are, because when a cap bites, the file everything imports is worth
 * more words than a leaf nobody has clicked on.
 */
function collectFileItems(
  atlas: Atlas,
  responsibilities: Map<string, string[]>,
  maxFiles: number,
): { items: Keyed[]; skipped: number } {
  const connections = new Map<string, number>();
  for (const edge of atlas.edges) {
    if (edge.kind === 'contains') continue;
    for (const id of [edge.fromId, edge.toId]) {
      connections.set(id, (connections.get(id) ?? 0) + edge.weight);
    }
  }

  const exportsOf = (node: AtlasNode) => (node.meta.exportedNames as string[] | undefined) ?? [];

  const candidates = atlas.nodes
    .filter((node) => node.kind === 'file' && node.summarySource !== 'docs')
    .sort((a, b) => (connections.get(b.id) ?? 0) - (connections.get(a.id) ?? 0) || a.id.localeCompare(b.id));

  const chosen = candidates.slice(0, maxFiles);
  const items = chosen.map((node) => {
    const item: LabelItem = {
      key: node.id,
      path: node.path ?? node.name,
      zone: node.zone,
      contains: [
        ...exportsOf(node).slice(0, 12),
        ...((node.meta.externalImports as string[] | undefined) ?? []).slice(0, 6).map((p) => `imports ${p}`),
      ],
      responsibilities: responsibilities.get(node.path ?? '') ?? [],
    };
    return { item, hash: hashParts('file', factSignature(item)) };
  });

  return { items, skipped: candidates.length - chosen.length };
}

/**
 * The cache key. It is a hash of exactly what goes into the prompt, so the promise
 * "you are never charged twice for the same answer" is structurally true rather than
 * something we have to remember to maintain.
 */
function factSignature(facts: LabelItem | AppFacts): string {
  return JSON.stringify(facts);
}

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

function estimateFor(backend: EnrichBackend, jobs: Job[], overview: boolean, items: number): CostEstimate {
  let inputTokens = 0;
  let outputTokens = 0;
  for (const job of jobs) {
    inputTokens += estimateTokens(job.request.system) + estimateTokens(job.request.user);
    // Models rarely use the whole ceiling; half of it is a fairer guess than all of it
    // and still errs high for the short answers we ask for.
    outputTokens += Math.round(job.request.maxOutputTokens * 0.5);
  }

  const pricing = backend.pricing;
  const costUsd = pricing
    ? (inputTokens / 1_000_000) * pricing.inputPerMillion + (outputTokens / 1_000_000) * pricing.outputPerMillion
    : null;

  return {
    backend,
    items: items + (overview ? 1 : 0),
    requests: jobs.length,
    inputTokens,
    outputTokens,
    costUsd,
  };
}

/** Replies are keyed by position; this hands the model 1, 2, 3 instead of node ids. */
function reKey(items: LabelItem[]): LabelItem[] {
  return items.map((item, index) => ({ ...item, key: String(index + 1) }));
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function pool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const runners = Array.from({ length: Math.max(1, Math.min(limit, queue.length)) }, async () => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      await worker(next);
    }
  });
  await Promise.all(runners);
}

function accumulate(total: EnrichUsage, usage: EnrichUsage | undefined): void {
  if (!usage) return;
  total.inputTokens += usage.inputTokens;
  total.outputTokens += usage.outputTokens;
  if (typeof usage.costUsd === 'number') total.costUsd = (total.costUsd ?? 0) + usage.costUsd;
}

function firstSentence(text: string): string {
  const match = /^[^.!?]+[.!?]?/.exec(text.trim());
  return (match?.[0] ?? text).trim().slice(0, 160);
}
