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

  // --- the desktop app's other half ---
  // `ipcMain.handle('renderer:open-preferences', …)` is the door between an Electron
  // renderer and the privileged process that can touch the filesystem and the shell.
  // The Rust tier reached this conclusion first, for `#[tauri::command]`, and the
  // argument transfers without a word changed: same architecture, and Electron is by
  // some distance the more common of the two. usebruno/bruno registers 255 of these and
  // was reported as having two ways in, both incidental (#149).
  if ((last === 'handle' || last === 'on' || last === 'handleOnce' || last === 'once') && root === 'ipcMain') {
    const channel = literalString(argAt(call, 0));
    if (channel) return emitIpc(ctx, call, channel, dotted);
    return;
  }

  // --- webhook signature verification ---
  // `constructEventAsync` is not a variant worth skipping: it is the *only* one that
  // works on an edge runtime, where there is no synchronous crypto to hash the body
  // with. Matching the sync spelling alone meant every Stripe webhook deployed to
  // Cloudflare or Vercel Edge — the exact repos most likely to have one — was reported
  // as a data-writing door that nothing checks (#122).
  if (/webhooks\.constructEvent(Async)?$/.test(dotted) || last === 'constructEvent' || last === 'constructEventAsync') {
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

/**
 * One Electron IPC channel, which is a door and is not a route.
 *
 * No auth verdict, deliberately, and the reason is quoted from the Rust tier that
 * settled it: the caller is the app's own interface, not a stranger on the internet, so
 * badging one "no auth check" would be the false alarm the C# desktop work exists to
 * avoid. Doing that 255 times on one repo would teach a reader to skip the auth line
 * entirely, which is #116 arriving from the other side.
 *
 * `handle` and `on` are kept apart in the snippet and nowhere else. Request/response
 * versus fire-and-forget matters to somebody tracing a call and does not change what
 * the boundary screen is for, so it is recorded as evidence rather than promoted to a
 * distinction the reader has to learn.
 */
function emitIpc(ctx: DetectorContext, at: Node, channel: string, dotted: string): void {
  ctx.emit({
    type: 'endpoint',
    endpointKind: 'ipc',
    key: `ipc ${channel}`,
    name: channel,
    method: 'IPC',
    route: channel,
    framework: 'Electron',
    // Not knowable from the registration, and the handler is a callback this detector
    // does not follow. Claiming a write would put an arrow on the screen somebody reads
    // to find out what writes.
    writes: false,
    guards: [],
    site: ctx.site(at, `${dotted}("${channel}")`),
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

