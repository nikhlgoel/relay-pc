const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

app.setPath('userData', path.join(app.getPath('appData'), 'whatsapp-pc-diag'));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 800,
    height: 600,
    webPreferences: {
      partition: 'persist:whatsapp_diag',
      contextIsolation: false,
      nodeIntegration: false
    }
  });

  const ses = win.webContents.session;
  ses.setPermissionRequestHandler((_wc, permission, callback) => callback(true));
  ses.setPermissionCheckHandler(() => true);
  ses.setDevicePermissionHandler(() => true);

  await win.loadURL('https://webrtc.github.io/samples/src/content/getusermedia/gum/');

  const result = await win.webContents.executeJavaScript(`
    (async () => {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      const videoTrack = stream.getVideoTracks()[0];
      const capabilities = videoTrack.getCapabilities ? videoTrack.getCapabilities() : null;
      const settings = videoTrack.getSettings ? videoTrack.getSettings() : null;
      
      // Test applying constraints to boost brightness
      let applied = null;
      try {
        if (capabilities && capabilities.brightness) {
          await videoTrack.applyConstraints({
            advanced: [{ brightness: Math.min(capabilities.brightness.max, 50) }]
          });
          applied = videoTrack.getSettings();
        }
      } catch (err) {
        applied = { error: String(err) };
      }

      stream.getTracks().forEach(t => t.stop());
      return { capabilities, settings, applied };
    })()
  `);

  console.log('Capabilities result:', JSON.stringify(result, null, 2));
  fs.writeFileSync('camera_capabilities.json', JSON.stringify(result, null, 2));
  app.quit();
});
