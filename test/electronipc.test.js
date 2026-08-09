/**
 * @fileoverview An Electron app's IPC channels are doors (#149).
 *
 * The Rust tier settled this first, for `#[tauri::command]`, and the argument transfers
 * without a word changed: the channel between a webview and the privileged process that
 * can touch the filesystem and the shell is a way in, and *"a map without them shows an
 * engine nothing can reach."* Electron is by some distance the more common of the two
 * and had no detector at all — usebruno/bruno registers 255 channels and was reported
 * as having two ways in, both incidental.
 *
 * The other half of the Tauri decision matters as much and is easier to get wrong.
 * These carry **no auth verdict**. The caller is the app's own renderer, not a stranger
 * on the internet, so "no auth check" would be a false alarm — and on bruno it would be
 * a false alarm 255 times over, which is the surest way to teach somebody to stop
 * reading the auth line.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyzeProject } from '../dist/node/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const { atlas } = await analyzeProject(path.join(here, 'fixtures', 'electronipc'), {
  followReferences: true,
  cache: 'off',
});

const doors = atlas.nodes.filter((n) => n.kind === 'endpoint');
// Registered channels only. A preload's bridged capability is the same `ipc` kind —
// deliberately, so it stays out of the auth count with the rest of them — and is told
// apart by its method, `BRIDGE` (#192).
const ipc = doors.filter((n) => n.meta.endpointKind === 'ipc' && n.meta.method === 'IPC');

test('every registered channel is a door, whichever way it was registered', () => {
  assert.deepEqual(ipc.map((n) => n.name).sort(), [
    'renderer:open-collection',
    'renderer:show-in-folder',
    'renderer:zoom-in',
  ]);
});

test('the framework is named, so the door says what kind of wire it is', () => {
  const door = ipc.find((n) => n.name === 'renderer:open-collection');
  assert.equal(door.meta.framework, 'Electron');
  assert.equal(door.meta.method, 'IPC');
});

test('the evidence keeps the spelling, without inventing a second kind of door', () => {
  // `handle` is request/response and `on` is fire-and-forget. That is worth recording
  // and not worth making the reader learn a new category for.
  assert.match(ipc.find((n) => n.name === 'renderer:zoom-in').meta.sites[0].snippet, /ipcMain\.on\(/);
  assert.match(
    ipc.find((n) => n.name === 'renderer:show-in-folder').meta.sites[0].snippet,
    /ipcMain\.handle\(/,
  );
});

test('no IPC channel is accused of missing an auth check', () => {
  // The whole of the Tauri decision, and the half that would do damage at scale.
  assert.equal(atlas.meta.stats.routes, 0);
  assert.equal(atlas.meta.stats.unprotectedRoutes, 0);
  for (const door of ipc) assert.deepEqual(door.meta.guards, []);
});

test('a computed channel name is not invented', () => {
  // `ipcMain.handle(channel, …)` where `channel` is built from a template. No literal,
  // so no address — and nothing pretending to be one.
  assert.equal(ipc.some((n) => /\$\{|`/.test(n.name)), false);
  assert.equal(ipc.some((n) => n.name === 'channel'), false);
});

test('the renderer side is not counted, because it is the same wire', () => {
  // `ipcRenderer.invoke` would list every channel a second time from the other end.
  assert.equal(doors.some((n) => n.meta.framework === 'Electron' && /askHost/.test(n.name)), false);
});

// --- the preload: the same boundary from the untrusted side (#192) ---

test('a capability handed straight over is a door nothing else carries', () => {
  // `shell.openExternal` is routed through no channel, so before #192 it appeared on
  // no map at all — and for a desktop app that is the most interesting thing on the
  // boundary: the renderer can ask the host to open any URL.
  const bridged = doors.filter((n) => n.meta.method === 'BRIDGE');
  assert.deepEqual(
    bridged.map((n) => n.name),
    ['api.openExternal'],
  );
  assert.match(bridged[0].meta.sites[0].snippet, /shell\.openExternal/);
});

test('a member that forwards to a channel is not a second door for one path', () => {
  // The inflation trap: `api.openCollection` is the renderer's name for
  // `renderer:open-collection`, which is already listed. Two entries, one wire.
  assert.equal(doors.some((n) => /openCollection|onCollectionChanged/.test(n.name)), false);
});

test('a bridged capability carries no auth verdict either', () => {
  for (const door of doors.filter((n) => n.meta.method === 'BRIDGE')) {
    assert.deepEqual(door.meta.guards, []);
  }
  assert.equal(atlas.meta.stats.unprotectedRoutes, 0);
});
