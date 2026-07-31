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
import { selectBackend } from '../enrich/backends/index.js';
import { symbolRequest } from '../enrich/prompts.js';
import type { SymbolFacts } from '../enrich/prompts.js';
import type { EnrichBackend } from '../enrich/types.js';
import { explanationKey } from '../enrich/types.js';
import { cleanParagraph, dropWrongMethods, methodsByRoute } from '../enrich/validate.js';
import { AtlasStore, atlasDbPath } from '../model/store.js';
import type { AtlasGraph } from '../model/graph.js';
import type { AtlasNode, EndpointMeta, FunctionMeta } from '../model/types.js';
import { hashParts } from '../util/hash.js';
import { readSource } from './source.js';

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

  constructor(private readonly options: AiServerOptions) {}

  /** What the UI needs to label the button honestly before anything has been run. */
  status(): { enabled: boolean } {
    return { enabled: this.options.enabled };
  }

  /**
   * The graph is passed in rather than held, because in a monorepo the answer depends
   * on which app the question came from.
   */
  async explain(nodeId: string, graph: AtlasGraph): Promise<ExplainResult | ExplainError> {
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

    // This tier is the one most likely to talk about a route — it is the only one that
    // reads real source, so a request handler's body is right there in the prompt — which
    // makes it the one place a wrong verb would look most authoritative.
    const routes = methodsByRoute(
      graph.nodesOfKind('endpoint').map((endpoint) => endpoint.meta as unknown as EndpointMeta),
    );

    const store = openStore(dbPath);
    try {
      const hit = store?.readExplanations().get(key);
      if (hit) {
        // Checked on the way out as well as on the way in, so an explanation cached
        // before this check existed is fixed by the upgrade rather than kept forever.
        const grounded = dropWrongMethods(hit.text, routes).text;
        if (!grounded) return { error: 'The cached description said something your routes disagree with, so it was dropped.' };
        apply(node, grounded);
        return { text: grounded, cached: true };
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

      // Cached as written, then checked. The answer was paid for either way, and the
      // check runs again on every read, so a table that grows a route later can still
      // let a sentence through that it stops today.
      store?.writeExplanations(
        new Map([
          [key, { nodeId, tier: 'symbol' as const, hash, text, backend: backend.id, createdAt: new Date().toISOString() }],
        ]),
      );

      const grounded = dropWrongMethods(text, routes).text;
      if (!grounded) {
        return { error: `${backend.label} paired one of your routes with a verb it does not answer to, so its answer was dropped.` };
      }

      apply(node, grounded);
      return { text: grounded, backend: backend.label, cached: false };
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
      source: readSource(graph.meta.root, node)?.code,
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

function openStore(dbPath: string): AtlasStore | null {
  try {
    return AtlasStore.open(dbPath);
  } catch {
    // A read-only or missing directory costs us the cache, not the feature.
    return null;
  }
}
