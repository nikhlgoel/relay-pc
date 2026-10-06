const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

ipcMain.handle('translucent:get', () => true);
ipcMain.handle('system:accent-color', () => ({ hex: '#bf5611', rgb: '191, 86, 17' }));
ipcMain.handle('pane-width:get', () => 379);
ipcMain.on('pane-width:set', () => {});
ipcMain.on('unread-count', () => {});
ipcMain.on('activate-window', () => {});

app.setPath('userData', path.join(app.getPath('appData'), 'whatsapp-pc'));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: true,
    width: 1400,
    height: 900,
    backgroundColor: '#111b21',
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'preload.js'),
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
      const ready = await win.webContents.executeJavaScript(`
        Boolean(document.getElementById('pane-side') && document.querySelector('[data-wa-pane="side"]'))
      `);

      if (ready || attempts > 25) {
        clearInterval(timer);
        // Wait 2.5s for layout and styles to fully settle
        await new Promise(r => setTimeout(r, 2500));

        const info = await win.webContents.executeJavaScript(`
          (() => {
            const rail = document.querySelector('[data-wa-pane="rail"]') || document.querySelector('header');
            const side = document.querySelector('[data-wa-pane="side"]');
            const sideHeader = side ? (side.querySelector('header') || side.querySelector('div')) : null;

            function inspect(el) {
              if (!el) return null;
              const r = el.getBoundingClientRect();
              const s = window.getComputedStyle(el);
              return {
                tag: el.tagName,
                testId: el.getAttribute('data-testid'),
                rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
                background: s.background,
                backgroundColor: s.backgroundColor,
                backgroundImage: s.backgroundImage,
                backdropFilter: s.backdropFilter,
                borderRight: s.borderRight,
                boxShadow: s.boxShadow
              };
            }

            return {
              rail: inspect(rail),
              sideHeader: inspect(sideHeader),
              accentColor: getComputedStyle(document.documentElement).getPropertyValue('--wa-accent-color'),
              accentRgb: getComputedStyle(document.documentElement).getPropertyValue('--wa-accent-rgb')
            };
          })()
        `);

        fs.writeFileSync('rail-debug.json', JSON.stringify(info, null, 2));

        const image = await win.webContents.capturePage();
        const scratchDir = 'C:/Users/datan/.gemini/antigravity/brain/ac0752be-ce86-4d4e-b07d-e6eb76e546b2/scratch';
        fs.writeFileSync(path.join(scratchDir, 'live_view.png'), image.toPNG());

        // Crop the left rail
        const railRect = info.rail && info.rail.rect ? info.rail.rect : { x: 0, y: 0, w: 80, h: 800 };
        const crop = image.crop({
          x: 0,
          y: 0,
          width: Math.min(300, image.getSize().width),
          height: Math.min(800, image.getSize().height)
        });
        fs.writeFileSync(path.join(scratchDir, 'live_rail_crop.png'), crop.toPNG());

        app.quit();
      }
    } catch (e) {
      fs.writeFileSync('rail-debug.json', JSON.stringify({ error: String(e) }));
      clearInterval(timer);
      app.quit();
    }
  }, 1000);
});

