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

        const res = await win.webContents.executeJavaScript(`
          (() => {
            // Find all input[type="file"]
            const inputs = Array.from(document.querySelectorAll('input[type="file"]')).map(i => ({
              accept: i.accept,
              multiple: i.multiple,
              className: i.className,
              outerHTML: i.outerHTML.slice(0, 150)
            }));

            // Check DataTransfer support
            const dt = new DataTransfer();
            const f = new File(['test'], 'test.txt', { type: 'text/plain' });
            dt.items.add(f);

            return {
              inputs,
              dtSupported: Boolean(dt.files.length === 1)
            };
          })()
        `);

        fs.writeFileSync('paste-analysis.json', JSON.stringify(res, null, 2));
        app.quit();
      }
    } catch (e) {
      fs.writeFileSync('paste-analysis.json', JSON.stringify({ error: String(e) }));
      clearInterval(timer);
      app.quit();
    }
  }, 1000);
});
