'use strict';

process.on('uncaughtException', (err) => console.error('Uncaught Exception:', err));
process.on('unhandledRejection', (err) => console.error('Unhandled Rejection:', err));

const {
  app, BrowserWindow, Tray, Menu, shell, session, clipboard,
  nativeImage, ipcMain, globalShortcut, dialog, systemPreferences, screen, desktopCapturer, nativeTheme,
  Notification, powerSaveBlocker, safeStorage, net, webContents, utilityProcess, powerMonitor
} = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const Store = require('electron-store');

const { autoUpdater } = require('electron-updater');
const { setupHub, cleanProxy } = require('./hub');
const { setupCaptions } = require('./captions');
const { setupVoice } = require('./voice');
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

/**
 * Settings live in config.json. If the file is empty or cut short (a crash or power cut
 * while it was being written), electron-store throws and Relay would not start at all.
 * The damaged file is kept aside as config.damaged-<time>.json and a fresh one is used.
 */
function openStore(options) {
  try {
    return new Store(options);
  } catch (err) {
    const file = path.join(app.getPath('userData'), 'config.json');
    try { fs.renameSync(file, path.join(path.dirname(file), 'config.damaged-' + Date.now() + '.json')); } catch (e) { /* nothing to move */ }
    console.error('Settings file was unreadable and has been set aside:', err && err.message);
    return new Store(options);
  }
}

const store = openStore({
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
    sharpVideo: true,
    // Offer calling even where WhatsApp has not enabled it for the account.
    webCalling: true,
    // Start WhatsApp's call engine (WebAssembly + ~20 worker threads) on the first
    // call instead of at launch. Saves a few hundred MB while idle.
    lazyCallEngine: true,
    // Record every call from the moment it connects (needs the one-time consent).
    autoRecord: false,
    // In-app Relay panel (src/hub.js)
    noiseSuppression: true,
    dnd: false,
    translateAll: false,
    snippets: []
  }
});

// Hand-edited or damaged settings: any value of the wrong type is dropped (the default applies).
(function sanitizeStore() {
  const shapes = {
    bounds: 'object', callBounds: 'object', maximized: 'boolean', minimizeToTray: 'boolean', startMinimized: 'boolean',
    zoom: 'number', paneWidth: 'number', hardwareAcceleration: 'boolean', privacyBlur: 'boolean', lowPower: 'boolean',
    blockTelemetry: 'boolean', enhanceCamera: 'boolean', enhanceMic: 'boolean', sharpVideo: 'boolean', proxy: 'string', waLang: 'string', webCalling: 'boolean',
    lazyCallEngine: 'boolean', autoRecord: 'boolean', noiseSuppression: 'boolean', dnd: 'boolean', translateAll: 'boolean',
    snippets: 'array', recordingsDir: 'string', recordingConsentAck: 'boolean', translateChoice: 'string',
    translateConsent: 'object', translateKeys: 'object', translateKeyEnc: 'string', appIdentity: 'string',
    captionLang: 'string', captionSize: 'string', captionOriginal: 'boolean', captionModel: 'string', captionFrom: 'string',
    captionGpu: 'number', captionConsent: 'object',
    voiceIn: 'boolean', voiceOut: 'boolean', voiceHear: 'string', voiceThey: 'string', voiceDuck: 'number', voiceConsent: 'object'
  };
  const kind = (v) => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v);
  for (const [key, want] of Object.entries(shapes)) {
    if (store.has(key) && kind(store.get(key)) !== want) store.delete(key);
  }
  for (const key of ['zoom', 'paneWidth']) {
    if (store.has(key) && !Number.isFinite(store.get(key))) store.delete(key);
  }
  if (store.has('zoom')) store.set('zoom', Math.max(-3, Math.min(3, store.get('zoom'))));
})();

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

  // Relay's call extras (captions, recording, shortcuts, back) find WhatsApp's buttons by their English names. On a PC set to
  // another language WhatsApp would label them in that language, so the user may pin WhatsApp to English (see askWhatsAppLanguage).
  if (store.get('waLang') === 'en') app.commandLine.appendSwitch('lang', 'en-US');

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
  // Not enable-low-end-device-mode: it paints in 512x256 low-colour tiles, which showed up as
  // banded gradients and mismatched rectangles. Memory is trimmed another way (see trimRendererMemory).
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
const APP_ID = 'com.nikhlgoel.relay';
// A run from source (npm start) gets its own identity: pinning that window must not
// create a Start-menu shortcut that claims the installed Relay's AUMID and hides it
// from Start and Search (it showed up as "Electron").
const RUNTIME_ID = app.isPackaged ? APP_ID : APP_ID + '.dev';
app.setAppUserModelId(RUNTIME_ID);

let mainWindow = null;
let tray = null;
let hub = null;
let isQuitting = false;

// whatsapp:// links open in Relay - unless another app (the official WhatsApp) already owns them,
// in which case Relay leaves them alone instead of silently stealing them on every start.
if (!process.env.RELAY_TEST) {
  let owner = '';
  try { owner = app.getApplicationNameForProtocol('whatsapp://') || ''; } catch (e) { /* unknown */ }
  if (!owner || app.isDefaultProtocolClient('whatsapp')) {
    if (process.defaultApp) {
      if (process.argv.length >= 2) app.setAsDefaultProtocolClient('whatsapp', process.execPath, [path.resolve(process.argv[1])]);
    } else {
      app.setAsDefaultProtocolClient('whatsapp');
    }
  }
}

/** What Windows should start at login. A development run needs the app folder too, a portable build its own file. */
function loginItem(openAtLogin) {
  const exe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
  const args = app.isPackaged ? [] : [app.getAppPath()];
  return { openAtLogin, path: exe, args };
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

// ---------------------------------------------------------------------------
// Icon identity on Windows. A window's own icon is not always what the taskbar shows:
// it can fall back to the icon of the .exe, which for a development run is Electron's
// atom. So Relay also tells the shell, explicitly, which icon and name belong to its
// app id (taskbar button, pinning, jump list) and registers that id for notifications.
// ---------------------------------------------------------------------------
const WINDOW_ICON = asset(process.platform === 'win32' ? 'icon.ico' : 'icon.png');
let relayIcoPath = asset('icon.ico');

/** The shell cannot read inside the asar, so a packaged build keeps a copy of the icon in its data folder. */
function prepareIconFile() {
  if (!app.isPackaged) return;
  try {
    const dst = path.join(app.getPath('userData'), 'relay.ico');
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, fs.readFileSync(asset('icon.ico')));
    relayIcoPath = dst;
  } catch (e) { /* the window icon still applies */ }
}

const quoteArg = (s) => (/[\s"]/.test(s) ? '"' + s.replace(/"/g, '\\"') + '"' : s);

/** Taskbar identity for one window (main, call pop-out, About, pickers). */
function brandWindow(win) {
  if (process.platform !== 'win32' || !win || win.isDestroyed()) return;
  try {
    const args = process.argv.slice(1).filter((a) => a.startsWith('--profile='));
    const relaunch = [process.execPath, ...(app.isPackaged ? [] : [app.getAppPath()]), ...args].map(quoteArg).join(' ');
    win.setAppDetails({
      appId: RUNTIME_ID,
      appIconPath: relayIcoPath,
      appIconIndex: 0,
      relaunchCommand: relaunch,
      relaunchDisplayName: 'Relay'
    });
  } catch (e) { console.warn('[brand] taskbar identity not applied:', e.message); }   // cosmetic: never block a window over it
}

/** Gives Windows notifications Relay's name and icon (HKCU, this user only, once per icon location). */
function registerAppIdentity() {
  if (process.platform !== 'win32') return;
  const stamp = relayIcoPath + '|' + app.getVersion();
  if (store.get('appIdentity') === stamp) return;
  const key = 'HKCU\\Software\\Classes\\AppUserModelId\\' + RUNTIME_ID;
  const add = (name, value) => new Promise((resolve) =>
    require('child_process').execFile('reg', ['add', key, '/v', name, '/d', value, '/f'], { windowsHide: true }, (err) => resolve(!err)));
  Promise.all([add('DisplayName', 'Relay'), add('IconUri', relayIcoPath), add('IconBackgroundColor', 'FF111921')])
    .then((ok) => { if (ok.every(Boolean)) store.set('appIdentity', stamp); });
}

/** A desktop notification from Relay itself (never while automated tests run on someone's PC). */
function toast(title, body, onClick) {
  if (process.env.RELAY_TEST || !Notification.isSupported()) return;
  try {
    const n = new Notification({ title, body, silent: true, icon: APP_ICON });
    if (onClick) n.on('click', onClick);
    n.show();
  } catch (e) { /* notifications unavailable */ }
}

// Every dialog, notification and window carries Relay's icon - none falls back to
// Electron's. (Windows draws a toast's image from the AppUserModelId's shortcut,
// which an unpackaged dev run does not have, so toasts are given the icon directly.)
const APP_ICON = nativeImage.createFromPath(asset('icon.png'));   // dialogs and toasts want an image, not a file
/** A dialog owned by a hidden or minimised window can open out of sight, so then it has no owner. */
const visibleOwner = (w) => (w && !w.isDestroyed() && w.isVisible() && !w.isMinimized() ? w : undefined);
const showBox = (win, opts) => {
  const owner = opts ? visibleOwner(win) : undefined;
  const options = { icon: APP_ICON, ...(opts || win) };
  return owner ? dialog.showMessageBox(owner, options) : dialog.showMessageBox(options);
};

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
  return { hex: '#5288c1', rgb: '82, 136, 193' };
}

/** Saved bounds, or defaults if the monitor they were on is gone. Restoring a
 *  window to a disconnected display leaves it off-screen with no way back. */
function restorableBounds(key = 'bounds') {
  const saved = store.get(key);
  if (!saved || ![saved.width, saved.height].every(Number.isFinite)) return {};
  const area = screen.getPrimaryDisplay().workArea;
  const small = key === 'callBounds' ? [320, 240] : [620, 480];
  const size = {
    width: Math.round(Math.min(area.width, Math.max(small[0], saved.width))),
    height: Math.round(Math.min(area.height, Math.max(small[1], saved.height)))
  };
  if (!Number.isFinite(saved.x) || !Number.isFinite(saved.y)) return size;
  const onScreen = screen.getAllDisplays().some(({ workArea: a }) =>
    saved.x < a.x + a.width - 80 && saved.x + size.width > a.x + 80 &&
    saved.y < a.y + a.height - 40 && saved.y + size.height > a.y);
  return onScreen ? { ...size, x: Math.round(saved.x), y: Math.round(saved.y) } : size;
}

function createWindow() {
  const bounds = restorableBounds();

  prepareIconFile();
  registerAppIdentity();
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
    icon: WINDOW_ICON,
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

  brandWindow(mainWindow);
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

  // Downloads keep Electron's Save As dialog; once one finishes, say so and offer the folder.
  ses.removeAllListeners('will-download');                // createWindow can run again (tray, taskbar): one listener only
  ses.on('will-download', (_e, item) => {
    item.once('done', (_ev, state) => {
      if (state !== 'completed') return;
      const file = item.getSavePath();
      toast('Download complete', path.basename(file), () => shell.showItemInFolder(file));
    });
  });

  // Allow enumerating and selecting audio/video hardware devices
  ses.setDevicePermissionHandler((details) => isTrusted(details.origin));

  // Screen sharing in calls. Without a handler getDisplayMedia is rejected.
  ses.setDisplayMediaRequestHandler(pickDisplaySource, { useSystemPicker: false });

  // Theme + layout styling lives in theme.css and is re-injected on every load.
  // Inserted as soon as the document commits, so the loading screen is already
  // themed instead of flashing WhatsApp's grey first; dom-ready is the fallback.
  let cssFor = null;
  const insertTheme = () => {
    const id = mainWindow.webContents.getURL();
    if (cssFor === id) return;
    cssFor = id;
    mainWindow.webContents.insertCSS(THEME_CSS).catch(() => { cssFor = null; });
  };
  mainWindow.webContents.on('did-navigate', () => { cssFor = null; insertTheme(); });
  mainWindow.webContents.on('dom-ready', insertTheme);

  let initialUrl = WHATSAPP_URL;
  const deepLinkArg = process.argv.find(arg => arg.startsWith('whatsapp://'));
  const deepLinkUrl = deepLinkArg && deepLinkToWebUrl(deepLinkArg);
  if (deepLinkUrl) initialUrl = deepLinkUrl;
  mainWindow.loadURL(initialUrl);


  // RELAY_TEST=hidden never shows the window; =offscreen shows it far off-screen
  // (so it renders and can be resized like a real one). For automated tests only:
  // nothing may pop up while someone is using the PC.
  const testMode = process.env.RELAY_TEST || '';
  const showMain = () => {
    if (testMode === 'hidden') return;
    if (testMode === 'offscreen') { mainWindow.setSkipTaskbar(true); mainWindow.setPosition(-32000, -32000); mainWindow.showInactive(); return; }
    mainWindow.show();
  };
  mainWindow.once('ready-to-show', () => {
    if (!store.get('startMinimized')) showMain();
    const z = store.get('zoom');
    if (z) mainWindow.webContents.setZoomLevel(z);
  });

  setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible() && !store.get('startMinimized')) {
      showMain();
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
          icon: WINDOW_ICON,
          // The call window comes back where and as big as you left it.
          ...(url === 'about:blank' ? restorableBounds('callBounds') : {})
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
    brandWindow(child);
    if (details.url === 'about:blank') {
      child.setAlwaysOnTop(true, 'floating');
      const remember = debounce(() => {
        if (child.isDestroyed() || child.isMaximized() || child.isFullScreen() || child.isMinimized()) return;
        store.set('callBounds', child.getBounds());
      }, 400);
      child.on('resize', remember);
      child.on('move', remember);
    }
  });

  // Offline at launch (or a DNS blip): say so, instead of leaving an empty window, and reconnect
  // by itself. A quiet probe (not a page load) decides when WhatsApp is reachable again, so the
  // message does not flicker on every attempt.
  let loadRetries = 0, probeTimer = null, offline = false;
  const probe = () => {
    clearTimeout(probeTimer);
    probeTimer = setTimeout(async () => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      let reachable = false;
      try { reachable = (await net.fetch(WHATSAPP_URL, { method: 'HEAD' })).status < 500; } catch (e) { /* still offline */ }
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (reachable) { offline = false; mainWindow.loadURL(WHATSAPP_URL); } else probe();
    }, Math.min(3000 * 1.6 ** loadRetries++, 30000));
  };
  mainWindow.webContents.once('did-finish-load', () => { if (!offline) setTimeout(askWhatsAppLanguage, 4000); });
  mainWindow.webContents.on('did-finish-load', () => {
    if (!offline) loadRetries = 0;
    if (offline) {
      const css = themeCss();
      if (css) mainWindow.webContents.insertCSS(css).catch(() => {});
      mainWindow.webContents.executeJavaScript(
        "(() => { const m = document.getElementById('mark'); if (m) m.style.backgroundImage = 'url(' + " + JSON.stringify(ICON_URI) + " + ')'; })()").catch(() => {});
    }
  });
  mainWindow.webContents.on('console-message', (_e, level, message, _line, source) => {
    if (level >= 2 && !/^https?:\/\/web\.whatsapp\.com.*(chat|message)/i.test(source || '')) diag(level === 3 ? 'error' : 'warn', message.replace(/\d{6,}/g, '#'));
  });
  mainWindow.webContents.on('render-process-gone', (_e, d) => diag('crash', d && d.reason));
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, _url, isMain) => {
    if (!isMain || code === -3) return;                // -3: a navigation that was replaced by another
    offline = true;
    mainWindow.loadFile(path.join(__dirname, 'offline.html'), { query: { c: String(desc || code) } });
    probe();
  });
  mainWindow.on('closed', () => clearTimeout(probeTimer));

  // The mouse's side buttons (and a keyboard's "browser back" key) arrive as Windows app commands.
  // WhatsApp is a single page, so the page decides what "back" means (src/page/nav.js).
  mainWindow.on('app-command', (_e, cmd) => {
    if (cmd === 'browser-backward' && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('relay:event', 'nav', 'back');
  });

  mainWindow.webContents.on('context-menu', (_e, params) =>
    setTimeout(() => { if (mainWindow && !mainWindow.isDestroyed()) showContextMenu(ses, params); }, 40));

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

  // At most one message per 120 ms while a window edge is being dragged; the last one always goes out.
  let refreshTimer = null;
  function triggerLayoutRefresh() {
    if (refreshTimer) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('window-resized');
    }, 120);
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

  mainWindow.on('unresponsive', async () => {
    if (process.env.RELAY_TEST) return;
    const { response } = await showBox(mainWindow, {
      type: 'warning', message: 'Relay is not responding.', buttons: ['Wait', 'Restart the page'], defaultId: 0, cancelId: 0
    });
    if (response === 1 && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.forcefullyCrashRenderer();   // render-process-gone reloads it
  });
  mainWindow.on('focus', applyDnd);
  mainWindow.on('blur', applyDnd);
  mainWindow.webContents.on('did-finish-load', applyDnd);
  mainWindow.webContents.on('did-start-navigation', (_e, _url, inPlace, isMainFrame) => { if (isMainFrame && !inPlace && callActive) endCallState(); });
  mainWindow.webContents.on('render-process-gone', () => endCallState());
  mainWindow.on('closed', () => { mainWindow = null; });
}

/**
 * Ask which screen or window to share (src/picker.html), then hand it to
 * getDisplayMedia. Relay's own windows are not offered, and while a whole screen
 * is shared they are excluded from the capture, so the call never mirrors itself.
 */
async function pickDisplaySource(request, callback) {
  if (!isWhatsAppWebUrl(request.securityOrigin) || !mainWindow) return callback({});
  let sources;
  try {
    sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 320, height: 180 },
      fetchWindowIcons: true
    });
  } catch (err) {
    console.error('Screen share: could not list sources', err);
    return callback({});
  }
  const own = new Set(BrowserWindow.getAllWindows().map((w) => w.getMediaSourceId()));
  sources = sources.filter((s) => !own.has(s.id));
  if (!sources.length) return callback({});
  const byId = new Map(sources.map((s) => [s.id, s]));

  // The window that asked (the call may be in the pop-out). A modal picker over a hidden or
  // minimised window would be invisible, so then it stands on its own.
  const askedBy = request.frame && webContents.fromFrame(request.frame);
  const parent = (askedBy && BrowserWindow.fromWebContents(askedBy)) || mainWindow;
  const attach = Boolean(parent) && parent.isVisible() && !parent.isMinimized();
  const win = new BrowserWindow({
    width: 800, height: 580, minWidth: 560, minHeight: 420,
    parent: attach ? parent : undefined, modal: attach, minimizable: false, maximizable: false,
    show: !process.env.RELAY_TEST,              // (automated tests drive it without showing it)
    autoHideMenuBar: true, backgroundColor: '#111921', title: 'Share your screen', icon: WINDOW_ICON,
    webPreferences: {
      preload: path.join(__dirname, 'picker-preload.js'),
      sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false
    }
  });
  win.setMenu(null);
  brandWindow(win);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (ev) => ev.preventDefault());

  let done = false;
  const finish = (result) => {
    if (done) return;
    done = true;
    ipcMain.removeListener('picker:done', onDone);
    if (!win.isDestroyed()) win.close();
    callback(result);
  };
  const onDone = (ev, choice) => {
    if (ev.sender !== win.webContents) return;
    const s = choice && byId.get(choice.id);
    if (!s) return finish({});
    const isScreen = s.id.startsWith('screen:');
    if (isScreen) holdShareProtection();
    // System audio can only be captured along with a whole screen.
    finish({ video: s, ...(isScreen && choice.audio && request.audioRequested ? { audio: 'loopback' } : {}) });
  };
  ipcMain.on('picker:done', onDone);
  win.on('closed', () => finish({}));

  win.webContents.once('did-finish-load', () => {
    const css = themeCss();
    if (css) win.webContents.insertCSS(css).catch(() => {});
    win.webContents.send('picker:data', {
      audio: Boolean(request.audioRequested),
      sources: sources.map((s) => ({
        id: s.id,
        kind: s.id.startsWith('screen:') ? 'screen' : 'window',
        name: s.name,
        thumb: s.thumbnail.isEmpty() ? '' : s.thumbnail.toDataURL(),
        icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.resize({ width: 16, height: 16 }).toDataURL() : ''
      }))
    });
  });
  win.loadFile(path.join(__dirname, 'picker.html'));
}

// While a whole screen is shared, Relay's windows are left out of the capture
// (Windows: WDA_EXCLUDEFROMCAPTURE). Released when the share ends.
let shareProtect = { on: false, since: 0, seen: false };
function setShareProtection(on) {
  shareProtect.on = on;
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.setContentProtection(on);
}
function holdShareProtection() {
  const mine = shareProtect = { on: true, since: Date.now(), seen: false };
  setShareProtection(true);
  // If WhatsApp never reports a running share (it was refused, or the call ended
  // first), do not leave the windows hidden from screenshots.
  setTimeout(() => { if (shareProtect === mine && !mine.seen) setShareProtection(false); }, 12000);
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
const ctxHint = { kind: '', count: 0, at: 0 };
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

  // "Translate" for a message (or for the messages ticked in select mode): the page said what the click was on just before
  if (ctxHint.kind && Date.now() - ctxHint.at < 1500) {
    items.push({
      label: ctxHint.kind === 'many' ? 'Translate ' + ctxHint.count + ' messages' : 'Translate this message',
      click: () => wc.send('relay:event', 'translate-now', null)
    });
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
  return {
    video: store.get('enhanceCamera'),
    audio: store.get('enhanceMic'),
    autoRecord: store.get('autoRecord'),
    noise: store.get('noiseSuppression')
  };
}

/** Push the call-quality toggles into the page; they apply to the next call. */
function pushMediaPrefs() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents
    .executeJavaScript('window.__waMedia = ' + JSON.stringify(mediaPrefs()))
    .catch(() => {});
}

/** Turning automatic recording on needs the same consent as the first manual one. */
function onAutoRecordToggled() {
  if (!store.get('autoRecord')) return pushMediaPrefs();
  confirmRecording(false).then((ok) => {
    if (!ok) { store.set('autoRecord', false); refreshTrayMenu(); }
    pushMediaPrefs();
  });
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
        showBox({
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
      checked: app.getLoginItemSettings(loginItem(false)).openAtLogin,
      click: (i) => app.setLoginItemSettings(loginItem(i.checked))
    },
    { type: 'separator' },
    toggle('Hardware acceleration', 'hardwareAcceleration', true),
    toggle('Low power when hidden', 'lowPower', true),
    toggle('Block telemetry', 'blockTelemetry', true),
    toggle('Do not disturb', 'dnd', false, applyDnd),
    toggle('Enhance camera in calls', 'enhanceCamera', false, pushMediaPrefs),
    toggle('Enhance microphone in calls', 'enhanceMic', false, pushMediaPrefs),
    toggle('Noise suppression in calls', 'noiseSuppression', false, pushMediaPrefs),
    toggle('Record calls automatically', 'autoRecord', false, onAutoRecordToggled),
    { label: 'Open recordings folder', click: openRecordingsDir },
    { label: 'Recordings folder...', click: chooseRecordingsDir },
    toggle('Enable calling', 'webCalling', true),
    toggle('Start call engine on demand (saves RAM)', 'lazyCallEngine', true),
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
  if (hub) hub.push();
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
    .replaceAll('{{FONT}}', FONT_B64)
    .replaceAll('{{VERSION}}', app.getVersion())
    .replaceAll('{{ELECTRON}}', process.versions.electron)
    .replaceAll('{{CHROMIUM}}', process.versions.chrome)
    .replaceAll('{{NODE}}', process.versions.node);

  aboutWindow = new BrowserWindow({
    width: 660,
    height: 760,
    minWidth: 420,
    minHeight: 360,
    parent: visibleOwner(mainWindow),
    autoHideMenuBar: true,
    backgroundColor: '#0e1621',
    title: 'About Relay',
    icon: WINDOW_ICON,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      partition: 'relay-about',     // in memory, separate from the WhatsApp session
      spellcheck: false
    }
  });
  aboutWindow.setMenu(null);
  brandWindow(aboutWindow);
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
  const { response } = await showBox({
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

  showBox({
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

on('unread-count', async (_e, count) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const n = Math.max(0, Math.floor(Number(count) || 0));
  const icon = n > 0 ? await badgeIcon(n) : null;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.setOverlayIcon(icon, n > 0 ? n + ' unread' : '');
  if (tray) tray.setToolTip(n > 0 ? 'Relay — ' + n + ' unread' : 'Relay');
});

// The page's theme palette, kept so Relay's own small windows (screen picker, key prompt) match it.
let themePalette = null;
on('theme-palette', (_e, p) => {
  if (!p || typeof p !== 'object') return;
  const hex = /^#[0-9a-f]{6}$/i;
  const clean = {};
  for (const k of ['accent', 'soft', 'strong', 'onAccent', 'r0', 'r1', 'r2', 'r3']) if (hex.test(p[k])) clean[k] = p[k];
  if (/^\d+, \d+, \d+$/.test(p.rgb)) clean.rgb = p.rgb;
  themePalette = clean;
});
/** CSS that gives one of Relay's own windows the current theme colours. */
function themeCss() {
  const p = themePalette;
  if (!p || !p.accent) return '';
  return ':root{--relay-accent:' + p.accent + ';--relay-accent-rgb:' + p.rgb + ';--relay-accent-soft:' + p.soft +
    ';--relay-accent-strong:' + p.strong + ';--relay-on-accent:' + (p.onAccent || '#ffffff') + ';--relay-0:' + p.r0 + ';--relay-1:' + p.r1 + ';--relay-2:' + p.r2 + ';--relay-3:' + p.r3 + '}';
}

on('activate-window', () => showWindow());

on('flash-window', () => {
  if (mainWindow && !mainWindow.isFocused() && !store.get('dnd')) {
    mainWindow.flashFrame(true);
  }
});

// ---------------------------------------------------------------------------
// Files copied in Windows Explorer (Ctrl+C) and pasted into a chat (Ctrl+V).
// Electron 44's clipboard is the web-style one (read / write / readText ...): it cannot list files, and
// the page's own paste event carries none from Explorer. So Windows is asked directly - in UTF-8, or
// Russian and Chinese file names come back as question marks - and the preload hands the result to
// WhatsApp as an ordinary paste of File objects (src/preload.js, hookClipboardFiles).
// ---------------------------------------------------------------------------
const MIME_BY_EXT = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp',
  '.bmp': 'image/bmp', '.heic': 'image/heic', '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo', '.webm': 'video/webm', '.3gp': 'video/3gpp',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
  '.pdf': 'application/pdf', '.zip': 'application/zip', '.rar': 'application/vnd.rar', '.7z': 'application/x-7z-compressed',
  '.txt': 'text/plain', '.csv': 'text/csv', '.json': 'application/json', '.md': 'text/markdown',
  '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.apk': 'application/vnd.android.package-archive'
};
const PASTE_FILE_MAX = 100 * 1024 * 1024;          // one file; bigger ones go through the attach button
const PASTE_TOTAL_MAX = 200 * 1024 * 1024;         // everything in one paste (it travels through IPC)
let pasteReading = false;

handle('clipboard:get-files', () => {
  if (process.platform !== 'win32' || pasteReading) return { files: [], skipped: 0 };
  pasteReading = true;
  return new Promise((resolve) => {
    const script = '[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);(Get-Clipboard -Format FileDropList).FullName';
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', script],
      { windowsHide: true, timeout: 6000, maxBuffer: 1024 * 1024, encoding: 'utf8' }, async (err, stdout) => {
        try {
          if (err || !stdout) return resolve({ files: [], skipped: 0 });
          const paths = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 30);
          const files = [];
          let total = 0, skipped = 0;
          for (const p of paths) {
            try {
              const st = await fs.promises.stat(p);
              if (!st.isFile()) continue;
              if (st.size > PASTE_FILE_MAX || total + st.size > PASTE_TOTAL_MAX) { skipped++; continue; }
              total += st.size;
              files.push({ name: path.basename(p), type: MIME_BY_EXT[path.extname(p).toLowerCase()] || 'application/octet-stream', lastModified: st.mtimeMs, buffer: await fs.promises.readFile(p) });
            } catch (e) { /* gone, or no permission: skip it */ }
          }
          resolve({ files, skipped });
        } finally { pasteReading = false; }
      });
  });
});

handle('pane-width:get', () => store.get('paneWidth'));
handle('privacyBlur:get', () => store.get('privacyBlur'));
handle('media:prefs', () => mediaPrefs());

// ---------------------------------------------------------------------------
// Call recordings. The page records (src/preload.js, hookCallRecording) and
// streams the file here in chunks, so it is on disk as it is made and a crash
// loses seconds, not the whole call.
// ---------------------------------------------------------------------------
const openRecordings = new Map();   // id -> { out: WriteStream, file }
let recordingSeq = 0;

function recordingsDir() {
  const chosen = store.get('recordingsDir');
  return (typeof chosen === 'string' && chosen) || path.join(app.getPath('videos'), 'WA');
}

/** One-time notice: recording laws differ and some need everyone's consent. */
async function confirmRecording(auto) {
  if (store.get('recordingConsentAck')) return true;
  if (auto) return false;            // automatic recording only after an explicit yes
  const { response, checkboxChecked } = await showBox(mainWindow, {
    type: 'warning',
    title: 'Record calls',
    message: 'Recording a call may need everyone\'s permission.',
    detail: 'Laws about recording calls differ by country, and many require every person on the ' +
      'call to agree. Only record if the other person knows and has agreed.\n\n' +
      'Recordings are saved on this PC, in:\n' + recordingsDir(),
    buttons: ['Record', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    checkboxLabel: 'I understand, don\'t show this again'
  });
  if (response !== 0) return false;
  if (checkboxChecked) store.set('recordingConsentAck', true);
  return true;
}

handle('recording:open', async (_e, opts) => {
  const ext = ['mp4', 'm4a', 'webm'].includes(opts && opts.ext) ? opts.ext : 'webm';
  if (!(await confirmRecording(Boolean(opts && opts.auto)))) return { ok: false };
  try {
    const dir = recordingsDir();
    await fs.promises.mkdir(dir, { recursive: true });
    const now = new Date();                      // local time, not UTC
    const p2 = (n) => String(n).padStart(2, '0');
    const stamp = now.getFullYear() + '-' + p2(now.getMonth() + 1) + '-' + p2(now.getDate()) + ' ' +
      p2(now.getHours()) + '-' + p2(now.getMinutes()) + '-' + p2(now.getSeconds());
    const base = path.join(dir, (opts && opts.video ? 'Video call ' : 'Voice call ') + stamp);
    let file = base + '.' + ext;
    for (let n = 2; fs.existsSync(file) && n < 100; n++) file = base + ' (' + n + ').' + ext;   // never overwrite or lose a second recording
    const id = ++recordingSeq;
    const out = fs.createWriteStream(file, { flags: 'wx' });
    out.on('error', (err) => {
      console.error('Recording write failed:', err.message);
      if (openRecordings.delete(id)) {
        toast('Call recording stopped', 'Could not write to the recordings folder (' + err.code + ').');
      }
    });
    openRecordings.set(id, { out, file });
    return { ok: true, id };
  } catch (err) {
    console.error('Could not start recording:', err.message);
    toast('Recording could not start', 'The recordings folder is not writable (' + (err.code || 'error') + '). Pick another in the tray menu.');
    return { ok: false };
  }
});

on('recording:chunk', (_e, id, buf) => {
  const r = openRecordings.get(id);
  if (r && buf) r.out.write(Buffer.from(buf));
});

function finishRecording(id) {
  const r = openRecordings.get(id);
  if (!r) return Promise.resolve();
  openRecordings.delete(id);
  return new Promise((resolve) => r.out.end(() => {
    try {
      // A recording that never got any data (the call ended at once) is not worth keeping.
      if (fs.statSync(r.file).size === 0) { fs.unlinkSync(r.file); return resolve(); }
    } catch (e) { /* fall through to the notice */ }
    toast('Call recording saved', path.basename(r.file), () => shell.showItemInFolder(r.file));
    resolve();
  }));
}
on('recording:close', (_e, id) => finishRecording(id));

/** Quit path: ask the page to stop recording and give the files a moment to close. */
let flushingRecordings = false;
app.on('before-quit', (e) => {
  if (flushingRecordings || openRecordings.size === 0 || !mainWindow || mainWindow.isDestroyed()) return;
  e.preventDefault();
  flushingRecordings = true;
  mainWindow.webContents.send('recording:flush');
  const started = Date.now();
  const timer = setInterval(() => {
    if (openRecordings.size === 0 || Date.now() - started > 4000) {
      clearInterval(timer);
      app.quit();
    }
  }, 150);
});

function chooseRecordingsDir() {
  const options = {
    title: 'Where should call recordings be saved?',
    defaultPath: recordingsDir(),
    properties: ['openDirectory', 'createDirectory']
  };
  (visibleOwner(mainWindow) ? dialog.showOpenDialog(mainWindow, options) : dialog.showOpenDialog(options)).then(({ canceled, filePaths }) => {
    if (!canceled && filePaths[0]) store.set('recordingsDir', filePaths[0]);
  });
}

function openRecordingsDir() {
  const dir = recordingsDir();
  fs.promises.mkdir(dir, { recursive: true }).then(() => shell.openPath(dir));
}

// Keep the screen awake while a call window is open.
let callBlocker = null;
let callActive = false;
/** The call window is gone (it ended, or the page reloaded or crashed under it): let the screen sleep again. */
function endCallState() {
  callActive = false;
  if (callBlocker !== null) { powerSaveBlocker.stop(callBlocker); callBlocker = null; }
  if (shareProtect.on) setShareProtection(false);
  applyDnd();
}
on('call-state', (_e, active) => {
  callActive = Boolean(active);
  applyDnd();
  if (!active && shareProtect.on) setShareProtection(false);
  if (active && callBlocker === null) callBlocker = powerSaveBlocker.start('prevent-display-sleep');
  else if (!active && callBlocker !== null) { powerSaveBlocker.stop(callBlocker); callBlocker = null; }
});

on('share-state', (_e, sharing) => {
  if (!shareProtect.on) return;
  if (sharing) shareProtect.seen = true;
  else if (shareProtect.seen || Date.now() - shareProtect.since > 10000) setShareProtection(false);
});

// Read synchronously by the preload before WhatsApp boots (see enableWebCalling).
ipcMain.on('features:get', (e) => {
  const ok = fromWhatsApp(e);
  e.returnValue = {
    calling: ok && Boolean(store.get('webCalling')),
    lazyEngine: ok && Boolean(store.get('lazyCallEngine')),
    icon: ok ? ICON_URI : ''
  };
});

// ---------------------------------------------------------------------------
// Relay panel (src/hub.js, page side src/page/*.js)
// ---------------------------------------------------------------------------
// The title typeface (Newsreader, SIL OFL; src/assets/fonts), loaded into the page by the preload.
let FONT_B64 = '';
try { FONT_B64 = fs.readFileSync(path.join(__dirname, 'assets', 'fonts', 'newsreader-500.woff2')).toString('base64'); } catch (e) { /* the title falls back to Georgia */ }
ipcMain.on('font:get', (e) => { e.returnValue = fromWhatsApp(e) ? FONT_B64 : ''; });

// Page-side modules, delivered to the preload as one string and run in the page.
/** The language Windows is set to ('zh', 'ru', 'en' ...), even when WhatsApp itself is pinned to English. */
function osLanguage() {
  if (process.env.RELAY_TEST && process.env.RELAY_TEST_OSLANG) return process.env.RELAY_TEST_OSLANG;      // tests only
  try { return String((app.getPreferredSystemLanguages()[0] || app.getLocale() || 'en')).slice(0, 2).toLowerCase(); } catch (e) { return 'en'; }
}
const PAGE_MODULES = ['i18n', 'core', 'translate', 'hub', 'calls', 'captions', 'transcribe', 'voice', 'nav', 'video', 'scroll'];
ipcMain.on('page:src', (e) => {
  if (process.env.RELAY_TEST && process.env.RELAY_TEST_NO_MODULES) { e.returnValue = ''; return; }      // tests only: "is it Relay or is it WhatsApp?"
  e.returnValue = fromWhatsApp(e)
    ? 'window.__relayLang = ' + JSON.stringify(osLanguage()) + ';\n;\n' +
      PAGE_MODULES.map((n) => fs.readFileSync(path.join(__dirname, 'page', n + '.js'), 'utf8')).join('\n;\n')
    : '';
});

/**
 * Do not disturb: toasts are dropped in the page (src/preload.js), the taskbar no
 * longer flashes, and Relay's sound is muted while the window is in the background
 * and no call is running. Unread counts and the badge still update.
 */
function applyDnd() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const quiet = Boolean(store.get('dnd')) && !callActive && !mainWindow.isFocused();
  mainWindow.webContents.setAudioMuted(quiet);
  if (tray) tray.setToolTip(store.get('dnd') ? 'Relay - do not disturb' : 'Relay');
}

/** A small window for the API key: it is typed here, never into WhatsApp's page. */
function promptForKey(provider) {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 440, height: 262, resizable: false, minimizable: false, maximizable: false,
      parent: visibleOwner(mainWindow), modal: Boolean(visibleOwner(mainWindow)),
      show: !process.env.RELAY_TEST,
      autoHideMenuBar: true, backgroundColor: '#111921', title: 'Relay', icon: WINDOW_ICON,
      webPreferences: {
        preload: path.join(__dirname, 'prompt-preload.js'),
        sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false
      }
    });
    win.setMenu(null);
    brandWindow(win);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (ev) => ev.preventDefault());
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      ipcMain.removeListener('prompt:done', onDone);
      if (!win.isDestroyed()) win.close();
      resolve(value);
    };
    const onDone = (ev, value) => { if (ev.sender === win.webContents) finish(String(value || '')); };
    ipcMain.on('prompt:done', onDone);
    win.on('closed', () => finish(''));
    win.webContents.once('did-finish-load', () => {
      const css = themeCss();
      if (css) win.webContents.insertCSS(css).catch(() => {});
    });
    win.loadFile(path.join(__dirname, 'prompt.html'), { query: { p: String(provider || '') } });
  });
}

// Where WhatsApp needs a VPN or proxy: Relay follows the Windows proxy settings, or the address typed in the Relay panel.
// Both the page's session and the one Relay's own requests (model download, translation) use are pointed at it.
async function applyProxy() {
  const rules = cleanProxy(store.get('proxy'));
  const config = rules ? { mode: 'fixed_servers', proxyRules: rules, proxyBypassRules: '<local>' } : { mode: 'system' };
  await Promise.all([session.defaultSession, session.fromPartition(currentPartition)].map((s) => s.setProxy(config).catch(() => {})));
}

function relaunchRelay() {
  isQuitting = true;
  app.relaunch();
  app.quit();
}

// On a PC that is not set to English, WhatsApp labels its buttons in that language and Relay's call extras cannot find them.
// Asked once, in the user's own language; changeable any time in the Relay panel.
const WA_LANG_TEXT = {
  en: ['WhatsApp language', 'Use English for WhatsApp?', 'The extras Relay adds to calls (captions, recording, keyboard shortcuts, sharper video, back button) work with WhatsApp in English. You can change this any time in the Relay panel.', ['Use English', 'Keep my language']],
  zh: ['WhatsApp 语言', '将 WhatsApp 设为英文？', 'Relay 在通话中的附加功能（字幕、录音、键盘快捷键、返回键）需要 WhatsApp 使用英文界面。您可以随时在 Relay 面板中更改。', ['使用英文', '保持我的语言']],
  ru: ['Язык WhatsApp', 'Использовать английский в WhatsApp?', 'Дополнительные функции Relay во время звонков (субтитры, запись, горячие клавиши, кнопка «назад») работают, когда WhatsApp на английском. Это можно изменить в любой момент в панели Relay.', ['Английский', 'Оставить мой язык']]
};
async function askWhatsAppLanguage() {
  if (process.env.RELAY_TEST || store.get('waLang') || !mainWindow || mainWindow.isDestroyed()) return;
  const code = String(app.getLocale() || 'en').slice(0, 2).toLowerCase();
  if (code === 'en') { store.set('waLang', 'auto'); return; }
  const t = WA_LANG_TEXT[code] || WA_LANG_TEXT.en;
  const { response } = await showBox(mainWindow, { type: 'question', title: t[0], message: t[1], detail: t[2], buttons: t[3], defaultId: 0, cancelId: 1 });
  store.set('waLang', response === 0 ? 'en' : 'auto');
  if (response === 0) relaunchRelay();
}

// "Save diagnostics": what went wrong lately, without any chat text, for when something does not work on a PC I cannot see.
const diagLog = [];                                          // recent page errors and failed loads (newest last)
function diag(kind, text) { diagLog.push(new Date().toISOString().slice(11, 19) + ' ' + kind + ' ' + String(text).slice(0, 300)); if (diagLog.length > 200) diagLog.shift(); }
async function saveDiagnostics() {
  const lines = [
    'Relay ' + app.getVersion() + ' | Electron ' + process.versions.electron + ' | Chromium ' + process.versions.chrome,
    'Windows ' + require('os').release() + ' | locale ' + app.getLocale() + ' | packaged ' + app.isPackaged,
    'proxy ' + (store.get('proxy') ? 'custom' : 'system') + ' | waLang ' + (store.get('waLang') || '-') + ' | GPU acceleration ' + store.get('hardwareAcceleration'),
    '', 'Recent problems (no message text is recorded):', ...(diagLog.length ? diagLog : ['(none)'])
  ];
  const file = path.join(app.getPath('documents'), 'Relay-diagnostics.txt');
  await fs.promises.writeFile(file, lines.join(String.fromCharCode(13, 10)), 'utf8');
  if (!process.env.RELAY_TEST) shell.showItemInFolder(file);
  return file;
}

let captions = null;
let voice = null;
hub = setupHub({
  relaunch: relaunchRelay,
  applyProxy,
  store, safeStorage, net, handle,
  send: (channel, data) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, data);
  },
  showBox: (opts) => showBox(mainWindow, opts),
  promptKey: promptForKey,
  extraState: () => ({ ...(captions ? { captions: captions.state() } : {}), ...(voice ? { voice: voice.state() } : {}) }),
  afterChange: (name) => {
    if (name === 'dnd') applyDnd();
    if (name === 'autoRecord') onAutoRecordToggled();
    else if (name === 'camera' || name === 'mic' || name === 'noise') pushMediaPrefs();
    refreshTrayMenu();
  }
});

// Live call captions: speech-to-text on this PC (src/captions.js), shown by src/page/captions.js.
captions = setupCaptions({
  app, store, net, handle, utilityProcess,
  showBox: (opts) => showBox(mainWindow, opts),
  event: (channel, data) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('relay:event', channel, data);
  },
  pushState: () => hub.push(),
  isOnBattery: () => { try { return powerMonitor.isOnBatteryPower(); } catch (e) { return false; } }
});
app.on('will-quit', () => captions.shutdown());

// Live voice translation (src/voice.js): speech to text (above), translation, a copy of the speaker's voice, played back by the page.
voice = setupVoice({
  app, store, handle, utilityProcess, fetch: net.fetch.bind(net),
  showBox: (opts) => showBox(mainWindow, opts),
  event: (channel, data) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('relay:event', channel, data);
  },
  pushState: () => hub.push(),
  transcribe: (pcm, language) => captions.transcribe(pcm, language),
  speechReady: () => captions.modelReady(),
  downloadSpeech: (onProgress) => captions.downloadSpeechModel(onProgress)
});
app.on('will-quit', () => voice.shutdown());

// Transcript of a call recording (page side: src/page/transcribe.js): the page decodes the file's sound and sends it in pieces;
// each piece becomes text here with the same speech model captions use. Nothing leaves the PC.
const TRANSCRIBE_MAX = 800 * 1024 * 1024;
handle('relay:transcribe-pick', async () => {
  const options = {
    title: 'Choose a recording to transcribe', defaultPath: recordingsDir(), properties: ['openFile'],
    filters: [{ name: 'Audio or video', extensions: ['mp4', 'webm', 'm4a', 'mp3', 'wav', 'ogg', 'opus', 'mkv', 'mov'] }]
  };
  const r = await (visibleOwner(mainWindow) ? dialog.showOpenDialog(mainWindow, options) : dialog.showOpenDialog(options));
  if (r.canceled || !r.filePaths[0]) return null;
  const file = r.filePaths[0];
  const st = await fs.promises.stat(file);
  if (st.size > TRANSCRIBE_MAX) throw new Error('That recording is too large to transcribe (limit 800 MB)');
  if (!captions.modelReady()) {
    await captions.downloadSpeechModel((pct) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('relay:event', 'transcribe-status', { phase: 'download', pct });
    });
  }
  return { name: path.basename(file), data: await fs.promises.readFile(file) };
});
handle('relay:transcribe-clip', async (_e, data, language) => {
  const buf = Buffer.isBuffer(data) ? data : ArrayBuffer.isView(data) ? Buffer.from(data.buffer, data.byteOffset, data.byteLength) : data instanceof ArrayBuffer ? Buffer.from(data) : null;
  if (!buf || buf.length < 3200 || buf.length > 16000 * 2 * 30 || buf.length % 2) throw new Error('Bad audio');
  const r = await captions.transcribe(buf, typeof language === 'string' ? language : 'auto');
  return { text: r.text, language: r.language };
});
handle('relay:transcribe-save', async (_e, name, txt, srt) => {
  if (typeof txt !== 'string' || typeof srt !== 'string' || txt.length > 20e6) throw new Error('Bad transcript');
  const base = String(name || 'recording').replace(/[\\/:*?"<>|]+/g, '_').replace(/\.[A-Za-z0-9]{1,5}$/, '');
  const options = {
    title: 'Save the transcript', defaultPath: path.join(recordingsDir(), base + '-transcript.txt'),
    filters: [{ name: 'Text', extensions: ['txt'] }]
  };
  const r = await (visibleOwner(mainWindow) ? dialog.showSaveDialog(mainWindow, options) : dialog.showSaveDialog(options));
  if (r.canceled || !r.filePath) return null;
  await fs.promises.writeFile(r.filePath, '﻿' + txt, 'utf8');
  await fs.promises.writeFile(r.filePath.replace(/\.txt$/i, '') + '.srt', '﻿' + srt, 'utf8');
  if (!process.env.RELAY_TEST) shell.showItemInFolder(r.filePath);
  return path.basename(r.filePath);
});

// The page says what a right-click landed on (a message, or ticked messages) so the menu can offer "Translate".
handle('relay:context-hint', (_e, kind, count) => {
  ctxHint.kind = kind === 'one' || kind === 'many' ? kind : '';
  ctxHint.count = Math.max(0, Math.min(500, Number(count) || 0));
  ctxHint.at = Date.now();
  return true;
});


// RNNoise: the worklet source and the WebAssembly build (SIMD where the CPU has it).
let rnnoiseAssets = null;
handle('relay:rnnoise', () => {
  if (!rnnoiseAssets) {
    const dir = path.join(__dirname, 'vendor', 'rnnoise');
    // The same feature probe the library uses: a tiny module that needs SIMD.
    const simd = WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]));
    rnnoiseAssets = {
      worklet: fs.readFileSync(path.join(dir, 'worklet.js'), 'utf8'),
      wasm: fs.readFileSync(path.join(dir, simd ? 'rnnoise_simd.wasm' : 'rnnoise.wasm'))
    };
  }
  return rnnoiseAssets;
});

handle('relay:action', (_e, name) => {
  if (name === 'open-recordings') return openRecordingsDir();
  if (name === 'choose-recordings') return chooseRecordingsDir();
  if (name === 'about') return showAbout();
  if (name === 'diagnostics') return saveDiagnostics();
  if (name === 'get-openrouter-key') return openExternalSafe('https://openrouter.ai/keys');
  if (name === 'press-escape') {                                   // "back" from a mouse side button: a real Escape key press, which WhatsApp treats as its own shortcut
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const wc = mainWindow.webContents;
    if (!wc.isFocused()) wc.focus();                                // a key press goes to the focused page
    for (const type of ['keyDown', 'keyUp']) wc.sendInputEvent({ type, keyCode: 'Escape' });
    return;
  }
  throw new Error('Unknown action');
});
handle('system:accent-color', () => getSystemAccent());
on('pane-width:set', (_e, px) => store.set('paneWidth', Math.max(0, Math.min(4000, Number(px) || 0))));

// The taskbar badge. Windows cannot make an image from SVG (it comes out empty), so the digit is
// drawn on a canvas in the page and handed back as a PNG. One image per count and colour is kept.
const badgeCache = new Map();
async function badgeIcon(n) {
  const text = n > 99 ? '99+' : String(n);
  const fill = (themePalette && themePalette.strong) || '#5288c1';             // the theme colour
  const key = text + fill;
  if (badgeCache.has(key)) return badgeCache.get(key);
  try {
    const size = text.length > 2 ? 15 : 20;
    const url = await mainWindow.webContents.executeJavaScript(`(() => {
      const c = document.createElement('canvas'); c.width = c.height = 32;
      const x = c.getContext('2d');
      x.fillStyle = ${JSON.stringify(fill)}; x.beginPath(); x.arc(16, 16, 16, 0, Math.PI * 2); x.fill();
      x.fillStyle = '#ffffff'; x.font = '700 ${size}px "Segoe UI", sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
      x.fillText(${JSON.stringify(text)}, 16, 17);
      return c.toDataURL('image/png'); })()`);
    const img = nativeImage.createFromDataURL(url);
    if (process.env.RELAY_TEST) console.log('[badge]', text, img.isEmpty() ? 'EMPTY' : 'ok ' + img.getSize().width + 'x' + img.getSize().height);
    if (img.isEmpty()) return null;
    if (badgeCache.size > 120) badgeCache.clear();
    badgeCache.set(key, img);
    return img;
  } catch (err) {
    return null;
  }
}

// ---------------------------------------------------------------------------
app.whenReady().then(async () => {
  if (!gotLock) return;                 // another Relay owns this profile; this copy is on its way out
  await applyProxy();
  createWindow();
  if (!process.env.RELAY_TEST) {
    createTray();
  } else {
    // Tests never put an icon in the user's tray, but still build the tray menu so a broken item shows up.
    tray = { setContextMenu: (menu) => console.log('[tray] menu built,', menu.items.length, 'items'), setToolTip() {}, on() {}, destroy() {} };
    refreshTrayMenu();
  }
  createMenu();
  
  if (process.platform === 'win32') {
    app.setUserTasks([
      {
        program: process.execPath,
        arguments: (app.isPackaged ? '' : '"' + app.getAppPath() + '" ') + '--profile=Work',
        iconPath: app.isPackaged ? process.execPath : asset('icon.ico'),
        iconIndex: 0,
        title: 'Relay - Work',
        description: 'Open Work Account'
      },
      {
        program: process.execPath,
        arguments: (app.isPackaged ? '' : '"' + app.getAppPath() + '" ') + '--profile=Personal',
        iconPath: app.isPackaged ? process.execPath : asset('icon.ico'),
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

  if (!process.env.RELAY_TEST) globalShortcut.register('CommandOrControl+Shift+W', toggleWindow);

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
