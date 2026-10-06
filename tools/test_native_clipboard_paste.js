const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

ipcMain.handle('translucent:get', () => true);
ipcMain.handle('system:accent-color', () => ({ hex: '#bf5611', rgb: '191, 86, 17' }));
ipcMain.handle('pane-width:get', () => 379);
ipcMain.on('pane-width:set', () => {});
ipcMain.on('unread-count', () => {});
ipcMain.on('activate-window', () => {});

app.setPath('userData', path.join(app.getPath('appData'), 'whatsapp-pc'));

function getNativeClipboardFiles() {
  return new Promise((resolve) => {
    const exePath = path.join(__dirname, '..', 'src', 'assets', 'get_clipboard_files.exe');
    execFile(exePath, { windowsHide: true, timeout: 2000 }, (err, stdout) => {
      if (err || !stdout) return resolve([]);
      const lines = stdout.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      const files = [];
      for (const filePath of lines) {
        try {
          if (fs.existsSync(filePath)) {
            const stat = fs.statSync(filePath);
            if (stat.isFile()) {
              files.push({
                name: path.basename(filePath),
                path: filePath,
                size: stat.size,
                lastModified: stat.mtimeMs,
                buffer: fs.readFileSync(filePath)
              });
            }
          }
        } catch (e) {
          console.error('Error reading file:', filePath, e);
        }
      }
      resolve(files);
    });
  });
}

ipcMain.handle('clipboard:get-files', async () => {
  return await getNativeClipboardFiles();
});

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
        console.log('Chat list ready. Waiting 2s...');
        await new Promise(r => setTimeout(r, 2000));

        // Click chat at (200, 250)
        win.webContents.sendInputEvent({ type: 'mouseDown', x: 200, y: 250, button: 'left', clickCount: 1 });
        await new Promise(r => setTimeout(r, 50));
        win.webContents.sendInputEvent({ type: 'mouseUp', x: 200, y: 250, button: 'left', clickCount: 1 });

        await new Promise(r => setTimeout(r, 2500));

        // Get clipboard files from native helper
        const files = await getNativeClipboardFiles();
        console.log('Clipboard files found:', files.map(f => ({ name: f.name, size: f.size })));

        // Pass files to renderer and dispatch paste
        const pasteResult = await win.webContents.executeJavaScript(`
          (async () => {
            const filesData = await window.require ? null : null; // we can pass via args or ipc
            return { ready: true };
          })()
        `);

        // Execute in page context with the files
        const injectResult = await win.webContents.executeJavaScript(`
          (async () => {
            // Test requesting from IPC handler
            const files = await window.__getClipboardFilesTest();
            return files;
          })()
        `).catch(async () => {
          // If no exposed helper yet, pass data directly via script:
          return await win.webContents.executeJavaScript(`
            (async () => {
              const filesInfo = ${JSON.stringify(files.map(f => ({
                name: f.name,
                size: f.size,
                lastModified: f.lastModified,
                base64: f.buffer.toString('base64')
              })))};

              const dt = new DataTransfer();
              for (const item of filesInfo) {
                const binStr = atob(item.base64);
                const len = binStr.length;
                const bytes = new Uint8Array(len);
                for (let i = 0; i < len; i++) {
                  bytes[i] = binStr.charCodeAt(i);
                }
                const f = new File([bytes], item.name, {
                  type: 'application/octet-stream',
                  lastModified: item.lastModified
                });
                dt.items.add(f);
              }

              const target = document.querySelector('footer div[contenteditable="true"]') || document.activeElement || document.getElementById('main');
              const pasteEv = new ClipboardEvent('paste', {
                bubbles: true,
                cancelable: true,
                composed: true,
                clipboardData: dt
              });
              target.dispatchEvent(pasteEv);

              await new Promise(r => setTimeout(r, 1500));

              const sendBtn = document.querySelector('button[aria-label*="Send" i], [data-icon="wds-ic-send-filled"]');
              return {
                filesCount: dt.files.length,
                hasSendBtn: Boolean(sendBtn),
                sendLabel: sendBtn ? sendBtn.getAttribute('aria-label') : null
              };
            })()
          `);
        });

        console.log('Inject result:', injectResult);

        const image = await win.webContents.capturePage();
        const scratchDir = 'C:/Users/datan/.gemini/antigravity/brain/ac0752be-ce86-4d4e-b07d-e6eb76e546b2/scratch';
        fs.writeFileSync(path.join(scratchDir, 'live_clipboard_files_test.png'), image.toPNG());
        console.log('Saved screenshot live_clipboard_files_test.png');

        app.quit();
      }
    } catch (e) {
      console.error('Error:', e);
      clearInterval(timer);
      app.quit();
    }
  }, 1000);
});
