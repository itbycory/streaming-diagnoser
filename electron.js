const { app, BrowserWindow, shell } = require('electron');
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ── Cross-platform log path ───────────────────────────────────────────────────
const LOG = path.join(os.tmpdir(), 'StreamDiagnoser.log');
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  process.stdout.write(line);
  try { fs.appendFileSync(LOG, line); } catch {}
}

log(`electron.js start — platform=${process.platform} __dirname=${__dirname}`);

// ── Performance flags ─────────────────────────────────────────────────────────
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

let mainWindow;
let serverProcess;

// ── Find Node.js binary ───────────────────────────────────────────────────────
// On Windows (packaged app), we use Electron itself with ELECTRON_RUN_AS_NODE=1
// — Electron IS Node.js, so no separate Node install is needed.
function findNode() {
  if (process.platform === 'win32') {
    return process.execPath; // Electron binary → will run as Node via env var
  }
  const candidates = [
    '/usr/local/bin/node',
    '/opt/homebrew/bin/node',
    '/usr/bin/node',
    process.execPath, // fallback: Electron itself
  ];
  for (const p of candidates) {
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch {}
  }
  return process.execPath;
}

// ── Wait for Express ──────────────────────────────────────────────────────────
function waitForServer(port, timeoutMs = 30000) {
  return new Promise(resolve => {
    const start = Date.now();
    const check = setInterval(() => {
      if (Date.now() - start > timeoutMs) { clearInterval(check); resolve(false); return; }
      const req = http.get(`http://127.0.0.1:${port}/`, res => {
        res.resume(); clearInterval(check); resolve(true);
      });
      req.on('error', () => {});
      req.setTimeout(400, () => req.destroy());
    }, 300);
  });
}

// ── App ready ─────────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  log('app ready');

  const isWin = process.platform === 'win32';

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    // titleBarStyle: 'hiddenInset' is macOS-only; omit on Windows
    ...(isWin ? {} : { titleBarStyle: 'hiddenInset' }),
    backgroundColor: '#0d0f14',
    title: 'Stream Diagnoser',
    show: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  mainWindow.show();
  mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<!DOCTYPE html><html><head><style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{background:#0d0f14;color:#e8ecf4;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;
    display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;gap:16px}
    .icon{font-size:56px}.dot{animation:p 1s infinite;display:inline-block}
    @keyframes p{0%,100%{opacity:.3}50%{opacity:1}}
  </style></head><body>
    <div class="icon">📡</div>
    <h1 style="font-size:22px;font-weight:600">Stream Diagnoser</h1>
    <p style="color:#8b93b0;font-size:13px">Starting server<span class="dot">…</span></p>
  </body></html>`)}`);

  // ── Spawn server.js ───────────────────────────────────────────────────────
  const nodeBin = findNode();
  const useElectronAsNode = nodeBin === process.execPath;
  log(`Using Node binary: ${nodeBin} (electron-as-node: ${useElectronAsNode})`);

  const spawnEnv = {
    ...process.env,
    ...(useElectronAsNode ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
  };

  try {
    serverProcess = spawn(nodeBin, [path.join(__dirname, 'server.js')], {
      cwd: __dirname,
      env: spawnEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Pipe server output to our log so it's visible
    if (serverProcess.stdout) serverProcess.stdout.on('data', d => log(`[server] ${d.toString().trim()}`));
    if (serverProcess.stderr) serverProcess.stderr.on('data', d => log(`[server-err] ${d.toString().trim()}`));

    serverProcess.on('error', err => log(`Server spawn error: ${err.message}`));
    serverProcess.on('exit', code => log(`Server exited with code ${code}`));
    log(`Server spawned (pid ${serverProcess.pid})`);
  } catch (err) {
    log(`Failed to spawn server: ${err.message}`);
  }

  const ready = await waitForServer(3847);
  log(`Server ready: ${ready}`);

  if (!mainWindow || mainWindow.isDestroyed()) return;

  if (ready) {
    mainWindow.loadURL('http://127.0.0.1:3847');
  } else {
    mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<!DOCTYPE html><html><head><style>
      *{margin:0;padding:0;box-sizing:border-box}
      body{background:#0d0f14;color:#f0524f;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;
      padding:48px;line-height:1.6}
      code{background:#1a1d26;color:#e8ecf4;padding:2px 6px;border-radius:4px}
      p{color:#8b93b0;margin-top:12px}
    </style></head><body>
      <h2>Server failed to start</h2>
      <p>Log file: <code>${LOG}</code></p>
      <p>Try closing and reopening the app. If the issue persists, check the log for details.</p>
    </body></html>`)}`);
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => { mainWindow = null; app.quit(); });
}).catch(err => log(`whenReady error: ${err.message}`));

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  if (serverProcess) {
    try { serverProcess.kill(); } catch {}
    serverProcess = null;
  }
});

process.on('uncaughtException', err => log(`uncaughtException: ${err.stack}`));
