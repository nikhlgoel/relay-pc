const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

app.setPath('userData', path.join(app.getPath('appData'), 'whatsapp-pc'));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: true,
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

        // Wait 3 seconds for chats to render
        await new Promise(r => setTimeout(r, 3000));

        const result = await win.webContents.executeJavaScript(`
          (async () => {
            // Click the first chat
            const chatRow = document.querySelector('#pane-side [role="row"], #pane-side [role="listitem"], #pane-side > div > div > div > div');
            if (chatRow) {
              chatRow.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
              chatRow.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
              chatRow.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            }

            await new Promise(r => setTimeout(r, 2000));

            const main = document.getElementById('main');
            if (!main) {
              return { error: 'No #main found after clicking chat' };
            }

            // Create a test file
            const file = new File(['Test content for delivery ' + Date.now()], 'delivery_test.txt', { type: 'text/plain' });
            const dt = new DataTransfer();
            dt.items.add(file);

            // Test Method A: Drop event on #main
            let dropWorked = false;
            try {
              const dropEvent = new DragEvent('drop', {
                bubbles: true,
                cancelable: true,
                dataTransfer: dt
              });
              main.dispatchEvent(dropEvent);
              await new Promise(r => setTimeout(r, 1000));
              dropWorked = Boolean(document.querySelector('[data-icon="send"], button[aria-label*="send" i], [data-animate-media-viewer="true"]'));
            } catch (e) {
              dropWorked = String(e);
            }

            // If drop didn't work, close viewer if any, and try Method B: Paste event on active element
            let pasteWorked = false;
            if (!dropWorked) {
              try {
                const active = document.activeElement || main;
                const pasteEvent = new ClipboardEvent('paste', {
                  bubbles: true,
                  cancelable: true,
                  clipboardData: dt
                });
                active.dispatchEvent(pasteEvent);
                await new Promise(r => setTimeout(r, 1000));
                pasteWorked = Boolean(document.querySelector('[data-icon="send"], button[aria-label*="send" i], [data-animate-media-viewer="true"]'));
              } catch (e) {
                pasteWorked = String(e);
              }
            }

            // Method C: Input[type="file"]
            let inputWorked = false;
            let inputsFound = [];
            if (!dropWorked && !pasteWorked) {
              // Click the attachment button (+ icon) if present to mount the file inputs
              const plusBtn = document.querySelector('[data-icon="plus"], button[title*="Attach" i], [data-icon="attach-menu-plus"]');
              if (plusBtn) {
                const btn = plusBtn.closest('button') || plusBtn;
                btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
                await new Promise(r => setTimeout(r, 800));
              }

              const allInputs = Array.from(document.querySelectorAll('input[type="file"]'));
              inputsFound = allInputs.map(i => ({ accept: i.accept, id: i.id }));

              const docInput = allInputs.find(i => i.accept === '*' || i.accept.includes('*')) || allInputs[0];
              if (docInput) {
                try {
                  docInput.files = dt.files;
                  docInput.dispatchEvent(new Event('change', { bubbles: true }));
                  await new Promise(r => setTimeout(r, 1000));
                  inputWorked = Boolean(document.querySelector('[data-icon="send"], button[aria-label*="send" i]'));
                } catch (e) {
                  inputWorked = String(e);
                }
              }
            }

            return {
              hasMain: true,
              dropWorked,
              pasteWorked,
              inputWorked,
              inputsFound
            };
          })()
        `);

        fs.writeFileSync('delivery-result.json', JSON.stringify(result, null, 2));
        app.quit();
      }
    } catch (e) {
      fs.writeFileSync('delivery-result.json', JSON.stringify({ error: String(e) }));
      clearInterval(timer);
      app.quit();
    }
  }, 1000);
});
