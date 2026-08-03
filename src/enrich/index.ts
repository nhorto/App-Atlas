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
import type { AppFacts, GroupOutline, LabelItem } from './prompts.js';
import type { Group } from '../model/groups.js';
import { isParked } from '../analyze/retired.js';
import { buildGroups } from '../model/groups.js';
import { knownServiceNames } from '../analyze/boundaries/catalog.js';
import { fileBatchRequest, groupBatchRequest, moduleBatchRequest, overviewRequest } from './prompts.js';
import type { CachedExplanation, EnrichBackend, EnrichTier, EnrichUsage } from './types.js';
import { estimateTokens, explanationKey } from './types.js';
import type { MethodsByRoute } from './validate.js';
import {
  cleanLabel,
  cleanParagraph,
  cleanSentence,
  dropWrongMethods,
  methodsByRoute,
  parseJsonReply,
} from './validate.js';

/** Batch sizes. Big enough that an agent CLI's startup cost is amortised, small
 *  enough that one malformed reply loses a dozen descriptions rather than a hundred. */
const FILES_PER_REQUEST = 12;
/**
 * Smaller than the file batch because each group carries far more facts — its members,
 * its doors, its arrows — and a batch that overflows loses every description in it.
 */
const GROUPS_PER_REQUEST = 6;
/** Folders that are not groups carry the old, thin facts, so they batch as they always did. */
const FOLDERS_PER_REQUEST = 8;

/** Ceilings, so pointing this at a huge repo cannot run away with someone's money. */
const DEFAULT_MAX_FILES = 400;
/**
 * How many groups get their own description, and how many the overview paragraph is shown.
 *
 * The clustering deliberately does not truncate a repo's own top level — a Go repo with
 * twenty packages has twenty groups, and dropping four of them there would be dropping
 * part of the architecture. Deciding how many will fit is this layer's job, because this
 * is the layer that knows what a paragraph and a batch can hold.
 */
const MAX_GROUPS_DESCRIBED = 24;
const MAX_GROUPS_IN_OVERVIEW = 12;
const MAX_FOLDERS_DESCRIBED = 40;

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
  /**
   * Companies the overview named that no detector found (#35).
   *
   * Not a correction — nothing here changes a box on a screen, because a generated
   * sentence is not evidence. It is a lead: the paragraph and the diagram are drawn
   * from the same list and shown together, so a name in one and not the other means one
   * of the two layers is wrong, and it is worth knowing which.
   *
   * "Found" means found *anywhere the reader looks* — as a service, as a data store, or
   * as a framework — not in the service list alone (#83). A lead nobody believes is worth
   * less than no lead, and this one used to fire on every run of our own fixture.
   */
  contradictions: string[];
  /**
   * Route-and-verb pairs the endpoint table disproved, like `GET /api/posts` (#47).
   *
   * Unlike `contradictions` these are acted on rather than merely reported: the atlas
   * holds the verb for that path, so the sentence is not a lead, it is wrong. The
   * sentence carrying it was dropped, and this is what it said — printed so that a
   * missing sentence is a decision the reader can see rather than a silence.
   */
  misattributedRoutes: string[];
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
    contradictions: [],
    misattributedRoutes: [],
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    additions: new Map(),
  };

  const byId = new Map(atlas.nodes.map((node) => [node.id, node]));
  const responsibilities = responsibilitiesByPath(atlas);
  // Every door the analyzer found, so a sentence can be held to it on the way in. Built
  // once here and threaded down, because the check has to run wherever text reaches a
  // node — including text that came back out of the cache, which was written before this
  // check existed and is re-examined rather than trusted.
  const routes = methodsByRoute(
    atlas.nodes
      .filter((node) => node.kind === 'endpoint')
      .map((node) => node.meta as unknown as EndpointMeta),
  );

  // --- work out what needs saying ---------------------------------------------
  // The clustering both tiers are built on. Computed once: the overview describes the
  // arrows between the groups, and the group tier describes the groups themselves, and
  // they must be describing the same cut or the paragraph and the cards disagree.
  const groups = buildGroups(atlas.nodes, atlas.edges).groups;

  const appNode = atlas.nodes.find((node) => node.kind === 'app');
  const appFacts = appNode ? collectAppFacts(atlas, groups) : null;
  const appHash = appFacts ? hashParts('overview', factSignature(appFacts)) : '';

  const groupItems = collectGroupItems(groups, byId);
  // The folders the cut did not stop at are still boxes on the map, and they get the older,
  // cheaper ask — see `moduleBatchRequest`. Without this the fixture went from fourteen
  // named folders to four, which is a better answer about the app and a worse map of it.
  const folderItems = collectFolderItems(atlas, byId, responsibilities, new Set(groups.map((g) => g.id)));
  const { items: fileItems, skipped } = collectFileItems(atlas, responsibilities, maxFiles);
  report.filesSkipped = skipped;

  // --- spend nothing on anything we already have -------------------------------
  const pending = {
    overview: false,
    groups: [] as Group[],
    folders: [] as LabelItem[],
    files: [] as LabelItem[],
  };

  if (appNode && appFacts) {
    const hit = cache.get(explanationKey('overview', appHash));
    if (hit) {
      applySummary(appNode, hit.text, routes, report);
      report.reusedFromCache++;
    } else {
      pending.overview = true;
    }
  }

  for (const item of groupItems) {
    const hit = cache.get(explanationKey('module', item.hash));
    if (!hit) {
      pending.groups.push(item.group);
      continue;
    }
    const node = byId.get(item.group.id);
    if (node) applyModule(node, hit.text, item.group.fileCount, routes, report);
    report.reusedFromCache++;
  }

  for (const item of folderItems) {
    const hit = cache.get(explanationKey('module', item.hash));
    if (!hit) {
      pending.folders.push(item.item);
      continue;
    }
    const node = byId.get(item.item.key);
    if (node) applyModule(node, hit.text, null, routes, report);
    report.reusedFromCache++;
  }

  for (const item of fileItems) {
    const hit = cache.get(explanationKey('file', item.hash));
    if (!hit) {
      pending.files.push(item.item);
      continue;
    }
    const node = byId.get(item.item.key);
    if (node && applySummary(node, hit.text, routes, report)) report.described++;
    report.reusedFromCache++;
  }

  const hashOf = new Map<string, string>();
  for (const entry of groupItems) hashOf.set(entry.group.id, entry.hash);
  for (const entry of [...folderItems, ...fileItems]) hashOf.set(entry.item.key, entry.hash);

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
      // Everything the paragraph was handed that the reader can also see for themselves.
      // Derived here rather than stored on `AppFacts`, which is the prompt payload and
      // whose JSON is the cache key — this adds nothing new to ask about.
      namesOnScreen: [...appFacts.services, ...appFacts.stores, ...appFacts.frameworks],
    });
  }
  for (const batch of chunk(pending.groups, GROUPS_PER_REQUEST)) {
    jobs.push({
      tier: 'module',
      nodeIds: batch.map((group) => group.id),
      hashes: batch.map((group) => hashOf.get(group.id) ?? ''),
      paths: batch.map((group) => group.path),
      describes: batch.map((group) => group.fileCount),
      request: groupBatchRequest(batch.map((group, index) => ({ key: String(index + 1), group }))),
    });
  }
  for (const batch of chunk(pending.folders, FOLDERS_PER_REQUEST)) {
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

  report.pendingItems = pending.groups.length + pending.folders.length + pending.files.length + (pending.overview ? 1 : 0);
  if (jobs.length === 0 || !backend) return report;

  // --- ask, but only when it costs -----------------------------------------------
  if (backend.billing === 'metered' && options.confirm) {
    const estimate = estimateFor(backend, jobs, pending.overview, pending.groups.length + pending.folders.length + pending.files.length);
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
      applyReply(job, reply.text, byId, routes, report);
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
  /**
   * Module tier only: how many files the answer will be *about*, per node, or null when
   * the answer covers whatever the node covers.
   *
   * A group is a cut across the folder tree, so the sentence written about `app` is
   * written about the five files sitting directly in it — while the box on the map
   * standing for `app` covers its ninety-six-file subtree. Carrying the number the
   * description was written against is what lets every screen print a count that
   * matches the words beside it (#94).
   */
  describes?: (number | null)[];
  request: { system: string; user: string; maxOutputTokens: number };
  /**
   * Overview only: everything about this app the reader will find on their own screen —
   * the services, the stores and the frameworks. What the prose is held against.
   */
  namesOnScreen?: string[];
}

/**
 * Companies the paragraph names that the reader will not find anywhere on their screen.
 *
 * Only names from the catalog count. "Stripe" appearing in prose beside a diagram with
 * no Stripe box means the detectors missed a payment integration or the model invented
 * one, and either is worth a line in the run report. Anything the tool has never heard
 * of is not evidence of a gap — it is a word.
 *
 * **The comparison is against everything shown, not the service list alone** (#83). A
 * store is a box on the boundary screen and a framework is the "Built with" line, so a
 * paragraph naming either is naming something the reader can see. Checking only the
 * services made the fixture report `Supabase` and `Vercel` as unfounded on every single
 * run — Supabase being a detected store holding two of its tables, Vercel being the
 * framework whose cron door carries a schedule. A warning that fires every time is one
 * people learn to scroll past, and this one fired on the repo everything else is tested
 * against.
 *
 * Matching runs both ways through {@link mentions}, so it no longer matters that a store
 * arrives spelled `Supabase Postgres (page_views, client_errors)` rather than `Supabase`.
 */
function companiesNotShown(paragraph: string, shown: string[]): string[] {
  const onScreen = shown.join('\n');
  const missing: string[] = [];
  for (const name of knownServiceNames()) {
    if (!mentions(paragraph, name)) continue;
    if (mentions(onScreen, name)) continue;
    missing.push(name);
  }
  return missing;
}

/**
 * Whether a company is named in this text, as a whole name rather than part of a word.
 *
 * `\b` cannot do this job. Half the reason is the escaping — the version this replaces
 * compiled to a no-op, so `Trigger.dev` matched "TriggerXdev" and `Email (SMTP)` matched
 * "Email SMTP", both of which are the tool inventing a finding out of a typo. The other
 * half is that `\b` is defined against word characters, so it never fires after the
 * closing bracket of `Email (SMTP)` and that name could not be matched at all.
 *
 * Explicit lookarounds say the thing actually meant: not butted up against a letter or a
 * digit. "Resend" still does not match "resends".
 */
function mentions(text: string, name: string): boolean {
  return new RegExp(`(?<![A-Za-z0-9])${escapeForRegExp(name)}(?![A-Za-z0-9])`, 'i').test(text);
}

function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function applyReply(
  job: Job,
  text: string,
  byId: Map<string, AtlasNode>,
  routes: MethodsByRoute,
  report: EnrichReport,
): void {
  if (job.tier === 'overview') {
    const node = byId.get(job.nodeIds[0]);
    const paragraph = cleanParagraph(text);
    if (!node || !paragraph) return;
    report.contradictions.push(...companiesNotShown(paragraph, job.namesOnScreen ?? []));
    // What the model wrote is what gets cached, even when part of it is about to be
    // dropped: the cache records an answer we paid for, and whether a sentence stands up
    // to the endpoint table is a judgement against a table that improves between runs.
    // Storing the trimmed version would bake today's detectors into next year's map, and
    // storing nothing would buy the same paragraph again on every run.
    remember(report, 'overview', node.id, job.hashes[0], paragraph);
    applySummary(node, paragraph, routes, report);
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
      const describes = job.describes?.[index] ?? null;
      if (applyModule(node, stored, describes, routes, report)) {
        remember(report, 'module', node.id, hash, stored);
      }
      continue;
    }

    const sentence = cleanSentence(value);
    if (!sentence) continue;
    remember(report, 'file', node.id, hash, sentence);
    if (applySummary(node, sentence, routes, report)) report.described++;
  }
}

/**
 * Folders carry a name and a sentence, stored together so one cache hit restores both.
 *
 * `describes` is how many files the answer was written about, when that is a different
 * number from the subtree the node stands for. It is recorded beside the words rather
 * than left to the reader to notice, because the alternative is what #94 reported: a
 * card reading "Build Settings · 96 files" over a sentence about five of them.
 */
function applyModule(
  node: AtlasNode,
  stored: string,
  describes: number | null,
  routes: MethodsByRoute,
  report: EnrichReport,
): boolean {
  let entry: { name?: unknown; text?: unknown };
  try {
    entry = JSON.parse(stored) as { name?: unknown; text?: unknown };
  } catch {
    return false;
  }

  const label = cleanLabel(entry.name, node.name);
  const sentence = cleanSentence(entry.text);
  if (describes !== null && (label || sentence)) node.meta.describedFileCount = describes;
  if (label) {
    node.label = label;
    report.labelled++;
  }
  if (sentence && applySummary(node, sentence, routes, report)) report.described++;
  // The answer was usable even if the endpoint table then took the sentence off it, so
  // it is still worth caching — otherwise the same paragraph is bought again every run.
  return Boolean(label || sentence);
}

/**
 * The one door every generated sentence goes through on its way onto a node, whether it
 * has just been paid for or has come back out of the cache.
 *
 * Two rules live here because both have to hold in every code path. A generated sentence
 * never displaces a docstring — the developer's own words outrank ours, always. And no
 * sentence may pair one of your routes with a verb the route does not answer to; that
 * one is dropped rather than corrected, because rewriting the verb would put a sentence
 * on screen that nobody wrote. Returns whether anything was actually written.
 */
function applySummary(node: AtlasNode, text: string, routes: MethodsByRoute, report: EnrichReport): boolean {
  if (node.summarySource === 'docs') return false;

  const grounded = dropWrongMethods(text, routes);
  for (const claim of grounded.wrong) {
    if (!report.misattributedRoutes.includes(claim)) report.misattributedRoutes.push(claim);
  }
  if (!grounded.text) return false;

  node.summary = grounded.text;
  node.summarySource = 'ai';
  node.provenance = 'ai';
  return true;
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

/**
 * The facts the overview paragraph is written from.
 *
 * Exported so a test can hold the *material* to account rather than the sentence: what
 * the model is given decides what it can say, and "never build the app's headline flow
 * out of a folder called parked" is a property of this list (#87).
 */
export function collectAppFacts(atlas: Atlas, groups: Group[]): AppFacts {
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

  // Where the top-level folder list used to go. The groups are the same idea carried one
  // step further: they are cut to a size worth describing, and each one says which of the
  // others it feeds, which is the fact a paragraph about architecture is built out of.
  // A retired lane is left out of the material entirely (#87). Given `parked/` in the
  // list, the model did the sensible thing with it and offered "a station-estimates
  // screen in parked/station-estimates hands its request across to scripts" as one of
  // the app's two headline flows. The folder is called parked. A paragraph about how
  // this app works cannot be built out of code that says it does not run, and the
  // handoffs *into* such a folder go with it, or the sentence names a destination that
  // is not in the list.
  const live = groups.filter((group) => !isParked(group.path));
  const outline: GroupOutline[] = live.slice(0, MAX_GROUPS_IN_OVERVIEW).map((group) => ({
    path: group.path,
    files: group.fileCount,
    zone: group.zone,
    handsOffTo: group.dependsOn
      .filter((link) => !isParked(link.toPath))
      .slice(0, 4)
      .map((link) => link.toPath || 'the repo root'),
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
    groups: outline,
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

interface KeyedGroup {
  group: Group;
  hash: string;
}

/**
 * The groups worth describing, with the cache key that decides whether we pay for each.
 *
 * A group is dropped when nothing in the atlas answers to its id. That happens for exactly
 * one group — the bucket holding files at the top of the repo, which is synthesized by the
 * clustering and has no folder node behind it. It still shapes the overview paragraph,
 * where it is one line among the others; there is simply no card for a sentence to land on.
 */
function collectGroupItems(groups: Group[], byId: Map<string, AtlasNode>): KeyedGroup[] {
  return groups
    .filter((group) => byId.has(group.id))
    .slice(0, MAX_GROUPS_DESCRIBED)
    .map((group) => ({ group, hash: hashParts('module', factSignature(group)) }));
}

/**
 * The folders inside a group, which are boxes on the map with nothing else to name them.
 *
 * This is the pass the group tier replaced for the folders it covers, kept for the ones it
 * does not. The facts are the old thin ones on purpose: `src/app/api/orders` holds one
 * route file, hands off to nothing in particular, and inventing a shape for it would be
 * writing about a group that is not there.
 */
function collectFolderItems(
  atlas: Atlas,
  byId: Map<string, AtlasNode>,
  responsibilities: Map<string, string[]>,
  isGroup: Set<string>,
): Keyed[] {
  const children = new Map<string, AtlasNode[]>();
  for (const node of atlas.nodes) {
    if (!node.parentId) continue;
    const list = children.get(node.parentId);
    if (list) list.push(node);
    else children.set(node.parentId, [node]);
  }

  return atlas.nodes
    .filter((node) => node.kind === 'module' && !isGroup.has(node.id))
    .sort((a, b) => Number(b.meta.descendantFileCount ?? 0) - Number(a.meta.descendantFileCount ?? 0))
    .slice(0, MAX_FOLDERS_DESCRIBED)
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
      return { item, hash: hashParts('folder', factSignature(item)) };
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
function factSignature(facts: LabelItem | AppFacts | Group): string {
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
