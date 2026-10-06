const { app, BrowserWindow, systemPreferences } = require('electron');
const path = require('path');
const fs = require('fs');

app.setPath('userData', path.join(app.getPath('appData'), 'whatsapp-pc'));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 800,
    height: 600,
    webPreferences: {
      partition: 'persist:whatsapp',
      contextIsolation: false,
      nodeIntegration: true
    }
  });

  const ses = win.webContents.session;

  ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
    console.log('[PERM REQUEST]', permission, details);
    callback(true);
  });

  ses.setPermissionCheckHandler((_wc, permission, origin, details) => {
    console.log('[PERM CHECK]', permission, origin, details);
    return true;
  });

  ses.setDevicePermissionHandler((details) => {
    console.log('[DEVICE PERM]', details);
    return true;
  });

  await win.loadURL('about:blank');

  const result = await win.webContents.executeJavaScript(`
    (async () => {
      const info = {};
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        info.devices = devices.map(d => ({
          kind: d.kind,
          label: d.label,
          deviceId: d.deviceId ? d.deviceId.slice(0, 8) + '...' : ''
        }));
      } catch (e) {
        info.enumerateDevicesError = String(e);
      }

      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
        info.hasStream = true;
        info.audioTracks = stream.getAudioTracks().map(t => ({
          label: t.label,
          enabled: t.enabled,
          muted: t.muted,
          settings: t.getSettings()
        }));
        info.videoTracks = stream.getVideoTracks().map(t => ({
          label: t.label,
          enabled: t.enabled,
          muted: t.muted,
          settings: t.getSettings(),
          capabilities: t.getCapabilities ? t.getCapabilities() : null
        }));
        // Stop tracks
        stream.getTracks().forEach(t => t.stop());
      } catch (e) {
        info.getUserMediaError = String(e);
      }

      return info;
    })()
  `);

  console.log('Diagnostic result:', JSON.stringify(result, null, 2));
  fs.writeFileSync('media_diagnostic.json', JSON.stringify(result, null, 2));

  app.quit();
});
