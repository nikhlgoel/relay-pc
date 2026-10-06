const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

app.setPath('userData', path.join(app.getPath('appData'), 'whatsapp-pc'));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 1920,
    height: 1080,
    webPreferences: {
      partition: 'persist:whatsapp',
      contextIsolation: false,
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
      const info = await win.webContents.executeJavaScript(`
        (() => {
          const side = document.getElementById('pane-side');
          if (!side) return null;

          // Points to test: x=5, 20, 40, 60 at y=200
          const points = [5, 15, 25, 35, 50, 64].map(x => {
            const el = document.elementFromPoint(x, 200);
            if (!el) return { x, el: null };
            const r = el.getBoundingClientRect();
            const s = window.getComputedStyle(el);
            return {
              x,
              tag: el.tagName,
              id: el.id,
              className: el.className ? String(el.className).slice(0, 50) : '',
              rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
              bg: s.backgroundColor,
              color: s.color,
              parentTag: el.parentElement ? el.parentElement.tagName : null,
              parentId: el.parentElement ? el.parentElement.id : null,
              parentClass: el.parentElement && el.parentElement.className ? String(el.parentElement.className).slice(0, 50) : ''
            };
          });

          return {
            windowSize: { w: window.innerWidth, h: window.innerHeight },
            devicePixelRatio: window.devicePixelRatio,
            points
          };
        })()
      `);

      if (info) {
        clearInterval(timer);
        fs.writeFileSync('points-debug.json', JSON.stringify(info, null, 2));
        app.quit();
      } else if (attempts > 30) {
        clearInterval(timer);
        fs.writeFileSync('points-debug.json', JSON.stringify({ error: 'timeout' }));
        app.quit();
      }
    } catch (e) {
      fs.writeFileSync('points-debug.json', JSON.stringify({ error: String(e) }));
      clearInterval(timer);
      app.quit();
    }
  }, 1000);
});
