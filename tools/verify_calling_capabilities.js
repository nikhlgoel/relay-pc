const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

app.setPath('userData', path.join(app.getPath('appData'), 'whatsapp-pc-diag'));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 1200,
    height: 800,
    webPreferences: {
      partition: 'persist:whatsapp_diag',
      contextIsolation: false,
      nodeIntegration: false
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

  // Test on https://webrtc.github.io/samples/src/content/getusermedia/gum/
  await win.loadURL('https://webrtc.github.io/samples/src/content/getusermedia/gum/');

  const result = await win.webContents.executeJavaScript(`
    (async () => {
      const out = {};
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
        out.hasAudio = stream.getAudioTracks().length > 0;
        out.hasVideo = stream.getVideoTracks().length > 0;
        out.audioTrack = stream.getAudioTracks()[0]?.label;
        out.videoTrack = stream.getVideoTracks()[0]?.label;
        out.videoSettings = stream.getVideoTracks()[0]?.getSettings();
        stream.getTracks().forEach(t => t.stop());
      } catch (e) {
        out.error = String(e);
      }
      return out;
    })()
  `);

  console.log('WebRTC test result:', JSON.stringify(result, null, 2));
  fs.writeFileSync('webrtc_diag.json', JSON.stringify(result, null, 2));
  app.quit();
});
