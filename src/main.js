'use strict';

process.on('uncaughtException', (err) => console.error('Uncaught Exception:', err));
process.on('unhandledRejection', (err) => console.error('Unhandled Rejection:', err));

const {
  app, BrowserWindow, Tray, Menu, shell, session, clipboard,
  nativeImage, ipcMain, globalShortcut, dialog, systemPreferences, screen, desktopCapturer, nativeTheme
} = require('electron');
const path = require('path');
const fs = require('fs');
const Store = require('electron-store');

const { autoUpdater } = require('electron-updater');
const {
  isWhatsAppWebUrl, isWhatsAppOwnedUrl, deepLinkToWebUrl, shouldOpenExternally
} = require('./urls');

// Profile parsing for Multi-Account support
const profileArgMatch = process.argv.find(arg => arg.startsWith('--profile='));
const currentProfile = ((profileArgMatch ? profileArgMatch.split('=')[1] : '') || 'default')
  .replace(/[^\w-]/g, '') || 'default';
const currentPartition = currentProfile === 'default' ? 'persist:whatsapp' : 'persist:whatsapp_' + currentProfile;

// The single-instance lock is keyed on the userData directory. Without a
// directory of its own, launching "--profile=Work" while the default profile is
// running just focused the existing window, so multi-account never worked.
// Must happen before the lock is requested and before the Store is created.
if (currentProfile !== 'default') {
  app.setPath('userData', app.getPath('userData') + '-' + currentProfile);
}

const store = new Store({
  defaults: {
    bounds: { width: 1200, height: 800 },
    maximized: false,
    minimizeToTray: true,
    startMinimized: false,
    zoom: 0,
    paneWidth: 0,
    hardwareAcceleration: true,
      privacyBlur: false,
    lowPower: true,
    blockTelemetry: true,
    // Call quality (see preload.js). The camera path costs a canvas copy of
    // every frame, so both can be switched off.
    enhanceCamera: true,
    enhanceMic: true,
    // Offer calling even where WhatsApp has not enabled it for the account.
    webCalling: true
  }
});

const WHATSAPP_URL = 'https://web.whatsapp.com/';
const debugPerms = Boolean(process.env.RELAY_DEBUG_PERMS);   // logs permission + popup decisions
// A 64px copy for the page and the About window (the full 256px icon is ~60 KB).
const ICON_URI = 'data:image/png;base64,' +
  nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png'))
    .resize({ width: 64, height: 64, quality: 'best' }).toPNG().toString('base64');
const THEME_CSS = fs.readFileSync(path.join(__dirname, 'theme.css'), 'utf8')
  .replaceAll('__RELAY_ICON__', ICON_URI);

// The default Electron UA carries "Electron/x" and the app name, which makes
// WhatsApp Web nag about an unsupported browser. Build the UA from the Chromium
// we actually ship: a hard-coded version drifts out of date and contradicts the
// Sec-CH-UA client hints Chromium sends on its own (it was claiming 128 while
// the hints said 152).
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/' + process.versions.chrome.split('.')[0] + '.0.0.0 Safari/537.36';

function openExternalSafe(url) {
  if (shouldOpenExternally(url)) shell.openExternal(url);
}

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
  if (!store.get('hardwareAcceleration')) {
    app.disableHardwareAcceleration();
  }

  app.userAgentFallback = CHROME_UA;

  // One call only: appendSwitch replaces the previous value for the same
  // switch, so a second 'disable-features' call silently discarded this whole
  // list (only CalculateNativeWinOcclusion survived).
  app.commandLine.appendSwitch('disable-features', [
    'Translate',                        // language detection on every page
    'MediaRouter',                      // Cast device discovery on the LAN
    'DialMediaRouteProvider',           // ditto
    'OptimizationHints',                // periodic model fetches from Google
    'OptimizationGuideModelDownloading',
    'AutofillServerCommunication',      // form uploads to Google
    'InterestFeedContentSuggestions',
    'SpareRendererForSitePerProcess',   // a whole idle renderer held in reserve
    'CalculateNativeWinOcclusion'       // misreports occlusion for transparent windows
  ].join(','));

  app.commandLine.appendSwitch('disable-component-update'); // no background updater
  app.commandLine.appendSwitch('disable-breakpad');         // no crash uploads
  app.commandLine.appendSwitch('disable-domain-reliability');
  app.commandLine.appendSwitch('disable-client-side-phishing-detection');
  app.commandLine.appendSwitch('disable-speech-api');
  app.commandLine.appendSwitch('disable-print-preview');
  app.commandLine.appendSwitch('disable-sync');
  app.commandLine.appendSwitch('no-pings');
  
  // WhatsApp's call pop-out prefers Document Picture-in-Picture when the API exists.
  // Electron exposes it but never completes requestWindow(), so the pop-out was a
  // blank white window. Without the API WhatsApp uses its classic pop-out window.
  app.commandLine.appendSwitch('disable-blink-features', 'DocumentPictureInPictureAPI');
  app.commandLine.appendSwitch('disk-cache-size', String(96 * 1024 * 1024));
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

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

// The whole UI is dark: native menus, dialogs and prefers-color-scheme follow.
nativeTheme.themeSource = 'dark';
// Must equal build.appId in package.json (test/appid.test.js checks): that is the
// AUMID electron-builder stamps on the Start-menu shortcut, and Windows keys
// toast notifications, taskbar grouping and Jump Lists on it. A different value
// detaches all three. It is a constant because electron-builder removes the
// 'build' section from the package.json inside the packaged app.
app.setAppUserModelId('com.nikhlgoel.relay');

let mainWindow = null;
let tray = null;
let isQuitting = false;

if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('whatsapp', process.execPath, [path.resolve(process.argv[1])]);
  }
} else {
  app.setAsDefaultProtocolClient('whatsapp');
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (event, commandLine, workingDirectory) => {
    showWindow();
    const url = commandLine.find(arg => arg.startsWith('whatsapp://'));
    const webUrl = url && deepLinkToWebUrl(url);
    if (webUrl && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.loadURL(webUrl);
    }
  });
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

/** Saved bounds, or defaults if the monitor they were on is gone. Restoring a
 *  window to a disconnected display leaves it off-screen with no way back. */
function restorableBounds() {
  const saved = store.get('bounds');
  if (typeof saved.x !== 'number' || typeof saved.y !== 'number') return saved;
  const onScreen = screen.getAllDisplays().some(({ workArea: a }) =>
    saved.x < a.x + a.width - 80 && saved.x + saved.width > a.x + 80 &&
    saved.y < a.y + a.height - 40 && saved.y + saved.height > a.y);
  return onScreen ? saved : { width: saved.width, height: saved.height };
}

function createWindow() {
  const bounds = restorableBounds();

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
    // Not `transparent`: nothing here ever applied a backdrop material, so a
    // transparent window only forced the slower layered-window path (and
    // fought Windows' maximize/resize handling) for no visible gain.
    backgroundColor: '#0e1621',
    title: 'Relay',
    icon: asset('icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      partition: currentPartition,
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

  // Present ourselves as Chrome. The session-level UA covers every request, so
  // no per-request header hook is needed (it cost an IPC round trip each).
  ses.setUserAgent(CHROME_UA);

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
    'speaker-selection', 'microphone', 'camera', 'persistent-storage'
  ];

  // Only WhatsApp itself gets hardware and storage permissions. The handlers
  // used to say yes to every origin, including any frame or window the page
  // could open.
  const isTrusted = (url) => isWhatsAppWebUrl(url);
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const url = (details && details.requestingUrl) || wc.getURL();
    if (debugPerms) console.log('[perm] request', permission, url);
    callback(ALLOWED_PERMISSIONS.includes(permission) && isTrusted(url));
  });

  // Permission queries (navigator.permissions.query) for camera & mic
  ses.setPermissionCheckHandler((wc, permission, requestingOrigin) => {
    if (debugPerms) console.log('[perm] check', permission, requestingOrigin);
    return ALLOWED_PERMISSIONS.includes(permission) &&
      isTrusted(requestingOrigin || wc.getURL());
  });

  // Allow enumerating and selecting audio/video hardware devices
  ses.setDevicePermissionHandler((details) => isTrusted(details.origin));

  // Screen sharing in calls. Without a handler getDisplayMedia is rejected.
  ses.setDisplayMediaRequestHandler(pickDisplaySource, { useSystemPicker: false });

  // Theme + layout styling lives in theme.css and is re-injected on every load.
  mainWindow.webContents.on('dom-ready', () => {
    mainWindow.webContents.insertCSS(THEME_CSS).catch(() => {});
  });

  let initialUrl = WHATSAPP_URL;
  const deepLinkArg = process.argv.find(arg => arg.startsWith('whatsapp://'));
  const deepLinkUrl = deepLinkArg && deepLinkToWebUrl(deepLinkArg);
  if (deepLinkUrl) initialUrl = deepLinkUrl;
  mainWindow.loadURL(initialUrl);


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

  // The page sets its own title ("(3) WhatsApp"); this window is Relay.
  mainWindow.on('page-title-updated', (e, title) => {
    e.preventDefault();
    mainWindow.setTitle(title.replace(/WhatsApp/gi, 'Relay'));
  });

  // Open real links in the user's browser, never in an app window.
  // The old check was url.includes('whatsapp.com'), which also matched
  // 'https://evil.example/?whatsapp.com' and gave that page an app window that
  // inherits our preload.
  mainWindow.webContents.setWindowOpenHandler(({ url, frameName, features }) => {
    if (debugPerms) console.log('[open]', url.slice(0, 120), frameName, features);
    if (url === 'about:blank' || url.startsWith('blob:') || isWhatsAppOwnedUrl(url)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          autoHideMenuBar: true,
          backgroundColor: '#0e1621',
          icon: asset('icon.png')
        }
      };
    }
    openExternalSafe(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!isWhatsAppWebUrl(url)) {
      e.preventDefault();
      openExternalSafe(url);
    }
  });

  // If the renderer ever dies, reload instead of showing a white window, but
  // give up after a few crashes in quick succession rather than spinning.
  const crashTimes = [];
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    if (details.reason === 'clean-exit' || !mainWindow) return;
    const now = Date.now();
    crashTimes.push(now);
    while (crashTimes.length && now - crashTimes[0] > 60000) crashTimes.shift();
    if (crashTimes.length > 3) {
      console.error('Renderer crashed repeatedly; not reloading again.', details.reason);
      return;
    }
    setTimeout(() => mainWindow && !mainWindow.isDestroyed() && mainWindow.reload(), 500 * crashTimes.length);
  });

  // A blank pop-out is WhatsApp's call window: it fills the page itself. Keep it
  // above other windows (that is the point of popping a call out) and drop the
  // File/Edit/View bar that the main window's menu would otherwise give it.
  mainWindow.webContents.on('did-create-window', (child, details) => {
    child.setMenu(null);
    if (details.url === 'about:blank') child.setAlwaysOnTop(true, 'floating');
  });

  // Offline at launch (or a DNS blip): retry with a growing delay, and stop
  // hammering once the page loads.
  let loadRetries = 0;
  mainWindow.webContents.on('did-finish-load', () => { loadRetries = 0; });
  mainWindow.webContents.on('did-fail-load', (_e, code, _desc, _url, isMain) => {
    if (isMain && code !== -3) {
      const delay = Math.min(3000 * 2 ** loadRetries++, 60000);
      setTimeout(() => mainWindow && !mainWindow.isDestroyed() && mainWindow.loadURL(WHATSAPP_URL), delay);
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
    if (input.type === 'keyDown' && input.key === 'F1') {
      showAbout();
      event.preventDefault();
    }
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

  // After a stretch in the tray, collect garbage once. WhatsApp's renderer
  // holds a lot of short-lived objects from the last session of use; V8 would
  // otherwise keep them until the next major GC, which is whenever you return
  // - right when you want the UI snappy. Once, hidden, and never while visible.
  let trimTimer = null;
  mainWindow.on('hide', () => {
    clearTimeout(trimTimer);
    trimTimer = setTimeout(trimRendererMemory, 90 * 1000);
  });
  mainWindow.on('show', () => clearTimeout(trimTimer));

  // Windows is logging off / shutting down. Vetoing 'close' here makes the OS
  // report that the app is blocking shutdown.
  mainWindow.on('session-end', () => { isQuitting = true; });

  mainWindow.on('close', (e) => {
    if (!isQuitting && store.get('minimizeToTray')) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

/** Ask which screen or window to share, then hand it to getDisplayMedia. */
async function pickDisplaySource(request, callback) {
  if (!isWhatsAppWebUrl(request.securityOrigin) || !mainWindow) return callback({});
  let sources;
  try {
    sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 64, height: 36 },
      fetchWindowIcons: false
    });
  } catch (err) {
    console.error('Screen share: could not list sources', err);
    return callback({});
  }
  // Sharing Relay itself just shows a mirror of the call.
  sources = sources.filter((s) => s.id !== mainWindow.getMediaSourceId());
  if (!sources.length) return callback({});

  let done = false;
  const finish = (result) => { if (!done) { done = true; callback(result); } };
  const label = (s) => (s.id.startsWith('screen:') ? 'Screen: ' : 'Window: ') +
    (s.name.length > 60 ? s.name.slice(0, 57) + '...' : s.name);

  Menu.buildFromTemplate([
    { label: 'Share your screen or a window', enabled: false },
    { type: 'separator' },
    ...sources.map((s) => ({
      label: label(s),
      icon: s.thumbnail.isEmpty() ? undefined : s.thumbnail,
      click: () => finish({
        video: s,
        // System audio can only be captured along with a whole screen.
        ...(request.audioRequested && s.id.startsWith('screen:') ? { audio: 'loopback' } : {})
      })
    })),
    { type: 'separator' },
    { label: 'Cancel', click: () => finish({}) }
  ]).popup({
    window: mainWindow,
    // The item's click handler may run just after the menu closes.
    callback: () => setTimeout(() => finish({}), 250)
  });
}

async function trimRendererMemory() {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isVisible()) return;
  const dbg = mainWindow.webContents.debugger;
  // Another debugger (--remote-debugging / DevTools) may already own it.
  if (dbg.isAttached()) return;
  try {
    dbg.attach('1.3');
    await dbg.sendCommand('HeapProfiler.collectGarbage');
  } catch (err) {
    console.warn('Memory trim skipped:', err && err.message);
  } finally {
    try { dbg.detach(); } catch {}
  }
}

/**
 * Right-click menu. Only offers what applies to what was clicked - the old one
 * always showed a disabled Cut / Copy / Paste / Select all, which on a picture
 * looked like a generic browser. WhatsApp draws its own menus on messages and
 * chats; this handles everything else (media viewer, links, text, inputs).
 */
function showContextMenu(ses, params) {
  const wc = mainWindow.webContents;
  const items = [];
  const separator = () => {
    if (items.length && items[items.length - 1].type !== 'separator') items.push({ type: 'separator' });
  };

  if (params.misspelledWord) {
    for (const word of params.dictionarySuggestions.slice(0, 5)) {
      items.push({ label: word, click: () => wc.replaceMisspelling(word) });
    }
    separator();
    items.push({
      label: 'Add to dictionary',
      click: () => ses.addWordToSpellCheckerDictionary(params.misspelledWord)
    });
    separator();
  }

  if (params.linkURL) {
    if (shouldOpenExternally(params.linkURL)) {
      items.push({ label: 'Open link in browser', click: () => shell.openExternal(params.linkURL) });
    }
    items.push({ label: 'Copy link address', click: () => clipboard.writeText(params.linkURL) });
    separator();
  }

  if (params.mediaType === 'image' || params.hasImageContents) {
    items.push({ label: 'Copy image', click: () => wc.copyImageAt(params.x, params.y) });
    if (params.srcURL) {
      items.push({ label: 'Save image as...', click: () => wc.downloadURL(params.srcURL) });
    }
    separator();
  }

  const f = params.editFlags;
  if (params.isEditable) {
    items.push(
      { role: 'undo', enabled: f.canUndo },
      { role: 'redo', enabled: f.canRedo },
      { type: 'separator' },
      { role: 'cut', enabled: f.canCut },
      { role: 'copy', enabled: f.canCopy },
      { role: 'paste', enabled: f.canPaste },
      { type: 'separator' },
      { role: 'selectAll' }
    );
  } else if (params.selectionText.trim()) {
    const text = params.selectionText.trim();
    items.push({ role: 'copy' });
    items.push({
      label: 'Search the web for "' + (text.length > 28 ? text.slice(0, 28) + '...' : text) + '"',
      click: () => shell.openExternal('https://www.google.com/search?q=' + encodeURIComponent(text.slice(0, 500)))
    });
    separator();
    items.push({ role: 'selectAll' });
  }

  while (items.length && items[items.length - 1].type === 'separator') items.pop();
  if (!items.length) return;                       // nothing useful to offer here
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
  tray.setToolTip('Relay');
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

function mediaPrefs() {
  return { video: store.get('enhanceCamera'), audio: store.get('enhanceMic') };
}

/** Push the call-quality toggles into the page; they apply to the next call. */
function pushMediaPrefs() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents
    .executeJavaScript('window.__waMedia = ' + JSON.stringify(mediaPrefs()))
    .catch(() => {});
}

/** A tray checkbox bound to a store key, with an optional restart nudge. */
function toggle(label, key, restart, after) {
  return {
    label,
    type: 'checkbox',
    checked: store.get(key),
    click: (item) => {
      store.set(key, item.checked);
      if (after) after();
      refreshTrayMenu();
      if (restart) {
        dialog.showMessageBox({
          type: 'info',
          buttons: ['Restart now', 'Later'],
          defaultId: 0,
          cancelId: 1,
          message: 'Restart Relay for this to take effect.'
        }).then(({ response }) => {
          if (response !== 0) return;
          isQuitting = true;
          app.relaunch();
          app.quit();
        });
      }
    }
  };
}

function refreshTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Relay', click: showWindow },
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
    toggle('Enhance camera in calls', 'enhanceCamera', false, pushMediaPrefs),
    toggle('Enhance microphone in calls', 'enhanceMic', false, pushMediaPrefs),
    toggle('Enable calling', 'webCalling', true),
      toggle('Privacy Blur', 'privacyBlur', true),
    { label: 'Resource usage…', click: showResourceUsage },
    { type: 'separator' },
    { label: 'Reset sidebar width', click: resetPaneWidth },
    { label: 'Reload', click: () => mainWindow && mainWindow.reload() },
    { label: 'Log out / reset session', click: resetSession },
    { type: 'separator' },
    { label: 'About Relay', click: showAbout },
    { label: 'Quit', click: () => { isQuitting = true; app.quit(); } }
  ]));
}

// ---------------------------------------------------------------------------
// About: what Relay is, that it is unofficial, and the licences. A static page
// (src/about.html) with a strict CSP and no scripts or preload.
// ---------------------------------------------------------------------------
let aboutWindow = null;

function showAbout() {
  if (aboutWindow && !aboutWindow.isDestroyed()) {
    aboutWindow.show();
    aboutWindow.focus();
    return;
  }
  const html = fs.readFileSync(path.join(__dirname, 'about.html'), 'utf8')
    .replaceAll('{{ICON}}', ICON_URI)
    .replaceAll('{{VERSION}}', app.getVersion())
    .replaceAll('{{ELECTRON}}', process.versions.electron)
    .replaceAll('{{CHROMIUM}}', process.versions.chrome)
    .replaceAll('{{NODE}}', process.versions.node)
    .replaceAll('{{YEAR}}', '2026');

  aboutWindow = new BrowserWindow({
    width: 660,
    height: 760,
    minWidth: 420,
    minHeight: 360,
    parent: mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined,
    autoHideMenuBar: true,
    backgroundColor: '#0e1621',
    title: 'About Relay',
    icon: asset('icon.png'),
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      partition: 'relay-about',     // in memory, separate from the WhatsApp session
      spellcheck: false
    }
  });
  aboutWindow.setMenu(null);
  aboutWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  aboutWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafe(url);
    return { action: 'deny' };
  });
  aboutWindow.webContents.on('will-navigate', (e, url) => {
    e.preventDefault();
    openExternalSafe(url);
  });
  aboutWindow.on('closed', () => { aboutWindow = null; });
}

async function resetSession() {
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    buttons: ['Cancel', 'Reset'],
    defaultId: 0,
    message: 'This clears the saved session. You will need to scan the QR code again.'
  });
  if (response !== 1) return;
  await session.fromPartition(currentPartition).clearStorageData();
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
    },
    {
      label: 'Help',
      submenu: [
        { label: 'About Relay', accelerator: 'F1', click: showAbout },
        { type: 'separator' },
        { label: 'Source code', click: () => shell.openExternal('https://github.com/nikhlgoel/whatsapp-pc') },
        { label: 'Report an issue', click: () => shell.openExternal('https://github.com/nikhlgoel/whatsapp-pc/issues') }
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
/** IPC is only honoured from WhatsApp's own top-level page. */
function fromWhatsApp(e) {
  return Boolean(e.senderFrame) && isWhatsAppWebUrl(e.senderFrame.url);
}

const on = (channel, fn) => ipcMain.on(channel, (e, ...a) => { if (fromWhatsApp(e)) fn(e, ...a); });
const handle = (channel, fn) => ipcMain.handle(channel, (e, ...a) => {
  if (!fromWhatsApp(e)) throw new Error('Untrusted sender for ' + channel);
  return fn(e, ...a);
});

on('unread-count', (_e, count) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const n = Math.max(0, Math.floor(Number(count) || 0));
  mainWindow.setOverlayIcon(n > 0 ? badgeIcon(n) : null, n > 0 ? n + ' unread' : '');
  if (tray) tray.setToolTip(n > 0 ? 'Relay — ' + n + ' unread' : 'Relay');
});

on('activate-window', () => showWindow());

on('flash-window', () => {
  if (mainWindow && !mainWindow.isFocused()) {
    mainWindow.flashFrame(true);
  }
});

handle('pane-width:get', () => store.get('paneWidth'));
handle('privacyBlur:get', () => store.get('privacyBlur'));
handle('media:prefs', () => mediaPrefs());

// Read synchronously by the preload before WhatsApp boots (see enableWebCalling).
ipcMain.on('features:get', (e) => {
  e.returnValue = { calling: fromWhatsApp(e) && Boolean(store.get('webCalling')) };
});
handle('system:accent-color', () => getSystemAccent());
on('pane-width:set', (_e, px) => store.set('paneWidth', Math.max(0, Math.min(4000, Number(px) || 0))));

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
  
  if (process.platform === 'win32') {
    app.setUserTasks([
      {
        program: process.execPath,
        arguments: '--profile=Work',
        iconPath: process.execPath,
        iconIndex: 0,
        title: 'Relay - Work',
        description: 'Open Work Account'
      },
      {
        program: process.execPath,
        arguments: '--profile=Personal',
        iconPath: process.execPath,
        iconIndex: 0,
        title: 'Relay - Personal',
        description: 'Open Personal Account'
      }
    ]);
  }
  
  // Auto-updater: only meaningful for an installed build. The portable target
  // cannot self-update, and in dev there is no update feed to read.
  if (app.isPackaged && !process.env.PORTABLE_EXECUTABLE_FILE) {
    autoUpdater.on('error', (err) => console.error('Auto-update failed:', err && err.message));
    autoUpdater.checkForUpdatesAndNotify().catch(() => {});
  }

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
