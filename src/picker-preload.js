'use strict';
// Preload for the screen-share picker (src/picker.html): receives the list of
// screens and windows, and returns the one that was chosen (or null).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('relayPicker', {
  onData: (fn) => ipcRenderer.on('picker:data', (_e, data) => fn(data)),
  choose: (id, audio) => ipcRenderer.send('picker:done', { id: String(id), audio: Boolean(audio) }),
  cancel: () => ipcRenderer.send('picker:done', null)
});
