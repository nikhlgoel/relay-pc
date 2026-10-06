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

          const rail = document.querySelector('header');
          if (!rail) return null;

          return {
            outerHTML: rail.outerHTML.slice(0, 3000),
            computedStyle: {
              width: window.getComputedStyle(rail).width,
              height: window.getComputedStyle(rail).height,
              position: window.getComputedStyle(rail).position,
              overflow: window.getComputedStyle(rail).overflow,
              backgroundColor: window.getComputedStyle(rail).backgroundColor
            },
            buttons: Array.from(rail.querySelectorAll('button, [role="button"], [data-icon]')).map(b => ({
              tag: b.tagName,
              ariaLabel: b.getAttribute('aria-label'),
              icon: b.getAttribute('data-icon') || (b.querySelector('[data-icon]') ? b.querySelector('[data-icon]').getAttribute('data-icon') : null),
              rect: {
                x: Math.round(b.getBoundingClientRect().x),
                y: Math.round(b.getBoundingClientRect().y),
                w: Math.round(b.getBoundingClientRect().width),
                h: Math.round(b.getBoundingClientRect().height)
              }
            }))
          };
        })()
      `);

      if (info) {
        clearInterval(timer);
        fs.writeFileSync('rail-html-debug.json', JSON.stringify(info, null, 2));
        app.quit();
      } else if (attempts > 30) {
        clearInterval(timer);
        fs.writeFileSync('rail-html-debug.json', JSON.stringify({ error: 'timeout' }));
        app.quit();
      }
    } catch (e) {
      fs.writeFileSync('rail-html-debug.json', JSON.stringify({ error: String(e) }));
      clearInterval(timer);
      app.quit();
    }
  }, 1000);
});
