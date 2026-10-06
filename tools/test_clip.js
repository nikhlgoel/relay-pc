
const { app, clipboard } = require('electron');
app.whenReady().then(() => {
  const formats = clipboard.availableFormats();
  console.log('formats:', formats);
  for (const f of formats) {
    const buf = clipboard.readBuffer(f);
    console.log(f, 'len:', buf.length);
  }
  const hdrop = clipboard.readBuffer('CF_HDROP');
  console.log('CF_HDROP buffer len:', hdrop.length);
  app.quit();
});
