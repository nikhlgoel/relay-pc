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
        await new Promise(r => setTimeout(r, 2000));

        const info = await win.webContents.executeJavaScript(`
          (() => {
            const side = document.getElementById('pane-side');
            const items = Array.from(side.querySelectorAll('[role="listitem"], [role="row"]')).map(el => ({
              tag: el.tagName,
              role: el.getAttribute('role'),
              text: el.innerText ? el.innerText.slice(0, 50).replace(/\\n/g, ' ') : '',
              childrenClasses: Array.from(el.querySelectorAll('*')).slice(0, 5).map(c => c.className).filter(Boolean)
            }));

            return {
              itemsCount: items.length,
              items: items.slice(0, 5)
            };
          })()
        `);

        fs.writeFileSync('side-items.json', JSON.stringify(info, null, 2));
        app.quit();
      }
    } catch (e) {
      fs.writeFileSync('side-items.json', JSON.stringify({ error: String(e) }));
      clearInterval(timer);
      app.quit();
    }
  }, 1000);
});
