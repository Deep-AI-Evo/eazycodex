# easyCodex

One-click install and launch **Codex** with **DeepSeek** as the backend model, designed for Chinese users who can't use official ChatGPT accounts.

## How It Works

easyCodex runs a local proxy server (http://127.0.0.1:18731) that sits between Codex and DeepSeek. When you click "launch Codex":

1. The proxy injects your DeepSeek API key into all requests
2. Codex's OpenAI Responses API calls are translated to DeepSeek's Chat Completions API
3. Streaming responses are translated back in real-time
4. auth.json uses a PROXY_MANAGED placeholder so Codex never needs OpenAI credentials

This is the same architecture as cc-switch (https://github.com/farion1231/cc-switch), but simplified into a single tool focused on DeepSeek.

## Prerequisites

- Codex desktop app installed (download from OpenAI or Microsoft Store)
- Windows 10/11 (x64)
- DeepSeek API key (get one at https://platform.deepseek.com/api_keys)

Node.js is optional - only needed if you want Codex CLI.

## Build Instructions

```bash
cd eazycodex
npm install
npm start          # development mode
npm run build      # build installer (.exe)
```

Output: dist/easyCodex Setup x.y.z.exe

### China mirror acceleration

GitHub downloads are slow in China. Use the mirror build script:

```bash
cd eazycodex
npm install
npm start          # development mode
npm run build      # build installer (.exe)
```

Or set environment variables manually before building:

```bash
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
npm run build
```

This reduces build time from ~5 minutes to ~15 seconds.

Output: dist/easyCodex Setup x.y.z.exe

## Usage

1. Install: Run the easyCodex Setup.exe installer
2. Configure: Open easyCodex, paste your DeepSeek API key, click Save
3. Launch: Click the big circular button to start Codex with DeepSeek

The proxy runs automatically in the background whenever easyCodex is open. Your API key is stored locally in ~/.codex/eazycodex.json.

## Architecture

```
Codex Desktop
    |
    | HTTP (Responses API wire format)
    v
easyCodex Proxy (127.0.0.1:18731)
    |
    | Translate: Responses API -> Chat Completions API
    | Inject: DeepSeek API Key
    v
DeepSeek API (api.deepseek.com)
```

### Key Files

- src/proxy.js - Local proxy server with API translation
- src/configManager.js - Writes config.toml and auth.json
- src/detector.js - Finds Codex installation (robust against version updates)
- src/launcher.js - Launches Codex desktop app
- src/main.js - Electron main process and IPC handlers
- src/renderer/ - Single-page UI (HTML/CSS/JS)

## Edge Cases Handled

- Codex self-update: detector searches OpenAI.Codex_* directories dynamically
- Existing config: backs up config.toml and auth.json before modifying
- cc-switch coexistence: both write to the same config.toml; easyCodex preserves non-model sections

## Icon

The app icon is SVG (assets/icon.svg). Generate a .ico before building:

```bash
npx svg-to-ico assets/icon.svg -o assets/icon.ico
```

## License

MIT
