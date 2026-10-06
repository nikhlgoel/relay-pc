
const { app, clipboard } = require('electron');
app.whenReady().then(() => {
  for (const fmt of ['FileNameW', 'FileName', 'Shell IDList Array']) {
    const buf = clipboard.readBuffer(fmt);
    console.log(fmt, 'size:', buf.length);
    console.log(fmt, 'hex:', buf.toString('hex').slice(0, 200));
  }
  app.quit();
});
