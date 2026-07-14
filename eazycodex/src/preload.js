/**
 * Preload script: securely exposes IPC methods to the renderer.
 */

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('easyCodex', {
  getStatus: () => ipcRenderer.invoke('get-status'),
  checkWizard: () => ipcRenderer.invoke('check-wizard'),
  installDependency: (dep) => ipcRenderer.invoke('install-dependency', dep),
 saveConfig: (apiKey, model, reasoningEffort) =>
   ipcRenderer.invoke('save-config', apiKey, model, reasoningEffort, null),
 saveConfigFull: (apiKey, model, reasoningEffort, contextWindow) =>
     ipcRenderer.invoke('save-config-full', apiKey, model, reasoningEffort, contextWindow),
  readSettings: () => ipcRenderer.invoke('read-settings'),
  launchCodex: () => ipcRenderer.invoke('launch-codex'),
 testApiKey: (apiKey) => ipcRenderer.invoke('test-api-key', apiKey),
 diagnoseConnection: () => ipcRenderer.invoke('diagnose-connection'),
 openExternal: (url) => ipcRenderer.invoke('open-external', url),
  onProxyLog: (callback) => {
    ipcRenderer.on('proxy-log', (event, msg) => callback(msg));
  },
  onInstallProgress: (callback) => {
    ipcRenderer.on('install-progress', (event, data) => callback(data));
  }
});
