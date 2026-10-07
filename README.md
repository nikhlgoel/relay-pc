# Relay

A native Windows desktop client for WhatsApp, built on Electron and WhatsApp Web.
Unofficial: not affiliated with or endorsed by WhatsApp or Meta.

## Features

- Resizable chat list (drag the divider, double-click to reset)
- Frameless window; the header areas drag the window
- Tray icon, close-to-tray, start with Windows, global show/hide shortcut
- Native notifications; clicking one brings the window forward
- Unread badge on the taskbar icon
- Voice and video calls with screen sharing
- Call quality: adaptive camera exposure, voice EQ, compression and limiting (tray toggles)
- Multiple accounts, each with its own session
- Spellcheck, zoom, drag-and-drop and file paste, links open in your browser
- Optional privacy blur and telemetry blocking
- Browser-only prompts (download banner, "stay logged in", sign-up) removed

## Install

Download the installer or portable build from the
[Releases](https://github.com/nikhlgoel/whatsapp-pc/releases) page, then scan the QR
code once. The session is stored on your PC.

## Build

Requires Node.js 20+ on Windows.

```bash
npm install
npm start          # run
npm test           # unit tests
npm run dist       # installer + portable build in dist/
```

`npm run start:debug` also opens the DevTools protocol on `127.0.0.1:9222`.

## Usage

| | |
|---|---|
| `Ctrl` `+` / `-` / `0` | Zoom in / out / reset |
| `F11` | Fullscreen |
| `Ctrl+Shift+W` | Show or hide from anywhere |
| `Ctrl+W` | Hide to tray |
| `Ctrl+R` | Reload |

Right-click the tray icon for settings, **Resource usage**, and **Log out / reset session**.

**Multiple accounts:** start with `Relay.exe --profile=Work`. Each profile has its own
data folder (`%APPDATA%\Relay-Work`) and can run alongside the others.

Settings are in `%APPDATA%\Relay\config.json`.

## Project layout

```
src/main.js      window, tray, permissions, screen share, updates
src/preload.js   unread badge, notifications, layout, call quality
src/theme.css    theme and layout styling
src/urls.js      URL allow-list (unit tested)
test/            unit tests
tools/           icon generator (npm run icons)
```

## License

MIT
