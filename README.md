# WhatsApp PC

A lightweight Electron wrapper around WhatsApp Web — the same client the official
desktop app runs, without the extra layers that make it hang, and with the
sidebar/chat split the PWA won't let you touch.

## Resizable sidebar

WhatsApp Web pins the chat list to a fixed proportion of the window and gives you
no handle to change it. This app adds one: **drag the divider** between the chat
list and the conversation, or **double-click it** to snap back to 30%. The width
is clamped to 260px–60% of the window and remembered across restarts.

It works without depending on WhatsApp's generated class names, which change
constantly. At runtime it finds `#pane-side`, walks up to the ancestor that stops
spanning the full app width — that's the sidebar column — marks its wide siblings
as the chat area, and drives both through a CSS custom property. If React
remounts the layout, it re-attaches within a few seconds and keeps your width.

The handle sits just outside the sidebar rather than straddling the boundary, so
it never covers the chat list's scrollbar. That scrollbar's thumb — a faint white
line in WhatsApp's own styling — is hidden unless you hover the list; only the
non-hover state is overridden, so WhatsApp's own colour still applies on hover
and the light theme is unaffected.

Tray → *Reset sidebar width* if it ever ends up somewhere odd.

## No "Get WhatsApp for Windows" upsell

We *are* the Windows app, so the download banner in the chat list — and the
matching card on the login screen — are removed.

Class names are generated and change constantly, so [src/preload.js:63](src/preload.js:63)
matches the promo text and the download link instead, then hides the smallest
enclosing banner. Anything inside a chat row or the conversation pane is skipped,
so a message that happens to contain the same words is never hidden. If WhatsApp
re-renders the banner it is hidden again within a few seconds.

## Translucent icon rail

The narrow rail holding your profile picture uses the Windows 11 acrylic
backdrop, so the desktop shows through it. Everything behind the rail is made
transparent and the chat list is given back an opaque surface sampled from the
current theme, which keeps the effect confined to the rail in both light and
dark mode. Tray → *Translucent sidebar* turns it off.

`backgroundMaterial` must **not** be passed to the `BrowserWindow` constructor:
doing so makes Windows report the window as non-maximizable and greys out the
maximize button. Applying it with `setBackgroundMaterial()` after creation gives
an identical backdrop with the caption buttons intact.

## Keyboard

| | |
|---|---|
| `Ctrl` `+` / `-` / `0` | Zoom in, out, reset — also `Ctrl` + numpad `+`/`-`, and `Ctrl` + mouse wheel |
| `F11` | Fullscreen |
| `Ctrl+Shift+W` | Show/hide from anywhere |
| `Ctrl+R` | Reload |
| `Ctrl+W` | Hide to tray |

Zoom and F11 are handled from `before-input-event` rather than menu
accelerators, because WhatsApp Web swallows those keys before a menu
accelerator would see them, and because "zoom in" is `Ctrl+=` on some layouts
and `Ctrl+Shift+=` or numpad `+` on others.

## Resource use

The point is to run the messaging parts of Chromium and nothing else.

**Switched off** — subsystems WhatsApp never touches, each of which otherwise
costs threads, memory or background network:

| Off | What it was doing |
|---|---|
| `SpareRendererForSitePerProcess` | holding an entire idle renderer process in reserve |
| Component updater | periodically phoning home for Chromium sub-component updates |
| Breakpad | crash-report collection (removes the crashpad process entirely) |
| Optimization hints/guide | fetching ML models from Google in the background |
| MediaRouter / DIAL | scanning your LAN for Chromecast devices |
| Translate | running language detection on page content |
| Autofill server comms, domain reliability, phishing detection, sync, speech API, print preview, hyperlink pings | — |

Analytics and crash endpoints (Google Analytics, GTM, DoubleClick, Crashlytics,
Sentry, `crashlogs.whatsapp.net`) are blocked at the network layer. None carry
message traffic, media or presence, so nothing breaks. Toggle in the tray menu.

The disk cache is capped at 96 MB, and only one spellcheck dictionary is loaded
instead of the set Chromium fetches on demand.

**The one deliberate tradeoff.** Timers are *never* throttled — a websocket app
that gets put to sleep delivers messages late, which defeats the point. Process
*priority* when hidden is a separate question, and **Low power when hidden**
(tray menu, on by default) leaves that to Windows so the app stops costing much
while it sits in the tray. Turn it off if you'd rather it never de-prioritises,
at the cost of idle CPU.

Always 5 processes, and no more:

| Process | |
|---|---|
| renderer | WhatsApp itself |
| renderer | WhatsApp's service worker — required for notifications |
| gpu-process | compositing (disable via tray → Hardware acceleration) |
| browser | the app's main process |
| utility | network service |

Measured private bytes: ~387 MB at the login screen, ~750 MB signed in with chat
history loaded on a 1920px display. Most of that is WhatsApp's own renderer
holding your conversations and media thumbnails — it is what the PWA costs too.
The savings here are in what *isn't* there: no crashpad process, no spare
renderer, no background updater or model downloads.

Tray → **Resource usage…** shows this live at any time.

## Why it shouldn't freeze the way the official app does

- **Current Chromium.** Electron 33 ships a far newer Chromium than the official
  desktop build, which is where most of the "Not Responding" stalls come from.
- **No timer throttling**, so it never has to thrash catching up after being hidden.
- **Self-healing.** If the renderer or the network drops, the app reloads instead
  of sitting on a white window.
- **No updater or telemetry side-processes.**

## Running it

```bash
npm start
```

First launch shows the QR code. Scan it once — the session lives in a persistent
partition, so it survives restarts.

## Building an installer

```bash
npm run dist
```

Produces, in `dist/`:
- `WhatsApp Setup 1.0.0.exe` — NSIS installer (per-user, no admin needed)
- `WhatsApp-portable-1.0.0.exe` — single-file portable build

For a quick unpacked build without installers: `npm run pack`.

## Features

| | |
|---|---|
| Resizable split | Drag the divider; double-click to reset |
| No upsell | The "Get WhatsApp for Windows" banner is removed |
| Tray icon | Click to show/hide; right-click for settings |
| Close to tray | On by default |
| Unread badge | Green count overlay on the taskbar icon + tray tooltip |
| Notifications | Native Windows toasts; clicking one focuses the window |
| Start with Windows | Tray menu toggle |
| Spellcheck | Right-click a misspelled word for suggestions |
| Zoom | `Ctrl +` / `Ctrl -` / `Ctrl 0`, remembered between runs |
| Global hotkey | `Ctrl+Shift+W` shows/hides the window |
| Window state | Size, position and maximized state are restored |
| External links | Open in your default browser, not in the app |

## Settings and data

Preferences: `%APPDATA%\whatsapp-pc\config.json`
Session data: `%APPDATA%\whatsapp-pc\Partitions\whatsapp`

"Log out / reset session" in the tray menu clears the session and shows the QR
code again.

## Icons

Generated from `brand/whatsapp-logo.jpg`:

```bash
npm run icons -- brand/whatsapp-logo.jpg
```

The source is a stock "transparent PNG" mockup flattened to JPEG, so its
checkerboard is real pixels. [tools/make-icons.js](tools/make-icons.js) keys it
out by greenness — which doubles as an antialiased alpha channel — crops to the
logo, and writes `icon.png`, `icon.ico` (7 sizes) and the tray icons. It runs
under Electron so `nativeImage` handles JPEG decoding; no imaging dependencies.

Point it at a different image any time to rebrand.

## Layout

```
src/main.js      main process: window, tray, menus, badge, runtime flags
src/preload.js   renderer: unread count, notification click, resizable panes
src/assets/      generated icons
brand/           source logo
tools/           icon generator
```

## Build troubleshooting

If `npm run dist` fails with *"Cannot create symbolic link ... libcrypto.dylib"*,
electron-builder is trying to unpack macOS symlinks from its code-signing bundle,
which Windows blocks without Developer Mode. We don't sign, so prime the cache
without the darwin folder once:

```bash
node_modules/7zip-bin/win/x64/7za.exe x -xr'!darwin' -o"$LOCALAPPDATA/electron-builder/Cache/winCodeSign/winCodeSign-2.6.0" "$LOCALAPPDATA/electron-builder/Cache/winCodeSign/winCodeSign-2.6.0.7z"
```

Similarly, if `node_modules/electron/dist/` ends up with only a licence file,
npm's install-script sandbox truncated the extraction. Unpack the cached zip by
hand and write `path.txt` containing `electron.exe`:

```bash
powershell -c "Expand-Archive $env:LOCALAPPDATA\electron\Cache\*\electron-v33.4.11-win32-x64.zip node_modules\electron\dist -Force"
```
