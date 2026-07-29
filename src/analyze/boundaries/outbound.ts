/**
 * @fileoverview Outbound calls — the companies your app sends data to.
 *
 * Two independent routes to the same answer, because real code uses both:
 *   - a literal URL in a `fetch`/`axios` call, resolved to a hostname
 *   - an official SDK, resolved through the package it was imported from
 *
 * SPEC.md 6.6 turns this into "your app sends data to these N companies", which for
 * the primary audience is often the single most surprising thing the tool says. That
 * makes precision matter: a hostname we cannot resolve is reported as a hostname, not
 * guessed into a brand.
 */
import { Node } from 'ts-morph';
import type { CallExpression, NewExpression } from 'ts-morph';
import type { ServiceCategory } from '../../model/types.js';
import { isInternalHost, serviceForHost, serviceForPackage } from './catalog.js';
import { dottedName, literalPrefix, literalString, objectProp } from './ast.js';
import type { BoundaryDetector, DetectorContext } from './types.js';

/** Clients whose calls are HTTP requests with a URL in the first argument. */
const HTTP_CLIENTS = new Set(['fetch', 'axios', 'got', 'ky', 'superagent', 'request', 'undici']);
const HTTP_VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'request']);
const WRITE_VERBS = new Set(['post', 'put', 'patch', 'delete']);

/**
 * Packages that data.ts already reports with more detail (tables, buckets, read and
 * write counts). Reporting them here too would put the same thing on the map twice.
 */
const HANDLED_AS_STORES = new Set([
  '@prisma/client',
  'drizzle-orm',
  'kysely',
  'knex',
  'pg',
  'postgres',
  'mysql2',
  'better-sqlite3',
  'mongoose',
  'mongodb',
  'sequelize',
  'typeorm',
  '@supabase/supabase-js',
  '@neondatabase/serverless',
  '@vercel/postgres',
  '@vercel/kv',
  '@vercel/blob',
  '@aws-sdk/client-s3',
  'cloudinary',
  '@google-cloud/storage',
  'ioredis',
  'redis',
  '@upstash/redis',
  'firebase-admin',
]);

export const outboundDetector: BoundaryDetector = {
  id: 'outbound',
  enabled: () => true,
  visit(node, ctx) {
    if (Node.isNewExpression(node)) return sdkConstruction(node, ctx);
    if (!Node.isCallExpression(node)) return;
    const dotted = dottedName(node.getExpression());
    if (!dotted) return;

    if (httpCall(node, dotted, ctx)) return;
    sdkCall(node, dotted, ctx);
  },
};

// ---------------------------------------------------------------------------
// Literal URLs
// ---------------------------------------------------------------------------

function httpCall(call: CallExpression, dotted: string, ctx: DetectorContext): boolean {
  const parts = dotted.split('.');
  const root = parts[0];
  const last = parts[parts.length - 1];

  const isClient =
    HTTP_CLIENTS.has(root) &&
    (parts.length === 1 || HTTP_VERBS.has(last) || last === 'create' || last === 'fetch');
  if (!isClient) return false;

  // `axios.create({ baseURL })` names the service for every call made through it.
  if (last === 'create') {
    const base = literalPrefix(objectProp(call.getArguments()[0], 'baseURL'));
    return base ? report(base, call, ctx, false) : false;
  }

  const url = literalPrefix(call.getArguments()[0]);
  if (!url) return false;

  const writes = WRITE_VERBS.has(last) || methodOfOptions(call) !== null;
  return report(url, call, ctx, writes || WRITE_VERBS.has(last));
}

/** `fetch(url, { method: 'POST' })` */
function methodOfOptions(call: CallExpression): string | null {
  const method = literalString(objectProp(call.getArguments()[1], 'method'));
  if (!method) return null;
  return WRITE_VERBS.has(method.toLowerCase()) ? method.toUpperCase() : null;
}

function report(url: string, call: CallExpression, ctx: DetectorContext, writes: boolean): boolean {
  const host = hostOf(url);
  // A relative URL is the app calling itself; that is an internal edge, not a company.
  if (!host || isInternalHost(host)) return false;

  const known = serviceForHost(host);
  ctx.emit({
    type: 'service',
    name: known?.name ?? host,
    category: known?.category ?? 'other',
    package: null,
    host,
    external: true,
    writes,
    site: ctx.site(call),
  });
  return true;
}

function hostOf(url: string): string | null {
  const match = /^https?:\/\/([^/?#]+)/i.exec(url.trim());
  if (!match) return null;
  const authority = match[1].split('@').pop() ?? '';
  const host = authority.split(':')[0].toLowerCase();
  return host.length > 0 ? host : null;
}

// ---------------------------------------------------------------------------
// Official SDKs
// ---------------------------------------------------------------------------

/**
 * `new Stripe(key)` — building a client, which sends nothing on its own.
 *
 * Worth reporting anyway, because it is the *only* thing a wrapper module like
 * `lib/stripe.ts` ever does. Without it an app whose six Stripe calls all go through
 * that wrapper reports no payments provider at all, while the frameworks list two
 * inches away names Stripe.
 */
function sdkConstruction(node: NewExpression, ctx: DetectorContext): void {
  const name = dottedName(node.getExpression());
  if (!name) return;
  const binding = ctx.imports.get(name.split('.')[0]);
  if (!binding?.external || HANDLED_AS_STORES.has(binding.module)) return;

  const service = serviceForPackage(binding.module);
  if (!service) return;

  ctx.emit({
    type: 'service',
    name: service.name,
    category: service.category,
    package: binding.module,
    host: null,
    external: true,
    writes: false,
    site: ctx.site(node),
  });

  const exported = exportedNameOf(node);
  if (exported) {
    ctx.emit({ type: 'client-export', exportName: exported, package: binding.module, site: ctx.site(node) });
  }
}

/** The name this expression is exported under, when it is exported at all. */
function exportedNameOf(node: Node): string | null {
  let current: Node | undefined = node.getParent();
  while (current) {
    if (Node.isVariableDeclaration(current)) {
      const name = current.getNameNode();
      if (!Node.isIdentifier(name)) return null;
      return current.getVariableStatement()?.isExported() ? name.getText() : null;
    }
    if (Node.isExportAssignment(current)) return 'default';
    // Anything else between the `new` and a declaration means it is not a plain
    // exported singleton, and guessing past that would invent a wrapper.
    if (Node.isFunctionDeclaration(current) || Node.isBlock(current)) return null;
    current = current.getParent();
  }
  return null;
}

/** `stripe.checkout.sessions.create(...)` — resolve `stripe` back to the package. */
function sdkCall(call: CallExpression, dotted: string, ctx: DetectorContext): void {
  const root = dotted.split('.')[0];
  const module = moduleFor(root, ctx);
  if (!module) {
    wrapperCall(call, dotted, root, ctx);
    return;
  }
  if (HANDLED_AS_STORES.has(module)) return;

  const service = serviceForPackage(module);
  if (!service) return;

  ctx.emit({
    type: 'service',
    name: service.name,
    category: service.category,
    package: module,
    host: null,
    external: true,
    writes: sendsData(dotted, service.category),
    site: ctx.site(call),
  });
}

/**
 * The receiver came from this repo's own code — `import { stripe } from "@/lib/stripe"`.
 *
 * Whether that name holds a Stripe client is not answerable from this file, and
 * guessing from the name would put companies on the map that the app has never heard
 * of. So the question gets written down, and `reach.ts` answers it against the
 * `client-export` findings once every file has been read.
 */
function wrapperCall(call: CallExpression, dotted: string, root: string, ctx: DetectorContext): void {
  const binding = ctx.imports.get(root);
  if (!binding || binding.external) return;
  // A bare `helper()` says nothing. It is `stripe.checkout.sessions.create` — a name
  // with an API surface hanging off it — that looks like a client.
  if (!dotted.includes('.')) return;

  ctx.emit({
    type: 'wrapper-call',
    exportName: binding.imported,
    module: binding.module,
    dotted,
    // Most of these turn out to be ordinary helpers and are dropped unread, so the
    // snippet is the call itself rather than however many lines its arguments run to.
    site: ctx.site(call, dotted),
  });
}

/** The package a local name ultimately came from, directly or via a constructor. */
function moduleFor(local: string, ctx: DetectorContext): string | null {
  const imported = ctx.imports.get(local);
  if (imported?.external) return imported.module;
  const built = ctx.locals.get(local);
  if (built?.module) return built.module;
  if (built) {
    const constructor = ctx.imports.get(built.callee.split('.')[0]);
    if (constructor?.external) return constructor.module;
  }
  return null;
}

/**
 * Sending an email or charging a card is data leaving; listing models is not. The
 * distinction is what makes the "where does my data go" answer worth reading.
 */
export function sendsData(dotted: string, category: ServiceCategory): boolean {
  const last = dotted.split('.').pop() ?? '';
  if (/^(send|create|post|upload|track|capture|identify|charge|publish|emit|log)/i.test(last)) return true;
  return category === 'email' || category === 'sms' || category === 'analytics' || category === 'payments';
}
