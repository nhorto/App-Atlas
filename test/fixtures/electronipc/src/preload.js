// The same boundary from the untrusted side (#192). Everything the renderer can reach
// is here, and only one of these three is a fact the map does not already carry.
const { contextBridge, ipcRenderer, shell } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // A name for a door already on the map — emitting it again would report two ways in
  // for one path, which is the inflation #149 was careful about.
  openCollection: (path) => ipcRenderer.invoke('renderer:open-collection', path),
  onCollectionChanged: (handler) => ipcRenderer.on('renderer:collection-changed', handler),

  // A privileged capability handed straight over, routed through no channel at all.
  // Nothing else on the map represents this, which is the whole reason to read it.
  openExternal: (url) => shell.openExternal(url),
});
