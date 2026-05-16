// ===== State =====
let hls = null;
let video = null;
let statsInterval = null;
let bufferHistory = [];
let bwHistory = [];
let bufferChart = null;
let bwChart = null;
let qualitySwitchLog = [];       // timestamps of recent quality switches
let stallCount = 0;
let totalStallMs = 0;
let stallStart = null;
let currentStreamInfo = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
const MAX_RECONNECT = 5;
let rescanAttempts = 0;
const MAX_RESCAN = 2;
let _silentRecoveryInProgress = false;

// ── Replay state ──────────────────────────────────────────────────────────────
let _isReplayMode = false;
let _replayContext = null;  // { promo, openSlug, filter } — saved when entering replay

// Active fixes state (for the fix badge bar)
const activeFixes = {
  qualityLocked: false,
  qualityLockedAt: '',
  bufferBoosted: false,
  reconnecting: false,
};
const CHART_POINTS = 30;

// ===== DOM =====
const urlInput      = document.getElementById('url-input');
const loadBtn       = document.getElementById('load-btn');
const loadBtnText   = document.getElementById('load-btn-text');
const loadSpinner   = document.getElementById('load-spinner');
const clearBtn      = document.getElementById('clear-btn');
const mainContent   = document.getElementById('main-content');
const landing       = document.getElementById('landing');
const errorBanner   = document.getElementById('error-banner');
const errorMsg      = document.getElementById('error-msg');
const errorTitle    = document.getElementById('error-title');
const overlayMsg    = document.getElementById('overlay-msg');
const overlayText   = document.getElementById('overlay-text');
const streamTitle   = document.getElementById('stream-title');
const liveBadge     = document.getElementById('live-badge');
const qualitySelect = document.getElementById('quality-select');
const networkBadge  = document.getElementById('network-badge');
const refererRow    = document.getElementById('referer-row');
const refererInput  = document.getElementById('referer-input');
const refererClear  = document.getElementById('referer-clear');

// ===== WebSocket (for scan progress) =====
let ws;
function initWs() {
  ws = new WebSocket(`ws://${location.host}`);
  ws.addEventListener('message', e => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'scan_progress') {
        setLoading(true, '🔍 ' + msg.msg);
        log('info', '🔍', msg.msg);
      } else if (msg.type === 'alt_stream_ready') {
        addAltStreamCandidate(msg);
      }
    } catch {}
  });
  ws.addEventListener('close', () => setTimeout(initWs, 2000));
}

// ===== Init =====
window.addEventListener('DOMContentLoaded', () => {
  video = document.getElementById('video');
  initCharts();
  checkNetworkSpeed();
  initWs();

  urlInput.addEventListener('input', () => {
    clearBtn.style.display = urlInput.value ? '' : 'none';
    // Show referer row when a direct stream URL is pasted
    const v = urlInput.value;
    const isDirectStream = v.includes('.m3u8') || v.includes('.mpd');
    refererRow.style.display = isDirectStream ? '' : 'none';
  });
  urlInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') loadStream();
  });
  clearBtn.addEventListener('click', () => {
    urlInput.value = '';
    clearBtn.style.display = 'none';
    refererRow.style.display = 'none';
    urlInput.focus();
  });
  refererInput.addEventListener('input', () => {
    refererClear.style.display = refererInput.value ? '' : 'none';
  });
  refererInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') loadStream();
  });
  refererClear.addEventListener('click', () => {
    refererInput.value = '';
    refererClear.style.display = 'none';
  });
  loadBtn.addEventListener('click', loadStream);

  qualitySelect.addEventListener('change', () => {
    if (!hls) return;
    const level = parseInt(qualitySelect.value);
    hls.currentLevel = level;
    if (level === -1) {
      hls.autoLevelEnabled = true;
      log('info', '🔄', 'Switched to Auto quality (ABR enabled)');
    } else {
      hls.autoLevelEnabled = false;
      const l = hls.levels[level];
      log('info', '📌', `Locked quality to ${l ? l.height + 'p' : 'level ' + level}`);
    }
  });

  // ── Keyboard shortcuts ──────────────────────────────────────────────────────
  document.addEventListener('keydown', e => {
    // Don't steal keys when user is typing in an input
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    // Only act when a stream is loaded
    if (!video || mainContent.style.display === 'none') return;

    switch (e.key) {
      case 'ArrowLeft':
      case 'j': {                          // ← or J  →  back 5s (hold Shift for 30s)
        e.preventDefault();
        const back = e.shiftKey ? 30 : 5;
        video.currentTime = Math.max(0, video.currentTime - back);
        showSeekToast(`⏪ −${back}s`);
        break;
      }
      case 'ArrowRight':
      case 'l': {                          // → or L  →  forward 5s (hold Shift for 30s)
        e.preventDefault();
        const fwd = e.shiftKey ? 30 : 5;
        if (video.duration && isFinite(video.duration))
          video.currentTime = Math.min(video.duration, video.currentTime + fwd);
        else
          video.currentTime += fwd;
        showSeekToast(`⏩ +${fwd}s`);
        break;
      }
      case ' ':
      case 'k':                            // Space or K  →  play/pause
        e.preventDefault();
        if (video.paused) video.play().catch(() => {});
        else video.pause();
        break;
      case 'ArrowUp':                      // ↑  →  volume up 10%
        e.preventDefault();
        video.volume = Math.min(1, video.volume + 0.1);
        showSeekToast(`🔊 ${Math.round(video.volume * 100)}%`);
        break;
      case 'ArrowDown':                    // ↓  →  volume down 10%
        e.preventDefault();
        video.volume = Math.max(0, video.volume - 0.1);
        showSeekToast(video.volume === 0 ? '🔇 Muted' : `🔉 ${Math.round(video.volume * 100)}%`);
        break;
      case 'm':
      case 'M':                            // M  →  mute toggle
        e.preventDefault();
        video.muted = !video.muted;
        showSeekToast(video.muted ? '🔇 Muted' : '🔊 Unmuted');
        break;
      case 'f':
      case 'F':                            // F  →  fullscreen toggle
        e.preventDefault();
        if (!document.fullscreenElement) {
          const wrap = video.closest('.video-wrap') || video;
          wrap.requestFullscreen().catch(() => {});
        } else {
          document.exitFullscreen().catch(() => {});
        }
        break;
      case 'Escape':                       // Esc  →  stop stream, go home
        e.preventDefault();
        stopStream();
        break;
    }
  });
});

// ── Seek toast (brief on-screen indicator) ────────────────────────────────────
let _toastTimer = null;
function showSeekToast(msg) {
  let toast = document.getElementById('seek-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'seek-toast';
    toast.className = 'seek-toast';
    document.querySelector('.video-wrap')?.appendChild(toast);
  }
  toast.textContent = msg;
  toast.classList.add('visible');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => toast.classList.remove('visible'), 800);
}

// ===== Network speed check =====
async function checkNetworkSpeed() {
  try {
    const res = await fetch('/api/speedtest');
    const data = await res.json();
    if (data.speedMbps !== null) {
      const mbps = data.speedMbps;
      let cls, label;
      if (mbps >= 10)       { cls = 'badge-good'; label = `${mbps} Mbps ✓`; }
      else if (mbps >= 3)   { cls = 'badge-warn'; label = `${mbps} Mbps`; }
      else                  { cls = 'badge-bad';  label = `${mbps} Mbps – Slow`; }
      networkBadge.className = `badge ${cls}`;
      networkBadge.innerHTML = `<span class="dot"></span> ${label}`;
    } else {
      networkBadge.className = 'badge badge-neutral';
      networkBadge.innerHTML = `<span class="dot"></span> Network unknown`;
    }
  } catch {
    networkBadge.className = 'badge badge-neutral';
    networkBadge.innerHTML = `<span class="dot"></span> Network unknown`;
  }
}

// ===== Load Stream =====
async function loadStream() {
  const inputUrl = urlInput.value.trim();
  if (!inputUrl) { urlInput.focus(); return; }

  const referer = refererInput.value.trim() || '';

  dismissError();
  hideCandidates();
  setLoading(true, 'Scanning page…');
  stopCurrentStream();
  reconnectAttempts = 0;
  rescanAttempts = 0;

  // For direct stream URLs: probe first so we know what we're dealing with
  const isDirectStream = inputUrl.includes('.m3u8') || inputUrl.includes('.mpd');
  if (isDirectStream) {
    setLoading(true, 'Probing stream…');
    const probe = await probeUrl(inputUrl, referer);
    if (!probe.ok) {
      const hint = probe.status === 403
        ? `The CDN is blocking our request (403 Forbidden). ${referer ? 'Try a different page URL in the Referer field.' : 'Paste the website URL you were watching in the "Page URL" field below the stream URL — the CDN checks this.'}`
        : probe.status === 404
        ? 'This stream URL no longer exists (404). Live URLs expire fast — go back and copy a fresh one from DevTools.'
        : probe.error
        ? `Could not reach the stream: ${probe.error}`
        : `Server returned ${probe.status}.`;
      showError('Stream unreachable', '', hint);
      setLoading(false);
      return;
    }
    log('info', '✅', `Stream reachable — HTTP ${probe.status}, type: ${probe.contentType || 'unknown'}`);
  }

  setLoading(true, isDirectStream ? 'Loading…' : 'Scanning page…');

  try {
    const res = await fetch('/api/extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inputUrl, referer })
    });
    const data = await res.json();

    if (!data.success) {
      showError('Could not load stream', data.error || 'Unknown error', data.hint);
      setLoading(false);
      return;
    }

    currentStreamInfo = data;
    streamTitle.textContent = data.title || 'Live Stream';
    liveBadge.style.display = data.isLive === false ? 'none' : '';
    // Show cast wrap whenever a stream is loaded
    const castWrap = document.getElementById('cast-wrap');
    if (castWrap) castWrap.style.display = '';

    showMainContent();
    clearLog();
    resetStats();

    if (data.scanned) {
      const method = data.scanMethod === 'dynamic' ? 'headless browser (intercepted XHR)' : 'page HTML/JS scan';
      log('info', '🔍', `Found via ${method} — ${data.candidates?.length || 1} stream URL(s)`);
    }
    log('info', '🎬', `Stream: ${data.title || inputUrl}`);
    log('info', '🔗', `Type: ${data.type.toUpperCase()}`);

    // Show candidate picker if multiple streams found
    if (data.candidates && data.candidates.length > 1) {
      showCandidates(data.candidates, data.streamUrl);
    }

    playStream(data);
  } catch (err) {
    showError('Network error', err.message);
  }

  setLoading(false);
}

function playStream(data) {
  if (data.type === 'hls' || data.streamUrl.includes('.m3u8') || data.streamUrl.includes('/proxy/')) {
    startHLS(data.streamUrl);
  } else {
    startNative(data.streamUrl);
  }
  // If already casting, send new stream to the Chromecast
  if (_activeCastDeviceId) castToDevice(_activeCastDeviceId, '');
}

async function probeUrl(url, referer) {
  try {
    const res = await fetch('/api/probe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, referer })
    });
    return await res.json();
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ===== Candidate picker (when multiple streams found on page) =====
function showCandidates(candidates, currentUrl) {
  let picker = document.getElementById('candidate-picker');
  if (!picker) {
    picker = document.createElement('div');
    picker.id = 'candidate-picker';
    picker.className = 'candidate-picker';
    // Insert below quality bar
    const qualityBar = document.querySelector('.quality-bar');
    qualityBar.parentNode.insertBefore(picker, qualityBar.nextSibling);
  }
  picker.innerHTML = `
    <span class="candidate-label">🔍 ${candidates.length} stream source(s) — switch if this one buffers:</span>
    <div class="candidate-list">
      ${candidates.map((c, i) => {
        const isActive = c.url && (c.url === currentUrl || c.rawUrl === currentUrl);
        const isPending = c.pendingScan;
        return `
        <button class="candidate-btn${isActive ? ' active' : ''}${isPending ? ' pending' : ''}"
                id="alt-btn-${i}" onclick="switchCandidate(${i})">
          ${c.label}
          <small>${isPending ? 'click to activate' : (c.rawUrl ? truncateUrl(c.rawUrl, 36) : '')}</small>
        </button>`;
      }).join('')}
    </div>
  `;
  picker.style.display = '';
  // Store candidates globally
  window._candidates = candidates;
}

function hideCandidates() {
  const picker = document.getElementById('candidate-picker');
  if (picker) picker.style.display = 'none';
  window._candidates = null;
}

async function switchCandidate(index) {
  const candidates = window._candidates;
  if (!candidates || !candidates[index]) return;
  let c = candidates[index];

  // Alt source not yet scanned — trigger the scan now, show progress in its button
  if (c.pendingScan) {
    const btn = document.getElementById(`alt-btn-${index}`);
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = `${c.label} <small>scanning…</small>`;
    }
    log('info', '🔍', `Scanning ${c.source} source — one moment…`);
    showOverlay('Scanning alternative source…');
    try {
      const res = await fetch('/api/scan-alt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ embedUrl: c.embedUrl, primarySid: c.primarySid }),
      }).then(r => r.json());

      if (!res.success || !res.streamUrl) {
        if (btn) {
          btn.disabled = false;
          btn.innerHTML = `${c.label} <small>no stream found</small>`;
        }
        hideOverlay();
        log('warn', '⚠️', `No stream found at ${c.source}`);
        return;
      }
      // Upgrade the candidate entry; use quality label if the scan returned one
      const qualityLabel = res.candidates?.[0]?.label;
      const finalLabel = qualityLabel || c.label;
      candidates[index] = { ...c, url: res.streamUrl, rawUrl: res.rawUrl || res.streamUrl,
        sessionId: res.sessionId, pendingScan: false, label: finalLabel };
      c = candidates[index];
      if (btn) {
        btn.disabled = false;
        btn.classList.remove('pending');
        btn.innerHTML = `${finalLabel} <small>${truncateUrl(c.rawUrl, 36)}</small>`;
      }
    } catch (e) {
      if (btn) { btn.disabled = false; btn.innerHTML = `${c.label} <small>scan failed</small>`; }
      hideOverlay();
      log('warn', '⚠️', `Alt scan error: ${e.message}`);
      return;
    }
  }

  stopCurrentStream();
  resetStats();
  clearLog();
  log('info', '🔀', `Switching to ${c.label}: ${c.rawUrl}`);
  currentStreamInfo = { ...currentStreamInfo, streamUrl: c.url, rawUrl: c.rawUrl,
    sessionId: c.sessionId || null,
    type: (c.rawUrl || c.url || '').includes('.mpd') ? 'dash' : 'hls' };
  // Update active button
  document.querySelectorAll('.candidate-btn').forEach((btn, i) => {
    btn.classList.toggle('active', i === index);
  });
  playStream(currentStreamInfo);
}

// Called when server announces an alternative source (either ready or pending scan).
// Adds it to the candidate picker without disrupting the playing stream.
function addAltStreamCandidate(msg) {
  if (!mainContent || mainContent.style.display === 'none') return;
  if (!window._candidates) window._candidates = [];

  // Avoid duplicates — key by embedUrl (pending) or streamUrl (ready)
  const key = msg.embedUrl || msg.streamUrl;
  if (window._candidates.some(c => (c.embedUrl || c.url) === key)) return;

  const isPending = !!msg.pendingScan;
  const candidate = {
    url: msg.streamUrl || null,
    rawUrl: msg.streamUrl || null,
    embedUrl: msg.embedUrl || null,
    label: msg.label || msg.source || 'Alt',
    sessionId: msg.sessionId || null,
    pendingScan: isPending,
    primarySid: msg.primarySid || null,
    source: msg.source,
  };
  window._candidates.push(candidate);
  const idx = window._candidates.length - 1;

  const existingPicker = document.getElementById('candidate-picker');
  if (!existingPicker || existingPicker.style.display === 'none') {
    showCandidates(window._candidates, currentStreamInfo?.streamUrl);
  } else {
    const list = existingPicker.querySelector('.candidate-list');
    if (list) {
      const btn = document.createElement('button');
      btn.className = `candidate-btn${isPending ? ' pending' : ''}`;
      btn.id = `alt-btn-${idx}`;
      btn.onclick = () => switchCandidate(idx);
      btn.innerHTML = isPending
        ? `${candidate.label} <small>click to activate</small>`
        : `${candidate.label} <small>ready — click to switch</small>`;
      list.appendChild(btn);
    }
  }

  const readyMsg = isPending
    ? `Alt source available: ${candidate.label} — click to activate`
    : `Alt stream ready: ${candidate.label} — click to switch`;
  log('info', '📡', readyMsg);
}

function truncateUrl(u, max) {
  try {
    const parsed = new URL(u);
    const short = parsed.hostname + parsed.pathname;
    return short.length > max ? '…' + short.slice(-max) : short;
  } catch { return u.slice(-max); }
}

// ===== HLS Playback =====
function startHLS(streamUrl) {
  if (!Hls.isSupported()) {
    // Fallback to native (Safari)
    startNative(streamUrl);
    return;
  }

  _silentRecoveryInProgress = false;
  const hlsConfig = buildHlsConfig();
  hls = new Hls(hlsConfig);

  hls.on(Hls.Events.MEDIA_ATTACHED, () => {
    log('info', '📡', 'HLS engine attached');
  });

  hls.on(Hls.Events.MANIFEST_PARSED, (event, data) => {
    log('info', '📋', `Manifest parsed — ${data.levels.length} quality level(s)`);
    populateQualitySelect(data.levels);
    video.muted = false;
    video.play().catch(err => {
      // Browser blocked autoplay with audio (user gesture too stale by now).
      // Fall back to muted playback and show a one-click unmute prompt.
      if (err.name === 'NotAllowedError') {
        video.muted = true;
        video.play().catch(() => {});
        showUnmuteOverlay();
        log('warn', '🔇', 'Autoplay blocked — playing muted, click to unmute');
      }
    });
    hideOverlay();
    renderActiveFixes();
  });

  hls.on(Hls.Events.LEVEL_SWITCHED, (event, data) => {
    const level = hls.levels[data.level];
    const res = level ? `${level.height}p` : `level ${data.level}`;
    document.getElementById('val-quality').textContent = level ? `${level.height}p` : '?';
    qualitySwitchLog.push(Date.now());
    // Keep only last 60 seconds of switches
    qualitySwitchLog = qualitySwitchLog.filter(t => Date.now() - t < 60000);

    log('warn', '📶', `Quality switched → ${res}`);
    checkQualityJitter();
  });

  hls.on(Hls.Events.FRAG_LOADED, (event, data) => {
    const ms = data.stats.loading.end - data.stats.loading.start;
    document.getElementById('val-latency').textContent = ms.toFixed(0);
    updateCard('card-latency', ms < 300 ? 'good' : ms < 800 ? 'warn' : 'bad');
  });

  hls.on(Hls.Events.FRAG_BUFFERED, () => {
    updateBufferStats();
  });

  hls.on(Hls.Events.ERROR, (event, data) => {
    handleHlsError(data);
  });

  // Stall detection via video events
  video.addEventListener('waiting', onVideoWaiting);
  video.addEventListener('playing', onVideoPlaying);
  video.addEventListener('stalled', onVideoStalled);

  // Use recommended HLS.js pattern: loadSource first, then attachMedia
  hls.loadSource(streamUrl);
  hls.attachMedia(video);
  startStatsLoop();
}

function buildHlsConfig() {
  return {
    // Let ABR pick the starting quality based on bandwidth estimate — avoids the
    // initial blocky period when startLevel:0 forces lowest quality first
    startLevel: -1,
    // Buffering — deep buffer absorbs proxy spikes without stalling
    maxBufferLength: 90,
    maxMaxBufferLength: 180,
    maxBufferSize: 120 * 1000 * 1000,
    maxBufferHole: 1.0,
    highBufferWatchdogPeriod: 3,
    nudgeMaxRetry: 8,
    startFragPrefetch: true,
    // ABR — conservative upgrades (proxy latency can look like bandwidth drop)
    // but fast enough that you land at a good quality quickly after start
    abrBandWidthFactor: 0.85,
    abrBandWidthUpFactor: 0.65,   // slightly more aggressive than before
    abrEwmaFastLive: 5,
    abrEwmaSlowLive: 12,
    capLevelToPlayerSize: true,
    // Retry — proxy can be slow, give it time
    fragLoadingMaxRetry: 5,
    manifestLoadingMaxRetry: 4,
    levelLoadingMaxRetry: 4,
    fragLoadingRetryDelay: 300,
    fragLoadingMaxRetryTimeout: 5000,
    manifestLoadingTimeOut: 15000,
    levelLoadingTimeOut: 15000,
    fragLoadingTimeOut: 15000,
    // Live stream — stay 6 segments (~36s) behind live; absorbs proxy jitter
    liveBackBufferLength: 60,
    liveSyncDurationCount: 6,
    liveMaxLatencyDurationCount: 12,
  };
}

function startNative(streamUrl) {
  video.src = streamUrl;
  video.addEventListener('waiting', onVideoWaiting);
  video.addEventListener('playing', onVideoPlaying);
  video.addEventListener('stalled', onVideoStalled);
  video.play().catch(() => {});
  hideOverlay();
  log('info', '▶️', 'Playing with native video player');
  startStatsLoop();
}

// ===== Alt source helpers =====

// Returns the first candidate that has already been scanned and is ready to play,
// excluding the stream currently playing.
function getBestReadyAlt() {
  const candidates = window._candidates || [];
  return candidates.find(c => !c.pendingScan && c.url && c.url !== currentStreamInfo?.streamUrl) || null;
}

// Silently scan the first pending alt in the background (called when stream is struggling).
// Updates the candidate button to "ready" once the scan finishes.
let _prescanning = false;
function prescanFirstPendingAlt() {
  if (_prescanning) return;
  const candidates = window._candidates || [];
  const idx = candidates.findIndex(c => c.pendingScan);
  if (idx < 0) return;
  const c = candidates[idx];
  _prescanning = true;
  log('info', '🔍', `Pre-scanning ${c.source} in background (stream struggling)…`);
  fetch('/api/scan-alt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ embedUrl: c.embedUrl, primarySid: c.primarySid }),
  }).then(r => r.json()).then(res => {
    _prescanning = false;
    if (!res.success || !res.streamUrl) return;
    if (!window._candidates?.[idx]) return;
    // Pick up the quality label from the returned candidates if available
    const qualityLabel = res.candidates?.[0]?.label;
    const label = qualityLabel || c.label;
    window._candidates[idx] = { ...c, url: res.streamUrl, rawUrl: res.rawUrl || res.streamUrl,
      sessionId: res.sessionId, pendingScan: false, label };
    const btn = document.getElementById(`alt-btn-${idx}`);
    if (btn) {
      btn.classList.remove('pending');
      btn.innerHTML = `${label} <small>ready — click to switch</small>`;
    }
    log('fix', '✅', `${label} ready as backup — click to switch if needed`);
  }).catch(() => { _prescanning = false; });
}

// ===== Quality Jitter Fix =====
function checkQualityJitter() {
  if (!document.getElementById('toggle-quality-lock').checked) return;
  if (!hls) return;
  // If more than 3 switches in 20 seconds, lock quality
  const recent = qualitySwitchLog.filter(t => Date.now() - t < 20000);
  if (recent.length >= 3 && hls.autoLevelEnabled) {
    // Lock to current level
    const lockLevel = hls.currentLevel >= 0 ? hls.currentLevel : hls.loadLevel;
    if (lockLevel >= 0) {
      hls.currentLevel = lockLevel;
      hls.autoLevelEnabled = false;
      const level = hls.levels[lockLevel];
      const res = level ? `${level.height}p` : `level ${lockLevel}`;
      log('fix', '🔒', `Quality jitter detected (${recent.length} switches/20s) — locked to ${res}`);
      updateQualitySelectValue(lockLevel);
      activeFixes.qualityLocked = true;
      activeFixes.qualityLockedAt = res;
      document.getElementById('quality-unit').textContent = '🔒 locked';
      renderActiveFixes();
      // Auto-unlock after 60 seconds and try ABR again
      setTimeout(() => {
        if (hls && document.getElementById('toggle-quality-lock').checked) {
          hls.autoLevelEnabled = true;
          hls.currentLevel = -1;
          qualitySwitchLog = [];
          updateQualitySelectValue(-1);
          log('info', '🔓', 'Quality lock released — resuming ABR');
          activeFixes.qualityLocked = false;
          activeFixes.qualityLockedAt = '';
          document.getElementById('quality-unit').textContent = 'resolution';
          renderActiveFixes();
        }
      }, 60000);
    }
  }
}

// ===== Buffer boost =====
function applyBufferBoost() {
  // Already at 60s baseline — boost pushes to 120s for extra CDN spike protection
  if (!hls || !document.getElementById('toggle-buffer-boost').checked) return;
  if (hls.config.maxBufferLength < 120) {
    hls.config.maxBufferLength = 120;
    hls.config.maxMaxBufferLength = 300;
    hls.config.maxBufferSize = 200 * 1000 * 1000;
    log('fix', '🚀', 'Buffer boost applied — target raised to 120s ultra-deep buffer');
    activeFixes.bufferBoosted = true;
    renderActiveFixes();
  }
}

// ===== Stall / Freeze Detection =====
function onVideoWaiting() {
  stallStart = Date.now();
  showOverlay('Buffering…');
  log('warn', '⏸', 'Stream buffering / stall detected');
  applyBufferBoost();

  // After 3 stalls: silently pre-scan the first pending alt so it's ready
  // when we need it — no disruption to the playing stream
  if (stallCount >= 2) prescanFirstPendingAlt();

  // After 5 stalls: if a ready alt exists, auto-switch — the current source
  // is clearly struggling and we have a better option
  if (stallCount >= 4) {
    const readyAlt = getBestReadyAlt();
    if (readyAlt) {
      const idx = (window._candidates || []).indexOf(readyAlt);
      if (idx >= 0) {
        log('fix', '🔀', `Auto-switching to ${readyAlt.label} after ${stallCount + 1} stalls`);
        stallCount = 0; // reset so we don't loop
        switchCandidate(idx);
        return;
      }
    }
  }
}

function onVideoPlaying() {
  if (stallStart !== null) {
    const ms = Date.now() - stallStart;
    stallCount++;
    totalStallMs += ms;
    stallStart = null;
    log('fix', '▶️', `Recovered from ${ms}ms freeze — stream resumed (${stallCount} total fixed)`);
    document.getElementById('val-stalls').textContent = stallCount;
    const totalSec = (totalStallMs / 1000).toFixed(1);
    document.getElementById('stall-unit').textContent = `${totalSec}s recovered`;
    updateCard('card-stalls', stallCount === 0 ? 'good' : stallCount < 3 ? 'warn' : 'bad');
    renderActiveFixes();
  }
  hideOverlay();
}

function onVideoStalled() {
  showOverlay('Stream stalled…');
  log('warn', '🧊', 'Video stalled — attempting recovery');
  applyBufferBoost();
  // Nudge playback forward slightly to escape stall
  if (video && !video.paused && video.currentTime > 0) {
    setTimeout(() => {
      if (video.readyState < 3) {
        video.currentTime = video.currentTime + 0.1;
        log('fix', '⏩', 'Nudged playback position to escape stall');
      }
    }, 2000);
  }
}

// ===== HLS Error Handling =====
function handleHlsError(data) {
  if (data.fatal) {
    // Try to get a meaningful message
    const detail = data.details || '';
    const response = data.response;
    let msg = `Fatal ${data.type}: ${detail}`;

    if (response && response.code) {
      msg += ` (HTTP ${response.code})`;
      if (response.code === 403) {
        msg = `403 Forbidden — the CDN rejected our request. The URL may require a browser cookie or has expired.`;
      } else if (response.code === 404) {
        msg = `404 Not Found — the stream URL no longer exists. Live stream URLs often expire within minutes.`;
      } else if (response.code === 0) {
        msg = `Network error — CORS or connectivity issue fetching segments.`;
      }
    }
    if (detail === 'manifestLoadError') msg = `Failed to load the stream manifest. The URL may have expired or be inaccessible.`;
    if (detail === 'manifestParsingError') msg = `The manifest file couldn't be parsed as a valid HLS stream.`;

    log('error', '❌', msg);

    switch (data.type) {
      case Hls.ErrorTypes.NETWORK_ERROR:
        // If it's a 403/404, don't bother reconnecting — it won't help
        if (response && (response.code === 403 || response.code === 404)) {
          const currentUrl = urlInput.value.trim();
          const isAutoLoaded = currentUrl.includes('stream-east.net') || currentUrl.includes('streamed.pk');
          // For auto-loaded streams: layered recovery —
          // 1. Ready alt source (instant switch, no scan needed)
          // 2. CDN-direct rescan (no re-scan if CDN is still alive)
          // 3. Full re-scan of the embed page
          if (isAutoLoaded && rescanAttempts < MAX_RESCAN) {
            rescanAttempts++;
            log('fix', '🔄', `Stream error (${response.code}) — recovering… (attempt ${rescanAttempts}/${MAX_RESCAN})`);
            showOverlay(`Recovering…`);
            if (hls) { hls.destroy(); hls = null; }

            (async () => {
              // ── Layer 1: ready alt ────────────────────────────────────────────
              const readyAlt = getBestReadyAlt();
              if (readyAlt) {
                const idx = (window._candidates || []).indexOf(readyAlt);
                if (idx >= 0) {
                  log('fix', '⚡', `Switching to ready alt: ${readyAlt.label}`);
                  hideOverlay();
                  switchCandidate(idx);
                  return;
                }
              }

              // ── Layer 2: CDN-direct (no embed re-scan needed) ─────────────────
              const sid = currentStreamInfo?.sessionId;
              if (sid) {
                try {
                  const cdnRes = await fetch('/api/cdn-rescan', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ sessionId: sid }),
                  }).then(r => r.json());
                  if (cdnRes.success) {
                    log('fix', '⚡', `CDN recovery${cdnRes.usedStandby ? ' via backup session' : ''} — no re-scan needed`);
                    currentStreamInfo = { ...currentStreamInfo, streamUrl: cdnRes.streamUrl };
                    hideOverlay();
                    playStream(currentStreamInfo);
                    return;
                  }
                } catch {}
              }

              // ── Layer 3: full embed re-scan ───────────────────────────────────
              log('info', '🔍', 'Full re-scan…');
              await new Promise(r => setTimeout(r, 800));
              loadStream();
            })();
            return;
          }
          showOverlay('Stream blocked or expired');
          showError(
            response.code === 403 ? 'Stream blocked (403)' : 'Stream expired (404)',
            msg,
            response.code === 403
              ? (isAutoLoaded
                  ? 'This stream is either offline or the CDN tokens have expired. Try refreshing the fight events and clicking Watch again.'
                  : 'This stream requires authentication that expires. Go back to the site, refresh, and copy the m3u8 URL again from DevTools → Network → filter "m3u8".')
              : 'Live stream URLs expire quickly. Go back to the site, start playing, then copy the fresh m3u8 URL from DevTools → Network.'
          );
          return;
        }
        // Transient network error — silent fast recovery.
        // Tear down HLS without touching the video element so the buffer keeps
        // playing, then restart immediately. No overlay, no reconnect counter.
        // Only escalate to a visible reconnect if this silent attempt also fails.
        if (!_silentRecoveryInProgress) {
          _silentRecoveryInProgress = true;
          log('fix', '🔄', 'Network hiccup — silently restarting…');
          const savedInfo = currentStreamInfo;
          if (hls) { hls.destroy(); hls = null; }
          video.removeEventListener('waiting', onVideoWaiting);
          video.removeEventListener('playing', onVideoPlaying);
          video.removeEventListener('stalled', onVideoStalled);
          setTimeout(() => { if (savedInfo) playStream(savedInfo); }, 100);
          return;
        }
        // Silent recovery itself failed — escalate to visible reconnect
        attemptReconnect();
        break;
      case Hls.ErrorTypes.MEDIA_ERROR:
        log('fix', '🔧', 'Attempting media recovery…');
        showOverlay('Recovering…');
        hls.recoverMediaError();
        break;
      default:
        hls.destroy();
        hls = null;
        if (document.getElementById('toggle-auto-reconnect').checked) {
          attemptReconnect();
        }
    }
  } else {
    // Non-fatal — only log interesting ones (skip noise)
    const skip = ['fragLoadError', 'fragLoadTimeOut', 'internalException'];
    if (!skip.includes(data.details)) {
      log('warn', '⚠️', `${data.details}`);
    }
  }
}

function attemptReconnect() {
  if (!document.getElementById('toggle-auto-reconnect').checked) return;
  if (reconnectAttempts >= MAX_RECONNECT) {
    log('error', '🚫', `Failed after ${MAX_RECONNECT} attempts — running deep diagnosis…`);
    showOverlay('Could not connect');
    showMainContent();
    // Run deep diagnose automatically
    if (currentStreamInfo?.rawUrl) {
      runDiagnose(currentStreamInfo.rawUrl, refererInput.value.trim());
    }
    showError(
      'Stream failed to connect',
      '',
      'Running diagnostics below to find the exact cause…'
    );
    return;
  }
  reconnectAttempts++;
  const delay = Math.min(500 * reconnectAttempts, 8000);
  log('fix', '🔄', `Reconnecting in ${delay / 1000}s… (attempt ${reconnectAttempts}/${MAX_RECONNECT})`);
  showOverlay(`Reconnecting… (${reconnectAttempts}/${MAX_RECONNECT})`);
  activeFixes.reconnecting = true;
  renderActiveFixes();
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    if (!currentStreamInfo) return;
    activeFixes.reconnecting = false;
    renderActiveFixes();
    stopCurrentStream();
    playStream(currentStreamInfo);
  }, delay);
}

// ===== Active Fixes Renderer =====
function renderActiveFixes() {
  const container = document.getElementById('active-fixes');
  if (!container) return;
  const fixes = [];
  if (activeFixes.qualityLocked) fixes.push({ icon: '🔒', label: `Quality locked ${activeFixes.qualityLockedAt}`, cls: 'fix-active' });
  if (activeFixes.bufferBoosted)  fixes.push({ icon: '🚀', label: 'Buffer boosted to 120s', cls: 'fix-active' });
  if (activeFixes.reconnecting)   fixes.push({ icon: '🔄', label: 'Reconnecting…', cls: 'fix-warn' });
  if (stallCount > 0)             fixes.push({ icon: '🛡', label: `${stallCount} freeze${stallCount > 1 ? 's' : ''} auto-fixed`, cls: 'fix-ok' });
  if (fixes.length === 0)         fixes.push({ icon: '✅', label: 'All systems good', cls: 'fix-ok' });
  container.innerHTML = fixes.map(f => `<span class="fix-badge ${f.cls}">${f.icon} ${f.label}</span>`).join('');
  updateHealthScore();
}

// ===== Session Health Score =====
function updateHealthScore() {
  const gradeEl = document.getElementById('health-grade');
  const scoreEl = document.getElementById('health-score');
  if (!gradeEl || !video) return;
  let score = 100;
  // Deduct for stalls
  score -= stallCount * 10;
  // Deduct for quality lock (means network is struggling)
  if (activeFixes.qualityLocked) score -= 15;
  // Deduct for reconnects
  score -= reconnectAttempts * 20;
  // Deduct for low buffer
  const bufSecs = video.buffered.length > 0 ? video.buffered.end(video.buffered.length - 1) - video.currentTime : 0;
  if (bufSecs < 2) score -= 30;
  else if (bufSecs < 5) score -= 10;

  score = Math.max(0, Math.min(100, score));
  let grade, color;
  if (score >= 85)      { grade = 'A'; color = '#22d07a'; }
  else if (score >= 65) { grade = 'B'; color = '#f5c518'; }
  else if (score >= 40) { grade = 'C'; color = '#f0874f'; }
  else                  { grade = 'F'; color = '#f0524f'; }

  gradeEl.textContent = grade;
  gradeEl.style.color = color;
  scoreEl.style.borderColor = color + '44';
}

// ===== Stats Loop =====
function startStatsLoop() {
  clearInterval(statsInterval);
  statsInterval = setInterval(updateBufferStats, 1000);
}

function updateBufferStats() {
  if (!video) return;
  let bufferSecs = 0;
  if (video.buffered.length > 0) {
    bufferSecs = video.buffered.end(video.buffered.length - 1) - video.currentTime;
    bufferSecs = Math.max(0, bufferSecs);
  }

  const bufferVal = document.getElementById('val-buffer');
  const bufferBar = document.getElementById('bar-buffer');
  bufferVal.textContent = bufferSecs.toFixed(1);

  // Bar: 0–30s mapped to 0–100%
  const pct = Math.min(100, (bufferSecs / 30) * 100);
  bufferBar.style.width = pct + '%';
  bufferBar.style.background = bufferSecs < 2 ? '#f0524f' : bufferSecs < 5 ? '#f5c518' : '#22d07a';
  updateCard('card-buffer', bufferSecs < 2 ? 'bad' : bufferSecs < 5 ? 'warn' : 'good');

  // Push to chart history
  pushHistory(bufferHistory, bufferSecs);
  updateChart(bufferChart, bufferHistory, '#22d07a', 0);

  // HLS bandwidth estimate + live edge
  if (hls) {
    const bw = hls.bandwidthEstimate;
    if (bw && bw > 0) {
      const mbps = (bw / 1e6).toFixed(2);
      document.getElementById('val-bandwidth').textContent = mbps;
      updateCard('card-bandwidth', bw > 5e6 ? 'good' : bw > 1.5e6 ? 'warn' : 'bad');
      pushHistory(bwHistory, parseFloat(mbps));
      updateChart(bwChart, bwHistory, '#4f8ef7', 0);
    }
    // Live edge latency (how far behind live the player is)
    try {
      const liveEdge = hls.liveSyncPosition;
      if (liveEdge && video.currentTime > 0) {
        const behindLive = Math.max(0, liveEdge - video.currentTime);
        document.getElementById('val-edge').textContent = behindLive.toFixed(1);
        updateCard('card-edge', behindLive < 8 ? 'good' : behindLive < 20 ? 'warn' : 'bad');
      }
    } catch {}
  }

  // Update health score every second
  updateHealthScore();
}

// ===== Charts =====
function initCharts() {
  const chartDefaults = {
    type: 'line',
    options: {
      animation: false,
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      scales: {
        x: { display: false },
        y: {
          display: true,
          grid: { color: 'rgba(255,255,255,0.05)' },
          ticks: { color: '#5a6282', font: { size: 9 }, maxTicksLimit: 4 },
          border: { display: false }
        }
      },
      elements: {
        point: { radius: 0 },
        line: { tension: 0.4, borderWidth: 2 }
      }
    }
  };

  const emptyData = () => ({
    labels: Array(CHART_POINTS).fill(''),
    datasets: [{ data: Array(CHART_POINTS).fill(null), borderColor: '#22d07a', backgroundColor: 'transparent', fill: false }]
  });

  bufferChart = new Chart(document.getElementById('buffer-chart').getContext('2d'), {
    ...chartDefaults,
    data: emptyData()
  });
  bwChart = new Chart(document.getElementById('bw-chart').getContext('2d'), {
    ...chartDefaults,
    data: emptyData()
  });
}

function pushHistory(arr, val) {
  arr.push(val);
  if (arr.length > CHART_POINTS) arr.shift();
}

function updateChart(chart, history, color, minY) {
  if (!chart) return;
  chart.data.datasets[0].data = [...history];
  chart.data.datasets[0].borderColor = color;
  chart.update('none');
}

// ===== Helpers =====
function setLoading(on, label) {
  loadBtn.disabled = on;
  loadSpinner.style.display = on ? '' : 'none';
  loadBtnText.style.display = '';
  loadBtnText.textContent = on ? (label || 'Loading…') : 'Load Stream';
}

function showMainContent() {
  landing.style.display = 'none';
  mainContent.style.display = '';
  document.getElementById('stop-btn').style.display = '';
}

function stopStream() {
  const wasReplay = _isReplayMode;
  const ctx = _replayContext;
  exitReplayMode();
  _replayContext = null;

  // Tear down HLS/video
  if (hls) { hls.destroy(); hls = null; }
  if (video) { video.pause(); video.src = ''; video.load(); }
  if (statsInterval) { clearInterval(statsInterval); statsInterval = null; }
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  currentStreamInfo = null;
  reconnectAttempts = 0;

  // Reset cast session if active
  if (_activeCastDeviceId) {
    fetch('/api/cast-stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceId: _activeCastDeviceId }) }).catch(() => {});
    _activeCastDeviceId = null;
  }

  // Hide cast wrap, stop button; show landing
  document.getElementById('stop-btn').style.display = 'none';
  const castWrap = document.getElementById('cast-wrap');
  if (castWrap) castWrap.style.display = 'none';
  mainContent.style.display = 'none';
  landing.style.display = '';
  dismissError();
  resetStats();
  clearLog();

  // If we were watching a replay, return to the replays tab
  if (wasReplay && ctx) {
    _currentPromo = ctx.promo;
    _openEventSlug = ctx.openSlug;
    document.querySelectorAll('.sport-tab').forEach(t => t.classList.toggle('active', t.dataset.sport === 'replays'));
    const grid = document.getElementById('sport-events-grid');
    if (grid) grid.classList.add('replay-mode-grid');
    loadReplays().then(() => {
      if (ctx.filter) {
        const fi = document.getElementById('replay-filter-input');
        if (fi) { fi.value = ctx.filter; filterReplayList(ctx.filter); }
      }
      if (ctx.openSlug) {
        setTimeout(() => {
          const row = document.getElementById(`row-${ctx.openSlug}`);
          if (row && document.getElementById(`sources-${ctx.openSlug}`)?.style.display === 'none') row.click();
        }, 150);
      }
    });
    return;
  }

  // Focus the URL input for the next stream
  urlInput.focus();
}

function showOverlay(text) {
  overlayText.textContent = text;
  overlayMsg.style.display = '';
}
function hideOverlay() {
  overlayMsg.style.display = 'none';
}

function showUnmuteOverlay() {
  let el = document.getElementById('unmute-overlay');
  if (!el) return;
  el.style.display = 'flex';
}
function hideUnmuteOverlay() {
  const el = document.getElementById('unmute-overlay');
  if (el) el.style.display = 'none';
}
function unmuteVideo() {
  video.muted = false;
  hideUnmuteOverlay();
  // If paused (browser blocked even muted play), try playing now
  if (video.paused) video.play().catch(() => {});
}

function showError(title, msg, hint) {
  errorTitle.textContent = title;
  errorMsg.textContent = (hint ? hint : msg);
  errorBanner.style.display = '';
  // Auto-run diagnose if we have a stream URL
  if (currentStreamInfo?.rawUrl) {
    runDiagnose(currentStreamInfo.rawUrl, refererInput.value.trim());
  }
}
function dismissError() {
  errorBanner.style.display = 'none';
}

// ===== Deep Diagnose =====
async function runDiagnose(url, referer) {
  const panel = document.getElementById('diagnose-panel');
  if (!panel) return;
  panel.style.display = '';
  panel.innerHTML = `<div class="diag-running"><span class="spinner" style="display:inline-block;width:12px;height:12px;border-width:2px"></span> Running diagnostics…</div>`;

  try {
    const res = await fetch('/api/diagnose', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, referer })
    });
    const data = await res.json();
    renderDiagnose(panel, data, url, referer);

    // Auto-load if diagnose found real stream URLs
    if (data.followUp?.type === 'streams' && data.followUp.urls?.length > 0) {
      const streamUrls = data.followUp.urls;
      const best = streamUrls.find(u => u.includes('.m3u8')) || streamUrls[0];
      log('fix', '🎯', `Diagnose found real stream — loading: ${best}`);
      dismissError();
      stopCurrentStream();
      resetStats();
      const proxiedUrl = `/proxy/stream?ref=${encodeURIComponent(referer || url)}&url=${encodeURIComponent(best)}`;
      currentStreamInfo = { streamUrl: proxiedUrl, rawUrl: best, type: 'hls', title: 'Live Stream', isLive: true };
      streamTitle.textContent = 'Live Stream';
      liveBadge.style.display = '';
      const _cb = document.getElementById('cast-btn');
      if (_cb) _cb.style.display = '';
      showMainContent();
      hideOverlay();

      if (streamUrls.length > 1) {
        showCandidates(streamUrls.map((u, i) => ({
          url: `/proxy/stream?ref=${encodeURIComponent(referer || url)}&url=${encodeURIComponent(u)}`,
          rawUrl: u,
          label: `Stream ${i + 1}`,
        })), proxiedUrl);
      }
      playStream(currentStreamInfo);
    }
  } catch (e) {
    panel.innerHTML = `<div class="diag-running" style="color:var(--red)">Diagnose failed: ${e.message}</div>`;
  }
}

function renderDiagnose(panel, data, url, referer) {
  const steps = data.steps || [];
  const allOk = steps.every(s => s.ok);
  let html = `<div class="diag-panel">
    <div class="diag-header">
      <span>${allOk ? '✅' : '🔬'} Stream Diagnosis</span>
      <button class="btn-sm" onclick="runDiagnose('${url.replace(/'/g,"\\'")}','${(referer||'').replace(/'/g,"\\'")}')">Re-run</button>
    </div>`;

  for (const step of steps) {
    const icon = step.ok ? '✅' : '❌';
    html += `<div class="diag-step ${step.ok ? 'ok' : 'fail'}">
      <div class="diag-step-title">${icon} ${step.step}${step.status ? ` <span class="diag-status">${step.status}</span>` : ''}${step.ms ? ` <span class="diag-ms">${step.ms}ms</span>` : ''}</div>
      <div class="diag-step-detail">${step.detail || ''}</div>
      ${step.hint ? `<div class="diag-step-hint">💡 ${step.hint}</div>` : ''}
      ${step.preview ? `<pre class="diag-preview">${step.preview}</pre>` : ''}
    </div>`;
  }

  if (steps.length === 0) {
    html += `<div class="diag-step fail"><div class="diag-step-detail">No diagnostic data returned.</div></div>`;
  }

  html += `</div>`;
  panel.innerHTML = html;
}

function populateQualitySelect(levels) {
  qualitySelect.innerHTML = '<option value="-1">Auto (ABR)</option>';
  levels.forEach((level, i) => {
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = level.height
      ? `${level.height}p${level.attrs?.FRAME_RATE ? ' ' + Math.round(parseFloat(level.attrs.FRAME_RATE)) + 'fps' : ''}`
      : `Level ${i}`;
    if (level.bitrate) opt.textContent += ` (${(level.bitrate / 1000).toFixed(0)}k)`;
    qualitySelect.appendChild(opt);
  });
}

function updateQualitySelectValue(val) {
  qualitySelect.value = val;
}

function updateCard(id, status) {
  const card = document.getElementById(id);
  card.className = 'stat-card ' + (status || '');
}

function resetStats() {
  bufferHistory = [];
  bwHistory = [];
  qualitySwitchLog = [];
  stallCount = 0;
  totalStallMs = 0;
  stallStart = null;
  _prescanning = false; // allow pre-scan on the new stream
  document.getElementById('val-buffer').textContent = '–';
  document.getElementById('val-quality').textContent = '–';
  document.getElementById('val-bandwidth').textContent = '–';
  document.getElementById('val-latency').textContent = '–';
  document.getElementById('val-stalls').textContent = '0';
  document.getElementById('val-edge').textContent = '–';
  document.getElementById('stall-unit').textContent = 'this session';
  document.getElementById('quality-unit').textContent = 'resolution';
  document.getElementById('health-grade').textContent = '–';
  document.getElementById('health-grade').style.color = '';
  document.getElementById('active-fixes').innerHTML = '';
  document.getElementById('bar-buffer').style.width = '0%';
  ['card-buffer','card-quality','card-bandwidth','card-latency','card-stalls','card-edge'].forEach(id => updateCard(id, ''));
  activeFixes.qualityLocked = false;
  activeFixes.qualityLockedAt = '';
  activeFixes.bufferBoosted = false;
  activeFixes.reconnecting = false;
  qualitySelect.innerHTML = '<option value="-1">Auto (ABR)</option>';
  if (bufferChart) { bufferChart.data.datasets[0].data = Array(CHART_POINTS).fill(null); bufferChart.update('none'); }
  if (bwChart)     { bwChart.data.datasets[0].data = Array(CHART_POINTS).fill(null); bwChart.update('none'); }
}

function stopCurrentStream() {
  clearInterval(statsInterval);
  clearTimeout(reconnectTimer);
  if (hls) {
    hls.destroy();
    hls = null;
  }
  if (video) {
    video.removeEventListener('waiting', onVideoWaiting);
    video.removeEventListener('playing', onVideoPlaying);
    video.removeEventListener('stalled', onVideoStalled);
    video.pause();
    video.removeAttribute('src');
  }
  hideOverlay();
  hideUnmuteOverlay();
}

// ===== Event Log =====
function log(type, icon, msg) {
  const el = document.getElementById('event-log');
  const entry = document.createElement('div');
  entry.className = `log-entry ${type}`;
  const now = new Date();
  const ts = `${now.getHours().toString().padStart(2,'0')}:${now.getMinutes().toString().padStart(2,'0')}:${now.getSeconds().toString().padStart(2,'0')}`;
  entry.innerHTML = `<span class="log-time">${ts}</span><span class="log-icon">${icon}</span><span class="log-msg">${msg}</span>`;
  el.insertBefore(entry, el.firstChild);
  // Keep max 100 entries
  while (el.children.length > 100) el.removeChild(el.lastChild);
}

function clearLog() {
  document.getElementById('event-log').innerHTML = '';
}

// ===== Chromecast (server-side mDNS discovery + castv2-client) =====
let _castLocalIp = null;
let _castLocalPort = 3847;
let _activeCastDeviceId = null;

fetch('/api/local-ip').then(r => r.json()).then(d => {
  _castLocalIp = d.ip; _castLocalPort = d.port;
}).catch(() => {});

function toggleCastMenu() {
  const menu = document.getElementById('cast-menu');
  if (!menu) return;
  if (menu.style.display !== 'none') { menu.style.display = 'none'; return; }
  _renderCastMenu(menu);
  menu.style.display = 'block';
  const close = (e) => {
    if (!menu.contains(e.target) && e.target.closest('#cast-btn') === null) {
      menu.style.display = 'none';
      document.removeEventListener('click', close, true);
    }
  };
  setTimeout(() => document.addEventListener('click', close, true), 0);
}

async function _renderCastMenu(menu) {
  menu.innerHTML = '<div class="cast-menu-item cast-scanning">Scanning for devices…</div>';
  try {
    const devices = await fetch('/api/cast-devices').then(r => r.json());
    if (!devices.length) {
      menu.innerHTML = '<div class="cast-menu-item cast-none">No Chromecast devices found<br><small>Make sure they\'re on the same Wi-Fi</small></div>';
      return;
    }
    menu.innerHTML = devices.map(d => {
      const active = d.id === _activeCastDeviceId;
      return `<div class="cast-menu-item${active ? ' cast-active' : ''}" onclick="castToDevice('${d.id}','${d.name.replace(/'/g,"\\'")}')">
        <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14" style="flex-shrink:0;margin-right:6px">
          <path d="M1 18v3h3c0-1.66-1.34-3-3-3zm0-4v2c2.76 0 5 2.24 5 5h2c0-3.87-3.13-7-7-7zm18-7H5c-1.1 0-2 .9-2 2v3h2v-3h14v10h-5v2h5c1.1 0 2-.9 2-2V9c0-1.1-.9-2-2-2zM1 10v2c4.97 0 9 4.03 9 9h2c0-6.08-4.93-11-11-11z"/>
        </svg>
        ${d.name}${active ? ' <span class="cast-stop-hint">(tap to stop)</span>' : ''}
      </div>`;
    }).join('');
  } catch {
    menu.innerHTML = '<div class="cast-menu-item cast-none">Could not reach server</div>';
  }
}

async function castToDevice(deviceId, deviceName) {
  document.getElementById('cast-menu').style.display = 'none';
  const btn = document.getElementById('cast-btn');

  if (_activeCastDeviceId === deviceId) {
    await fetch('/api/cast-stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceId }) }).catch(() => {});
    _activeCastDeviceId = null;
    if (btn) btn.classList.remove('casting');
    log('info', '📺', `Stopped casting to ${deviceName}`);
    return;
  }

  if (!currentStreamInfo?.streamUrl || !_castLocalIp) {
    log('warn', '📺', 'No stream loaded to cast'); return;
  }
  const castUrl = currentStreamInfo.streamUrl.replace(/https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/, `http://${_castLocalIp}:${_castLocalPort}`);
  log('info', '📺', `Connecting to ${deviceName}…`);
  if (btn) btn.classList.add('casting');

  try {
    const res = await fetch('/api/cast-start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceId, streamUrl: castUrl }) });
    const data = await res.json();
    if (data.success) {
      _activeCastDeviceId = deviceId;
      log('info', '📺', `Casting to ${deviceName}`);
    } else {
      _activeCastDeviceId = null; if (btn) btn.classList.remove('casting');
      log('warn', '📺', `Cast failed: ${data.error}`);
    }
  } catch (e) {
    _activeCastDeviceId = null; if (btn) btn.classList.remove('casting');
    log('warn', '📺', `Cast error: ${e.message}`);
  }
}

// ===== Sports Hub =====

const SPORT_LABELS = {
  mma:        { label: 'MMA',       color: '#a855f7' },
  football:   { label: 'Soccer',    color: '#22d07a' },
  afl:        { label: 'AFL',       color: '#f5882a' },
  cricket:    { label: 'Cricket',   color: '#4f8ef7' },
  tennis:     { label: 'Tennis',    color: '#84cc16' },
  f1:         { label: 'F1',        color: '#ef4444' },
  motorsport: { label: 'Motorsport',color: '#ef4444' },
  motogp:     { label: 'MotoGP',    color: '#f59e0b' },
  basketball: { label: 'NBA',       color: '#f97316' },
  baseball:   { label: 'MLB',       color: '#3b82f6' },
  hockey:     { label: 'Hockey',    color: '#06b6d4' },
  rugby:      { label: 'Rugby',     color: '#84cc16' },
  other:      { label: 'Other',     color: '#6b7280' },
};

const SPORT_CONFIG = {
  all: {
    label: 'All Live',
    empty: 'No live events right now.<br>Check back closer to event time.',
    gradients: [
      'linear-gradient(135deg, #0a0f1e 0%, #111827 40%, #060a14 100%)',
      'linear-gradient(135deg, #0f0a1e 0%, #1a1040 40%, #080614 100%)',
      'linear-gradient(135deg, #0a1628 0%, #0d2545 40%, #060e1a 100%)',
      'linear-gradient(135deg, #1a0a2e 0%, #2d0a3d 40%, #0d0814 100%)',
      'linear-gradient(135deg, #061a0a 0%, #0a3018 40%, #040e08 100%)',
      'linear-gradient(135deg, #1a0500 0%, #3d0a00 40%, #0d0300 100%)',
    ],
  },
  mma: {
    label: 'MMA & Boxing',
    empty: 'No fight events found right now.<br>Check back closer to event time.',
    gradients: [
      'linear-gradient(135deg, #1a0a2e 0%, #2d0a3d 40%, #0d0814 100%)',
      'linear-gradient(135deg, #0a1628 0%, #0d2545 40%, #060e1a 100%)',
      'linear-gradient(135deg, #1a0808 0%, #3d1010 40%, #0d0808 100%)',
      'linear-gradient(135deg, #200818 0%, #3d0825 40%, #100610 100%)',
      'linear-gradient(135deg, #080f1a 0%, #0f2040 40%, #050a12 100%)',
      'linear-gradient(135deg, #1a0a10 0%, #350d20 40%, #0d0810 100%)',
    ],
  },
  football: {
    label: 'Soccer',
    empty: 'No soccer matches found right now.<br>Check back closer to kick-off.',
    gradients: [
      'linear-gradient(135deg, #061a0a 0%, #0a3018 40%, #040e08 100%)',
      'linear-gradient(135deg, #081a06 0%, #123d08 40%, #060e04 100%)',
      'linear-gradient(135deg, #062010 0%, #0d3820 40%, #04100a 100%)',
      'linear-gradient(135deg, #0a200c 0%, #153a10 40%, #060e06 100%)',
      'linear-gradient(135deg, #041810 0%, #0a2d18 40%, #030e08 100%)',
      'linear-gradient(135deg, #082014 0%, #123518 40%, #050e08 100%)',
    ],
  },
  afl: {
    label: 'AFL',
    empty: 'No AFL matches found right now.<br>Check back on game day.',
    gradients: [
      'linear-gradient(135deg, #1a1008 0%, #3d2808 40%, #0d0e04 100%)',
      'linear-gradient(135deg, #181206 0%, #3a2c06 40%, #100e04 100%)',
      'linear-gradient(135deg, #200e04 0%, #3d1e06 40%, #100a03 100%)',
      'linear-gradient(135deg, #1a1506 0%, #3d3008 40%, #0d1004 100%)',
      'linear-gradient(135deg, #180a04 0%, #350f06 40%, #0d0804 100%)',
      'linear-gradient(135deg, #1a1204 0%, #3a2806 40%, #100e04 100%)',
    ],
  },
  cricket: {
    label: 'Cricket',
    empty: 'No cricket matches found right now.<br>Check back on match day.',
    gradients: [
      'linear-gradient(135deg, #0a1020 0%, #102040 40%, #060c18 100%)',
      'linear-gradient(135deg, #0e1228 0%, #142545 40%, #080e1a 100%)',
      'linear-gradient(135deg, #081828 0%, #0f2d45 40%, #050e1a 100%)',
      'linear-gradient(135deg, #0c1420 0%, #182840 40%, #080e18 100%)',
      'linear-gradient(135deg, #061020 0%, #0d2038 40%, #040c14 100%)',
      'linear-gradient(135deg, #0a1828 0%, #123040 40%, #060e18 100%)',
    ],
  },
  tennis: {
    label: 'Tennis',
    empty: 'No tennis matches found right now.<br>Check back closer to match time.',
    gradients: [
      'linear-gradient(135deg, #141a08 0%, #2d3d0a 40%, #0a0e04 100%)',
      'linear-gradient(135deg, #101806 0%, #253808 40%, #0a0e04 100%)',
      'linear-gradient(135deg, #181a04 0%, #353d06 40%, #0e1004 100%)',
      'linear-gradient(135deg, #141606 0%, #2d3008 40%, #0a0c04 100%)',
      'linear-gradient(135deg, #101a06 0%, #263508 40%, #080e04 100%)',
      'linear-gradient(135deg, #181a06 0%, #323808 40%, #0e1004 100%)',
    ],
  },
  f1: {
    label: 'Formula 1',
    empty: 'No F1 sessions live right now.<br>Check back on race weekend.',
    gradients: [
      'linear-gradient(135deg, #1a0500 0%, #3d0a00 40%, #0d0300 100%)',
      'linear-gradient(135deg, #180300 0%, #3a0600 40%, #0e0200 100%)',
      'linear-gradient(135deg, #1a0800 0%, #350e00 40%, #0d0400 100%)',
      'linear-gradient(135deg, #200400 0%, #3d0800 40%, #100200 100%)',
      'linear-gradient(135deg, #1a0300 0%, #380600 40%, #0d0200 100%)',
      'linear-gradient(135deg, #1a0600 0%, #3d0c00 40%, #0d0400 100%)',
    ],
  },
};

let _currentSport = 'all';

function switchSport(sport) {
  _currentSport = sport;
  document.querySelectorAll('.sport-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.sport === sport);
  });
  const grid = document.getElementById('sport-events-grid');
  if (grid) grid.classList.toggle('replay-mode-grid', sport === 'replays');
  if (sport === 'replays') {
    loadReplays();
  } else {
    loadSportEvents(sport);
  }
}

let _autoRefreshTimer = null;

function _startAutoRefresh() {
  if (_autoRefreshTimer) clearInterval(_autoRefreshTimer);
  _autoRefreshTimer = setInterval(() => {
    if (mainContent.style.display === 'none' && _currentSport !== 'replays') {
      loadSportEvents(_currentSport);
    }
  }, 2 * 60 * 1000);
}

function refreshCurrentSport() {
  if (_currentSport === 'replays') loadReplays();
  else loadSportEvents(_currentSport);
  _updateTabCounts();
}

function _updateGridHeader(count, sport) {
  const countEl = document.getElementById('events-live-count');
  const updatedEl = document.getElementById('events-updated-at');
  if (countEl) {
    countEl.textContent = count > 0
      ? `${count} event${count !== 1 ? 's' : ''} live now`
      : (sport === 'replays' ? '' : 'No live events');
  }
  if (updatedEl) {
    const t = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    updatedEl.textContent = `Updated ${t}`;
  }
}

async function _updateTabCounts() {
  try {
    const all = await fetch('/api/sport-events?sport=all').then(r => r.json());
    if (!Array.isArray(all)) return;
    const counts = {};
    all.forEach(ev => { counts[ev.sport] = (counts[ev.sport] || 0) + 1; });
    const total = all.length;
    document.querySelectorAll('.sport-tab[data-sport]').forEach(tab => {
      const s = tab.dataset.sport;
      const n = s === 'all' ? total : (counts[s] || 0);
      let badge = tab.querySelector('.sport-tab-count');
      if (n > 0) {
        if (!badge) {
          badge = document.createElement('span');
          badge.className = 'sport-tab-count';
          tab.appendChild(badge);
        }
        badge.textContent = n;
      } else if (badge) {
        badge.remove();
      }
    });
  } catch {}
}

async function loadSportEvents(sport) {
  const grid = document.getElementById('sport-events-grid');
  if (!grid) return;
  const config = SPORT_CONFIG[sport] || SPORT_CONFIG.mma;
  grid.innerHTML = '<div class="fight-events-loading">Loading events…</div>';
  try {
    const events = await fetch(`/api/sport-events?sport=${sport}`).then(r => r.json());
    if (!events || events.error) throw new Error(events?.error || 'Unknown error');
    _updateGridHeader(events.length, sport);
    if (!events.length) {
      grid.innerHTML = `<div class="fight-events-empty">${config.empty}</div>`;
      return;
    }
    const now = Date.now();
    const showSportChip = sport === 'all';
    grid.innerHTML = events.map((ev, i) => {
      const timeStr = _eventTimeStr(ev.date, now);
      const teamA = ev.teams?.home?.name;
      const teamB = ev.teams?.away?.name;
      const gradient = config.gradients[i % config.gradients.length];
      const bgStyle = ev.poster
        ? `background-image: url('${ev.poster}'), ${gradient}`
        : `background: ${gradient}`;
      const liveBadge = ev.isLive
        ? `<span class="event-live-badge" id="badge-${ev.id}">● LIVE</span>`
        : `<span class="event-time-badge">${timeStr}</span>`;
      const sportInfo = SPORT_LABELS[ev.sport] || SPORT_LABELS.other;
      const sportChip = showSportChip
        ? `<span class="event-sport-chip" style="background:${sportInfo.color}22;color:${sportInfo.color};border-color:${sportInfo.color}44">${sportInfo.label}</span>`
        : '';
      const badgeRow = `<div class="event-badge-row-inner">${liveBadge}${sportChip}</div>`;
      const fighters = (teamA && teamB)
        ? `<div class="event-fighter-a">${teamA}</div>
           <div class="event-vs">VS</div>
           <div class="event-fighter-b">${teamB}</div>`
        : `<div class="event-single-title">${ev.title}</div>`;
      const subtitle = (teamA && teamB) ? `<div class="event-poster-sub">${ev.title}</div>` : '';
      return `<div class="event-poster-card" onclick="loadSportEvent('${ev.id}')">
        <div class="event-poster-bg" style="${bgStyle}"></div>
        <div class="event-poster-overlay"></div>
        <div class="event-poster-content">
          <div class="event-poster-badge-row">${badgeRow}</div>
          ${fighters}
          ${subtitle}
          <div class="event-watch-btn">▶ Watch Live</div>
        </div>
      </div>`;
    }).join('');
    // Pre-warm live events in background so Watch Live is instant
    events.filter(e => e.isLive).slice(0, 3).forEach(e => {
      fetch('/api/prewarm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ matchId: e.id }),
      }).catch(() => {});
    });

    // Background stream-availability check — updates each card badge once results arrive
    const liveIds = events.filter(e => e.isLive).map(e => e.id);
    if (liveIds.length) {
      fetch(`/api/stream-status?ids=${liveIds.map(encodeURIComponent).join(',')}`)
        .then(r => r.json())
        .then(status => {
          for (const [id, hasStream] of Object.entries(status)) {
            const badge = document.getElementById(`badge-${id}`);
            if (!badge) continue;
            if (hasStream) {
              badge.className = 'event-live-badge';
              badge.textContent = '● LIVE';
            } else {
              badge.className = 'event-prematch-badge';
              badge.textContent = '⏳ Pre-Match';
            }
          }
        })
        .catch(() => {});
    }
  } catch (e) {
    grid.innerHTML = `<div class="fight-events-empty">Could not load events: ${e.message}</div>`;
  }
}

function _eventTimeStr(dateMs, now) {
  const diff = dateMs - now;
  const date = new Date(dateMs);
  if (diff < 0) return 'Starting soon';
  if (diff < 60 * 60 * 1000) return `In ${Math.round(diff / 60000)} min`;
  if (diff < 24 * 60 * 60 * 1000) {
    return `Today ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  }
  if (diff < 48 * 60 * 60 * 1000) {
    return `Tomorrow ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  }
  return date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }) +
    ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

async function loadSportEvent(matchId) {
  const streamEastUrl = `https://stream-east.net/watch.html?id=${matchId}`;
  const urlInput = document.getElementById('url-input');
  if (urlInput) urlInput.value = streamEastUrl;
  await loadStream();
}

// Keep old name as alias for any remaining references
const loadFightEvent = loadSportEvent;

// ─── Replay mode (no diag panel, back button visible) ────────────────────────

function enterReplayMode() {
  _isReplayMode = true;
  mainContent.classList.add('replay-mode');
  const backBtn = document.getElementById('back-btn');
  if (backBtn) backBtn.style.display = '';
  // Show replay badge, hide live badge
  const rb = document.getElementById('replay-badge');
  const lb = document.getElementById('live-badge');
  if (rb) rb.style.display = '';
  if (lb) lb.style.display = 'none';
}

function exitReplayMode() {
  _isReplayMode = false;
  mainContent.classList.remove('replay-mode');
  const backBtn = document.getElementById('back-btn');
  if (backBtn) backBtn.style.display = 'none';
  const rb = document.getElementById('replay-badge');
  if (rb) rb.style.display = 'none';
}

function backToReplays() {
  const ctx = _replayContext;
  exitReplayMode();

  // Tear down player
  stopCurrentStream();
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  currentStreamInfo = null;
  reconnectAttempts = 0;
  document.getElementById('stop-btn').style.display = 'none';
  const castWrap = document.getElementById('cast-wrap');
  if (castWrap) castWrap.style.display = 'none';
  dismissError();
  resetStats();
  clearLog();
  hideChapterNav();

  // Show landing
  mainContent.style.display = 'none';
  landing.style.display = '';

  // Restore replays tab at the right place
  if (ctx) {
    _currentPromo = ctx.promo;
    _openEventSlug = ctx.openSlug;
  }
  // Switch to replays tab
  document.querySelectorAll('.sport-tab').forEach(t => t.classList.toggle('active', t.dataset.sport === 'replays'));
  const grid = document.getElementById('sport-events-grid');
  if (grid) grid.classList.add('replay-mode-grid');

  loadReplays().then(() => {
    // Restore filter
    if (ctx?.filter) {
      const fi = document.getElementById('replay-filter-input');
      if (fi) { fi.value = ctx.filter; filterReplayList(ctx.filter); }
    }
    // Re-open the event panel the user was browsing
    if (ctx?.openSlug) {
      setTimeout(() => {
        const row = document.getElementById(`row-${ctx.openSlug}`);
        if (row && document.getElementById(`sources-${ctx.openSlug}`)?.style.display === 'none') {
          row.click();
        }
      }, 150);
    }
  });
}

// Load MMA events on startup
loadSportEvents('all');
_updateTabCounts();
_startAutoRefresh();

// ===== Replays =====

// ── Replay state ──────────────────────────────────────────────────────────────
let _currentPromo    = 'ufc';        // active promotion tab
let _allUfcEvents    = [];
let _allBellatorEvents = [];
let _allOneEvents    = [];
let _openEventSlug   = null;

const PROMOS = [
  { id: 'ufc',      label: 'UFC',           endpoint: '/api/ufc-events',      isPPV: name => /UFC \d+/.test(name), usePosters: true },
  { id: 'bellator', label: 'Bellator / PFL', endpoint: '/api/bellator-events', isPPV: name => /Bellator \d{3}/.test(name) },
  { id: 'one',      label: 'ONE',           endpoint: '/api/one-events',       isPPV: name => /ONE Fight Night/.test(name) },
  { id: 'boxing',   label: 'Boxing',        endpoint: null,                    isPPV: () => false },
];

function _promoCache(id) {
  if (id === 'ufc')      return _allUfcEvents;
  if (id === 'bellator') return _allBellatorEvents;
  if (id === 'one')      return _allOneEvents;
  return [];
}
function _setPromoCache(id, data) {
  if (id === 'ufc')      _allUfcEvents      = data;
  if (id === 'bellator') _allBellatorEvents = data;
  if (id === 'one')      _allOneEvents      = data;
}

async function loadReplays() {
  const grid = document.getElementById('sport-events-grid');
  if (!grid) return;
  _updateGridHeader(0, 'replays');

  const promoTabs = PROMOS.map(p => `
    <button class="promo-tab${p.id === _currentPromo ? ' active' : ''}"
            onclick="switchPromo('${p.id}')">${p.label}</button>
  `).join('');

  const isBoxing = _currentPromo === 'boxing';
  const placeholder = isBoxing
    ? 'Search fight… Canelo, Fury vs Usyk, Haney…'
    : _currentPromo === 'ufc' ? 'Filter events… UFC 309, Chimaev, Jones, Fight Night…'
    : _currentPromo === 'bellator' ? 'Filter events… Bellator 300, Nurmagomedov, Primus…'
    : 'Filter events… ONE Fight Night, Petchmorakot…';

  grid.innerHTML = `
    <div class="replay-search-strip">
      <div class="promo-tabs">${promoTabs}</div>
      <div class="replay-search-inner">
        <input id="replay-filter-input" type="text"
          placeholder="${placeholder}"
          autocomplete="off" spellcheck="false"
          oninput="${isBoxing ? 'boxingSearchInput(this.value)' : 'filterReplayList(this.value)'}" />
        ${isBoxing ? `<button class="boxing-search-btn" onclick="boxingSearchGo()">Search</button>` : ''}
      </div>
      <div class="replay-source-row">
        <span class="replay-src-label">Streams via:</span>
        <span class="replay-source-chip yt-chip">▶ YouTube</span>
        <span class="replay-source-chip">watchmmafull.com</span>
      </div>
    </div>
    <div id="replay-list-container">
      ${isBoxing
        ? `<div class="fight-events-empty boxing-hint">Type a fight or event above to search for replays.<br><span class="boxing-examples">e.g. "Fury vs Usyk", "Canelo Alvarez 2024", "Haney Prograis"</span></div>`
        : `<div class="fight-events-loading">Loading events…</div>`}
    </div>`;

  setTimeout(() => document.getElementById('replay-filter-input')?.focus(), 50);

  if (isBoxing) return; // boxing is search-only

  const promo = PROMOS.find(p => p.id === _currentPromo);
  if (_promoCache(_currentPromo).length === 0) {
    try {
      const data = await fetch(promo.endpoint).then(r => r.json());
      _setPromoCache(_currentPromo, data);
    } catch (e) {
      document.getElementById('replay-list-container').innerHTML =
        `<div class="fight-events-empty">Could not load events: ${e.message}</div>`;
      return;
    }
  }
  renderReplayList(_promoCache(_currentPromo));
}

function switchPromo(id) {
  if (_currentPromo === id) return;
  _currentPromo = id;
  _openEventSlug = null;
  loadReplays();
}

// Boxing-tab search
let _boxingSearchTimer = null;
function boxingSearchInput(val) {
  clearTimeout(_boxingSearchTimer);
  _boxingSearchTimer = setTimeout(() => boxingSearchGo(val), 500);
}

async function boxingSearchGo(query) {
  const input = document.getElementById('replay-filter-input');
  const q = (query ?? input?.value ?? '').trim();
  const container = document.getElementById('replay-list-container');
  if (!q) return;
  if (!container) return;
  container.innerHTML = `<div class="fight-events-loading">Searching for "${q}"…</div>`;
  try {
    const results = await fetch(`/api/search-replays?q=${encodeURIComponent(q)}`).then(r => r.json());
    if (!results.length) {
      container.innerHTML = `<div class="fight-events-empty">No sources found for "${q}".<br>Try a different name or fighters.</div>`;
      return;
    }
    // Render as a flat source list (no event nesting needed for boxing)
    const slug = 'boxing-' + q.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    container.innerHTML = `
      <div class="replay-list">
        <div class="replay-list-row active" id="row-${slug}">
          <div class="replay-row-info">
            <span class="replay-row-name">${q}</span>
            <span class="replay-row-date">${results.length} source${results.length !== 1 ? 's' : ''} found</span>
          </div>
        </div>
        <div class="replay-sources-panel" id="sources-${slug}" style="display:block">
          ${renderSourceItems(results, slug)}
        </div>
      </div>`;
  } catch (e) {
    container.innerHTML = `<div class="fight-events-empty">Search error: ${e.message}</div>`;
  }
}

function filterReplayList(query) {
  const q = query.trim().toLowerCase();
  const events = _promoCache(_currentPromo);
  const filtered = q ? events.filter(e => e.name.toLowerCase().includes(q)) : events;
  renderReplayList(filtered);
}

// Shared helper — renders source items HTML string (stream sources)
function renderSourceItems(results) {
  return `<div class="replay-sources-list">
    ${results.map(r => {
      const safeUrl = (r.embedUrl || r.url || '').replace(/'/g, "\\'");
      const safeLabel = (r.label || r.title || 'Watch').replace(/'/g, "\\'");
      const isYt = r.source === 'youtube' || (r.embedUrl || '').includes('youtube.com');
      const host = isYt ? 'YouTube' : (r.embedUrl || r.url || '').replace(/^https?:\/\//, '').split('/')[0];
      return `<div class="replay-source-row-item stream-source-item" onclick="playStreamSource('${safeUrl}', '${safeLabel}', this)">
        <span class="replay-src-quality q-stream">${isYt ? 'YT' : 'HD'}</span>
        <span class="replay-src-name">${r.label || r.title || 'Watch'} <span class="stream-src-badge${isYt ? ' yt-chip' : ''}">${host}</span></span>
        <span class="replay-src-play">▶ Watch</span>
      </div>`;
    }).join('')}
  </div>`;
}

// Play a watchmmafull embed URL — feeds it into the existing Puppeteer scan flow
async function playStreamSource(embedUrl, label, rowEl) {
  const playBtn = rowEl?.querySelector('.replay-src-play');
  if (playBtn) { playBtn.textContent = 'Scanning…'; rowEl.style.opacity = '0.6'; rowEl.style.pointerEvents = 'none'; }

  // Save replay context so the back button can restore it
  if (_currentSport === 'replays') {
    _replayContext = {
      promo: _currentPromo,
      openSlug: _openEventSlug,
      filter: document.getElementById('replay-filter-input')?.value || '',
    };
    _isReplayMode = true;
  }

  urlInput.value = embedUrl;
  clearBtn.style.display = '';
  await loadStream();

  // If stream loaded successfully, enter replay mode UI
  if (_isReplayMode && mainContent.style.display !== 'none') {
    enterReplayMode();
  } else if (_isReplayMode && mainContent.style.display === 'none') {
    // loadStream failed — reset replay mode
    _isReplayMode = false;
    _replayContext = null;
    if (playBtn) { playBtn.textContent = '▶ Watch'; rowEl.style.opacity = '1'; rowEl.style.pointerEvents = ''; }
  }
}

function renderReplayList(events) {
  const promo = PROMOS.find(p => p.id === _currentPromo);
  if (promo?.usePosters) {
    renderPosterGrid(events);
    return;
  }
  // ── Text list (Bellator / ONE) ─────────────────────────────────────────────
  const c = document.getElementById('replay-list-container');
  if (!c) return;
  if (!events.length) {
    c.innerHTML = `<div class="fight-events-empty">No events match that search.</div>`;
    return;
  }
  c.innerHTML = `
    <div class="replay-list">
      ${events.map(ev => {
        const d = new Date(ev.date);
        const dateStr = d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
        const isPPV = promo?.isPPV(ev.name);
        return `<div class="replay-list-row${isPPV ? ' ppv-row' : ''}" id="row-${ev.slug}" onclick="toggleReplaySources('${ev.slug}', '${ev.name.replace(/'/g,"\\'")}', ${ev.date || 0})">
          <div class="replay-row-info">
            <span class="replay-row-name">${ev.name}</span>
            <span class="replay-row-date">${dateStr}</span>
          </div>
          <span class="replay-row-arrow">›</span>
        </div>
        <div class="replay-sources-panel" id="sources-${ev.slug}" style="display:none"></div>`;
      }).join('')}
    </div>`;
}

// ── Poster grid (UFC) ──────────────────────────────────────────────────────────

function renderPosterGrid(events) {
  const c = document.getElementById('replay-list-container');
  if (!c) return;
  if (!events.length) {
    c.innerHTML = `<div class="fight-events-empty">No events match that search.</div>`;
    return;
  }
  c.innerHTML = `
    <div class="poster-grid" id="poster-grid">
      ${events.map(ev => {
        const d       = new Date(ev.date);
        const year    = d.getFullYear();
        const month   = d.toLocaleDateString('en-AU', { month: 'short' });
        const dayNum  = d.getDate();
        const subtitle = ev.name.replace(/^UFC\s+\d+:\s*/i, '').replace(/^UFC Fight Night:\s*/i, '').replace(/^UFC on \w+:\s*/i, '').replace(/^UFC Freedom\s*/i, '');
        const isNumbered = ev.number !== null && ev.number !== undefined;
        const isUpcoming = ev.upcoming === true;
        const safeSlug  = ev.slug.replace(/'/g, "\\'");
        const safeName  = ev.name.replace(/'/g, "\\'");
        const safeWiki  = (ev.wikiTitle || '').replace(/'/g, "\\'");
        return `<div class="poster-card${_openEventSlug === ev.slug ? ' selected' : ''}${isUpcoming ? ' upcoming' : ''}"
                     id="poster-${ev.slug}"
                     onclick="openPosterEvent('${safeSlug}','${safeName}',${ev.date||0},'${safeWiki}')">
          <div class="poster-img-wrap">
            ${ev.posterUrl
              ? `<img src="${ev.posterUrl}" loading="lazy" alt="${ev.name}" />`
              : `<div class="poster-placeholder"><span>${isNumbered ? 'UFC ' + ev.number : 'UFC'}</span></div>`}
            ${isUpcoming ? `<div class="poster-upcoming-badge">UPCOMING</div>` : ''}
            <div class="poster-hover-overlay">
              <span class="poster-play-icon">${isUpcoming ? '📋' : '▶'}</span>
              <span class="poster-play-label">${isUpcoming ? 'Fight Card' : 'Fight Card'}</span>
            </div>
          </div>
          <div class="poster-meta">
            <span class="poster-meta-sub">${subtitle || ev.name}</span>
            <span class="poster-meta-date">${dayNum} ${month} ${year}</span>
          </div>
        </div>`;
      }).join('')}
    </div>
    <div id="poster-fight-panel" class="poster-fight-panel" style="display:none"></div>`;

  // Restore open state after re-render (e.g. after filter)
  if (_openEventSlug) {
    const ev = events.find(e => e.slug === _openEventSlug);
    if (ev) _restorePosterPanel(ev);
  }
}

async function openPosterEvent(slug, name, dateMs, wikiTitle) {
  const panel = document.getElementById('poster-fight-panel');
  if (!panel) return;

  // Toggle off if same card clicked again
  if (_openEventSlug === slug) {
    document.querySelectorAll('.poster-card').forEach(c => c.classList.remove('selected'));
    panel.style.display = 'none';
    panel.innerHTML = '';
    _openEventSlug = null;
    _openFightIdx = null;
    return;
  }

  _openEventSlug = slug;
  _openFightIdx  = null;
  document.querySelectorAll('.poster-card').forEach(c => c.classList.remove('selected'));
  document.getElementById(`poster-${slug}`)?.classList.add('selected');

  const ev = _promoCache(_currentPromo).find(e => e.slug === slug);
  _showPosterPanel(panel, ev, name);
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  await _loadPosterFights(panel, name, dateMs, wikiTitle);
}

async function _restorePosterPanel(ev) {
  const panel = document.getElementById('poster-fight-panel');
  if (!panel) return;
  document.getElementById(`poster-${ev.slug}`)?.classList.add('selected');
  _showPosterPanel(panel, ev, ev.name);
  await _loadPosterFights(panel, ev.name, ev.date, ev.wikiTitle);
}

function _showPosterPanel(panel, ev, name) {
  const dateStr = ev ? new Date(ev.date).toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' }) : '';
  panel.style.display = '';
  panel.innerHTML = `
    <div class="pfp-header">
      ${ev?.posterUrl ? `<img class="pfp-thumb" src="${ev.posterUrl}" alt="${name}" />` : ''}
      <div class="pfp-title-block">
        <h3 class="pfp-name">${name}</h3>
        <span class="pfp-date">${dateStr}</span>
      </div>
    </div>
    <div class="pfp-body">
      <div class="replay-sources-loading">
        <span class="spinner" style="display:inline-block;width:14px;height:14px;border-width:2px;vertical-align:middle;margin-right:8px"></span>
        Loading fight card…
      </div>
    </div>`;
}

async function _loadPosterFights(panel, name, dateMs, wikiTitle) {
  try {
    const wikiParam = wikiTitle ? `&wiki=${encodeURIComponent(wikiTitle)}` : '';
    const dateParam = dateMs    ? `&date=${dateMs}` : '';
    const result = await fetch(`/api/event-fights?q=${encodeURIComponent(name)}${dateParam}${wikiParam}`)
      .then(r => r.json());
    const body = panel.querySelector('.pfp-body');
    if (!body) return;
    if (result.type === 'fights' && result.fights?.length) {
      renderFightList(result.fights, body);
    } else {
      body.innerHTML = `<div class="fight-events-empty" style="padding:20px 16px">No fight card found for this event yet.</div>`;
    }
  } catch (e) {
    const body = panel.querySelector('.pfp-body');
    if (body) body.innerHTML = `<div class="fight-events-empty" style="padding:20px 16px">Error: ${e.message}</div>`;
  }
}

async function toggleReplaySources(slug, name, dateMs) {
  const panel = document.getElementById(`sources-${slug}`);
  const row = document.getElementById(`row-${slug}`);
  if (!panel || !row) return;

  // Collapse if already open
  if (_openEventSlug === slug) {
    panel.style.display = 'none';
    row.classList.remove('active');
    _openEventSlug = null;
    return;
  }

  // Collapse any previously open panel
  if (_openEventSlug) {
    const prev = document.getElementById(`sources-${_openEventSlug}`);
    const prevRow = document.getElementById(`row-${_openEventSlug}`);
    if (prev) prev.style.display = 'none';
    if (prevRow) prevRow.classList.remove('active');
  }
  _openEventSlug = slug;
  _openFightIdx = null;   // reset fight expand state for the new event
  row.classList.add('active');
  panel.style.display = '';
  panel.innerHTML = `<div class="replay-sources-loading"><span class="spinner" style="display:inline-block;width:12px;height:12px;border-width:2px"></span> Loading fight card…</div>`;
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  try {
    const dateParam = dateMs ? `&date=${dateMs}` : '';
    const result = await fetch(`/api/event-fights?q=${encodeURIComponent(name)}${dateParam}`).then(r => r.json());

    // Event just aired — nothing uploaded yet
    if (result.notYet) {
      panel.innerHTML = `<div class="replay-sources-empty">
        <span class="sources-empty-icon">⏳</span>
        <strong>Event just aired — full replay not uploaded yet.</strong><br>
        Check back in a few hours. Torrents usually appear 4–8 hours after the event ends.
      </div>`;
      return;
    }

    // watchmmafull or Wikipedia found individual fight pages — show fight card
    if (result.type === 'fights') {
      renderFightList(result.fights, panel);
      return;
    }

    // Nothing found at all
    panel.innerHTML = `<div class="replay-sources-empty">
      <span class="sources-empty-icon">🔍</span>
      No sources found for this event yet.
    </div>`;
  } catch (e) {
    panel.innerHTML = `<div class="replay-sources-empty">Error: ${e.message}</div>`;
  }
}

// ── Fight card list ────────────────────────────────────────────────────────────

let _currentFights = [];   // fights from the last /api/event-fights response
let _openFightIdx   = null; // which fight row is currently expanded

function renderFightList(fights, panel) {
  _currentFights = fights;
  const rows = fights.map((fight, i) => `
    <div class="fight-card-row" id="fight-row-${i}" onclick="toggleFightSources(${i}, this)">
      <span class="fight-card-icon">🥊</span>
      <span class="fight-card-name">${fight.label}</span>
      <span class="fight-card-arrow">›</span>
    </div>
    <div class="fight-card-streams" id="fight-streams-${i}" style="display:none"></div>`
  ).join('');

  panel.innerHTML = `<div class="fight-card-list">
    <div class="fight-card-header">Fight Card — tap a fight to watch</div>
    ${rows}
  </div>`;
}

async function toggleFightSources(idx, rowEl) {
  const streamsPanel = document.getElementById(`fight-streams-${idx}`);
  const fight = _currentFights[idx];
  if (!streamsPanel || !fight) return;

  // Collapse if already open
  if (_openFightIdx === idx) {
    streamsPanel.style.display = 'none';
    rowEl.classList.remove('active');
    _openFightIdx = null;
    return;
  }

  // Collapse any previously open fight stream
  if (_openFightIdx !== null) {
    const prevStreams = document.getElementById(`fight-streams-${_openFightIdx}`);
    const prevRow    = document.getElementById(`fight-row-${_openFightIdx}`);
    if (prevStreams) prevStreams.style.display = 'none';
    if (prevRow)    prevRow.classList.remove('active');
  }
  _openFightIdx = idx;
  rowEl.classList.add('active');
  streamsPanel.style.display = '';
  streamsPanel.innerHTML = `<div class="replay-sources-loading" style="padding:8px 20px"><span class="spinner" style="display:inline-block;width:10px;height:10px;border-width:2px"></span> Finding stream…</div>`;
  streamsPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  try {
    const streams = await fetch('/api/fight-streams', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fight),
    }).then(r => r.json());

    if (!streams.length) {
      streamsPanel.innerHTML = `<div class="fight-streams-empty">No stream found for this fight yet — try another fight or check back later.</div>`;
      return;
    }

    streamsPanel.innerHTML = streams.map(s => {
      const safeUrl   = s.embedUrl.replace(/'/g, "\\'");
      const safeLabel = (s.label || 'Watch').replace(/'/g, "\\'");
      const isYt = s.embedUrl.includes('youtube.com') || s.embedUrl.includes('youtu.be');
      const host = isYt ? 'YouTube' : s.embedUrl.replace(/^https?:\/\//, '').split('/')[0];
      return `<div class="fight-stream-item" onclick="playStreamSource('${safeUrl}', '${safeLabel}', this)">
        <span class="fight-stream-icon">▶</span>
        <span class="fight-stream-label">${s.label || 'Watch'}</span>
        <span class="fight-stream-host">${host}</span>
        <span class="replay-src-play">Watch</span>
      </div>`;
    }).join('');
  } catch (e) {
    streamsPanel.innerHTML = `<div class="fight-streams-empty">Error: ${e.message}</div>`;
  }
}

// ── Chapter / fight navigation panel ─────────────────────────────────────────

function fmtTime(secs) {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  return `${m}:${String(s).padStart(2,'0')}`;
}

function showChapterNav(chapters, fightList) {
  let panel = document.getElementById('chapter-nav');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'chapter-nav';
    panel.className = 'chapter-nav';
    // Insert below the video player quality bar
    const qualityBar = document.querySelector('.quality-bar');
    if (qualityBar) qualityBar.parentNode.insertBefore(panel, qualityBar.nextSibling);
    else document.querySelector('.player-col')?.appendChild(panel);
  }

  const hasTimestamps = chapters && chapters.length > 0;
  const hasFightList = fightList && fightList.length > 0;

  if (!hasTimestamps && !hasFightList) {
    panel.style.display = 'none';
    return;
  }

  panel.style.display = '';

  if (hasTimestamps) {
    // Full chapter navigation with seek buttons
    panel.innerHTML = `
      <div class="chapter-nav-title">⏱ Jump to fight</div>
      <div class="chapter-list">
        ${chapters.map((ch, i) => `
          <button class="chapter-btn" onclick="seekToChapter(${ch.startTime})" title="${fmtTime(ch.startTime)}">
            <span class="chapter-time">${fmtTime(ch.startTime)}</span>
            <span class="chapter-label">${ch.title}</span>
          </button>`).join('')}
      </div>`;
  } else {
    // Fight list from page HTML — no timestamps, just show as reference
    panel.innerHTML = `
      <div class="chapter-nav-title">🥊 Fight card</div>
      <div class="chapter-list chapter-list-text">
        ${fightList.map(f => `<div class="chapter-fight-text">${f}</div>`).join('')}
      </div>
      <div class="chapter-nav-hint">Scrub the timeline to find each fight</div>`;
  }
}

function seekToChapter(secs) {
  if (video) {
    video.currentTime = secs;
    video.play().catch(() => {});
    // Highlight the active chapter
    document.querySelectorAll('.chapter-btn').forEach(b => {
      b.classList.toggle('active', parseInt(b.querySelector('.chapter-time')?.dataset?.secs || -1) === secs);
    });
  }
}

function hideChapterNav() {
  const panel = document.getElementById('chapter-nav');
  if (panel) panel.style.display = 'none';
}

// Track current chapter highlight as video plays
function updateChapterHighlight() {
  if (!video || !currentStreamInfo?.isReplay) return;
  const t = video.currentTime;
  const chapters = currentStreamInfo?.chapters || [];
  if (!chapters.length) return;
  document.querySelectorAll('.chapter-btn').forEach((btn, i) => {
    const ch = chapters[i];
    const next = chapters[i + 1];
    const active = t >= ch.startTime && (!next || t < next.startTime);
    btn.classList.toggle('active', active);
  });
}
// Attach after DOMContentLoaded when video element exists
document.addEventListener('DOMContentLoaded', () => {
  const vid = document.getElementById('video');
  if (vid) vid.addEventListener('timeupdate', updateChapterHighlight);
});

// ── Load & play a replay ──────────────────────────────────────────────────────

async function loadReplayEvent(title) {
  dismissError();
  hideCandidates();
  hideChapterNav();
  setLoading(true, `🎬 Searching for "${title}"…`);
  stopCurrentStream();
  reconnectAttempts = 0;
  rescanAttempts = 0;

  try {
    const res = await fetch('/api/find-replay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    });
    const data = await res.json();

    if (!data.success) {
      showError('Replay not found', data.error || '', data.hint);
      setLoading(false);
      return;
    }

    currentStreamInfo = { ...data, isReplay: true };
    streamTitle.textContent = data.title || title;
    liveBadge.style.display = 'none';
    const rb = document.getElementById('replay-badge');
    if (rb) rb.style.display = '';

    const castWrap = document.getElementById('cast-wrap');
    if (castWrap) castWrap.style.display = '';

    showMainContent();
    clearLog();
    resetStats();

    const src = data.replaySource === 'youtube' ? 'YouTube' : data.replaySource || 'web';
    const sizeStr = data.filesize ? ` · ${(data.filesize / 1e9).toFixed(1)} GB` : '';
    log('info', '🎬', `Replay found via ${src}${sizeStr}`);
    if (data.replayPageUrl) log('info', '🔗', `Source page: ${data.replayPageUrl}`);
    if (data.candidates?.length > 1) showCandidates(data.candidates, data.streamUrl);

    // Show chapter / fight card nav
    showChapterNav(data.chapters || [], data.fightList || []);

    playStream(data);
  } catch (err) {
    showError('Network error', err.message);
  }
  setLoading(false);
}

// Hide chapter nav when stream is stopped (replay badge is handled by exitReplayMode)
const _origStopStream = stopStream;
stopStream = function() {
  hideChapterNav();
  _origStopStream();
};
