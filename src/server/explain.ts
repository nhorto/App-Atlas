/**
 * @fileoverview Explaining one thing, when someone asks.
 *
 * The third tier of SPEC.md 5.5, and the only one that runs from the browser. Cost
 * scales with curiosity instead of repository size: nobody pays to describe nine
 * hundred functions on the chance that one gets clicked.
 *
 * It is also the only tier that sends real source code. A function's purpose genuinely
 * is not recoverable from its signature, and the user has just pointed at this one
 * specific function and asked — so the trade is worth making here and nowhere else.
 * The UI says so on the button, and the answer says which backend wrote it.
 *
 * Nothing is spawned until the first click. A user who never opens a detail panel
 * never starts an agent CLI, which is why backend selection is memoised rather than
 * resolved when the server boots.
 */
import fs from 'node:fs';
import path from 'node:path';
import { selectBackend } from '../enrich/backends/index.js';
import { symbolRequest } from '../enrich/prompts.js';
import type { SymbolFacts } from '../enrich/prompts.js';
import type { EnrichBackend } from '../enrich/types.js';
import { explanationKey } from '../enrich/types.js';
import { cleanParagraph } from '../enrich/validate.js';
import { AtlasStore, atlasDbPath } from '../model/store.js';
import type { AtlasGraph } from '../model/graph.js';
import type { AtlasNode, FunctionMeta } from '../model/types.js';
import { hashParts } from '../util/hash.js';

/** Enough source to explain a function, capped so one huge file cannot blow a budget. */
const MAX_SOURCE_LINES = 220;
const MAX_SOURCE_CHARS = 7000;

export interface AiServerOptions {
  /** False under `--no-ai`. The endpoint then explains only from the cache. */
  enabled: boolean;
  backendId?: string;
  model?: string;
}

export interface ExplainResult {
  text: string;
  /** Which backend wrote it, so the panel can say. Absent for a cache hit. */
  backend?: string;
  cached: boolean;
}

export interface ExplainError {
  error: string;
}

export class Explainer {
  private resolved: Promise<EnrichBackend | null> | null = null;

  constructor(
    private readonly options: AiServerOptions,
    private readonly getGraph: () => AtlasGraph,
  ) {}

  /** What the UI needs to label the button honestly before anything has been run. */
  status(): { enabled: boolean } {
    return { enabled: this.options.enabled };
  }

  async explain(nodeId: string): Promise<ExplainResult | ExplainError> {
    const graph = this.getGraph();
    const node = graph.getNodeById(nodeId);
    if (!node) return { error: `Unknown node: ${nodeId}` };
    if (node.summarySource === 'docs') {
      // The developer already wrote one. Generating a second is money spent to
      // produce a worse answer than the one on screen.
      return { error: 'This one already has a description from your own code.' };
    }

    const facts = this.factsFor(node, graph);
    const hash = hashParts('symbol', JSON.stringify(facts));
    const key = explanationKey('symbol', hash);
    const dbPath = atlasDbPath(graph.meta.root);

    const store = openStore(dbPath);
    try {
      const hit = store?.readExplanations().get(key);
      if (hit) {
        apply(node, hit.text);
        return { text: hit.text, cached: true };
      }

      if (!this.options.enabled) {
        return { error: 'Explanations are turned off for this atlas (--no-ai).' };
      }

      const backend = await this.backend();
      if (!backend) {
        return {
          error: 'No AI backend is available. Install Claude Code or Codex CLI, or set ANTHROPIC_API_KEY.',
        };
      }

      const controller = new AbortController();
      const reply = await backend.run(symbolRequest(facts), controller.signal);
      const text = cleanParagraph(reply.text, 4);
      if (!text) return { error: `${backend.label} did not return a usable description.` };

      apply(node, text);
      store?.writeExplanations(
        new Map([
          [key, { nodeId, tier: 'symbol' as const, hash, text, backend: backend.id, createdAt: new Date().toISOString() }],
        ]),
      );
      return { text, backend: backend.label, cached: false };
    } catch (err) {
      return { error: (err as Error).message };
    } finally {
      store?.close();
    }
  }

  /** Resolved once per server, on the first click, and reused after that. */
  private backend(): Promise<EnrichBackend | null> {
    if (!this.resolved) {
      this.resolved = selectBackend({ prefer: this.options.backendId, model: this.options.model })
        .then((selection) => selection.backend)
        .catch(() => null);
    }
    return this.resolved;
  }

  private factsFor(node: AtlasNode, graph: AtlasGraph): SymbolFacts {
    const meta = node.meta as unknown as Partial<FunctionMeta>;
    const view = graph.getNode(node.id);

    return {
      name: node.name,
      kind: node.kind === 'function' ? (meta.isMethod ? 'method' : 'function') : String(node.meta.typeKind ?? node.kind),
      path: node.path ?? '',
      signature: meta.signature,
      source: readSource(graph.meta.root, node),
      uses: (view?.outgoing ?? []).slice(0, 12).map((link) => link.other.name),
      usedBy: (view?.incoming ?? []).slice(0, 12).map((link) => link.other.name),
    };
  }
}

function apply(node: AtlasNode, text: string): void {
  node.summary = text;
  node.summarySource = 'ai';
  node.provenance = 'ai';
}

/**
 * Pulls one declaration out of the file it lives in. Reading on demand rather than
 * keeping every function body in the atlas keeps the export small and means the
 * source shown is whatever is on disk right now.
 */
function readSource(root: string, node: AtlasNode): string | undefined {
  if (!node.path || !node.startLine) return undefined;
  const absolute = path.resolve(root, node.path);
  // Never read outside the analyzed project, whatever a node id claims.
  if (!absolute.startsWith(path.resolve(root))) return undefined;

  try {
    const lines = fs.readFileSync(absolute, 'utf8').split(/\r?\n/);
    const end = Math.min(node.endLine ?? node.startLine, node.startLine + MAX_SOURCE_LINES);
    const slice = lines.slice(node.startLine - 1, end).join('\n');
    return slice.length > MAX_SOURCE_CHARS ? `${slice.slice(0, MAX_SOURCE_CHARS)}\n…` : slice;
  } catch {
    return undefined;
  }
}

function openStore(dbPath: string): AtlasStore | null {
  try {
    return AtlasStore.open(dbPath);
  } catch {
    // A read-only or missing directory costs us the cache, not the feature.
    return null;
  }
}
