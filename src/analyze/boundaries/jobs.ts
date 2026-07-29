/**
 * @fileoverview The doors that are not URLs: schedules, queues, webhooks, the command
 * line, realtime subscriptions and files read off disk.
 *
 * These are the entry points people forget they have. A cron job that runs at 3am is
 * every bit as much a way into the app as a login form, and it is far less likely to
 * be on anyone's mental map.
 */
import { Node } from 'ts-morph';
import type { CallExpression, NewExpression } from 'ts-morph';
import { argAt, dottedName, literalString, objectProp } from './ast.js';
import type { BoundaryDetector, DetectorContext } from './types.js';

export const jobsDetector: BoundaryDetector = {
  id: 'jobs',
  enabled: () => true,
  visit(node, ctx) {
    if (Node.isNewExpression(node)) return newExpression(node, ctx);
    if (!Node.isCallExpression(node)) {
      // `process.argv` is how a script takes its input.
      if (Node.isPropertyAccessExpression(node) && node.getExpression().getText() === 'process') {
        if (node.getName() === 'argv') emitCli(node, ctx, 'process.argv');
      }
      return;
    }
    callExpression(node, ctx);
  },
};

function callExpression(call: CallExpression, ctx: DetectorContext): void {
  const dotted = dottedName(call.getExpression());
  if (!dotted) return;
  const last = dotted.split('.').pop() ?? '';
  const root = dotted.split('.')[0];

  // --- scheduled work ---
  if (last === 'schedule' && isFrom(root, ctx, 'node-cron')) {
    const expression = literalString(argAt(call, 0));
    return emitCron(ctx, call, expression, 'node-cron');
  }
  if (dotted === 'createFunction' || dotted.endsWith('.createFunction')) {
    if (!ctx.signals.packages.has('inngest')) return;
    const id = literalString(objectProp(argAt(call, 0), 'id')) ?? 'function';
    const trigger =
      literalString(objectProp(argAt(call, 1), 'event')) ?? literalString(objectProp(argAt(call, 1), 'cron'));
    return emitQueue(ctx, call, trigger ?? id, 'Inngest');
  }
  if (dotted === 'task' && ctx.signals.packages.has('@trigger.dev/sdk')) {
    const id = literalString(objectProp(argAt(call, 0), 'id'));
    if (id) return emitQueue(ctx, call, id, 'Trigger.dev');
  }

  // --- webhook signature verification ---
  if (/webhooks\.constructEvent$/.test(dotted) || last === 'constructEvent') {
    return ctx.emit({ type: 'webhook', provider: 'Stripe', site: ctx.site(call) });
  }
  if (last === 'verify' && isFrom(root, ctx, 'svix')) {
    return ctx.emit({ type: 'webhook', provider: 'Svix', site: ctx.site(call) });
  }
  if (/^verify(Webhook|Signature)/i.test(last) || last === 'verifyWebhookSignature') {
    return ctx.emit({ type: 'webhook', provider: 'custom', site: ctx.site(call) });
  }

  // --- realtime ---
  if (last === 'channel' && isFrom(root, ctx, '@supabase/supabase-js')) {
    const name = literalString(argAt(call, 0)) ?? 'realtime';
    return emitRealtime(ctx, call, name, 'Supabase');
  }
  if (last === 'on' && (root === 'io' || root === 'wss' || root === 'socket')) {
    const event = literalString(argAt(call, 0));
    if (event === 'connection' || event === 'connect') return emitRealtime(ctx, call, event, 'WebSocket');
  }
  if (last === 'subscribe' && isFrom(root, ctx, 'pusher')) {
    return emitRealtime(ctx, call, literalString(argAt(call, 0)) ?? 'channel', 'Pusher');
  }

  // --- command line ---
  if (dotted === 'yargs' || (last === 'command' && isFrom(root, ctx, 'commander'))) {
    return emitCli(call, ctx, dotted);
  }

}

function newExpression(node: NewExpression, ctx: DetectorContext): void {
  const name = dottedName(node.getExpression());
  if (!name) return;
  const last = name.split('.').pop() ?? '';

  const firstArg = node.getArguments()[0];
  if (last === 'CronJob') {
    return emitCron(ctx, node, literalString(firstArg), 'cron');
  }
  if (last === 'Worker' && ctx.signals.packages.has('bullmq')) {
    return emitQueue(ctx, node, literalString(firstArg) ?? 'queue', 'BullMQ');
  }
  if (last === 'WebSocketServer' || (last === 'Server' && isFrom(name.split('.')[0], ctx, 'socket.io'))) {
    return emitRealtime(ctx, node, 'connection', 'WebSocket');
  }
  if (last === 'Command' && ctx.signals.packages.has('commander')) {
    return emitCli(node, ctx, 'new Command()');
  }
}

// ---------------------------------------------------------------------------
// Emitters — every one of these merges by `key` in build.ts
// ---------------------------------------------------------------------------

function emitCron(ctx: DetectorContext, at: Node, expression: string | null, framework: string): void {
  const schedule = expression ?? 'schedule';
  ctx.emit({
    type: 'endpoint',
    endpointKind: 'cron',
    key: `cron ${schedule}`,
    name: schedule,
    method: 'CRON',
    route: schedule,
    framework,
    writes: true,
    guards: [],
    site: ctx.site(at),
    handlerId: ctx.enclosing(at),
  });
}

function emitQueue(ctx: DetectorContext, at: Node, name: string, framework: string): void {
  ctx.emit({
    type: 'endpoint',
    endpointKind: 'queue',
    key: `queue ${name}`,
    name,
    method: 'JOB',
    route: name,
    framework,
    writes: true,
    guards: [],
    site: ctx.site(at),
    handlerId: ctx.enclosing(at),
  });
}

function emitRealtime(ctx: DetectorContext, at: Node, name: string, framework: string): void {
  ctx.emit({
    type: 'endpoint',
    endpointKind: 'realtime',
    key: `realtime ${name}`,
    name,
    method: 'LIVE',
    route: name,
    framework,
    writes: false,
    guards: [],
    site: ctx.site(at),
    handlerId: ctx.enclosing(at),
  });
}

/** Every command-line entry point collapses into one door — there is only one shell. */
function emitCli(at: Node, ctx: DetectorContext, snippet: string): void {
  ctx.emit({
    type: 'endpoint',
    endpointKind: 'cli',
    key: 'cli',
    name: 'Command line',
    method: 'CLI',
    route: null,
    framework: 'Node',
    writes: false,
    guards: [],
    site: ctx.site(at, snippet),
    handlerId: ctx.enclosing(at),
  });
}

// ---------------------------------------------------------------------------

/** Was this local name imported from that package? */
function isFrom(local: string, ctx: DetectorContext, pkg: string): boolean {
  const binding = ctx.imports.get(local);
  if (binding?.external && binding.module === pkg) return true;
  const built = ctx.locals.get(local);
  return built?.module === pkg;
}

