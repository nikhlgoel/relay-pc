'use strict';
// Preload for the small "API key" window (src/prompt.html). It can only hand the
// typed value, or a cancel, back to the main process.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('relayPrompt', {
  submit: (value) => ipcRenderer.send('prompt:done', String(value || '')),
  cancel: () => ipcRenderer.send('prompt:done', '')
});
