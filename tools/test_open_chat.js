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
        await new Promise(r => setTimeout(r, 2500));

        const result = await win.webContents.executeJavaScript(`
          (async () => {
            // Find chat with text "Private" or "Papa"
            const spans = Array.from(document.querySelectorAll('#pane-side span'));
            const targetSpan = spans.find(s => s.innerText && (s.innerText.includes('Private') || s.innerText.includes('Papa')));
            if (!targetSpan) {
              return { error: 'Target chat not found' };
            }

            // Click the target
            targetSpan.click();
            await new Promise(r => setTimeout(r, 2000));

            const main = document.getElementById('main');
            if (!main) {
              // Try clicking parent
              const parent = targetSpan.closest('[role="listitem"], [role="row"], [tabindex]');
              if (parent) parent.click();
              await new Promise(r => setTimeout(r, 2000));
            }

            const hasMain = Boolean(document.getElementById('main'));

            return {
              targetText: targetSpan.innerText,
              hasMain,
              mainTag: document.getElementById('main') ? document.getElementById('main').tagName : null
            };
          })()
        `);

        fs.writeFileSync('open-chat-result.json', JSON.stringify(result, null, 2));
        app.quit();
      }
    } catch (e) {
      fs.writeFileSync('open-chat-result.json', JSON.stringify({ error: String(e) }));
      clearInterval(timer);
      app.quit();
    }
  }, 1000);
});
