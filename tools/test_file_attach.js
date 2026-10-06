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

        const result = await win.webContents.executeJavaScript(`
          (async () => {
            // Click the first chat in the list if #main is not open
            if (!document.getElementById('main')) {
              const firstChat = document.querySelector('#pane-side [role="row"], #pane-side [role="listitem"]');
              if (firstChat) {
                firstChat.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
                firstChat.dispatchEvent(new MouseEvent('click', { bubbles: true }));
              }
            }

            await new Promise(r => setTimeout(r, 1500));

            const hasMain = Boolean(document.getElementById('main'));

            // Create a dummy text file to test attachment
            const dt = new DataTransfer();
            const file = new File(['Hello WhatsApp test attachment content'], 'test_document.txt', { type: 'text/plain' });
            dt.items.add(file);

            // Test 1: Try input[type="file"][accept="*"]
            let inputResult = false;
            const input = document.querySelector('input[type="file"][accept="*"]') || document.querySelector('input[type="file"]');
            if (input) {
              try {
                input.files = dt.files;
                input.dispatchEvent(new Event('change', { bubbles: true }));
                inputResult = true;
              } catch (e) {
                inputResult = String(e);
              }
            }

            await new Promise(r => setTimeout(r, 1000));

            // Check if send preview opened
            const isPreviewOpen = Boolean(document.querySelector('[data-icon="send"], [data-animate-media-viewer="true"]'));

            // If not opened, test 2: dispatch drop event on #main
            let dropResult = false;
            if (!isPreviewOpen && document.getElementById('main')) {
              try {
                const main = document.getElementById('main');
                const dropEvent = new DragEvent('drop', {
                  bubbles: true,
                  cancelable: true,
                  dataTransfer: dt
                });
                main.dispatchEvent(dropEvent);
                dropResult = true;
              } catch (e) {
                dropResult = String(e);
              }
            }

            await new Promise(r => setTimeout(r, 1000));
            const isPreviewOpenAfterDrop = Boolean(document.querySelector('[data-icon="send"], [data-animate-media-viewer="true"]'));

            return {
              hasMain,
              hasInput: Boolean(input),
              inputResult,
              isPreviewOpen,
              dropResult,
              isPreviewOpenAfterDrop
            };
          })()
        `);

        fs.writeFileSync('attach-debug.json', JSON.stringify(result, null, 2));
        app.quit();
      }
    } catch (e) {
      fs.writeFileSync('attach-debug.json', JSON.stringify({ error: String(e) }));
      clearInterval(timer);
      app.quit();
    }
  }, 1000);
});
