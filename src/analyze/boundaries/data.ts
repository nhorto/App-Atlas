/**
 * @fileoverview Where the data actually lives: databases, buckets and the disk.
 *
 * Each ORM has its own dialect for the same four ideas, so this is a set of small
 * per-client readers rather than one clever generic rule. Every one of them is gated
 * on the project actually depending on that client — otherwise `db.select(...)` in an
 * app with no database would produce a table that does not exist, and a made-up box
 * on the map is worse than a missing one.
 */
import { Node } from 'ts-morph';
import type { CallExpression, NewExpression } from 'ts-morph';
import type { StoreKind } from '../../model/types.js';
import { readSqlStatement } from '../sql.js';
import { prismaProviderName, storeForPackage } from './catalog.js';
import { dottedName, literalString } from './ast.js';
import type { BoundaryDetector, DetectorContext, StoreFinding } from './types.js';

const PRISMA_READS = new Set(['findMany', 'findUnique', 'findFirst', 'findUniqueOrThrow', 'findFirstOrThrow', 'count', 'aggregate', 'groupBy']);
const PRISMA_WRITES = new Set(['create', 'createMany', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany', 'createManyAndReturn']);

const SUPABASE_WRITES = new Set(['insert', 'update', 'upsert', 'delete']);

const FS_WRITES = new Set([
  'writeFile',
  'writeFileSync',
  'appendFile',
  'appendFileSync',
  'createWriteStream',
  'mkdir',
  'mkdirSync',
  'rm',
  'rmSync',
  'unlink',
  'unlinkSync',
  'copyFile',
  'rename',
]);

export const storeDetector: BoundaryDetector = {
  id: 'stores',
  // Browser storage needs no dependency at all, so this one always runs; every
  // individual reader below is gated on its own package.
  enabled: () => true,
  visit(node, ctx) {
    if (Node.isNewExpression(node)) return s3Client(node, ctx);
    if (!Node.isCallExpression(node)) return;

    const dotted = dottedName(node.getExpression());
    if (!dotted) return;

    prisma(node, dotted, ctx) ||
      drizzle(node, dotted, ctx) ||
      kysely(node, dotted, ctx) ||
      supabase(node, dotted, ctx) ||
      mongoose(node, dotted, ctx) ||
      rawSql(node, dotted, ctx) ||
      keyValue(node, dotted, ctx) ||
      blobWrite(node, dotted, ctx) ||
      browserStorage(node, dotted, ctx) ||
      fileWrite(node, dotted, ctx);
  },
};

// ---------------------------------------------------------------------------
// Prisma
// ---------------------------------------------------------------------------

/** `prisma.user.findMany()` — the model sits between the client and the operation. */
function prisma(call: CallExpression, dotted: string, ctx: DetectorContext): boolean {
  if (!ctx.signals.packages.has('@prisma/client')) return false;
  const parts = dotted.split('.');
  if (parts.length < 3) return false;

  const operation = parts[parts.length - 1];
  const model = parts[parts.length - 2];
  const root = parts[0];
  if (!PRISMA_READS.has(operation) && !PRISMA_WRITES.has(operation)) return false;
  if (!isPrismaClient(root, ctx)) return false;

  // The schema, when we have it, turns a guess into a fact.
  const known = ctx.signals.prisma?.models ?? [];
  const table = known.find((name) => name.toLowerCase() === model.toLowerCase()) ?? model;

  emit(ctx, call, {
    key: 'prisma',
    name: ctx.signals.prisma ? prismaProviderName(ctx.signals.prisma.provider) : 'Database',
    client: 'Prisma',
    storeKind: ctx.signals.prisma?.provider === 'mongodb' ? 'nosql' : 'sql',
    table,
    operation: PRISMA_WRITES.has(operation) ? 'write' : 'read',
  });
  return true;
}

function isPrismaClient(root: string, ctx: DetectorContext): boolean {
  const local = ctx.locals.get(root);
  if (local && /PrismaClient/.test(local.callee)) return true;
  // The near-universal convention is a shared `prisma` or `db` singleton imported
  // from the app's own code, which no import alone would identify.
  return /^(prisma|db|database|prismaClient)$/i.test(root);
}

// ---------------------------------------------------------------------------
// Drizzle / Kysely / knex
// ---------------------------------------------------------------------------

/** `db.select().from(users)`, `db.insert(users).values(...)` */
function drizzle(call: CallExpression, dotted: string, ctx: DetectorContext): boolean {
  if (!ctx.signals.packages.has('drizzle-orm')) return false;
  const parts = dotted.split('.');
  const operation = parts[parts.length - 1];
  const root = parts[0];
  if (!/^(db|database|drizzle|conn)$/i.test(root) && !isBuiltBy(root, ctx, 'drizzle')) return false;

  const reads = operation === 'select' || operation === 'query';
  const writes = operation === 'insert' || operation === 'update' || operation === 'delete';
  if (!reads && !writes) return false;

  emit(ctx, call, {
    key: 'drizzle',
    name: 'Database',
    client: 'Drizzle',
    storeKind: 'sql',
    table: tableFromArgOrChain(call, operation),
    operation: writes ? 'write' : 'read',
  });
  return true;
}

/** `db.selectFrom('users')`, `db.insertInto('users')`, and knex's `knex('users')`. */
function kysely(call: CallExpression, dotted: string, ctx: DetectorContext): boolean {
  const parts = dotted.split('.');
  const operation = parts[parts.length - 1];
  const root = parts[0];

  if (ctx.signals.packages.has('kysely')) {
    const map: Record<string, 'read' | 'write'> = {
      selectFrom: 'read',
      insertInto: 'write',
      updateTable: 'write',
      deleteFrom: 'write',
    };
    const kind = map[operation];
    if (kind && /^(db|database|kysely|conn)$/i.test(root)) {
      emit(ctx, call, {
        key: 'kysely',
        name: 'Database',
        client: 'Kysely',
        storeKind: 'sql',
        table: literalString(call.getArguments()[0]),
        operation: kind,
      });
      return true;
    }
  }

  if (ctx.signals.packages.has('knex') && /^knex$/i.test(dotted)) {
    emit(ctx, call, {
      key: 'knex',
      name: 'Database',
      client: 'Knex',
      storeKind: 'sql',
      table: literalString(call.getArguments()[0]),
      operation: 'read',
    });
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Supabase
// ---------------------------------------------------------------------------

/** `supabase.from('orders').insert(...)` and `supabase.storage.from('avatars')`. */
function supabase(call: CallExpression, dotted: string, ctx: DetectorContext): boolean {
  if (!ctx.signals.packages.has('@supabase/supabase-js')) return false;
  const parts = dotted.split('.');
  const last = parts[parts.length - 1];
  const root = parts[0];
  if (!/^(supabase|sb|client|supabaseAdmin)$/i.test(root) && !isBuiltBy(root, ctx, 'createClient')) return false;

  if (last === 'from' && parts.includes('storage')) {
    emit(ctx, call, {
      key: 'supabase-storage',
      name: 'Supabase Storage',
      client: 'Supabase',
      storeKind: 'blob',
      table: literalString(call.getArguments()[0]),
      operation: 'write',
    });
    return true;
  }

  if (last === 'from') {
    // `.from('x')` alone is a read; a write shows up as `.insert(...)` further along
    // the chain, so look at what is done with the result.
    const chained = chainedCallNames(call);
    const writes = chained.some((name) => SUPABASE_WRITES.has(name));
    emit(ctx, call, {
      key: 'supabase',
      name: 'Supabase Postgres',
      client: 'Supabase',
      storeKind: 'sql',
      table: literalString(call.getArguments()[0]),
      operation: writes ? 'write' : 'read',
    });
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Mongoose / raw SQL
// ---------------------------------------------------------------------------

function mongoose(call: CallExpression, dotted: string, ctx: DetectorContext): boolean {
  if (!ctx.signals.packages.has('mongoose') && !ctx.signals.packages.has('mongodb')) return false;
  const parts = dotted.split('.');
  const last = parts[parts.length - 1];

  if (parts.length === 2 && /^model$/.test(last)) {
    const name = literalString(call.getArguments()[0]);
    emit(ctx, call, {
      key: 'mongo',
      name: 'MongoDB',
      client: 'Mongoose',
      storeKind: 'nosql',
      table: name,
      operation: 'read',
    });
    return true;
  }

  const reads = new Set(['find', 'findOne', 'findById', 'countDocuments', 'aggregate']);
  const writes = new Set(['create', 'insertMany', 'updateOne', 'updateMany', 'deleteOne', 'deleteMany', 'findByIdAndUpdate', 'save']);
  if (!reads.has(last) && !writes.has(last)) return false;
  // Mongoose models are capitalised by convention; without that we would claim every
  // `.find()` in the codebase is a database call.
  const model = parts[parts.length - 2];
  if (!model || !/^[A-Z]/.test(model)) return false;

  emit(ctx, call, {
    key: 'mongo',
    name: 'MongoDB',
    client: 'Mongoose',
    storeKind: 'nosql',
    table: model,
    operation: writes.has(last) ? 'write' : 'read',
  });
  return true;
}

/** `pool.query('SELECT … FROM orders')` — the table is in the SQL, so read the SQL. */
function rawSql(call: CallExpression, dotted: string, ctx: DetectorContext): boolean {
  const parts = dotted.split('.');
  const last = parts[parts.length - 1];
  if (last !== 'query' && last !== 'execute' && last !== 'unsafe') return false;

  const sqlPackage = ['pg', 'postgres', 'mysql2', '@neondatabase/serverless', '@vercel/postgres', 'better-sqlite3'].find(
    (pkg) => ctx.signals.packages.has(pkg),
  );
  if (!sqlPackage) return false;

  const sql = literalString(call.getArguments()[0]) ?? templateSql(call);
  const statement = sql ? readSqlStatement(sql) : null;
  if (!statement) return false;

  const def = storeForPackage(sqlPackage);
  emit(ctx, call, {
    key: 'sql',
    name: def?.fallbackName ?? 'Database',
    client: def?.client ?? sqlPackage,
    storeKind: 'sql',
    table: statement.table,
    operation: statement.operation,
  });
  return true;
}

function templateSql(call: CallExpression): string | null {
  const arg = call.getArguments()[0];
  if (arg && Node.isTemplateExpression(arg)) return arg.getText();
  return null;
}

// ---------------------------------------------------------------------------
// Redis and key–value stores
// ---------------------------------------------------------------------------

/** Redis commands, split by whether they change anything. */
const KV_READS = new Set([
  'get', 'mget', 'hget', 'hgetall', 'hmget', 'exists', 'ttl', 'keys', 'scan', 'smembers',
  'sismember', 'lrange', 'llen', 'zrange', 'zscore', 'zcard', 'getdel', 'hkeys', 'hvals',
]);
const KV_WRITES = new Set([
  'set', 'mset', 'setex', 'setnx', 'hset', 'hmset', 'del', 'unlink', 'expire', 'incr',
  'incrby', 'decr', 'decrby', 'sadd', 'srem', 'lpush', 'rpush', 'lpop', 'rpop', 'zadd',
  'zrem', 'flushall', 'flushdb', 'hincrby', 'hdel', 'persist', 'rename',
]);

/** Client names that are conventionally the Redis handle, so `redis.get` reads as one. */
const KV_RECEIVERS = /^(kv|redis|redisClient|cache|cacheClient|client|store)$/i;

/**
 * `kv.get(key)`, `redis.set(key, value)`.
 *
 * A cache is where a surprising amount of an app's real state ends up living —
 * sessions, rate limits, whole storage layers behind a "just a cache" name — so an app
 * whose only persistence is Redis should not read as an app with no database.
 */
function keyValue(call: CallExpression, dotted: string, ctx: DetectorContext): boolean {
  const parts = dotted.split('.');
  const operation = (parts[parts.length - 1] ?? '').toLowerCase();
  const reads = KV_READS.has(operation);
  const writes = KV_WRITES.has(operation);
  if (!reads && !writes) return false;

  const root = parts[0];
  const pkg = ['@vercel/kv', '@upstash/redis', 'ioredis', 'redis'].find((name) =>
    ctx.signals.packages.has(name),
  );
  if (!pkg) return false;

  // Either the name was imported from the client itself (`import { kv } from
  // "@vercel/kv"`), built by it, or is one of the handful of names everybody uses.
  const imported = ctx.imports.get(root);
  const known =
    imported?.module === pkg ||
    ctx.locals.get(root)?.module === pkg ||
    (KV_RECEIVERS.test(root) && parts.length === 2);
  if (!known) return false;

  const def = storeForPackage(pkg);
  emit(ctx, call, {
    key: 'kv',
    name: def?.fallbackName ?? 'Redis',
    client: def?.client ?? pkg,
    storeKind: 'kv',
    table: null,
    operation: writes ? 'write' : 'read',
  });
  return true;
}

// ---------------------------------------------------------------------------
// Blobs and the filesystem
// ---------------------------------------------------------------------------

function s3Client(node: NewExpression, ctx: DetectorContext): void {
  const name = dottedName(node.getExpression());
  if (name !== 'S3Client' && name !== 'S3') return;
  if (!ctx.signals.packages.has('@aws-sdk/client-s3') && !ctx.signals.packages.has('aws-sdk')) return;
  emit(ctx, node, {
    key: 's3',
    name: 'Amazon S3',
    client: 'AWS SDK',
    storeKind: 'blob',
    table: null,
    operation: 'write',
  });
}

function blobWrite(call: CallExpression, dotted: string, ctx: DetectorContext): boolean {
  const last = dotted.split('.').pop() ?? '';

  if (last === 'put' && ctx.packages.has('@vercel/blob')) {
    emit(ctx, call, { key: 'vercel-blob', name: 'Vercel Blob', client: 'Vercel Blob', storeKind: 'blob', table: null, operation: 'write' });
    return true;
  }
  if (last === 'send' && /^(s3|s3Client)$/i.test(dotted.split('.')[0])) {
    emit(ctx, call, { key: 's3', name: 'Amazon S3', client: 'AWS SDK', storeKind: 'blob', table: null, operation: 'write' });
    return true;
  }
  if (last === 'upload' && ctx.packages.has('cloudinary')) {
    emit(ctx, call, { key: 'cloudinary', name: 'Cloudinary', client: 'Cloudinary', storeKind: 'blob', table: null, operation: 'write' });
    return true;
  }
  return false;
}

/**
 * `localStorage`, IndexedDB and AsyncStorage.
 *
 * Easy to overlook because they need no dependency and no server — and important for
 * exactly that reason: an app whose only store is the browser is an app whose data
 * lives on one device and disappears when the cache is cleared. That is a thing its
 * owner should be told, not left to discover.
 */
function browserStorage(call: CallExpression, dotted: string, ctx: DetectorContext): boolean {
  const parts = dotted.split('.');
  const operation = parts[parts.length - 1];
  const holder = parts[parts.length - 2] ?? '';

  const reads = new Set(['getItem', 'key', 'getAll', 'getAllKeys', 'multiGet']);
  const writes = new Set(['setItem', 'removeItem', 'clear', 'multiSet', 'mergeItem', 'put', 'add', 'delete']);

  const web = holder === 'localStorage' || holder === 'sessionStorage';
  if (web && (reads.has(operation) || writes.has(operation))) {
    emit(ctx, call, {
      key: holder === 'sessionStorage' ? 'sessionstorage' : 'localstorage',
      name: holder === 'sessionStorage' ? 'Browser session storage' : 'Browser storage',
      client: holder,
      storeKind: 'kv',
      table: null,
      operation: writes.has(operation) ? 'write' : 'read',
    });
    return true;
  }

  if (dotted === 'indexedDB.open' || (operation === 'openDB' && ctx.packages.has('idb'))) {
    emit(ctx, call, {
      key: 'indexeddb',
      name: 'Browser database',
      client: 'IndexedDB',
      storeKind: 'kv',
      table: literalString(call.getArguments()[0]),
      operation: 'write',
    });
    return true;
  }

  if (/^AsyncStorage$/.test(holder) && (reads.has(operation) || writes.has(operation))) {
    emit(ctx, call, {
      key: 'asyncstorage',
      name: 'Device storage',
      client: 'AsyncStorage',
      storeKind: 'kv',
      table: null,
      operation: writes.has(operation) ? 'write' : 'read',
    });
    return true;
  }

  return false;
}

function fileWrite(call: CallExpression, dotted: string, ctx: DetectorContext): boolean {
  const parts = dotted.split('.');
  const last = parts[parts.length - 1];
  if (!FS_WRITES.has(last)) return false;

  const root = parts[0];
  const viaNamespace = ctx.imports.get(root)?.module === 'fs' || /^(fs|fsp|fsPromises)$/.test(root);
  const viaNamed = ctx.imports.get(last)?.module === 'fs';
  if (!viaNamespace && !viaNamed) return false;

  emit(ctx, call, {
    key: 'filesystem',
    name: 'Files on disk',
    client: 'Node fs',
    storeKind: 'filesystem',
    table: null,
    operation: 'write',
  });
  return true;
}

// ---------------------------------------------------------------------------

interface StoreInput {
  key: string;
  name: string;
  client: string;
  storeKind: StoreKind;
  table: string | null;
  operation: 'read' | 'write';
}

function emit(ctx: DetectorContext, at: Node, input: StoreInput): void {
  const finding: StoreFinding = {
    type: 'store',
    key: input.key,
    name: input.name,
    client: input.client,
    storeKind: input.storeKind,
    table: input.table,
    operation: input.operation,
    site: ctx.site(at),
  };
  ctx.emit(finding);
}

function isBuiltBy(local: string, ctx: DetectorContext, callee: string): boolean {
  return ctx.locals.get(local)?.callee.endsWith(callee) ?? false;
}

/** `db.insert(users)` — the table is the argument; `select().from(users)` — it is downstream. */
function tableFromArgOrChain(call: CallExpression, operation: string): string | null {
  if (operation !== 'select' && operation !== 'query') {
    const arg = call.getArguments()[0];
    if (arg && Node.isIdentifier(arg)) return arg.getText();
    return literalString(arg);
  }
  const parent = call.getParent();
  if (parent && Node.isPropertyAccessExpression(parent) && parent.getName() === 'from') {
    const grandparent = parent.getParent();
    if (grandparent && Node.isCallExpression(grandparent)) {
      const arg = grandparent.getArguments()[0];
      if (arg && Node.isIdentifier(arg)) return arg.getText();
      return literalString(arg);
    }
  }
  return null;
}

/** The method names applied to the result of a call, walking up the chain. */
function chainedCallNames(call: CallExpression): string[] {
  const names: string[] = [];
  let current: Node | undefined = call.getParent();
  let depth = 0;
  while (current && depth < 8) {
    if (Node.isPropertyAccessExpression(current)) {
      names.push(current.getName());
      current = current.getParent();
    } else if (Node.isCallExpression(current) || Node.isAwaitExpression(current)) {
      current = current.getParent();
    } else {
      break;
    }
    depth++;
  }
  return names;
}
