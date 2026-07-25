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
import { buildBoundaryView } from '../model/boundary.js';
import { AtlasGraph } from '../model/graph.js';
import { buildInsights } from '../model/insights.js';
import { buildTypeView } from '../model/typeview.js';
import { Explainer } from './explain.js';
import type { AiServerOptions } from './explain.js';

export interface ServerHandle {
  url: string;
  port: number;
  close(): Promise<void>;
  /** Swap in a freshly analyzed atlas (used by --watch in M5). */
  update(atlas: Atlas): void;
}

export interface ServeOptions {
  atlas: Atlas;
  port?: number;
  host?: string;
  /** Settings for explain-on-click. Defaults to on, using whatever backend is found. */
  ai?: AiServerOptions;
}

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
  let graph = new AtlasGraph(options.atlas);

  const explainer = new Explainer(options.ai ?? { enabled: true }, () => graph);

  const server = http.createServer((req, res) => {
    try {
      handleRequest(req, res, () => graph, webRoot, explainer);
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
        server.close((err) => (err ? reject(err) : resolve()));
      }),
    update: (atlas: Atlas) => {
      graph = new AtlasGraph(atlas);
    },
  };
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
  getGraph: () => AtlasGraph,
  webRoot: string,
  explainer: Explainer,
): void {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);

  if (pathname.startsWith('/api/')) {
    const graph = getGraph();
    switch (pathname) {
      case '/api/health':
        return sendJson(res, 200, { ok: true, name: graph.meta.name });

      case '/api/ai':
        return sendJson(res, 200, explainer.status());

      /**
       * The one endpoint that does work rather than answering from memory: it may
       * start an agent CLI and will take a few seconds. Kept a GET because it is
       * idempotent — the second click on the same unchanged code is a cache hit.
       */
      case '/api/explain': {
        const id = url.searchParams.get('id') ?? '';
        void explainer.explain(id).then(
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

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}
