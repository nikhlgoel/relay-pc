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
        await new Promise(r => setTimeout(r, 2000));

        // Get coordinates of the first chat in the list
        const coords = await win.webContents.executeJavaScript(`
          (() => {
            const side = document.getElementById('pane-side');
            // The chat rows are inside the virtual scroll container
            const chat = side.querySelector('div[role="listitem"], div[role="row"], div[style*="translateY"], div[style*="height"]');
            if (chat) {
              const r = chat.getBoundingClientRect();
              return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + 40) };
            }
            // Fallback: click at x=200, y=150
            return { x: 200, y: 150 };
          })()
        `);

        // Click on the chat
        win.webContents.sendInputEvent({ type: 'mouseDown', x: coords.x, y: coords.y, button: 'left', clickCount: 1 });
        win.webContents.sendInputEvent({ type: 'mouseUp', x: coords.x, y: coords.y, button: 'left', clickCount: 1 });

        await new Promise(r => setTimeout(r, 2000));

        // Check if #main appeared and test attaching a file
        const testResult = await win.webContents.executeJavaScript(`
          (async () => {
            const hasMain = Boolean(document.getElementById('main'));

            // Create a test file
            const file = new File(['Hello, this is a test document attachment!'], 'test_file.txt', { type: 'text/plain' });
            const dt = new DataTransfer();
            dt.items.add(file);

            // Method 1: Drop on #main
            const main = document.getElementById('main') || document.body;
            const dropEvent = new DragEvent('drop', {
              bubbles: true,
              cancelable: true,
              composed: true,
              dataTransfer: dt
            });
            main.dispatchEvent(dropEvent);

            await new Promise(r => setTimeout(r, 1200));

            let previewActive = Boolean(document.querySelector('[data-icon="send"], button[aria-label*="send" i], [data-animate-media-viewer="true"]'));

            // Method 2: If not active, dispatch paste on activeElement
            if (!previewActive) {
              const pasteEvent = new ClipboardEvent('paste', {
                bubbles: true,
                cancelable: true,
                composed: true,
                clipboardData: dt
              });
              (document.activeElement || main).dispatchEvent(pasteEvent);
              await new Promise(r => setTimeout(r, 1200));
              previewActive = Boolean(document.querySelector('[data-icon="send"], button[aria-label*="send" i], [data-animate-media-viewer="true"]'));
            }

            return {
              hasMain,
              coords,
              previewActive
            };
          })()
        `);

        fs.writeFileSync('click-attach-result.json', JSON.stringify(testResult, null, 2));

        // Take a screenshot
        const img = await win.webContents.capturePage();
        fs.writeFileSync('scratch/attach_test_view.png', img.toPNG());

        app.quit();
      }
    } catch (e) {
      fs.writeFileSync('click-attach-result.json', JSON.stringify({ error: String(e) }));
      clearInterval(timer);
      app.quit();
    }
  }, 1000);
});
