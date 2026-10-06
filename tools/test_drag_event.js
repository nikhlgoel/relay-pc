const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

app.setPath('userData', path.join(app.getPath('appData'), 'whatsapp-pc'));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 1400,
    height: 900,
    webPreferences: {
      partition: 'persist:whatsapp',
      contextIsolation: false,
      nodeIntegration: true
    }
  });

  await win.loadURL('https://web.whatsapp.com/', {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
  });

  let attempts = 0;
  const timer = setInterval(async () => {
    attempts++;
    try {
      const ready = await win.webContents.executeJavaScript(`Boolean(document.getElementById('pane-side'))`);
      if (ready || attempts > 25) {
        clearInterval(timer);

        try {
          const res = await win.webContents.executeJavaScript(`
            (() => {
              try {
                const dt = new DataTransfer();
                const f = new File(['hello'], 'hello.txt', { type: 'text/plain' });
                dt.items.add(f);

                // Test ClipboardEvent
                const pEv = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
                const pasteFilesCount = pEv.clipboardData.files.length;

                // Test input.files assignment
                const input = document.createElement('input');
                input.type = 'file';
                input.files = dt.files;
                const inputFilesCount = input.files.length;

                return {
                  pasteFilesCount,
                  inputFilesCount
                };
              } catch (err) {
                return { error: err.stack || String(err) };
              }
            })()
          `);
          fs.writeFileSync('paste-test.json', JSON.stringify(res, null, 2));
        } catch (e) {
          fs.writeFileSync('paste-test.json', JSON.stringify({ execError: e.stack || String(e) }));
        }
        app.quit();
      }
    } catch (e) {
      fs.writeFileSync('paste-test.json', JSON.stringify({ error: String(e) }));
      clearInterval(timer);
      app.quit();
    }
  }, 1000);
});
