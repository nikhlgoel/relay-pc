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
      contextIsolation: false, // Let our test inspect DOM directly
      nodeIntegration: false
    }
  });

  win.webContents.on('console-message', (_event, level, message) => {
    console.log(`[CONSOLE] ${message}`);
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
        console.log('WhatsApp Web chat list loaded! Waiting 2s...');
        await new Promise(r => setTimeout(r, 2000));

        // Click using real hardware input events
        console.log('Sending real click at (200, 250)...');
        win.webContents.sendInputEvent({ type: 'mouseDown', x: 200, y: 250, button: 'left', clickCount: 1 });
        await new Promise(r => setTimeout(r, 50));
        win.webContents.sendInputEvent({ type: 'mouseUp', x: 200, y: 250, button: 'left', clickCount: 1 });

        // Wait for #main to mount
        await new Promise(r => setTimeout(r, 3000));

        const mainInspection = await win.webContents.executeJavaScript(`
          (() => {
            const main = document.getElementById('main');
            if (!main) return { error: 'No #main' };

            const footer = main.querySelector('footer');
            const input = footer ? footer.querySelector('div[contenteditable="true"]') : null;
            const attachBtn = footer ? footer.querySelector('button[title*="Attach" i], [data-icon="plus"], [data-icon="attach-menu-plus"]') : null;
            
            // All file inputs on the page
            const fileInputs = Array.from(document.querySelectorAll('input[type="file"]')).map(i => ({
              accept: i.accept,
              id: i.id,
              multiple: i.multiple
            }));

            return {
              hasMain: true,
              hasFooter: Boolean(footer),
              hasInput: Boolean(input),
              hasAttachBtn: Boolean(attachBtn),
              fileInputs
            };
          })()
        `);
        console.log('Main inspection:', mainInspection);

        // Now test sending a file via DataTransfer and paste / drop
        const attachTest = await win.webContents.executeJavaScript(`
          (async () => {
            const main = document.getElementById('main');
            if (!main) return { error: 'no main' };

            const testFile = new File(['Sample test file attachment content created at ' + new Date().toISOString()], 'test_document.txt', { type: 'text/plain' });

            const results = {};

            // Method 1: Dispatch 'paste' event on the footer input
            const input = main.querySelector('footer div[contenteditable="true"]') || document.activeElement;
            if (input) {
              input.focus();
              const dt = new DataTransfer();
              dt.items.add(testFile);
              
              const pasteEv = new ClipboardEvent('paste', {
                bubbles: true,
                cancelable: true,
                composed: true,
                clipboardData: dt
              });
              input.dispatchEvent(pasteEv);
              await new Promise(r => setTimeout(r, 1200));

              // Check if media/document preview viewer opened
              const preview = document.querySelector('[data-icon="send"], [data-animate-media-viewer="true"], button[aria-label*="send" i]');
              results.methodPastePreview = Boolean(preview);
            }

            // Method 2: If paste didn't trigger preview, try drop on main
            if (!results.methodPastePreview) {
              const dt2 = new DataTransfer();
              dt2.items.add(testFile);

              const dropEv = new DragEvent('drop', {
                bubbles: true,
                cancelable: true,
                composed: true,
                dataTransfer: dt2
              });
              main.dispatchEvent(dropEv);
              await new Promise(r => setTimeout(r, 1200));

              const preview2 = document.querySelector('[data-icon="send"], [data-animate-media-viewer="true"], button[aria-label*="send" i]');
              results.methodDropPreview = Boolean(preview2);
            }

            // Method 3: Try file input
            if (!results.methodPastePreview && !results.methodDropPreview) {
              // Click attach button
              const attachBtn = main.querySelector('button[title*="Attach" i], [data-icon="plus"], [data-icon="attach-menu-plus"]');
              if (attachBtn) {
                const b = attachBtn.closest('button') || attachBtn;
                b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
                await new Promise(r => setTimeout(r, 500));
              }

              const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
              const docInput = inputs.find(i => i.accept === '*' || i.accept.includes('*')) || inputs[0];
              if (docInput) {
                const dt3 = new DataTransfer();
                dt3.items.add(testFile);
                docInput.files = dt3.files;
                docInput.dispatchEvent(new Event('change', { bubbles: true }));
                await new Promise(r => setTimeout(r, 1200));

                const preview3 = document.querySelector('[data-icon="send"], [data-animate-media-viewer="true"], button[aria-label*="send" i]');
                results.methodInputPreview = Boolean(preview3);
              }
            }

            return results;
          })()
        `);
        console.log('Attach test results:', attachTest);

        fs.writeFileSync('attach_test_results.json', JSON.stringify({
          mainInspection,
          attachTest
        }, null, 2));

        const image = await win.webContents.capturePage();
        const scratchDir = 'C:/Users/datan/.gemini/antigravity/brain/ac0752be-ce86-4d4e-b07d-e6eb76e546b2/scratch';
        fs.writeFileSync(path.join(scratchDir, 'live_attach_test.png'), image.toPNG());
        console.log('Saved live_attach_test.png');

        app.quit();
      } else if (attempts > 30) {
        clearInterval(timer);
        console.log('Timeout waiting for WhatsApp Web');
        app.quit();
      }
    } catch (e) {
      console.error('Error:', e);
      clearInterval(timer);
      app.quit();
    }
  }, 1000);
});
