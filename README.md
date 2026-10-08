# Relay

A native Windows desktop client for WhatsApp, built on Electron and WhatsApp Web.
Unofficial: not affiliated with or endorsed by WhatsApp or Meta.

## Features

- Resizable chat list (drag the divider, double-click to reset)
- Frameless window; the header areas drag the window
- Tray icon, close-to-tray, start with Windows, optional global show/hide shortcut
- Native notifications; clicking one brings the window forward
- Unread badge on the taskbar icon (in your theme colour)
- Offline? A "can't reach WhatsApp" screen appears and Relay reconnects by itself
- Voice and video calls with screen sharing and a full-screen button on the call window. WhatsApp Web only offers calls to accounts it has enabled for; Relay switches that flag on locally, like the official Windows app (tray: **Enable calling**). Whether a call connects is up to WhatsApp's servers
- Call keys: `M` mute, `V` camera, `S` share screen, `F` full screen, `R` record. The pop-out call window comes back where you left it
- Screen sharing with a thumbnail picker; Relay's own windows are left out of the capture, so there is no mirror effect
- Call recording to `Videos/WA` (button in the call toolbar, or automatic; saved as it goes and closed when the call ends)
- Call quality: neural noise suppression (RNNoise), voice EQ and levelling, and a GPU camera cleanup (face-weighted exposure, shadow lift, colour, denoise, sharpen)
- **Translate chats**: incoming messages in any language appear under the original in casual, chat-style English. Per chat (button in the chat header) or for all chats. Best with a free OpenRouter key (free models), or your own Claude key; Google Translate works with no key. It asks before any text is sent
- **Relay panel** (button at the foot of the left rail): translation, do not disturb, call settings and quick replies in one place
- **Live captions** in calls (`C` or the CC button): the other person's speech is turned into text on your PC (whisper.cpp on your graphics card, nothing recorded or uploaded), the language is detected, and the captions are translated into the language you choose (English by default; English also works offline). Draggable, top or bottom, three sizes, normal and full screen. The speech model downloads once (60 MB, or 190 MB for "Accurate")
- **Sharper video**: the picture you receive in a call gets a light sharpening at your screen's resolution and a short, steady video buffer (Relay panel > Calls). Your own camera has its own cleanup
- **Back** from the mouse's side button, `Alt+Left` or the Windows back key: closes a preview, goes up a Settings page, then closes the open chat
- **For places where WhatsApp needs a VPN or proxy** (mainland China, Russia ...): Relay follows the Windows proxy; Relay panel > Network takes a proxy address; the model download falls back to a mirror (hf-mirror.com); the Relay panel, captions notice and the "can't reach WhatsApp" screen speak Chinese and Russian
- **Add-ons**: the speech models are not bundled; Relay offers the 60 MB one on first start and the Relay panel lists them. **Transcript** (panel footer) turns a call recording into a `.txt` and `.srt`. **Right-click a message > Translate** works for one message or for ticked messages
- **Live voice translation** (button on the call, or `T`): what the other person says is translated and spoken in a copy of *their* voice, while the original is turned down; your own voice goes to them translated, in a copy of *yours*, after a spoken notice that the call is translated automatically. Runs on your PC (translator on the graphics card; about 3 GB of models downloaded once, after a notice). Speaks English, Hindi, Chinese, Russian and Spanish; listens in any language. Expect about 2.5-4 s of delay per sentence, and a voice that moves towards the speaker's rather than matching it
- Screen stays awake during calls; on-demand call engine and idle trimming keep RAM down
- Multiple accounts, each with its own session
- Spellcheck, zoom, drag-and-drop and file paste, links open in your browser
- Context-aware right-click menu (links, images, text, inputs); email and phone links open in your mail or phone app; a notice when a download finishes
- Dark by default; the whole look (glow, accents, surfaces) follows the chat theme colour you pick in WhatsApp, else your Windows accent colour
- Smooth mouse-wheel scrolling in the chat list and side panels
- Do not disturb, optional privacy blur and telemetry blocking
- Browser-only prompts (download banner, "stay logged in", sign-up) removed

## Disclaimer

Relay is an independent, unofficial project. It is not affiliated with, authorised or endorsed by WhatsApp LLC or Meta Platforms, Inc. WhatsApp is a trademark of its owner. Relay is a window around WhatsApp Web: messaging, calls and your data are WhatsApp's own software and service. WhatsApp does not support third-party clients and may restrict access, so use it at your own risk and under WhatsApp's [Terms](https://www.whatsapp.com/legal/terms-of-service). Help > About Relay (F1) shows the full notice.

## Install

Download the installer or portable build from the
[Releases](https://github.com/nikhlgoel/whatsapp-pc/releases) page, then scan the QR
code once. The session is stored on your PC. The installer registers Relay with Windows
(Start menu and search, Default apps, `Win+R relay`) and is available in English, Chinese and Russian.

**Setup kit** (`npm run dist`, then `tools/build-kit.ps1`): a zip with `Install-Relay.cmd`, which removes the Microsoft Store and older Win32 WhatsApp,
earlier wrappers (Aura, WaDesk) and installs Relay in one go; optionally with offline speech models for PCs that cannot reach huggingface.co.
See `tools/setup-kit/README.txt` (English, Chinese, Russian).

## Build

Requires Node.js 22+ on Windows.

```bash
npm install
npm start          # run
npm test           # unit tests
npm run dist       # installer + portable build in dist/
```

`npm start` first gives the development `electron.exe` Relay's icon and name (once; `tools/brand-electron.js`), so the taskbar shows Relay instead of the Electron atom. `npm run start:debug` also opens the DevTools protocol on `127.0.0.1:9222`.

## Usage

| | |
|---|---|
| `Ctrl` `+` / `-` / `0` | Zoom in / out / reset |
| `F11` | Fullscreen |
| `Ctrl+Alt+W` | Show or hide from anywhere (off by default; tray menu > Global show/hide shortcut) |
| `Ctrl+W` | Hide to tray |
| `Ctrl+R` | Reload |

Right-click the tray icon for settings, **Resource usage**, and **Log out / reset session**.

**Multiple accounts:** start with `Relay.exe --profile=Work`. Each profile has its own
data folder (`%APPDATA%\Relay-Work`) and can run alongside the others.

Settings are in `%APPDATA%\Relay\config.json`.

## Project layout

```
src/main.js      window, tray, permissions, screen share, updates
src/preload.js   unread badge, notifications, layout, call quality, panel bridge
src/page/        in-page panel, translation, call keys, captions, back, sharper video, Chinese/Russian text
src/hub.js       panel settings, consent, translation requests, proxy and language choice
src/captions.js  live captions: speech model, engine process, translation (unit tested)
src/captions-engine.js  whisper.cpp in a utility process
src/voice.js, voice-engine.js, voice-ipc.js, voice/  live voice translation (the engine runs in a bundled Node.js process, tools/get-node.js fetches it at build time)
src/picker*, prompt*, about.html, offline.html  small native-style windows and the offline screen
src/vendor/      RNNoise (noise suppression)
src/assets/installer.nsh  Windows registration done by the installer (App Paths, Default apps, clean uninstall)
src/translate.js translation back-ends (unit tested)
src/theme.css    theme and layout styling
src/urls.js      URL allow-list (unit tested)
test/            unit tests
tools/           icon generator (npm run icons), setup kit (setup-kit/, build-kit.ps1)
```

## Third-party

Live captions use [whisper.cpp](https://github.com/ggerganov/whisper.cpp) (MIT, via `@fugood/node-whisper-win32-x64-vulkan`) and OpenAI's Whisper models (MIT),
downloaded on first use and checked against a pinned SHA-256. RNNoise (BSD-3) is bundled in `src/vendor/rnnoise`.

## License

MIT
