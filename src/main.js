'use strict';

process.on('uncaughtException', (err) => console.error('Uncaught Exception:', err));
process.on('unhandledRejection', (err) => console.error('Unhandled Rejection:', err));

const {
  app, BrowserWindow, Tray, Menu, shell, session, clipboard,
  nativeImage, ipcMain, globalShortcut, dialog, systemPreferences
} = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const Store = require('electron-store');

const { autoUpdater } = require('electron-updater');



const store = new Store({
  defaults: {
    bounds: { width: 1200, height: 800 },
    maximized: false,
    minimizeToTray: true,
    startMinimized: false,
    zoom: 0,
    paneWidth: 0,
    hardwareAcceleration: true,
    lowPower: true,
    blockTelemetry: true,
    // Translucent icon rail via Windows 11 acrylic backdrop or system-wide DWM blur
    translucent: true
  }
});

const WHATSAPP_URL = 'https://web.whatsapp.com/';

// A real, current Chrome UA. WhatsApp Web nags about an "unsupported browser"
// under the default Electron UA.
const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Endpoints that exist purely to report on you. None of these carry message
// traffic, media or presence, so blocking them costs no functionality.
const TELEMETRY_HOSTS = [
  '*://*.google-analytics.com/*',
  '*://*.googletagmanager.com/*',
  '*://*.doubleclick.net/*',
  '*://*.crashlytics.com/*',
  '*://*.sentry.io/*',
  '*://crashlogs.whatsapp.net/*'
];

// ---------------------------------------------------------------------------
// Chromium is a browser; we only need the messaging parts of it. Everything
// switched off below is a subsystem WhatsApp never touches but which otherwise
// costs threads, memory, background fetches, or all three.
// ---------------------------------------------------------------------------
function configureRuntime() {
  // Translucency (Acrylic / Mica / DWM blur) requires GPU compositing to render
  if (!store.get('hardwareAcceleration') && !store.get('translucent')) {
    app.disableHardwareAcceleration();
  }

  app.commandLine.appendSwitch('disable-features', [
    'Translate',                        // language detection on every page
    'MediaRouter',                      // Cast device discovery on the LAN
    'DialMediaRouteProvider',           // ditto
    'OptimizationHints',                // periodic model fetches from Google
    'OptimizationGuideModelDownloading',
    'AutofillServerCommunication',      // form uploads to Google
    'InterestFeedContentSuggestions',
    'SpareRendererForSitePerProcess'    // a whole idle renderer held in reserve
  ].join(','));

  app.commandLine.appendSwitch('disable-component-update'); // no background updater
  app.commandLine.appendSwitch('disable-breakpad');         // no crash uploads
  app.commandLine.appendSwitch('disable-domain-reliability');
  app.commandLine.appendSwitch('disable-client-side-phishing-detection');
  app.commandLine.appendSwitch('disable-speech-api');
  app.commandLine.appendSwitch('disable-print-preview');
  app.commandLine.appendSwitch('disable-sync');
  app.commandLine.appendSwitch('no-pings');
  
  // Memory optimization (without breaking WebAssembly media decryption)
  app.commandLine.appendSwitch('disable-site-isolation-trials');
  app.commandLine.appendSwitch('process-per-site');
  
  app.commandLine.appendSwitch('disk-cache-size', String(96 * 1024 * 1024));
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
  app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer,WebRtcApmInAudioService');

  // Timers are never throttled: the websocket and its keepalives have to keep
  // running or messages arrive late. Process *priority*, on the other hand, is
  // left to Windows unless you ask otherwise — that is the low-power tradeoff.
  app.commandLine.appendSwitch('disable-background-timer-throttling');
  if (!store.get('lowPower')) {
    app.commandLine.appendSwitch('disable-renderer-backgrounding');
    app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
  }
}

configureRuntime();
app.setAppUserModelId('com.whitedev.whatsapppc');

let mainWindow = null;
let tray = null;
let isQuitting = false;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
}

function asset(name) {
  return path.join(__dirname, 'assets', name);
}

function getSystemAccent() {
  if (process.platform === 'win32') {
    try {
      if (systemPreferences && systemPreferences.getAccentColor) {
        const hex = systemPreferences.getAccentColor();
        if (hex && hex.length >= 6) {
          const r = parseInt(hex.slice(0, 2), 16);
          const g = parseInt(hex.slice(2, 4), 16);
          const b = parseInt(hex.slice(4, 6), 16);
          return { hex: '#' + hex.slice(0, 6), rgb: `${r}, ${g}, ${b}` };
        }
      }
    } catch {}

    // Registry fallback for HKCU\Software\Microsoft\Windows\DWM\AccentColor
    try {
      const { execSync } = require('child_process');
      const out = execSync('reg query "HKCU\\Software\\Microsoft\\Windows\\DWM" /v AccentColor', { encoding: 'utf8' });
      const m = /AccentColor\s+REG_DWORD\s+0x([0-9a-fA-F]+)/.exec(out);
      if (m) {
        const val = parseInt(m[1], 16);
        // AccentColor in registry is 0xAABBGGRR (ABGR)
        const r = val & 0xff;
        const g = (val >> 8) & 0xff;
        const b = (val >> 16) & 0xff;
        const hex = '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
        return { hex, rgb: `${r}, ${g}, ${b}` };
      }
    } catch {}
  }
  return { hex: '#bf5611', rgb: '191, 86, 17' };
}

function createWindow() {
  const bounds = store.get('bounds');

  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: 620,
    minHeight: 480,
    show: false,
    autoHideMenuBar: true,
    maximizable: true,
    fullscreenable: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: 'rgba(0, 0, 0, 0)',
      symbolColor: '#ffffff',
      height: 30
    },
    transparent: true,
    backgroundColor: '#00000000',
    title: 'WhatsApp',
    icon: asset('icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      partition: 'persist:whatsapp',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
      backgroundThrottling: false,
      webviewTag: false,
      enableWebSQL: false,
      v8CacheOptions: 'code'
    }
  });

  if (store.get('maximized')) mainWindow.maximize();

  const ses = mainWindow.webContents.session;

  // Present ourselves as Chrome for every request, including subresources.
  ses.setUserAgent(CHROME_UA);
  ses.webRequest.onBeforeSendHeaders((details, cb) => {
    details.requestHeaders['User-Agent'] = CHROME_UA;
    cb({ requestHeaders: details.requestHeaders });
  });

  if (store.get('blockTelemetry')) {
    ses.webRequest.onBeforeRequest({ urls: TELEMETRY_HOSTS },
      (_details, cb) => cb({ cancel: true }));
  }

  // One dictionary, not the dozen Chromium would otherwise fetch on demand.
  const locale = app.getLocale();
  ses.setSpellCheckerLanguages([
    ses.availableSpellCheckerLanguages.includes(locale) ? locale : 'en-US'
  ]);

  const ALLOWED_PERMISSIONS = [
    'notifications', 'media', 'mediaKeySystem', 'display-capture',
    'clipboard-read', 'clipboard-sanitized-write', 'fullscreen',
    'speaker-selection', 'microphone', 'camera'
  ];

  // Grant permissions for calls, camera, microphone, notifications, and clipboard
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(ALLOWED_PERMISSIONS.includes(permission));
  });

  // Handle permission queries (e.g. navigator.permissions.query) for camera & mic
  ses.setPermissionCheckHandler((_wc, permission) => {
    return ALLOWED_PERMISSIONS.includes(permission);
  });

  // Allow enumerating and selecting audio/video hardware devices
  ses.setDevicePermissionHandler(() => true);

  mainWindow.loadURL(WHATSAPP_URL, { userAgent: CHROME_UA });

  mainWindow.once('ready-to-show', () => {
    if (!store.get('startMinimized')) mainWindow.show();
    const z = store.get('zoom');
    if (z) mainWindow.webContents.setZoomLevel(z);
  });

  setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible() && !store.get('startMinimized')) {
      mainWindow.show();
    }
  }, 1500);

  // Open real links in the user's browser, never in an app window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('https://web.whatsapp.com')) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });

  // If the renderer ever dies, reload instead of showing a white window.
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    if (details.reason !== 'clean-exit') mainWindow.reload();
  });

  mainWindow.webContents.on('did-fail-load', (_e, code, _desc, _url, isMain) => {
    if (isMain && code !== -3) {
      setTimeout(() => mainWindow && mainWindow.loadURL(WHATSAPP_URL), 3000);
    }
  });

  mainWindow.webContents.on('context-menu', (_e, params) =>
    showContextMenu(ses, params));

  // Menu accelerators only bind one key each, but "zoom in" is Ctrl+= on most
  // layouts, Ctrl+Shift+= on others and Ctrl+NumpadAdd on a full keyboard.
  // Catching the raw input covers all of them.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !input.control || input.alt) return;
    const key = input.key;
    if (key === '=' || key === '+' || key === 'Add') {
      zoom(0.5); event.preventDefault();
    } else if (key === '-' || key === '_' || key === 'Subtract') {
      zoom(-0.5); event.preventDefault();
    } else if (key === '0' || key === 'Insert') {
      zoom(0, true); event.preventDefault();
    }
  });

  // F11 fullscreen. WhatsApp Web swallows the keypress before the menu
  // accelerator sees it, so handle it on the way in.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') {
      mainWindow.setFullScreen(!mainWindow.isFullScreen());
      event.preventDefault();
    }
  });

  // Ctrl+wheel, the other thing everyone reaches for.
  mainWindow.webContents.on('zoom-changed', (_e, direction) =>
    zoom(direction === 'in' ? 0.5 : -0.5));

  const saveBounds = debounce(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    store.set('maximized', mainWindow.isMaximized());
    if (!mainWindow.isMaximized() && !mainWindow.isMinimized()) {
      store.set('bounds', mainWindow.getBounds());
    }
  }, 400);

  function triggerLayoutRefresh() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('window-resized');
  }

  mainWindow.on('resize', () => {
    saveBounds();
    triggerLayoutRefresh();
  });
  mainWindow.on('move', saveBounds);
  mainWindow.on('maximize', () => {
    saveBounds();
    setTimeout(triggerLayoutRefresh, 50);
    setTimeout(triggerLayoutRefresh, 250);
  });
  mainWindow.on('unmaximize', () => {
    saveBounds();
    setTimeout(triggerLayoutRefresh, 50);
    setTimeout(triggerLayoutRefresh, 250);
  });
  mainWindow.on('enter-full-screen', () => {
    setTimeout(triggerLayoutRefresh, 50);
    setTimeout(triggerLayoutRefresh, 250);
  });
  mainWindow.on('leave-full-screen', () => {
    setTimeout(triggerLayoutRefresh, 50);
    setTimeout(triggerLayoutRefresh, 250);
  });

  mainWindow.on('close', (e) => {
    if (!isQuitting && store.get('minimizeToTray')) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

function showContextMenu(ses, params) {
  const items = [];

  for (const suggestion of params.dictionarySuggestions) {
    items.push({
      label: suggestion,
      click: () => mainWindow.webContents.replaceMisspelling(suggestion)
    });
  }
  if (params.dictionarySuggestions.length) items.push({ type: 'separator' });

  if (params.misspelledWord) {
    items.push({
      label: 'Add to dictionary',
      click: () => ses.addWordToSpellCheckerDictionary(params.misspelledWord)
    });
    items.push({ type: 'separator' });
  }

  if (params.hasImageContents) {
    items.push({
      label: 'Copy image',
      click: () => mainWindow.webContents.copyImageAt(params.x, params.y)
    });
    if (params.srcURL) {
      items.push({
        label: 'Save image as...',
        click: () => mainWindow.webContents.downloadURL(params.srcURL)
      });
    }
    items.push({ type: 'separator' });
  }

  if (params.linkURL) {
    items.push({
      label: 'Copy link address',
      click: () => clipboard.writeText(params.linkURL)
    });
    items.push({ type: 'separator' });
  }

  items.push(
    { role: 'cut', enabled: params.editFlags.canCut },
    { role: 'copy', enabled: params.editFlags.canCopy },
    { role: 'paste', enabled: params.editFlags.canPaste },
    { type: 'separator' },
    { role: 'selectAll' }
  );

  Menu.buildFromTemplate(items).popup({ window: mainWindow });
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.setAlwaysOnTop(true);
  mainWindow.show();
  mainWindow.focus();
  mainWindow.setAlwaysOnTop(false);
}

// ---------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------
function createTray() {
  const icon = nativeImage.createFromPath(asset('tray.png'));
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip('WhatsApp');
  tray.on('click', toggleWindow);
  refreshTrayMenu();
}

function toggleWindow() {
  if (mainWindow && mainWindow.isVisible() && mainWindow.isFocused()) {
    mainWindow.hide();
  } else {
    showWindow();
  }
}

/** A tray checkbox bound to a store key, with an optional restart nudge. */
function toggle(label, key, restart) {
  return {
    label,
    type: 'checkbox',
    checked: store.get(key),
    click: (item) => {
      store.set(key, item.checked);
      refreshTrayMenu();
      if (restart) {
        dialog.showMessageBox({
          type: 'info',
          message: 'Restart WhatsApp for this to take effect.'
        });
      }
    }
  };
}

function refreshTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open WhatsApp', click: showWindow },
    { type: 'separator' },
    toggle('Close to tray', 'minimizeToTray'),
    toggle('Start minimized', 'startMinimized'),
    {
      label: 'Start with Windows',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (i) => app.setLoginItemSettings({ openAtLogin: i.checked })
    },
    { type: 'separator' },
    toggle('Hardware acceleration', 'hardwareAcceleration', true),
    toggle('Low power when hidden', 'lowPower', true),
    toggle('Block telemetry', 'blockTelemetry', true),
    toggle('Translucent sidebar', 'translucent', true),
    { label: 'Resource usage…', click: showResourceUsage },
    { type: 'separator' },
    { label: 'Reset sidebar width', click: resetPaneWidth },
    { label: 'Reload', click: () => mainWindow && mainWindow.reload() },
    { label: 'Log out / reset session', click: resetSession },
    { type: 'separator' },
    { label: 'Quit', click: () => { isQuitting = true; app.quit(); } }
  ]));
}

async function resetSession() {
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    buttons: ['Cancel', 'Reset'],
    defaultId: 0,
    message: 'This clears the saved session. You will need to scan the QR code again.'
  });
  if (response !== 1) return;
  await session.fromPartition('persist:whatsapp').clearStorageData();
  if (mainWindow) mainWindow.reload();
}

function resetPaneWidth() {
  store.set('paneWidth', 0);
  if (mainWindow) mainWindow.reload();
}

function showResourceUsage() {
  const metrics = app.getAppMetrics();
  const total = metrics.reduce((sum, m) => sum + m.memory.workingSetSize, 0);
  const rows = metrics
    .sort((a, b) => b.memory.workingSetSize - a.memory.workingSetSize)
    .map((m) => `${m.type.padEnd(12)} ${(m.memory.workingSetSize / 1024)
      .toFixed(0).padStart(5)} MB   ${m.cpu.percentCPUUsage.toFixed(1)}% CPU`);

  dialog.showMessageBox({
    type: 'info',
    title: 'Resource usage',
    message: `${metrics.length} processes · ${(total / 1024).toFixed(0)} MB total`,
    detail: rows.join('\n')
  });
}

// ---------------------------------------------------------------------------
// Application menu (hidden behind Alt, but keeps the shortcuts alive)
// ---------------------------------------------------------------------------
function createMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: 'File',
      submenu: [
        { label: 'Reload', accelerator: 'CmdOrCtrl+R',
          click: () => mainWindow && mainWindow.reload() },
        { label: 'Hide to tray', accelerator: 'CmdOrCtrl+W',
          click: () => mainWindow && mainWindow.hide() },
        { type: 'separator' },
        { label: 'Quit', accelerator: 'CmdOrCtrl+Q',
          click: () => { isQuitting = true; app.quit(); } }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' },
        { role: 'pasteAndMatchStyle' }, { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { label: 'Zoom in', accelerator: 'CmdOrCtrl+=', click: () => zoom(0.5) },
        { label: 'Zoom out', accelerator: 'CmdOrCtrl+-', click: () => zoom(-0.5) },
        { label: 'Reset zoom', accelerator: 'CmdOrCtrl+0', click: () => zoom(0, true) },
        { type: 'separator' },
        { label: 'Reset sidebar width', click: resetPaneWidth },
        { role: 'togglefullscreen' },
        { label: 'Developer tools', accelerator: 'CmdOrCtrl+Shift+I',
          click: () => mainWindow && mainWindow.webContents.toggleDevTools() }
      ]
    }
  ]));
}

function zoom(delta, reset) {
  if (!mainWindow) return;
  const wc = mainWindow.webContents;
  const level = reset ? 0 : Math.max(-3, Math.min(3, wc.getZoomLevel() + delta));
  wc.setZoomLevel(level);
  store.set('zoom', level);
}

// ---------------------------------------------------------------------------
// Renderer bridge
// ---------------------------------------------------------------------------
ipcMain.on('unread-count', (_e, count) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const n = Number(count) || 0;
  mainWindow.setOverlayIcon(n > 0 ? badgeIcon(n) : null, n > 0 ? n + ' unread' : '');
  if (tray) tray.setToolTip(n > 0 ? 'WhatsApp — ' + n + ' unread' : 'WhatsApp');
});

ipcMain.on('activate-window', () => showWindow());
ipcMain.on('dom-debug', (_e, data) => {
  try {
    fs.writeFileSync(path.join(__dirname, '..', 'dom-debug.json'), JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('Failed to write dom-debug.json', err);
  }
});
ipcMain.handle('pane-width:get', () => store.get('paneWidth'));
ipcMain.handle('translucent:get', () => store.get('translucent'));
ipcMain.handle('system:accent-color', () => getSystemAccent());
ipcMain.on('pane-width:set', (_e, px) => store.set('paneWidth', Number(px) || 0));

function getMimeType(filename) {
  const ext = path.extname(filename).toLowerCase();
  const mimeMap = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.svg': 'image/svg+xml',
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.m4v': 'video/x-m4v',
    '.3gp': 'video/3gpp',
    '.webm': 'video/webm',
    '.mkv': 'video/x-matroska',
    '.avi': 'video/x-msvideo',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.m4a': 'audio/mp4',
    '.pdf': 'application/pdf',
    '.zip': 'application/zip',
    '.rar': 'application/x-rar-compressed',
    '.7z': 'application/x-7z-compressed',
    '.tar': 'application/x-tar',
    '.gz': 'application/gzip',
    '.txt': 'text/plain',
    '.csv': 'text/csv',
    '.json': 'application/json',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  };
  return mimeMap[ext] || 'application/octet-stream';
}

function getClipboardExePath() {
  const unpackedPath = path.join(__dirname, 'assets', 'get_clipboard_files.exe').replace('app.asar', 'app.asar.unpacked');
  if (fs.existsSync(unpackedPath)) return unpackedPath;
  const directPath = path.join(__dirname, 'assets', 'get_clipboard_files.exe');
  if (fs.existsSync(directPath)) return directPath;
  return null;
}

function getNativeClipboardFiles() {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-Command', '(Get-Clipboard -Format FileDropList).FullName'], { windowsHide: true, timeout: 2000 }, (err, stdout) => {
      if (err || !stdout) return resolve([]);
      const lines = stdout.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      const files = [];
      for (const filePath of lines) {
        try {
          if (fs.existsSync(filePath)) {
            const stat = fs.statSync(filePath);
            // Prevent loading insanely huge files into memory which would crash the IPC/renderer
            if (stat.isFile() && stat.size < 100 * 1024 * 1024) {
              files.push({
                name: path.basename(filePath),
                path: filePath,
                size: stat.size,
                lastModified: stat.mtimeMs,
                mimeType: getMimeType(filePath),
                buffer: fs.readFileSync(filePath)
              });
            }
          }
        } catch (e) {
          console.error('Error reading clipboard file:', filePath, e);
        }
      }
      resolve(files);
    });
  });
}

ipcMain.handle('clipboard:get-files', async () => {
  return await getNativeClipboardFiles();
});

function badgeIcon(n) {
  const text = n > 99 ? '99+' : String(n);
  const size = text.length > 2 ? 13 : 17;
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32">' +
    '<circle cx="16" cy="16" r="16" fill="#25D366"/>' +
    '<text x="16" y="22" font-family="Segoe UI,sans-serif" font-size="' + size +
    '" font-weight="600" fill="#0b141a" text-anchor="middle">' + text + '</text></svg>';
  return nativeImage.createFromDataURL(
    'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64')
  );
}

// ---------------------------------------------------------------------------
app.whenReady().then(() => {
  createWindow();
  createTray();
  createMenu();
  
  // Auto-updater setup
  autoUpdater.checkForUpdatesAndNotify();

  if (process.platform === 'win32' && systemPreferences && systemPreferences.on) {
    try {
      systemPreferences.on('accent-color-changed', () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('accent-color-updated', getSystemAccent());
        }
      });
    } catch {}
  }

  globalShortcut.register('CommandOrControl+Shift+W', toggleWindow);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (!store.get('minimizeToTray')) app.quit();
});

app.on('before-quit', () => { isQuitting = true; });
app.on('will-quit', () => globalShortcut.unregisterAll());

function debounce(fn, ms) {
  let t;
  return function () {
    const a = arguments;
    clearTimeout(t);
    t = setTimeout(() => fn.apply(null, a), ms);
  };
}
