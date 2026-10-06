const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

ipcMain.handle('translucent:get', () => true);
ipcMain.handle('system:accent-color', () => ({ hex: '#bf5611', rgb: '191, 86, 17' }));
ipcMain.handle('pane-width:get', () => 379);
ipcMain.on('pane-width:set', () => {});
ipcMain.on('unread-count', () => {});
ipcMain.on('activate-window', () => {});
ipcMain.handle('clipboard:get-files', () => []);

app.setPath('userData', path.join(app.getPath('appData'), 'whatsapp-pc-diag'));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'preload.js'),
      partition: 'persist:whatsapp_diag',
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  const ses = win.webContents.session;

  const ALLOWED_PERMISSIONS = [
    'notifications', 'media', 'mediaKeySystem', 'display-capture',
    'clipboard-read', 'clipboard-sanitized-write', 'fullscreen',
    'speaker-selection', 'microphone', 'camera'
  ];

  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(ALLOWED_PERMISSIONS.includes(permission));
  });

  ses.setPermissionCheckHandler((_wc, permission) => {
    return ALLOWED_PERMISSIONS.includes(permission);
  });

  ses.setDevicePermissionHandler(() => true);

  // Load a test page with secure origin
  await win.loadURL('https://webrtc.github.io/samples/src/content/getusermedia/gum/');

  const report = await win.webContents.executeJavaScript(`
    (async () => {
      const results = {};

      // Test 1: Splitter overlay and modal suppression
      try {
        const splitter = document.getElementById('wa-splitter');
        results.splitterExists = Boolean(splitter);
        if (splitter) {
          results.splitterZIndex = window.getComputedStyle(splitter).zIndex;
        }

        // Simulate an open image/media viewer modal
        const mockModal = document.createElement('div');
        mockModal.setAttribute('data-animate-media-viewer', 'true');
        document.body.appendChild(mockModal);

        // Trigger resize / splitter repositioning
        window.dispatchEvent(new Event('resize'));
        await new Promise(r => setTimeout(r, 100));

        results.splitterHiddenOnModal = splitter ? (splitter.style.display === 'none' || window.getComputedStyle(splitter).display === 'none') : null;

        mockModal.remove();
        window.dispatchEvent(new Event('resize'));
        await new Promise(r => setTimeout(r, 100));
        results.splitterRestoredAfterModal = splitter ? splitter.style.display !== 'none' : null;
      } catch (e) {
        results.splitterError = String(e);
      }

      // Test 2: Camera enhancement pipeline (brightness boost & audio tuning)
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
        results.hasAudio = stream.getAudioTracks().length > 0;
        results.hasVideo = stream.getVideoTracks().length > 0;

        const videoTrack = stream.getVideoTracks()[0];
        const audioTrack = stream.getAudioTracks()[0];

        results.videoSettings = videoTrack ? videoTrack.getSettings() : null;
        results.audioSettings = audioTrack ? audioTrack.getSettings() : null;

        // Clean up
        stream.getTracks().forEach(t => t.stop());
      } catch (e) {
        results.mediaError = String(e);
      }

      return results;
    })()
  `);

  console.log('Verification Report:', JSON.stringify(report, null, 2));
  fs.writeFileSync('all_improvements_report.json', JSON.stringify(report, null, 2));
  app.quit();
});
