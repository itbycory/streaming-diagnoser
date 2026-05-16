# 📡 Stream Diagnoser

A personal sports streaming hub with real-time HLS diagnostics and automatic stream fixes. Paste any livestream URL and it plays — or browse live events by sport and click to watch.

![Sports tabs: MMA, Soccer, AFL, Cricket, Tennis, F1, Replays]

## Features

### Live Sports Hub
- **MMA & Boxing** — UFC, Bellator, ONE Championship live events
- **Soccer** — live matches worldwide
- **AFL** — Australian Football League
- **Cricket** — international and domestic matches
- **Tennis** — ATP/WTA tournaments
- **Formula 1** — race weekends, qualifying, sprints

### Replay System
- Browse UFC, Bellator, ONE Championship event archives
- Individual fight-level browsing — click a specific fight, not just the whole event
- Wikipedia fallback for older events (UFC 1–200 and beyond)
- YouTube stream discovery via yt-dlp
- Boxing search — find any fight by name (Fury vs Usyk, Canelo, etc.)

### HLS Diagnostics & Auto-Fix
- Real-time buffer, bandwidth, quality, and live-edge monitoring
- **Auto-lock quality** — prevents rapid quality switches on unstable connections
- **Buffer boost** — increases buffer depth when freezes are detected
- **Auto-reconnect** — recovers from network drops automatically
- Live charts: buffer health (30s) and bandwidth estimate (30s)
- Event log showing every auto-fix applied

### CDN Bypass
- Puppeteer-based proxy for CDN streams that block Node.js (`modifiles.fans` and similar)
- TLS fingerprint spoofing (Chrome 131) via `node-tls-client`
- Stealth plugin hides automation signals
- Parallel range-request fetching (N=16) for maximum segment throughput

### Cast to TV
- Chromecast support via mDNS device discovery
- Auto-detects Chromecast devices on your local network

## Requirements

- **Node.js** 18+
- **yt-dlp** — for YouTube replay search
- **Chromium** — bundled via `puppeteer-core` (auto-downloaded on first run)

## Setup

```bash
# Install dependencies
npm install

# Install yt-dlp
npm run install-yt-dlp

# Start the server
npm start
```

Then open **http://localhost:3847** in your browser.

### Electron Desktop App

```bash
# Run as a native desktop app
npm run app
```

## Configuration

Copy `config.json.example` to `config.json` if you need to store any local settings. This file is gitignored and never committed.

## Architecture

```
server.js          Express + WebSocket backend (port 3847)
public/
  app.js           Frontend — HLS.js player, diagnostics, sports hub UI
  index.html       UI shell
  style.css        Dark sports-watching theme
electron.js        Electron wrapper for desktop app
Dockerfile         Container deployment
```

### Stream Resolution Flow

1. URL pasted → static scan for `.m3u8` links
2. If not found → Puppeteer stealth scan intercepts XHR/fetch requests
3. Found stream URLs routed through `/proxy/pup` (Puppeteer session proxy) or `/proxy/stream` (standard HLS proxy)
4. HLS.js plays the proxied stream in-browser with full diagnostic events

### Replay Discovery Flow

1. Search watchmmafull.com for recent events (UFC/Bellator/ONE, ~last 2 years)
2. Fallback to Wikipedia fight card parsing for older events
3. Per-fight YouTube search via yt-dlp (`ytsearchN:` syntax)
4. Stream extracted and played via same HLS pipeline

## Notes

- CDN tokens are time-limited — streams go offline when the event ends (expected 403s)
- `internalException` errors from HLS.js are non-fatal and filtered from the log
- Port 3847 is fixed (`autoPort: false`) for Chromecast compatibility
