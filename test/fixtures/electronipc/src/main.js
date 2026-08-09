// The privileged half of a desktop app. Every channel registered here is something the
// renderer is allowed to ask the host process to do — the filesystem and the shell
// included — which makes this list the inventory somebody opens an atlas to find.
import { app, ipcMain, shell } from 'electron';

import { readCollection } from './collections.js';

ipcMain.handle('renderer:open-collection', async (event, path) => {
  return readCollection(path);
});

ipcMain.handle('renderer:show-in-folder', async (event, path) => {
  return shell.showItemInFolder(path);
});

// Fire-and-forget rather than request/response. Still a door, and recorded as the
// spelling it was written in rather than as a second kind of thing.
ipcMain.on('renderer:zoom-in', () => {
  return null;
});

// The channel is computed, so the door keeps its place and loses its address (#142).
const channel = `renderer:${app.name}-ready`;
ipcMain.handle(channel, () => null);

// Not a door: `ipcRenderer` is the other side of the same wire, and counting it would
// list every channel twice.
export function askHost(name) {
  return name;
}
