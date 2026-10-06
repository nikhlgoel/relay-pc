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
      contextIsolation: true,
      nodeIntegration: false
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

        const info = await win.webContents.executeJavaScript(`
          (() => {
            const inputs = Array.from(document.querySelectorAll('input[type="file"]')).map(i => ({
              accept: i.accept,
              multiple: i.multiple,
              id: i.id,
              name: i.name,
              parentTag: i.parentElement ? i.parentElement.tagName : null,
              parentClass: i.parentElement ? i.parentElement.className : ''
            }));

            return {
              inputs,
              hasMain: Boolean(document.getElementById('main'))
            };
          })()
        `);

        fs.writeFileSync('inputs-debug.json', JSON.stringify(info, null, 2));
        app.quit();
      }
    } catch (e) {
      fs.writeFileSync('inputs-debug.json', JSON.stringify({ error: String(e) }));
      clearInterval(timer);
      app.quit();
    }
  }, 1000);
});
