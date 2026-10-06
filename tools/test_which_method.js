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
      const ready = await win.webContents.executeJavaScript(`
        Boolean(document.getElementById('pane-side') && document.querySelector('[data-wa-pane="side"]'))
      `);

      if (ready) {
        clearInterval(timer);
        await new Promise(r => setTimeout(r, 2000));

        // Click chat
        win.webContents.sendInputEvent({ type: 'mouseDown', x: 200, y: 250, button: 'left', clickCount: 1 });
        await new Promise(r => setTimeout(r, 50));
        win.webContents.sendInputEvent({ type: 'mouseUp', x: 200, y: 250, button: 'left', clickCount: 1 });

        await new Promise(r => setTimeout(r, 3000));

        // Test ONE method at a time:
        // Test Method A: Paste event on document.activeElement
        const pasteResult = await win.webContents.executeJavaScript(`
          (async () => {
            const f = new File(['method A paste test'], 'paste_test.txt', { type: 'text/plain' });
            const dt = new DataTransfer();
            dt.items.add(f);

            const active = document.activeElement || document.querySelector('footer div[contenteditable="true"]');
            console.log('Active element tag:', active ? active.tagName : 'none');

            const pasteEv = new ClipboardEvent('paste', {
              bubbles: true,
              cancelable: true,
              composed: true,
              clipboardData: dt
            });
            active.dispatchEvent(pasteEv);
            await new Promise(r => setTimeout(r, 1500));

            // Check what modal or media viewer opened
            const sendBtn = document.querySelector('[data-icon="send"], span[data-icon="send"]');
            const mediaViewer = document.querySelector('[data-animate-media-viewer="true"]');
            const allButtons = Array.from(document.querySelectorAll('button, div[role="button"]')).map(b => ({
              ariaLabel: b.getAttribute('aria-label'),
              text: b.innerText,
              icon: b.querySelector('[data-icon]') ? b.querySelector('[data-icon]').getAttribute('data-icon') : null
            }));

            return {
              pasteFired: true,
              hasSendIcon: Boolean(sendBtn),
              hasMediaViewer: Boolean(mediaViewer),
              buttonsWithIcons: allButtons.filter(b => b.icon || (b.ariaLabel && b.ariaLabel.toLowerCase().includes('send')))
            };
          })()
        `);
        console.log('Paste result:', JSON.stringify(pasteResult, null, 2));

        const image = await win.webContents.capturePage();
        const scratchDir = 'C:/Users/datan/.gemini/antigravity/brain/ac0752be-ce86-4d4e-b07d-e6eb76e546b2/scratch';
        fs.writeFileSync(path.join(scratchDir, 'live_paste_only.png'), image.toPNG());

        app.quit();
      }
    } catch (e) {
      console.error('Error:', e);
      clearInterval(timer);
      app.quit();
    }
  }, 1000);
});
