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
    width: 1400,
    height: 900,
    backgroundColor: '#111b21',
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'preload.js'),
      partition: 'persist:whatsapp',
      contextIsolation: false,
      nodeIntegration: false
    }
  });

  win.webContents.on('console-message', (_e, level, msg) => {
    if (level >= 2) console.log(`[ERR/WARN] ${msg}`);
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

      if (ready) {
        clearInterval(timer);
        console.log('App loaded successfully! Waiting 3s for styles...');
        await new Promise(r => setTimeout(r, 3000));

        // Maximize window to verify that maximize event has NO errors
        win.maximize();
        await new Promise(r => setTimeout(r, 1500));

        const image = await win.webContents.capturePage();
        const scratchDir = 'C:/Users/datan/.gemini/antigravity/brain/ac0752be-ce86-4d4e-b07d-e6eb76e546b2/scratch';
        fs.writeFileSync(path.join(scratchDir, 'clean_installed_view.png'), image.toPNG());
        console.log('Saved clean_installed_view.png');

        // Check if top glow is applied
        const styleCheck = await win.webContents.executeJavaScript(`
          (() => {
            const sideHeader = document.querySelector('[data-wa-pane="side"] header');
            const rail = document.querySelector('[data-wa-pane="rail"]');
            const app = document.getElementById('app');
            return {
              hasSideHeader: Boolean(sideHeader),
              sideHeaderBg: sideHeader ? getComputedStyle(sideHeader).background : null,
              hasRail: Boolean(rail),
              railBg: rail ? getComputedStyle(rail).background : null,
              accentColor: getComputedStyle(document.documentElement).getPropertyValue('--wa-accent-color'),
              accentRgb: getComputedStyle(document.documentElement).getPropertyValue('--wa-accent-rgb')
            };
          })()
        `);
        console.log('Style check:', JSON.stringify(styleCheck, null, 2));

        app.quit();
      } else if (attempts > 25) {
        clearInterval(timer);
        console.log('Timeout');
        app.quit();
      }
    } catch (e) {
      console.error(e);
      clearInterval(timer);
      app.quit();
    }
  }, 1000);
});
