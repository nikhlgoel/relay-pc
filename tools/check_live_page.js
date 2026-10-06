const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

app.setPath('userData', path.join(app.getPath('appData'), 'whatsapp-pc'));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: true,
    width: 1300,
    height: 850,
    webPreferences: {
      partition: 'persist:whatsapp',
      contextIsolation: false,
      nodeIntegration: true
    }
  });

  await win.loadURL('https://web.whatsapp.com/', {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
  });

  // Wait 15 seconds to let WhatsApp Web load completely
  console.log('Waiting 15 seconds for WhatsApp Web to load...');
  await new Promise(r => setTimeout(r, 15000));

  const info = await win.webContents.executeJavaScript(`
    (() => {
      return {
        title: document.title,
        url: window.location.href,
        hasPaneSide: Boolean(document.getElementById('pane-side')),
        hasMain: Boolean(document.getElementById('main')),
        bodyText: document.body ? document.body.innerText.slice(0, 300) : '',
        appHtml: document.getElementById('app') ? document.getElementById('app').innerHTML.slice(0, 300) : ''
      };
    })()
  `);
  console.log('Window info:', JSON.stringify(info, null, 2));

  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(__dirname, '..', 'live_page_check.png'), img.toPNG());
  console.log('Saved live_page_check.png');

  app.quit();
});
