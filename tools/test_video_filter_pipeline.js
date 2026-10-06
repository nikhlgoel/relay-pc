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
  ses.setPermissionRequestHandler((_wc, perm, cb) => cb(true));
  ses.setPermissionCheckHandler(() => true);
  ses.setDevicePermissionHandler(() => true);

  await win.loadURL('https://webrtc.github.io/samples/src/content/getusermedia/gum/');

  const testResult = await win.webContents.executeJavaScript(`
    (async () => {
      const res = {};
      try {
        const rawStream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 } }
        });
        const rawTrack = rawStream.getVideoTracks()[0];
        res.rawSettings = rawTrack.getSettings();

        // Test pipeline
        const video = document.createElement('video');
        video.autoplay = true;
        video.muted = true;
        video.playsInline = true;
        video.srcObject = new MediaStream([rawTrack]);
        await video.play();

        const canvas = document.createElement('canvas');
        canvas.width = rawTrack.getSettings().width || 640;
        canvas.height = rawTrack.getSettings().height || 480;
        const ctx = canvas.getContext('2d');
        ctx.filter = 'brightness(1.25) contrast(1.15) saturate(1.10)';

        let frameCount = 0;
        let active = true;
        function render() {
          if (!active) return;
          if (video.readyState >= 2) {
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            frameCount++;
          }
          if ('requestVideoFrameCallback' in video) {
            video.requestVideoFrameCallback(render);
          } else {
            requestAnimationFrame(render);
          }
        }
        render();

        const filteredStream = canvas.captureStream(30);
        const filteredTrack = filteredStream.getVideoTracks()[0];
        res.filteredSettings = filteredTrack.getSettings();

        // Wait 500ms to verify frames are being captured
        await new Promise(r => setTimeout(r, 600));
        res.framesRendered = frameCount;

        // Cleanup
        active = false;
        rawTrack.stop();
        filteredTrack.stop();
        video.srcObject = null;
        video.remove();
        canvas.remove();
      } catch (err) {
        res.error = String(err);
      }
      return res;
    })()
  `);

  console.log('Video filter pipeline test result:', JSON.stringify(testResult, null, 2));
  fs.writeFileSync('pipeline_test.json', JSON.stringify(testResult, null, 2));
  app.quit();
});
