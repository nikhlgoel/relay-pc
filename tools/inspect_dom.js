
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

app.setPath('userData', path.join(app.getPath('appData'), 'whatsapp-pc'));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 800,
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
      const tree = await win.webContents.executeJavaScript(`
        (() => {
          const side = document.getElementById('pane-side');
          if (!side) return null;

          function dump(el, depth) {
            if (depth > 6 || !el) return null;
            const r = el.getBoundingClientRect();
            const s = window.getComputedStyle(el);
            return {
              tag: el.tagName,
              id: el.id,
              class: el.className ? String(el.className).slice(0, 40) : '',
              role: el.getAttribute('role'),
              testId: el.getAttribute('data-testid'),
              ariaLabel: el.getAttribute('aria-label'),
              rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
              bg: s.backgroundColor,
              pos: s.position,
              children: Array.from(el.children).map(c => dump(c, depth + 1)).filter(Boolean)
            };
          }

          const app = document.getElementById('app');
          return dump(app, 0);
        })()
      `);

      if (tree) {
        clearInterval(timer);
        fs.writeFileSync('dom-tree.json', JSON.stringify(tree, null, 2));
        app.quit();
      } else if (attempts > 30) {
        clearInterval(timer);
        fs.writeFileSync('dom-tree.json', JSON.stringify({ error: 'timeout' }));
        app.quit();
      }
    } catch (e) {
      fs.writeFileSync('dom-tree.json', JSON.stringify({ error: String(e) }));
      clearInterval(timer);
      app.quit();
    }
  }, 1000);
});
