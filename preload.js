'use strict';

const { contextBridge, ipcRenderer, webFrame } = require('electron');

// The only bridge between the page and the main process
contextBridge.exposeInMainWorld('native', {
  auth: {
    status: () => ipcRenderer.invoke('auth:status'),
    login: () => ipcRenderer.invoke('auth:login'),
    logout: () => ipcRenderer.invoke('auth:logout'),
    setManual: (token, clientId) => ipcRenderer.invoke('auth:setManual', { token, clientId })
  },
  api: (request) => ipcRenderer.invoke('api:request', request),
  humanCheck: (url) => ipcRenderer.invoke('api:humanCheck', url),
  prefs: {
    load: () => ipcRenderer.sendSync('prefs:load'),
    save: (entries) => ipcRenderer.invoke('prefs:save', entries)
  },
  sources: {
    spotifyPlaylist: (link) => ipcRenderer.invoke('sources:spotifyPlaylist', link),
    audiusSearch: (query) => ipcRenderer.invoke('sources:audiusSearch', query),
    bandcampSearch: (query) => ipcRenderer.invoke('sources:bandcampSearch', query)
  },
  json: (url) => ipcRenderer.invoke('net:json', url),
  image: (url) => ipcRenderer.invoke('net:image', url),
  setZoom: (factor) => ipcRenderer.invoke('window:zoom', factor),
  setTitleBar: (color, symbolColor) => ipcRenderer.invoke('window:titlebar', { color, symbolColor }),
  windowMode: () => ipcRenderer.invoke('window:mode'),
  setSeeThrough: (on) => ipcRenderer.invoke('window:setSeeThrough', on),
  setBlurMethod: (method) => ipcRenderer.invoke('window:setBlurMethod', method),
  windowControl: (action) => ipcRenderer.invoke('window:control', action),
  onMaximized: (fn) => ipcRenderer.on('window:maximized', (event, value) => fn(value)),
  onNavigate: (fn) => ipcRenderer.on('nav:history', (event, direction) => fn(direction === 'back' ? 'back' : 'forward')),
  openExternal: (url) => ipcRenderer.invoke('shell:open', url),
  copy: (text) => ipcRenderer.invoke('clipboard:write', text),
  discord: {
    update: (state) => ipcRenderer.invoke('discord:update', state),
    setEnabled: (on) => ipcRenderer.invoke('discord:setEnabled', on),
    status: () => ipcRenderer.invoke('discord:status')
  },
  metrics: () => ipcRenderer.invoke('app:metrics'),
  performanceInfo: () => ipcRenderer.invoke('app:performanceInfo'),
  setHardwareAcceleration: (on) => ipcRenderer.invoke('app:setHardwareAcceleration', on),
  onVisibility: (fn) => ipcRenderer.on('window:visibility', (event, hidden) => fn(hidden)),
  // a game or another app is fullscreen in front of Quantm (Windows)
  onGaming: (fn) => ipcRenderer.on('window:gaming', (event, gaming) => fn(gaming)),
  // drop decoded images and other caches (used when the window is minimized)
  trimMemory: () => webFrame.clearCache(),
  offline: {
    list: () => ipcRenderer.invoke('offline:list'),
    download: (id) => ipcRenderer.invoke('offline:download', id),
    cancel: (id) => ipcRenderer.invoke('offline:cancel', id),
    remove: (id) => ipcRenderer.invoke('offline:remove', id),
    removeAll: () => ipcRenderer.invoke('offline:removeAll'),
    openFolder: () => ipcRenderer.invoke('offline:openFolder'),
    onProgress: (fn) => ipcRenderer.on('offline:progress', (event, progress) => fn(progress))
  },
  updates: {
    status: () => ipcRenderer.invoke('update:status'),
    check: () => ipcRenderer.invoke('update:check'),
    download: () => ipcRenderer.invoke('update:download'),
    install: () => ipcRenderer.invoke('update:install'),
    setAuto: (on) => ipcRenderer.invoke('update:setAuto', on),
    onStatus: (fn) => ipcRenderer.on('update:status', (event, state) => fn(state))
  },
  info: () => ipcRenderer.invoke('app:info'),
  openCrashLogs: () => ipcRenderer.invoke('app:openCrashLogs')
});
