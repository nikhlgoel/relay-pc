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

  win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    console.log(`[RENDERER ${level}] ${message} (${sourceId}:${line})`);
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
        console.log('pane-side ready! Waiting 3s for chat list...');
        await new Promise(r => setTimeout(r, 3000));

        // Click the first chat by finding the first element with role="listitem" or role="row" in pane-side
        const clicked = await win.webContents.executeJavaScript(`
          (() => {
            const side = document.getElementById('pane-side');
            if (!side) return { error: 'no pane-side' };
            
            // Find any chat element inside pane-side
            const items = side.querySelectorAll('[role="listitem"], [role="row"], div[tabindex="-1"]');
            console.log('Found items in pane-side:', items.length);
            for (const item of items) {
              const rect = item.getBoundingClientRect();
              if (rect.height > 40 && rect.width > 100) {
                console.log('Clicking item:', item.innerText ? item.innerText.slice(0, 30) : 'no text');
                item.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
                item.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
                item.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
                return { clicked: true, text: item.innerText ? item.innerText.slice(0, 30) : '' };
              }
            }
            return { clicked: false, itemsCount: items.length };
          })()
        `);
        console.log('Chat clicked result:', clicked);

        await new Promise(r => setTimeout(r, 2500));

        // Check if #main is visible
        const mainInfo = await win.webContents.executeJavaScript(`
          (() => {
            const main = document.getElementById('main');
            if (!main) return { hasMain: false };
            const footer = main.querySelector('footer');
            const input = footer ? footer.querySelector('div[contenteditable="true"]') : null;
            return {
              hasMain: true,
              hasFooter: Boolean(footer),
              hasInput: Boolean(input),
              inputClass: input ? input.className : null
            };
          })()
        `);
        console.log('Main info:', mainInfo);

        // Now test file delivery options:
        // Option 1: Drop event on #main
        // Option 2: Paste event on input
        // Option 3: file inputs
        const deliveryTest = await win.webContents.executeJavaScript(`
          (async () => {
            const results = {};
            const main = document.getElementById('main');
            if (!main) return { error: 'no main' };

            const testFile = new File(['Hello world test attachment content ' + Date.now()], 'test_doc.txt', { type: 'text/plain' });
            
            // 1. Try paste event on footer contenteditable div
            try {
              const editable = main.querySelector('footer div[contenteditable="true"]');
              if (editable) {
                editable.focus();
                const dt = new DataTransfer();
                dt.items.add(testFile);
                const pasteEv = new ClipboardEvent('paste', {
                  bubbles: true,
                  cancelable: true,
                  clipboardData: dt
                });
                editable.dispatchEvent(pasteEv);
                await new Promise(r => setTimeout(r, 1000));
                
                const hasSend = Boolean(document.querySelector('[data-icon="send"], button[aria-label*="send" i], [data-animate-media-viewer="true"]'));
                results.pasteOnEditable = hasSend;
                console.log('Paste on editable result:', hasSend);
              }
            } catch (err) {
              results.pasteOnEditableError = String(err);
            }

            // If not opened, try Drop event on main
            if (!results.pasteOnEditable) {
              try {
                const dt2 = new DataTransfer();
                dt2.items.add(testFile);
                
                // Dragover first
                const dragOverEv = new DragEvent('dragover', {
                  bubbles: true,
                  cancelable: true,
                  dataTransfer: dt2
                });
                main.dispatchEvent(dragOverEv);
                
                // Drop
                const dropEv = new DragEvent('drop', {
                  bubbles: true,
                  cancelable: true,
                  dataTransfer: dt2
                });
                main.dispatchEvent(dropEv);
                await new Promise(r => setTimeout(r, 1000));
                
                const hasSend = Boolean(document.querySelector('[data-icon="send"], button[aria-label*="send" i], [data-animate-media-viewer="true"]'));
                results.dropOnMain = hasSend;
                console.log('Drop on main result:', hasSend);
              } catch (err) {
                results.dropOnMainError = String(err);
              }
            }

            // If still not opened, inspect file inputs
            try {
              // Click attach button to ensure inputs are populated
              const attachBtn = main.querySelector('button[title*="Attach" i], [data-icon="plus"], [data-icon="attach-menu-plus"]');
              if (attachBtn) {
                const b = attachBtn.closest('button') || attachBtn;
                b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
                await new Promise(r => setTimeout(r, 600));
              }

              const fileInputs = Array.from(document.querySelectorAll('input[type="file"]'));
              results.fileInputs = fileInputs.map(fi => ({ accept: fi.accept, id: fi.id }));
              
              if (!results.pasteOnEditable && !results.dropOnMain) {
                // Try putting file into the * (document) input
                const docInput = fileInputs.find(fi => fi.accept === '*' || fi.accept.includes('*')) || fileInputs[0];
                if (docInput) {
                  const dt3 = new DataTransfer();
                  dt3.items.add(testFile);
                  docInput.files = dt3.files;
                  docInput.dispatchEvent(new Event('change', { bubbles: true }));
                  await new Promise(r => setTimeout(r, 1000));
                  const hasSend = Boolean(document.querySelector('[data-icon="send"], button[aria-label*="send" i], [data-animate-media-viewer="true"]'));
                  results.inputChange = hasSend;
                }
              }
            } catch (err) {
              results.fileInputError = String(err);
            }

            return results;
          })()
        `);
        console.log('Delivery test results:', deliveryTest);
        fs.writeFileSync('delivery-test-output.json', JSON.stringify(deliveryTest, null, 2));

        const img = await win.webContents.capturePage();
        fs.writeFileSync('scratch/live_delivery_view.png', img.toPNG());
        console.log('Saved screenshot to scratch/live_delivery_view.png');

        app.quit();
      }
    } catch (e) {
      console.error('Error during test:', e);
      clearInterval(timer);
      app.quit();
    }
  }, 1000);
});
