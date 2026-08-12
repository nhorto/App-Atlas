/**
 * @fileoverview The local server.
 *
 * Serves the built web app plus a small read-only API over the atlas. Everything
 * stays on the machine — the server binds to loopback and never phones home.
 *
 * Each endpoint returns one *slice* of the graph rather than the whole thing, which
 * is what keeps the canvas honest on large repos.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Atlas } from '../model/types.js';
import type { ScopeRecord } from '../model/store.js';
import { buildBoundaryView } from '../model/boundary.js';
import { traceError } from '../model/errortrace.js';
import { buildFlow, listDoors } from '../model/flow.js';
import { AtlasGraph } from '../model/graph.js';
import { buildInsights } from '../model/insights.js';
import { installedPackages } from '../model/packages.js';
import { bundleMaps } from '../model/sourcemap.js';
import { buildTours, tourFor } from '../model/tours.js';
import { buildTypeView } from '../model/typeview.js';
import { readSource } from './source.js';
import { ErrorHelper } from './errorhelp.js';
import { Explainer } from './explain.js';
import type { AiServerOptions } from './explain.js';

export interface ServerHandle {
  url: string;
  port: number;
  close(): Promise<void>;
  /**
   * Swap in a freshly analyzed atlas and tell every open page about it (`--watch`).
   * `scopeId` names which app changed in a monorepo; omit it when there is only one.
   */
  update(atlas: Atlas, scopeId?: string): void;
}

/** One app inside a workspace, and the atlas of it. */
export interface ScopeAtlas {
  scope: ScopeRecord;
  atlas: Atlas;
}

export interface ServeOptions {
  /** The atlas shown when nobody has picked a scope. */
  atlas: Atlas;
  /**
   * Every app in the workspace, when this is a monorepo. Empty for an ordinary repo,
   * which is also what makes the switcher disappear rather than showing one option.
   */
  scopes?: ScopeAtlas[];
  port?: number;
  host?: string;
  /** Settings for explain-on-click. Defaults to on, using whatever backend is found. */
  ai?: AiServerOptions;
}

/** The id the default scope answers to. Empty because a single-app repo has no name for it. */
const DEFAULT_SCOPE = '';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
};

/** Location of the built web app (dist/web), relative to this compiled module. */
export function webRootPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '../../web');
}

export async function startServer(options: ServeOptions): Promise<ServerHandle> {
  const host = options.host ?? '127.0.0.1';
  const webRoot = webRootPath();
  const listeners = new Listeners();

  const graphs = new Map<string, AtlasGraph>();
  graphs.set(DEFAULT_SCOPE, new AtlasGraph(options.atlas));
  for (const entry of options.scopes ?? []) graphs.set(entry.scope.id, new AtlasGraph(entry.atlas));
  const scopeList = (options.scopes ?? []).map((entry) => entry.scope);

  // An unknown scope falls back to the default rather than erroring: a bookmarked URL
  // for an app that has since been deleted should still show something.
  const graphFor = (id: string | null) => graphs.get(id ?? DEFAULT_SCOPE) ?? graphs.get(DEFAULT_SCOPE)!;
  const explainer = new Explainer(options.ai ?? { enabled: true });
  const errorHelper = new ErrorHelper(options.ai ?? { enabled: true });

  const server = http.createServer((req, res) => {
    try {
      handleRequest(req, res, graphFor, scopeList, webRoot, explainer, errorHelper, listeners);
    } catch (err) {
      sendJson(res, 500, { error: (err as Error).message });
    }
  });

  const port = await listen(server, host, options.port ?? 4477);

  return {
    url: `http://${host}:${port}`,
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        // An open event stream never ends on its own, so the server would wait forever
        // for it. Hang them up first, then close.
        listeners.closeAll();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
    update: (atlas: Atlas, scopeId = DEFAULT_SCOPE) => {
      const graph = new AtlasGraph(atlas);
      graphs.set(scopeId, graph);
      listeners.broadcast({
        scope: scopeId,
        name: graph.meta.name,
        generatedAt: graph.meta.generatedAt,
        stats: graph.meta.stats,
      });
    },
  };
}

/**
 * The open pages, waiting to be told the code changed.
 *
 * Server-sent events rather than a websocket: the traffic only goes one way, it is a
 * dozen lines over the http server we already have, and the browser reconnects by
 * itself when the CLI is restarted.
 */
class Listeners {
  private readonly open = new Set<http.ServerResponse>();
  private heartbeat: NodeJS.Timeout | null = null;

  add(res: http.ServerResponse): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    });
    res.write('retry: 2000\n\n');
    this.open.add(res);
    res.on('close', () => {
      this.open.delete(res);
      if (this.open.size === 0 && this.heartbeat) {
        clearInterval(this.heartbeat);
        this.heartbeat = null;
      }
    });
    // A silent connection gets closed by whatever sits in the middle; a comment every
    // twenty seconds costs nothing and keeps it up. `unref` so it never holds the CLI open.
    if (!this.heartbeat) {
      this.heartbeat = setInterval(() => {
        for (const client of this.open) client.write(': ping\n\n');
      }, 20_000);
      this.heartbeat.unref();
    }
  }

  broadcast(payload: unknown): void {
    const data = JSON.stringify(payload);
    for (const client of this.open) client.write(`event: atlas\ndata: ${data}\n\n`);
  }

  closeAll(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    for (const client of this.open) client.end();
    this.open.clear();
  }
}

/** Binds to the requested port, walking forward if it is taken. */
function listen(server: http.Server, host: string, preferred: number): Promise<number> {
  return new Promise((resolve, reject) => {
    let attempt = 0;
    const tryPort = (port: number) => {
      const onError = (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE' && attempt < 20) {
          attempt++;
          server.removeListener('error', onError);
          tryPort(port + 1);
        } else {
          reject(err);
        }
      };
      server.once('error', onError);
      server.listen(port, host, () => {
        server.removeListener('error', onError);
        resolve(port);
      });
    };
    tryPort(preferred);
  });
}

function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  graphFor: (id: string | null) => AtlasGraph,
  scopes: ScopeRecord[],
  webRoot: string,
  explainer: Explainer,
  errorHelper: ErrorHelper,
  listeners: Listeners,
): void {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);

  if (pathname.startsWith('/api/')) {
    // Every view answers for one app. In an ordinary repo there is only one, and the
    // parameter is never sent.
    const graph = graphFor(url.searchParams.get('scope'));
    switch (pathname) {
      case '/api/health':
        return sendJson(res, 200, { ok: true, name: graph.meta.name });

      /** The apps in a workspace. Empty for an ordinary repo, which hides the switcher. */
      case '/api/scopes':
        return sendJson(res, 200, { scopes });

      /** Stays open for as long as the page does; used by `--watch`. */
      case '/api/events':
        return listeners.add(res);

      case '/api/ai':
        return sendJson(res, 200, explainer.status());

      /**
       * The one endpoint that does work rather than answering from memory: it may
       * start an agent CLI and will take a few seconds. Kept a GET because it is
       * idempotent — the second click on the same unchanged code is a cache hit.
       */
      case '/api/explain': {
        const id = url.searchParams.get('id') ?? '';
        void explainer.explain(id, graph).then(
          (result) => sendJson(res, 'error' in result ? 400 : 200, result),
          (err: Error) => sendJson(res, 500, { error: err.message }),
        );
        return;
      }

      case '/api/overview':
        return sendJson(res, 200, graph.getOverview());

      case '/api/boundaries':
        return sendJson(res, 200, buildBoundaryView(graph));

      case '/api/insights':
        return sendJson(res, 200, buildInsights(graph));

      case '/api/types':
        return sendJson(res, 200, buildTypeView(graph));

      case '/api/tours':
        return sendJson(res, 200, { tours: buildTours(graph) });

      /**
       * The walkthrough for one thing, built when the reader opens it. Not part of
       * `/api/tours` because a repo with 760 doors would ship 760 walkthroughs to
       * answer a question about one of them.
       */
      case '/api/tour': {
        const id = url.searchParams.get('id') ?? '';
        const tour = tourFor(graph, id);
        if (!tour) return sendJson(res, 404, { error: 'No walkthrough for this one.' });
        return sendJson(res, 200, tour);
      }

      /** Every way in, for the list the trace view is chosen from. */
      case '/api/doors':
        return sendJson(res, 200, listDoors(graph));

      /**
       * Where one door leads. Separate from `/api/doors` for the reason `/api/tour` is
       * separate from `/api/tours`: following every door up front would walk the whole
       * reference graph once per way in to answer a question about one of them.
       */
      case '/api/flow': {
        const id = url.searchParams.get('id') ?? '';
        const flow = buildFlow(graph, id);
        if (!flow) return sendJson(res, 404, { error: `Not a way in: ${id}` });
        return sendJson(res, 200, flow);
      }

      /**
       * A pasted error, placed on the map. POST because a stack trace is far past what
       * belongs in a query string, and because it is the one request here carrying
       * something the reader typed rather than something the atlas already knows.
       */
      case '/api/trace': {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'Paste an error with POST.' });
        void readBody(req).then(
          (pasted) => {
            if (!pasted.trim()) return sendJson(res, 400, { error: 'Nothing was pasted.' });
            sendJson(res, 200, traceError(graph, pasted, bundleMaps(graph.meta.root), installedPackages(graph.meta.root)));
          },
          (err: Error) => sendJson(res, 500, { error: err.message }),
        );
        return;
      }

      /**
       * The closing paragraph for a traced error — the only generated thing in this
       * feature. The path is recomputed here rather than taken from the request, so
       * what the model is shown is what the compiler found and not what a browser
       * claimed it found.
       */
      case '/api/trace/explain': {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'Post the trace to explain.' });
        void readBody(req).then(
          (pasted) => {
            if (!pasted.trim()) return sendJson(res, 400, { error: 'Nothing was pasted.' });
            void errorHelper
              .explainTrace(graph, pasted)
              .then((result) => sendJson(res, 'error' in result ? 400 : 200, result));
          },
          (err: Error) => sendJson(res, 500, { error: err.message }),
        );
        return;
      }

      /**
       * Where to start when the paste has no frames in it. The candidates are searched
       * out of the atlas before the model sees them, so it chooses among real things
       * rather than producing a path.
       */
      case '/api/trace/start': {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'Post the description.' });
        void readBody(req).then(
          (described) => {
            if (!described.trim()) return sendJson(res, 400, { error: 'Nothing was pasted.' });
            void errorHelper
              .guessStart(graph, described)
              .then((result) => sendJson(res, 'error' in result ? 400 : 200, result));
          },
          (err: Error) => sendJson(res, 500, { error: err.message }),
        );
        return;
      }

      /** The code behind one step of a walkthrough, read from disk on demand. */
      case '/api/source': {
        const id = url.searchParams.get('id') ?? '';
        const node = graph.getNodeById(id);
        if (!node) return sendJson(res, 404, { error: `Unknown node: ${id}` });
        const slice = readSource(graph.meta.root, node, 60);
        if (!slice) return sendJson(res, 404, { error: 'No source for this one.' });
        return sendJson(res, 200, slice);
      }

      case '/api/level': {
        const id = url.searchParams.get('id') || graph.rootId;
        if (!graph.getNodeById(id)) return sendJson(res, 404, { error: `Unknown node: ${id}` });
        return sendJson(res, 200, graph.getLevel(id));
      }

      case '/api/node': {
        const id = url.searchParams.get('id') ?? '';
        const view = graph.getNode(id);
        if (!view) return sendJson(res, 404, { error: `Unknown node: ${id}` });
        return sendJson(res, 200, view);
      }

      case '/api/search': {
        const q = url.searchParams.get('q') ?? '';
        return sendJson(res, 200, { results: graph.search(q) });
      }

      default:
        return sendJson(res, 404, { error: 'Unknown endpoint' });
    }
  }

  serveStatic(pathname, res, webRoot);
}

function serveStatic(pathname: string, res: http.ServerResponse, webRoot: string): void {
  if (!fs.existsSync(webRoot)) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(
      `<!doctype html><meta charset="utf-8"><title>App Atlas</title>
       <body style="font-family:system-ui;padding:3rem;max-width:40rem;margin:auto">
       <h1>The web app isn't built yet</h1>
       <p>Run <code>npm run build:web</code> in the App Atlas repo, then reload.</p>
       <p>The API is live in the meantime — try <a href="/api/overview">/api/overview</a>.</p>`,
    );
    return;
  }

  const requested = pathname === '/' ? '/index.html' : pathname;
  const candidate = path.join(webRoot, requested);
  const resolved = path.resolve(candidate);

  // Never serve outside the web root, whatever the URL claims.
  if (!resolved.startsWith(path.resolve(webRoot))) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  const file = fs.existsSync(resolved) && fs.statSync(resolved).isFile() ? resolved : path.join(webRoot, 'index.html');
  if (!fs.existsSync(file)) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
  });
  fs.createReadStream(file).pipe(res);
}

/** How much pasted text to accept. A stack trace is kilobytes; anything past this is not one. */
const MAX_PASTE_BYTES = 512 * 1024;

/**
 * The `trace` field out of a posted body, as text.
 *
 * Capped and hung up on rather than buffered without limit: this is the only endpoint
 * that reads a request body at all, and a loopback server with no ceiling on one is a
 * way to run a machine out of memory by accident.
 */
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_PASTE_BYTES) {
        req.destroy();
        reject(new Error('That paste is too big to be a stack trace.'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { trace?: unknown };
        resolve(typeof parsed.trace === 'string' ? parsed.trace : '');
      } catch {
        reject(new Error('That request body was not JSON.'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}
