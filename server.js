const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const fetch = require('node-fetch');
const { execFile } = require('child_process');
const path = require('path');
const os = require('os');
const puppeteerExtra = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteerExtra.use(StealthPlugin());

// ─── Chrome path (must be declared before warm-browser IIFE below) ───────────
// Resolution order:
//  1. PUPPETEER_EXECUTABLE_PATH env var (set by Docker / Pi deployment)
//  2. Bundled Chromium from 'puppeteer' package (Windows portable build)
//  3. Platform-specific system Chrome / Edge
const CHROME_PATH = (() => {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
  try { return require('puppeteer').executablePath(); } catch {}   // bundled Chromium
  if (process.platform === 'win32') {
    const fs = require('fs'), p = require('path');
    const roots = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean);
    for (const r of roots) {
      const c = p.join(r, 'Google', 'Chrome', 'Application', 'chrome.exe');
      try { if (fs.existsSync(c)) return c; } catch {}
    }
    // Microsoft Edge as last resort
    const edge = p.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe');
    try { if (require('fs').existsSync(edge)) return edge; } catch {}
  }
  return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'; // macOS fallback
})();

// ─── TLS fingerprint spoofing (node-tls-client) ───────────────────────────────
// Spoof Chrome's JA3/JA4 TLS fingerprint so Node.js can fetch CDN segments
// directly — eliminating the Chrome pool page IPC + base64 round-trip entirely.
let tlsSession = null;

// ─── Warm browser (pre-launched at startup to eliminate first-scan delay) ─────
let warmBrowser = null;
const BROWSER_LAUNCH_ARGS = [
  '--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu',
  '--disable-dev-shm-usage', '--mute-audio',
  '--disable-blink-features=AutomationControlled',
  '--window-size=1280,720',
  '--disable-web-security',
  '--disable-features=IsolateOrigins,site-per-process',
];
(async () => {
  try {
    warmBrowser = await puppeteerExtra.launch({
      executablePath: CHROME_PATH,
      headless: true,
      args: BROWSER_LAUNCH_ARGS,
      defaultViewport: { width: 1280, height: 720 },
      timeout: 60000,
    });
    console.log('[browser] Warm browser ready — first scan will start instantly');
  } catch (e) {
    console.log('[browser] Warm browser pre-launch failed:', e.message.slice(0, 80));
  }
})();
(async () => {
  try {
    const { Session, initTLS } = require('node-tls-client');
    await initTLS();
    tlsSession = new Session({ clientIdentifier: 'chrome_131' });
    console.log('[tls-client] Chrome TLS fingerprint session ready (chrome_131)');
  } catch (e) {
    console.log('[tls-client] Not available:', e.message.slice(0, 80));
  }
})();

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Helpers ────────────────────────────────────────────────────────────────

// Broadcast a JSON message to all connected WebSocket clients
function wssBroadcast(msg) {
  const str = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(str);
  }
}

// Parse max resolution from an HLS master playlist manifest
function getMaxQuality(manifestContent) {
  if (!manifestContent || !manifestContent.includes('#EXT-X-STREAM-INF')) return null;
  const heights = [...manifestContent.matchAll(/RESOLUTION=\d+x(\d+)/gi)].map(m => parseInt(m[1]));
  if (heights.length === 0) return null;
  const maxH = Math.max(...heights);
  if (maxH >= 1080) return '1080p';
  if (maxH >= 720)  return '720p HD';
  if (maxH >= 480)  return '480p';
  return `${maxH}p`;
}

function detectStreamType(inputUrl) {
  try {
    const u = new URL(inputUrl);
    const host = u.hostname.toLowerCase();
    if (host.includes('youtube.com') || host.includes('youtu.be')) return 'youtube';
    if (host.includes('twitch.tv')) return 'twitch';
    if (host.includes('facebook.com') || host.includes('fb.com')) return 'facebook';
    if (host.includes('twitter.com') || host.includes('x.com')) return 'twitter';
    if (inputUrl.includes('.m3u8')) return 'hls';
    if (inputUrl.includes('.mpd')) return 'dash';
    if (inputUrl.includes('.mp4') || inputUrl.includes('.webm')) return 'direct';
    return 'webpage';
  } catch {
    return 'invalid';
  }
}

function browserHeaders(refererUrl, compress = false) {
  let referer = '';
  try { referer = new URL(refererUrl).origin + '/'; } catch {}
  return {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    // Request uncompressed by default so we can read text directly
    // node-fetch v2 does not auto-decompress brotli
    'Accept-Encoding': compress ? 'gzip, deflate' : 'identity',
    'Origin': referer.replace(/\/$/, ''),
    'Referer': referer,
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'cross-site',
  };
}

// ─── Proxy (CORS bypass + manifest URL rewriting) ───────────────────────────

// Parallel range downloader — bypasses per-connection CDN throttling.
// Fires N concurrent range requests and concatenates the chunks.
// Returns assembled Buffer, or null if the CDN doesn't support ranges / errors out.
async function parallelFetch(url, headers, contentLength, N = 4) {
  const chunkSize = Math.ceil(contentLength / N);
  try {
    const chunks = await Promise.all(
      Array.from({ length: N }, (_, i) => {
        const start = i * chunkSize;
        const end = Math.min(start + chunkSize - 1, contentLength - 1);
        return fetch(url, {
          headers: { ...headers, Range: `bytes=${start}-${end}` },
          timeout: 30000,
        }).then(r => {
          if (!r.ok && r.status !== 206) throw new Error(`chunk ${i}: ${r.status}`);
          return r.buffer();
        });
      })
    );
    return Buffer.concat(chunks);
  } catch (e) {
    console.warn('[proxy:parallel] failed, will fallback:', e.message);
    return null;
  }
}

app.get('/proxy/stream', async (req, res) => {
  const targetUrl = req.query.url;
  const referer = req.query.ref || targetUrl;
  const cookie = req.query.cookie || '';
  if (!targetUrl) return res.status(400).json({ error: 'Missing url' });

  try {
    const headers = { ...browserHeaders(referer) };
    if (cookie) headers['Cookie'] = cookie;

    // ── Parallel download for large segments (.ts / .jpg disguised TS) ────────
    // Many CDNs throttle per-connection bandwidth. Firing 4 range requests
    // in parallel multiplies effective throughput (e.g. 155 KB/s → 524 KB/s).
    // We do a HEAD first to get content-length cheaply, then decide.
    const looksLikeSeg = /\.(ts|jpg|mp4|aac|fmp4|m4s)(\?|$)/i.test(targetUrl.split('?')[0]);
    if (looksLikeSeg) {
      try {
        const headRes = await fetch(targetUrl, { method: 'HEAD', headers, timeout: 6000, redirect: 'follow' });
        if (headRes.ok) {
          const cl = parseInt(headRes.headers.get('content-length') || '0');
          const acceptsRanges = headRes.headers.get('accept-ranges') === 'bytes';
          if (cl > 400 * 1024 && acceptsRanges) {   // > 400 KB and supports ranges
            const buf = await parallelFetch(targetUrl, headers, cl, 16);
            if (buf) {
              res.set('Access-Control-Allow-Origin', '*');
              res.set('Cache-Control', 'no-cache');
              res.set('Content-Type', headRes.headers.get('content-type') || 'video/mp2t');
              res.set('Content-Length', buf.length);
              return res.send(buf);
            }
          }
        }
      } catch (e) {
        // HEAD failed or parallel failed — fall through to normal single-connection
        console.warn('[proxy:parallel] HEAD failed:', e.message);
      }
    }
    // ──────────────────────────────────────────────────────────────────────────

    const response = await fetch(targetUrl, {
      headers,
      timeout: 15000,
      redirect: 'follow',
    });

    if (!response.ok) {
      return res.status(response.status).json({
        error: `Upstream returned ${response.status} ${response.statusText}`,
        hint: response.status === 403
          ? 'The streaming CDN rejected the request (403). The stream may require a browser cookie or the URL may have expired.'
          : response.status === 404
          ? 'Stream not found (404). The URL may have expired — live stream URLs often expire within minutes.'
          : null,
      });
    }

    res.set('Access-Control-Allow-Origin', '*');
    res.set('Cache-Control', 'no-cache');

    const contentType = response.headers.get('content-type') || '';
    const isManifest = contentType.includes('mpegurl') || contentType.includes('x-mpegurl') ||
                       targetUrl.includes('.m3u8') || targetUrl.includes('manifest');

    if (isManifest) {
      res.set('Content-Type', 'application/vnd.apple.mpegurl');
      let text = await response.text();

      // Resolve base URL for relative segment URLs
      const baseUrl = targetUrl.substring(0, targetUrl.lastIndexOf('/') + 1);
      const origin = new URL(targetUrl).origin;

      function proxyUrl(u) {
        u = u.trim();
        if (!u) return u;
        let abs;
        if (u.startsWith('http://') || u.startsWith('https://')) {
          abs = u;
        } else if (u.startsWith('//')) {
          abs = 'https:' + u;
        } else if (u.startsWith('/')) {
          abs = origin + u;
        } else {
          abs = baseUrl + u;
        }
        let qs = `ref=${encodeURIComponent(referer)}&url=${encodeURIComponent(abs)}`;
        if (cookie) qs += `&cookie=${encodeURIComponent(cookie)}`;
        return `/proxy/stream?${qs}`;
      }

      // Rewrite EXT-X-KEY URIs (encryption keys)
      text = text.replace(/URI="([^"]+)"/g, (_, uri) => `URI="${proxyUrl(uri)}"`);

      // Rewrite all non-comment, non-empty lines (segment/sub-manifest URLs)
      text = text.replace(/^(?!#)(\S.*)$/gm, (line) => proxyUrl(line));

      return res.send(text);
    }

    res.set('Content-Type', contentType || 'application/octet-stream');
    response.body.pipe(res);
  } catch (err) {
    console.error('[proxy]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── yt-dlp extraction ───────────────────────────────────────────────────────

// Parse timestamp lines from YouTube video descriptions.
// Handles formats like "0:00 Intro", "1:23:45 Jones vs Miocic", "- 00:30 Fight 1" etc.
function parseDescriptionTimestamps(description, totalDuration) {
  const lines = description.split('\n');
  const results = [];
  const reTimestamp = /(?:^|[\s\-–•▶])((?:\d{1,2}:)?\d{1,2}:\d{2})[\s\-–:]+(.+)/;
  for (const line of lines) {
    const m = line.match(reTimestamp);
    if (!m) continue;
    const timeParts = m[1].split(':').map(Number);
    let secs = 0;
    if (timeParts.length === 3) secs = timeParts[0]*3600 + timeParts[1]*60 + timeParts[2];
    else if (timeParts.length === 2) secs = timeParts[0]*60 + timeParts[1];
    const label = m[2].trim().slice(0, 80);
    if (label.length > 1) results.push({ startTime: secs, title: label });
  }
  // Sort by time and compute end times
  results.sort((a, b) => a.startTime - b.startTime);
  return results.map((ch, i) => ({
    ...ch,
    endTime: results[i + 1]?.startTime ?? Math.round(totalDuration),
  })).filter(ch => ch.title);
}

function extractWithYtDlp(inputUrl) {
  return new Promise((resolve, reject) => {
    const paths = ['yt-dlp', '/usr/local/bin/yt-dlp', '/opt/homebrew/bin/yt-dlp',
                   `${process.env.HOME}/.local/bin/yt-dlp`, '/usr/bin/yt-dlp',
                   `${process.env.HOME}/Library/Python/3.9/bin/yt-dlp`,
                   `${process.env.HOME}/Library/Python/3.10/bin/yt-dlp`,
                   `${process.env.HOME}/Library/Python/3.11/bin/yt-dlp`,
                   `${process.env.HOME}/Library/Python/3.12/bin/yt-dlp`];
    let i = 0;
    function tryNext() {
      if (i >= paths.length) return reject(new Error('yt-dlp not installed'));
      execFile(paths[i++], ['--no-warnings', '-j', '--no-playlist', inputUrl],
        { timeout: 30000 }, (err, stdout) => {
          if (err) return tryNext();
          try {
            const info = JSON.parse(stdout);
            const formats = info.formats || [];
            const hlsFmt = formats.find(f =>
              f.protocol === 'm3u8_native' || f.protocol === 'm3u8' ||
              (f.url && f.url.includes('.m3u8'))
            );
            const streamUrl = hlsFmt?.url || (info.url?.includes('.m3u8') ? info.url : null) ||
              formats.filter(f => f.url).sort((a,b) => (b.tbr||0)-(a.tbr||0))[0]?.url ||
              info.url;
            // Extract chapters — prefer native chapters, fall back to description timestamps
            let chapters = (info.chapters || []).map(c => ({
              title: c.title,
              startTime: Math.round(c.start_time),
              endTime: Math.round(c.end_time),
            }));
            if (chapters.length === 0 && info.description) {
              chapters = parseDescriptionTimestamps(info.description, info.duration || 0);
            }
            resolve({ streamUrl, title: info.title || 'Live Stream', isLive: info.is_live, chapters });
          } catch { reject(new Error('Failed to parse yt-dlp output')); }
        });
    }
    tryNext();
  });
}

// ─── YouTube search ───────────────────────────────────────────────────────────

const YTDLP_PATHS = [
  'yt-dlp', '/usr/local/bin/yt-dlp', '/opt/homebrew/bin/yt-dlp',
  `${process.env.HOME}/.local/bin/yt-dlp`, '/usr/bin/yt-dlp',
  `${process.env.HOME}/Library/Python/3.9/bin/yt-dlp`,
  `${process.env.HOME}/Library/Python/3.10/bin/yt-dlp`,
  `${process.env.HOME}/Library/Python/3.11/bin/yt-dlp`,
  `${process.env.HOME}/Library/Python/3.12/bin/yt-dlp`,
];

// Search YouTube and return up to maxResults video {url, title} objects.
// Uses yt-dlp with ytsearchN: prefix. Returns [] if yt-dlp unavailable.
function searchYouTubeMultiple(query, maxResults = 5) {
  return new Promise(resolve => {
    let i = 0;
    function tryNext() {
      if (i >= YTDLP_PATHS.length) return resolve([]);
      execFile(YTDLP_PATHS[i++],
        ['--no-warnings', '-j', `ytsearch${maxResults}:${query}`],
        { timeout: 25000 },
        (err, stdout) => {
          if (err) return tryNext();
          try {
            const results = stdout.trim().split('\n')
              .map(line => { try { return JSON.parse(line); } catch { return null; } })
              .filter(Boolean)
              .map(info => ({
                url: info.webpage_url || (info.id ? `https://www.youtube.com/watch?v=${info.id}` : null),
                title: info.title || query,
              }))
              .filter(r => r.url);
            resolve(results);
          } catch { tryNext(); }
        });
    }
    tryNext();
  });
}

async function findFightOnYoutube(query) {
  const results = await searchYouTubeMultiple(query, 1);
  return results.length > 0 ? results[0] : null;
}

// ─── Wikipedia fight card scraper (wikitext API) ─────────────────────────────
// Uses {{MMAevent bout|WeightClass|Fighter1|def.|Fighter2|...}} template format
// which is how all UFC event pages on Wikipedia are structured.

// Split "A|B|[[C|D]]|E" by top-level pipes only (ignores pipes inside [[...]])
function splitTemplateFields(str) {
  const fields = [];
  let depth = 0, cur = '';
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '[' && str[i + 1] === '[') { depth++; cur += '[['; i++; }
    else if (str[i] === ']' && str[i + 1] === ']') { depth--; cur += ']]'; i++; }
    else if (str[i] === '|' && depth === 0) { fields.push(cur.trim()); cur = ''; }
    else cur += str[i];
  }
  if (cur.trim()) fields.push(cur.trim());
  return fields;
}

function resolveWikiLink(raw) {
  // Strip (c) champion marker first, then resolve [[Page|Display]] or [[Page]]
  const cleaned = raw.replace(/\s*\(c\)\s*/gi, '').trim();
  const m = cleaned.match(/\[\[([^\]|#]+?)(?:\|([^\]]*))?\]\]/);
  if (m) return (m[2] || m[1]).replace(/_/g, ' ').trim();
  return cleaned.replace(/_/g, ' ').trim();
}

// Non-fighter Wikipedia links that appear in weight class / notes columns
const WIKI_NON_FIGHTER = /^(Heavyweight|Light Heavyweight|Middleweight|Welterweight|Lightweight|Featherweight|Bantamweight|Flyweight|Strawweight|Women|UFC|TBA|N\/A|Ultimate|Madison|New York|Performance|Fight of|Submission of|Decision|KO|TKO|Catchweight)/i;

function parseFightsFromWikitext(wikitext, eventContext) {
  const fights = [];
  const seen   = new Set();

  // Match every {{MMAevent bout ...}} template — fields may be newline-separated.
  // Use bracket-aware field splitter so pipes inside [[Link|Display]] don't break indexing.
  const boutRe = /\{\{MMAevent bout[\s\S]*?\}\}/gi;
  let m;
  while ((m = boutRe.exec(wikitext)) !== null) {
    // Strip the template name, split on top-level pipes, drop empty leading field
    const inner = m[0].replace(/^\{\{MMAevent bout\s*/i, '').replace(/\}\}$/, '');
    // Fields: [0]=WeightClass [1]=Fighter1 [2]=def./vs./NC [3]=Fighter2 [4]=Method ...
    const fields = splitTemplateFields(inner).filter(f => f.length > 0);
    if (fields.length < 4) continue;

    const f1 = resolveWikiLink(fields[1]);
    const f2 = resolveWikiLink(fields[3]);

    if (!f1 || !f2 || f1.length < 3 || f2.length < 3) continue;
    if (WIKI_NON_FIGHTER.test(f1) || WIKI_NON_FIGHTER.test(f2)) continue;
    // fields[2] should be the result verb — skip if it looks like more fighter data
    const verb = fields[2]?.toLowerCase() || '';
    if (!verb.includes('def') && !verb.includes('vs') && !verb.includes('nc') && !verb.includes('no contest')) continue;

    const key = [f1, f2].sort().join('|');
    if (!seen.has(key)) {
      seen.add(key);
      fights.push({ label: `${f1} vs ${f2}`, f1, f2, source: 'wikipedia', eventContext });
    }
    if (fights.length >= 15) break;
  }
  return fights;
}

async function discoverFightsFromWikipedia(eventName) {
  // Build the Wikipedia page slug — e.g. "UFC 309" → "UFC_309"
  const slug = eventName.trim().replace(/\s+/g, '_').replace(/[^A-Za-z0-9_:.'-]/g, '');
  const apiUrl = `https://en.wikipedia.org/w/api.php?action=parse&page=${encodeURIComponent(slug)}&prop=wikitext&format=json&formatversion=2`;
  try {
    const raw = await safeFetch(apiUrl, 'https://en.wikipedia.org/');
    if (!raw) return [];
    const data = JSON.parse(raw);
    if (data.error || !data.parse?.wikitext) return [];
    return parseFightsFromWikitext(data.parse.wikitext, eventName);
  } catch { return []; }
}

// ─── Static page scanner (HTML/JS regex — fast but misses dynamic streams) ──

const STREAM_RE = [
  /["'`](https?:\/\/[^"'`\s<>{}]{6,}\.m3u8[^"'`\s<>]*)/g,
  /["'`](https?:\/\/[^"'`\s<>{}]{6,}\.mpd[^"'`\s<>]*)/g,
  /(?:["']?)(?:file|src|url|stream|hls|source|hlsUrl|streamUrl|videoUrl|manifestUrl|playbackUrl|contentUrl|liveUrl|hlsManifest|manifestUri|streamingUrl|live_url|stream_url|hls_url|video_url)(?:["']?)\s*[=:]\s*["'`](https?:\/\/[^"'`\s<>]{10,})/gi,
  /data-(?:src|url|stream|hls|file)=["'](https?:\/\/[^"']{10,})/gi,
];

// These domains host JS/CSS libraries, not streams — skip them even if their
// URL accidentally matches the /hls|live|stream/ path-component test.
const EXTRACT_SKIP_DOMAINS = [
  'jsdelivr.net', 'cdnjs.cloudflare.com', 'unpkg.com', 'cdn.plyr.io',
  'ajax.googleapis.com', 'cdn.jwplayer.com', 'cdn.bitmovin.com',
];

function extractUrls(text) {
  const found = new Set();
  for (const re of STREAM_RE) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const u = m[1];
      if (!u) continue;
      // Must look like a stream (m3u8 / mpd / path contains hls|live|stream|manifest)
      if (!u.includes('.m3u8') && !u.includes('.mpd') && !/\/(hls|live|stream|manifest)(\/|$|\?|#)/.test(u)) continue;
      // Skip static asset files (JS libraries, CSS, HTML pages)
      if (/\.(js|css|html?|png|jpg|gif|svg|woff2?|ttf)(\?[^"]*)?$/.test(u)) continue;
      // Skip known CDN domains that serve libraries, not streams
      try {
        const hostname = new URL(u).hostname;
        if (EXTRACT_SKIP_DOMAINS.some(d => hostname.endsWith(d))) continue;
        found.add(u);
      } catch {}
    }
  }
  return found;
}

async function safeFetch(url, referer) {
  try {
    const r = await fetch(url, { headers: browserHeaders(referer || url), timeout: 10000, redirect: 'follow' });
    if (!r.ok) return '';
    return await r.text();
  } catch { return ''; }
}

async function staticScan(inputUrl) {
  const found = new Set();
  const base = new URL(inputUrl);
  const html = await safeFetch(inputUrl);
  if (!html) return [];

  // ── VidSonic: stream URL is hex-encoded and reversed in _0x1 variable ──────
  // Format: const _0x1 = 'ab|cd|ef|...'; then decoded = hexToStr(_0x1.join('')).reverse()
  if (base.hostname.includes('vidsonic.net')) {
    const m0x1 = html.match(/(?:const|let|var)\s+_0x1\s*=\s*'([^']+)'/);
    if (m0x1) {
      const hex = m0x1[1].replace(/\|/g, '');
      let decoded = '';
      for (let i = 0; i < hex.length; i += 2) decoded += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
      const streamUrl = decoded.split('').reverse().join('');
      if (streamUrl.startsWith('http') && (streamUrl.includes('.m3u8') || streamUrl.includes('/hls'))) {
        console.log('[vidsonic] Decoded stream URL:', streamUrl.split('?')[0]);
        return [{ url: streamUrl, headers: { referer: inputUrl, origin: 'https://vidsonic.net' } }];
      }
    }
  }
  // ───────────────────────────────────────────────────────────────────────────
  extractUrls(html).forEach(u => found.add(u));

  // Inline scripts
  for (const [, s] of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi))
    extractUrls(s).forEach(u => found.add(u));

  // External scripts (skip analytics/social)
  const extScripts = [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)]
    .map(m => m[1])
    .filter(s => !/(google|analytics|facebook|twitter|gtag|ads|recaptcha)/.test(s))
    .slice(0, 6)
    .map(s => s.startsWith('http') ? s : s.startsWith('//') ? base.protocol + s : base.origin + (s.startsWith('/') ? s : '/' + s));

  await Promise.all(extScripts.map(async url => {
    const text = await safeFetch(url, inputUrl);
    extractUrls(text).forEach(u => found.add(u));
  }));

  // Iframes (one level deep)
  const iframes = [...html.matchAll(/<iframe[^>]+src=["']([^"']{10,})["']/gi)]
    .map(m => m[1])
    .filter(s => s.startsWith('http') || s.startsWith('/'))
    .slice(0, 3)
    .map(s => s.startsWith('http') ? s : base.origin + s);

  await Promise.all(iframes.map(async url => {
    const ih = await safeFetch(url, inputUrl);
    extractUrls(ih).forEach(u => found.add(u));
    for (const [, s] of ih.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi))
      extractUrls(s).forEach(u => found.add(u));
  }));

  return Array.from(found);
}

function waitFor(condFn, maxMs, intervalMs = 200) {
  return new Promise(resolve => {
    if (condFn()) return resolve();
    const iv = setInterval(() => { if (condFn()) { clearInterval(iv); clearTimeout(tm); resolve(); } }, intervalMs);
    const tm = setTimeout(() => { clearInterval(iv); resolve(); }, maxMs);
  });
}

// ─── Puppeteer stealth scanner ───────────────────────────────────────────────
// Captures stream URLs AND the exact request headers (cookies, referer, origin)
// so we can replay them in the proxy.

async function puppeteerScan(inputUrl, wsClient) {
  const results = [];   // { url, headers }
  let browser;
  let page;
  const sid = String(++sessionCounter);

  function wsLog(msg) {
    console.log('[puppeteer]', msg);
    if (wsClient && wsClient.readyState === 1) {
      wsClient.send(JSON.stringify({ type: 'scan_progress', msg }));
    }
  }

  try {
    if (warmBrowser) {
      browser = warmBrowser;
      warmBrowser = null;
      wsLog('Headless browser ready (pre-warmed — instant start)');
      // Immediately kick off a replacement warm browser for the next scan
      puppeteerExtra.launch({
        executablePath: CHROME_PATH,
        headless: true,
        args: BROWSER_LAUNCH_ARGS,
        defaultViewport: { width: 1280, height: 720 },
        timeout: 60000,
      }).then(b => { warmBrowser = b; console.log('[browser] Replacement warm browser ready'); })
        .catch(() => {});
    } else {
      wsLog('Launching headless browser (stealth mode)…');
      browser = await puppeteerExtra.launch({
        executablePath: CHROME_PATH,
        headless: true,
        args: BROWSER_LAUNCH_ARGS,
        defaultViewport: { width: 1280, height: 720 },
        timeout: 30000,
      });
    }

    page = await browser.newPage();

    // Only capture genuine stream URLs — check path only, not hostname
    let foundM3u8 = false;
    await page.setRequestInterception(true);
    // Domains that serve JS/ad SDKs — never real streams even if path matches /hls/ or /live/
    const PUP_SKIP_DOMAINS = [
      'googlesyndication.com', 'googletagmanager.com', 'doubleclick.net',
      'googlevideo.com',  // YouTube segments go through their own flow
      'cdn.jwplayer.com', 'cdn.bitmovin.com', 'cdn.plyr.io',
      'jsdelivr.net', 'cdnjs.cloudflare.com', 'unpkg.com',
      'analytics', 'tracking', 'telemetry',
    ];

    page.on('request', req => {
      const url = req.url();
      try {
        const parsed = new URL(url);
        const { pathname, hostname } = parsed;

        // Skip known ad/analytics/library domains
        if (PUP_SKIP_DOMAINS.some(d => hostname.includes(d))) {
          req.continue().catch(() => {}); return;
        }
        // Skip static assets
        if (/\.(js|css|woff2?|ttf|png|jpg|gif|svg|ico)(\?|$)/.test(pathname)) {
          req.continue().catch(() => {}); return;
        }

        const isRealStream = url.includes('.m3u8') || url.includes('.mpd') ||
                             /\/(hls|live)(\/|$|\?)/.test(pathname);  // must be a path segment
        if (isRealStream && !results.find(r => r.url === url)) {
          const headers = req.headers();
          results.push({ url, headers });
          wsLog(`Found stream: ${url}`);
          if (url.includes('.m3u8')) foundM3u8 = true;
        }
      } catch {}
      req.continue().catch(() => {});
    });

    // Catch by content-type on response
    page.on('response', async resp => {
      try {
        const url = resp.url();
        const ct = resp.headers()['content-type'] || '';
        if ((ct.includes('mpegurl') || ct.includes('x-mpegurl')) &&
            !results.find(r => r.url === url)) {
          results.push({ url, headers: {} });
          wsLog(`Found stream via content-type: ${url}`);
          foundM3u8 = true;
        }
      } catch {}
    });

    wsLog(`Navigating to ${inputUrl}…`);
    await page.goto(inputUrl, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(e => wsLog(`Navigation: ${e.message}`));

    // Dismiss cookie banners / overlays
    await page.evaluate(() => {
      const bannerSelectors = [
        '[id*="cookie"] button', '[class*="cookie"] button',
        '[id*="consent"] button', '[class*="consent"] button',
        '[id*="accept"]', '[class*="accept"]', '.fc-cta-consent',
      ];
      for (const sel of bannerSelectors) {
        const el = document.querySelector(sel);
        if (el) { el.click(); break; }
      }
    }).catch(() => {});

    wsLog('Waiting for player to initialise…');
    // Poll for m3u8 — bail as soon as we have one, up to 3s
    await waitFor(() => foundM3u8, 3000);

    if (!foundM3u8) {
      // Click play buttons
      const playSelectors = [
        '.vjs-big-play-button', 'button.play-button', '.play-btn', '#play-btn',
        '[class*="play"]', 'video', '.jw-display-icon-container',
        '.plyr__control--overlaid', 'button[aria-label*="play" i]', '.fp-play',
      ];
      for (const sel of playSelectors) {
        try {
          const el = await page.$(sel);
          if (el) { await el.click(); wsLog(`Clicked: ${sel}`); break; }
        } catch {}
      }
      // Wait up to 8s for stream after click — bail early if found
      wsLog('Waiting for stream after play click…');
      await waitFor(() => foundM3u8, 8000);
    }

    // Still nothing — try clicking page centre
    if (!foundM3u8) {
      wsLog('Trying centre click…');
      await page.mouse.click(640, 360).catch(() => {});
      await waitFor(() => foundM3u8, 4000);
    }

    // Scan rendered DOM too
    const domText = await page.content().catch(() => '');
    extractUrls(domText).forEach(u => {
      if (!results.find(r => r.url === u)) results.push({ url: u, headers: {} });
    });

    // ── Only fetch real stream URLs from inside Puppeteer (skip images/pages) ──
    for (const result of results.filter(r => r.url.includes('.m3u8') || r.url.includes('.mpd'))) {
      try {
        wsLog(`Fetching ${result.url} from browser session…`);
        const fetched = await page.evaluate(async (url) => {
          function tryXhr(u) {
            return new Promise(resolve => {
              const xhr = new XMLHttpRequest();
              xhr.open('GET', u, true);
              xhr.withCredentials = true;
              xhr.timeout = 15000;
              xhr.onload = () => resolve({ ok: xhr.status < 400, status: xhr.status, text: xhr.responseText, contentType: xhr.getResponseHeader('content-type') || '' });
              xhr.onerror = () => resolve({ ok: false, error: 'XHR network error' });
              xhr.ontimeout = () => resolve({ ok: false, error: 'XHR timeout' });
              xhr.send();
            });
          }
          let r = await tryXhr(url);
          if (!r.ok) {
            try {
              const res = await fetch(url, { credentials: 'omit' });
              r = { ok: res.ok, status: res.status, text: await res.text(), contentType: res.headers.get('content-type') || '' };
            } catch (e) { r.error = e.message; }
          }
          return r;
        }, result.url);

        if (fetched.ok) {
          const ct = fetched.contentType;
          const isHls = ct.includes('mpegurl') || fetched.text.trim().startsWith('#EXTM3U');
          const isJson = ct.includes('json') || (!isHls && (fetched.text.trim().startsWith('{') || fetched.text.trim().startsWith('[')));

          if (isHls) {
            result.manifestContent = fetched.text;
            wsLog('Got manifest content from browser session');
          } else if (isJson) {
            // API returned JSON — mine it for m3u8 URLs
            try {
              const parsed = JSON.parse(fetched.text);
              const mineUrls = (obj, depth = 0) => {
                if (depth > 5 || !obj) return [];
                if (typeof obj === 'string' && (obj.includes('.m3u8') || obj.includes('.mpd'))) return [obj];
                if (Array.isArray(obj)) return obj.flatMap(i => mineUrls(i, depth + 1));
                if (typeof obj === 'object') return Object.values(obj).flatMap(v => mineUrls(v, depth + 1));
                return [];
              };
              const found = mineUrls(parsed);
              if (found.length > 0) {
                wsLog(`API returned JSON with ${found.length} stream URL(s) — fetching best one…`);
                // Fetch the best m3u8 from inside the browser too
                const best = found[0];
                const mfetch = await page.evaluate(async (url) => {
                  try {
                    const r = await fetch(url, { credentials: 'omit' });
                    const text = await r.text();
                    return { ok: r.ok, text, contentType: r.headers.get('content-type') || '' };
                  } catch (e) { return { ok: false }; }
                }, best);
                if (mfetch.ok && mfetch.text.trim().startsWith('#EXTM3U')) {
                  results.push({ url: best, headers: {}, manifestContent: mfetch.text });
                  wsLog(`Got m3u8 from JSON API: ${best}`);
                } else {
                  results.push({ url: best, headers: {} });
                }
              }
            } catch {}
          }
        }
      } catch (e) { wsLog(`In-browser fetch failed: ${e.message}`); }

      // Grab cookies for this origin to use in segment proxy requests
      try {
        const cookies = await page.cookies(result.url);
        if (cookies.length > 0) {
          result.cookieString = cookies.map(c => `${c.name}=${c.value}`).join('; ');
          wsLog(`Captured ${cookies.length} cookie(s) for ${new URL(result.url).hostname}`);
        }
      } catch {}
    }

    wsLog(`Scan complete — ${results.length} stream URL(s) found`);

    // Keep browser alive for session-auth segment proxying
    // The CDN accepts Chrome's TLS fingerprint regardless of CORS credentials,
    // so we use the main page for fetching (--disable-web-security + credentials:omit fallback)
    const m3u8Hits = results.filter(r => r.url.includes('.m3u8') || r.url.includes('.mpd'));
    if (m3u8Hits.length > 0 && browser && page) {
      // The main scan page (navigated to the embed site) is kept separate for manifest refreshes.
      // It has the correct Origin + cookies that the CDN requires for auth.
      // Pool pages are blank pages used only for segment fetches via /proxy/pup.
      const poolPages = [];
      try {
        for (let i = 0; i < 4; i++) {
          const p = await browser.newPage();
          poolPages.push(p);
        }
      } catch {}

      const liveManifestUrl = m3u8Hits[0]?.url;
      const session = { browser, mainPage: page, pages: poolPages, pageQueue: [], lastUsed: Date.now(), latestManifest: null, embedUrl: inputUrl, cdnLatency: new Map() };
      pupSessions.set(sid, session);
      results.forEach(r => { r.sessionId = sid; });

      // 1. Passive capture: fires for all network responses in this page + iframes.
      //    Captures both manifests AND segments — segments are free since Chrome is
      //    already downloading them for the in-page player. Cache them so /proxy/pup
      //    can serve instantly without any IPC round-trip.
      page.on('response', async (response) => {
        const url = response.url();
        const isM3u8 = url.includes('.m3u8') || url.includes('playlist');
        // Detect segments: .ts, .jpg (CDN disguises .ts as .jpg), .m4s, .aac
        const isSegment = !isM3u8 && /\.(ts|jpg|jpeg|m4s|aac|mp4)(\?|$)/i.test(url);

        if (!isM3u8 && !isSegment) return;
        if (response.status() !== 200) return;

        if (isM3u8) {
          try {
            const text = await response.text();
            if (text && text.includes('#EXTM3U') && text.includes('#EXT-X-MEDIA-SEQUENCE')) {
              const baseUrl = url.substring(0, url.lastIndexOf('/') + 1);
              if (pupSessions.has(sid)) {
                session.latestManifest = { text, baseUrl };
                const seq = (text.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/) || [])[1];
                wsLog(`Manifest captured from embed player (seq: ${seq})`);
                // Pre-fetch upcoming segments before HLS.js asks
                triggerSegmentPrefetch(session, text, baseUrl);
              }
            }
          } catch {}
        }

        if (isSegment) {
          // Don't double-cache
          if (getCachedSegment(url)) return;
          try {
            const buf = await response.buffer();
            if (buf && buf.length > 0) {
              const ct = response.headers()['content-type'] || 'video/mp2t';
              cacheSegment(url, buf, ct);
            }
          } catch {}
        }
      });

      // 2. Active poll: re-fetch the manifest URL on an interval matching the segment duration.
      //    The main page runs in the embedsports.top context with correct Origin + CDN cookies,
      //    so the CDN accepts the request (unlike blank pool pages which get 403).
      //    Interval = #EXT-X-TARGETDURATION from the manifest (typically 2–6s), clamped 3–8s.
      if (liveManifestUrl) {
        let pollInterval = 6000; // default before first manifest parsed
        let refreshTimer;

        const doRefresh = async () => {
          try {
            if (!pupSessions.has(sid)) return;

            let fetched = null;

            // ── Method 1: main page XHR (correct Origin + CDN cookies) ──────────
            // Works as long as the embed page JS context is still alive.
            if (!session._mainPageDead) {
              try {
                fetched = await page.evaluate(async (url) => {
                  return new Promise(resolve => {
                    const xhr = new XMLHttpRequest();
                    xhr.open('GET', url, true);
                    xhr.withCredentials = true;
                    xhr.timeout = 10000;
                    xhr.onload = () => resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, text: xhr.responseText });
                    xhr.onerror = () => resolve({ ok: false, status: 0 });
                    xhr.ontimeout = () => resolve({ ok: false, status: 0 });
                    xhr.send();
                  });
                }, liveManifestUrl);
              } catch (e) {
                session._mainPageDead = true;
                wsLog(`Embed page context lost — switching to direct CDN refresh (${e.message.slice(0, 60)})`);
              }
            }

            // ── Method 2: tls-client (Chrome JA3/JA4 fingerprint, no IPC) ───────
            // Survives embed site going offline — goes directly to CDN.
            if (!fetched?.ok && tlsSession) {
              try {
                const referer = session.embedUrl || liveManifestUrl;
                const origin = (() => { try { return new URL(referer).origin; } catch { return ''; } })();
                const r = await tlsSession.get(liveManifestUrl, {
                  headers: {
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                    'Accept': '*/*', 'Accept-Encoding': 'identity',
                    'Referer': origin + '/', 'Origin': origin,
                    'Sec-Fetch-Dest': 'empty', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Site': 'cross-site',
                  },
                });
                if (r.status >= 200 && r.status < 300 && r.body?.includes('#EXTM3U')) {
                  fetched = { ok: true, status: r.status, text: r.body };
                }
              } catch {}
            }

            // ── Method 3: node-fetch (fast, may 403 on fingerprint-checking CDNs) ─
            if (!fetched?.ok) {
              try {
                const referer = session.embedUrl || liveManifestUrl;
                const r = await fetch(liveManifestUrl, {
                  headers: { ...browserHeaders(referer), 'Accept-Encoding': 'identity' },
                  timeout: 10000, redirect: 'follow',
                });
                if (r.ok) {
                  const text = await r.text();
                  if (text.includes('#EXTM3U')) fetched = { ok: true, status: r.status, text };
                }
              } catch {}
            }

            if (fetched?.ok && fetched.text?.includes('#EXTM3U') && fetched.text.includes('#EXT-X-MEDIA-SEQUENCE')) {
              const baseUrl = liveManifestUrl.substring(0, liveManifestUrl.lastIndexOf('/') + 1);
              session.latestManifest = { text: fetched.text, baseUrl };
              session._failureCount = 0; // reset on success
              const seq = (fetched.text.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/) || [])[1];
              const segCount = fetched.text.split('\n').filter(l => /\.(ts|jpg)(\?|$)/.test(l) || /\/seg/.test(l)).length;
              // Tune poll interval to match segment duration so we never miss a manifest update
              const targetDur = parseInt((fetched.text.match(/#EXT-X-TARGETDURATION:(\d+)/) || [])[1] || 0);
              if (targetDur > 0) {
                const newInterval = Math.max(2000, Math.min(targetDur * 1000, 8000));
                if (newInterval !== pollInterval) {
                  pollInterval = newInterval;
                  wsLog(`Manifest poll interval → ${pollInterval / 1000}s (seg duration: ${targetDur}s)`);
                }
              }
              wsLog(`Manifest refreshed (seq: ${seq}, ${segCount} segs)`);
              // Pre-fetch upcoming segments on every manifest refresh
              triggerSegmentPrefetch(session, fetched.text, baseUrl);
            } else {
              session._failureCount = (session._failureCount || 0) + 1;
              if (session._failureCount === 3) {
                wsLog(`CDN manifest failing (${session._failureCount} consecutive errors) — stream may be offline`);
              }
            }
          } catch (e) {
            wsLog(`Manifest refresh error: ${e.message}`);
            session._failureCount = (session._failureCount || 0) + 1;
          }

          // Schedule next poll only if session still alive
          if (pupSessions.has(sid)) refreshTimer = setTimeout(doRefresh, pollInterval);
        };

        refreshTimer = setTimeout(doRefresh, pollInterval);
        // Store so cleanup can cancel it
        session._refreshTimer = () => clearTimeout(refreshTimer);
      }

      wsLog(`Browser session ${sid} kept alive — main page for manifest refresh, ${poolPages.length} pool pages for segments`);
      browser = null;  // prevent close in finally
    }

  } catch (err) {
    wsLog(`Error: ${err.message}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
  return results;  // [{ url, headers, sessionId? }]
}

// ─── Multi-backend stream resolver ───────────────────────────────────────────
// We try multiple aggregator APIs so one going down doesn't kill the app.
// Both use the same API shape as streamed.pk.
const STREAM_BACKENDS = [
  { base: 'https://streamed.pk', name: 'streamed.pk' },
  { base: 'https://streamed.su', name: 'streamed.su' },
];

// Query one backend for all sources for a given match ID.
// Returns { title, sources: [{ embedUrl, source }] } or null on failure.
async function queryBackend(backend, matchId, wsLog) {
  try {
    const matchesResp = await fetch(`${backend.base}/api/matches/live`, {
      headers: browserHeaders('https://stream-east.net/'), timeout: 8000,
    });
    if (!matchesResp.ok) return null;
    const matches = await matchesResp.json();
    const match = matches.find(m => m.id === matchId);
    if (!match) return null;
    if (!match.sources?.length) return { title: match.title, sources: [] };

    wsLog(`[${backend.name}] Found "${match.title}" with ${match.sources.length} source(s): ${match.sources.map(s => s.source).join(', ')}`);

    const sources = [];
    for (const src of match.sources) {
      try {
        const streamResp = await fetch(`${backend.base}/api/stream/${src.source}/${src.id}`, {
          headers: browserHeaders('https://stream-east.net/'), timeout: 8000,
        });
        if (!streamResp.ok) continue;
        const streams = await streamResp.json();
        if (!Array.isArray(streams) || streams.length === 0) continue;
        const best = streams.find(s => s.hd) || streams[0];
        if (best.embedUrl) {
          sources.push({ embedUrl: best.embedUrl, title: match.title, source: src.source });
        }
      } catch {}
    }
    return { title: match.title, sources };
  } catch { return null; }
}

// resolveStreamedPk — find working sources for a stream-east match.
// Tries all backends in order; for allSources=true, merges results from all backends
// so the user gets maximum choice of CDN providers.
async function resolveStreamedPk(inputUrl, wsLog, allSources = false) {
  try {
    const u = new URL(inputUrl);
    if (!u.hostname.includes('stream-east')) return null;
    const matchId = u.searchParams.get('id');
    if (!matchId) return null;

    let matchTitle = null;
    const allFound = [];    // deduplicated across backends
    const seenUrls  = new Set();

    for (const backend of STREAM_BACKENDS) {
      const result = await queryBackend(backend, matchId, wsLog);
      if (!result) continue;
      matchTitle = matchTitle || result.title;

      for (const src of result.sources) {
        if (seenUrls.has(src.embedUrl)) continue;
        seenUrls.add(src.embedUrl);
        allFound.push(src);
        if (!allSources) {
          wsLog(`Using "${src.source}" from ${backend.name}`);
          return { embedUrl: src.embedUrl, title: matchTitle, source: src.source };
        }
      }

      // For allSources=false, if primary backend found the match but had no streams,
      // mark that so we still try the next backend.
    }

    if (allSources) {
      if (allFound.length > 0) return allFound;
      if (matchTitle) return null; // match known, zero streams anywhere
      return null;
    }

    if (matchTitle) {
      wsLog('No working sources found on any backend');
      return { noStream: true, title: matchTitle };
    }
    return null;
  } catch { return null; }
}

// ─── Extract API ─────────────────────────────────────────────────────────────

app.post('/api/extract', async (req, res) => {
  const { inputUrl, referer } = req.body;
  if (!inputUrl) return res.status(400).json({ error: 'Missing inputUrl' });

  const type = detectStreamType(inputUrl);
  // Use user-supplied referer if provided, otherwise fall back to stream URL's origin
  const ref = referer || inputUrl;

  // Direct stream URL — probe it first to check if it's actually HLS or a JSON API
  if (type === 'hls') {
    try {
      const probeResp = await fetch(inputUrl, { headers: browserHeaders(ref), timeout: 8000, redirect: 'follow' });
      const ct = probeResp.headers.get('content-type') || '';
      const body = await probeResp.text();
      const isJson = ct.includes('json') || body.trim().startsWith('[') || body.trim().startsWith('{');

      if (isJson) {
        // It's a JSON API — extract embed URLs and scan them
        let parsed;
        try { parsed = JSON.parse(body); } catch {}
        if (parsed) {
          const items = Array.isArray(parsed) ? parsed : [parsed];
          const embedUrls = items.map(i => i.embedUrl || i.embed_url || i.url).filter(Boolean);
          const directUrls = items.map(i => i.streamUrl || i.stream_url || i.hls || i.hlsUrl).filter(Boolean);

          if (directUrls.length > 0) {
            return res.json(buildCandidateResponse(directUrls, ref, 'static'));
          }

          if (embedUrls.length > 0) {
            const allFound = [];
            for (const embedUrl of embedUrls.slice(0, 3)) {
              const found = await puppeteerScan(embedUrl, null);
              allFound.push(...found);
            }
            if (allFound.length > 0) {
              return res.json(buildCandidateResponse(allFound, embedUrls[0], 'dynamic'));
            }
            return res.json({ success: false, type: 'hls',
              error: 'Found embed players but no stream URLs inside them.',
              hint: `Try opening ${embedUrls[0]} directly in your browser and copying the m3u8 from DevTools → Network.` });
          }
        }
      }
    } catch { /* fall through to proxy */ }

    return res.json({
      success: true,
      streamUrl: `/proxy/stream?ref=${encodeURIComponent(ref)}&url=${encodeURIComponent(inputUrl)}`,
      rawUrl: inputUrl, type: 'hls', title: 'HLS Stream',
    });
  }
  if (type === 'dash' || type === 'direct') {
    return res.json({ success: true, streamUrl: inputUrl, rawUrl: inputUrl, type, title: 'Stream' });
  }

  // yt-dlp for known platforms
  if (['youtube','twitch','facebook','twitter'].includes(type)) {
    try {
      const info = await extractWithYtDlp(inputUrl);
      const proxied = info.streamUrl.includes('.m3u8')
        ? `/proxy/stream?ref=${encodeURIComponent(inputUrl)}&url=${encodeURIComponent(info.streamUrl)}`
        : info.streamUrl;
      return res.json({ success: true, streamUrl: proxied, rawUrl: info.streamUrl,
        type: info.streamUrl.includes('.m3u8') ? 'hls' : 'direct',
        title: info.title, isLive: info.isLive });
    } catch { /* fall through */ }
  }

  // Step 0: for stream-east.net, resolve the best available source via streamed.pk API
  const wsClient = [...wss.clients].find(c => c.readyState === 1) || null;
  const wsLog = msg => { console.log('[resolve]', msg); if (wsClient?.readyState === 1) wsClient.send(JSON.stringify({ type: 'scan_progress', msg })); };

  let streamEastMatch = null;
  try {
    const u = new URL(inputUrl);
    if (u.hostname.includes('stream-east')) {
      // Check pre-warm cache first — avoids full Puppeteer scan if already done
      const matchId = u.searchParams.get('id');
      const warmed = matchId && preWarmStore.get(matchId);
      if (warmed && Date.now() - warmed.timestamp < 25 * 60 * 1000) {
        // Verify the session is still alive
        const sessionAlive = warmed.hits.some(h => h.sessionId && pupSessions.has(h.sessionId));
        if (sessionAlive) {
          wsLog(`Using pre-warmed scan for "${warmed.title}" — instant start`);
          const resp = buildCandidateResponse(warmed.hits, warmed.embedUrl, 'dynamic');
          resp.title = warmed.title;
          return res.json(resp);
        }
      }

      const resolved = await resolveStreamedPk(inputUrl, wsLog);
      if (resolved && !resolved.noStream) {
        // Scan the resolved embed directly
        wsLog(`Scanning embed from streamed.pk (${resolved.source})…`);
        const dynHits = await puppeteerScan(resolved.embedUrl, wsClient);
        if (dynHits.length > 0) {
          const resp = buildCandidateResponse(dynHits, resolved.embedUrl, 'dynamic', resolved.source);
          resp.title = resolved.title;

          // ── Alternate sources: announce without pre-scanning ──────────────────
          // We resolve the embed URLs cheaply (API-only, no Puppeteer) and tell the
          // frontend they exist. The browser scan only happens when the user clicks
          // one of the alt buttons, or when auto-recovery needs them.
          // This eliminates 3 extra Chrome instances competing with the active stream.
          const primarySid = dynHits.find(h => h.sessionId)?.sessionId;
          const primarySession = primarySid && pupSessions.get(primarySid);
          if (primarySession) {
            resolveStreamedPk(inputUrl, () => {}, true).then(async allSrcs => {
              if (!allSrcs || allSrcs.length <= 1) return;
              const alts = allSrcs.filter(s => s.source !== resolved.source).slice(0, 4);
              if (alts.length === 0) return;

              // Store embed URLs on primary session for auto-recovery fallback
              primarySession.altEmbedUrls = alts.map(a => ({ embedUrl: a.embedUrl, source: a.source }));
              console.log(`[alts] ${alts.length} alternative source(s) available: ${alts.map(a => a.source).join(', ')}`);

              // Tell the frontend so it can show "activate" buttons — no scan yet
              for (const alt of alts) {
                wssBroadcast({
                  type: 'alt_stream_ready',
                  embedUrl: alt.embedUrl,
                  label: alt.source,
                  source: alt.source,
                  primarySid,
                  pendingScan: true,  // user must click to trigger the actual scan
                });
              }
            }).catch(() => {});
          }

          return res.json(resp);
        }
      } else if (resolved?.noStream) {
        // Match found but no broadcaster is live — return immediately, no point scanning further
        return res.json({
          success: false, type,
          error: `"${resolved.title}" has no active stream right now.`,
          hint: `The site knows about this game but no broadcaster has gone live yet. Try again closer to kick-off, or check if the game has already finished.`,
        });
      }
    }
  } catch {}

  // Step 1: fast static scan
  const staticHits = await staticScan(inputUrl);

  if (staticHits.length > 0) {
    return res.json(buildCandidateResponse(staticHits, inputUrl, 'static'));
  }

  // Step 2: full headless browser scan with stealth + play click
  console.log('[puppeteer] launching for', inputUrl);
  const dynHits = await puppeteerScan(inputUrl, wsClient);

  if (dynHits.length > 0) {
    return res.json(buildCandidateResponse(dynHits, inputUrl, 'dynamic'));
  }

  // Nothing found
  const ytHint = ['youtube','twitch'].includes(type)
    ? ' Install yt-dlp for YouTube/Twitch: `pip3 install yt-dlp`.' : '';
  return res.json({
    success: false, type,
    error: 'No stream URL found.',
    hint: `Could not find a stream URL — even after scanning the page with a headless browser.${ytHint} Open DevTools (F12) → Network tab → play the stream → filter by "m3u8" → right-click the request → Copy URL, then paste that here.`,
  });
});

function buildCandidateResponse(hits, pageUrl, method, sourceLabel) {
  const normalised = hits.map(h => typeof h === 'string' ? { url: h, headers: {} } : h);
  // Prefer hits with pre-fetched manifest content
  const best = normalised.find(h => h.manifestContent && h.url.includes('.m3u8'))
    || normalised.find(h => h.url.includes('.m3u8'))
    || normalised[0];

  function toStreamUrl(h) {
    // If we have a live browser session, route through pup proxy (handles auth cookies)
    if (h.sessionId && pupSessions.has(h.sessionId)) {
      // If we have the manifest content, store it and serve from memory.
      // The manifest URL token is very short-lived (seconds) — we can't re-fetch it.
      // The segment tokens INSIDE the manifest are longer-lived and route through /proxy/pup.
      if (h.manifestContent) {
        const id = String(++manifestCounter);
        const baseUrl = h.url.substring(0, h.url.lastIndexOf('/') + 1);
        manifestStore.set(id, {
          text: h.manifestContent,
          baseUrl,
          cookie: h.cookieString || h.headers?.cookie || '',
          referer: h.headers?.referer || h.headers?.Referer || pageUrl,
          sessionId: h.sessionId,
        });
        setTimeout(() => manifestStore.delete(id), 4 * 60 * 60 * 1000);
        return `/proxy/manifest/${id}`;
      }
      return `/proxy/pup?sid=${encodeURIComponent(h.sessionId)}&url=${encodeURIComponent(h.url)}`;
    }

    // If we have the manifest content (no live session), store it and serve via /proxy/manifest
    if (h.manifestContent) {
      const id = String(++manifestCounter);
      const baseUrl = h.url.substring(0, h.url.lastIndexOf('/') + 1);
      manifestStore.set(id, {
        text: h.manifestContent,
        baseUrl,
        cookie: h.cookieString || h.headers?.cookie || '',
        referer: h.headers?.referer || h.headers?.Referer || pageUrl,
      });
      setTimeout(() => manifestStore.delete(id), 4 * 60 * 60 * 1000);
      return `/proxy/manifest/${id}`;
    }
    // Otherwise proxy it the normal way with cookies
    const ref = h.headers?.referer || h.headers?.Referer || pageUrl;
    const cookie = h.cookieString || h.headers?.cookie || '';
    let qs = `ref=${encodeURIComponent(ref)}&url=${encodeURIComponent(h.url)}`;
    if (cookie) qs += `&cookie=${encodeURIComponent(cookie)}`;
    return `/proxy/stream?${qs}`;
  }

  const candidates = normalised.map(h => {
    let label = h.url.includes('.mpd') ? 'DASH' : 'HLS';
    // Label with quality if we have the master manifest
    const q = getMaxQuality(h.manifestContent);
    if (q) label = q;
    // Prefix with source name if provided (e.g. "admin · 1080p")
    if (sourceLabel) label = `${sourceLabel}${q ? ` · ${q}` : ''}`;
    return { url: toStreamUrl(h), rawUrl: h.url, label, sessionId: h.sessionId || null };
  });
  return {
    success: true,
    streamUrl: toStreamUrl(best),
    rawUrl: best.url,
    type: best.url.includes('.mpd') ? 'dash' : 'hls',
    title: 'Live Stream', isLive: true,
    sessionId: best.sessionId || null,  // for CDN-direct rescan without re-scanning embed
    candidates: candidates.length > 1 ? candidates : undefined,
    scanned: true, scanMethod: method,
  };
}

// ─── In-memory manifest store (for pre-fetched manifests from Puppeteer) ─────
const manifestStore = new Map();  // id → { text, baseUrl, cookie }
let manifestCounter = 0;

app.get('/proxy/manifest/:id', (req, res) => {
  const entry = manifestStore.get(req.params.id);
  if (!entry) return res.status(404).send('Manifest expired');

  const { cookie, referer } = entry;
  let { sessionId } = entry;

  // Use the latest manifest captured from Chrome's own player (updated every ~10s)
  // Falls back to the initial scan manifest if Chrome hasn't refreshed yet
  let session = sessionId ? pupSessions.get(sessionId) : null;
  let live = session?.latestManifest;

  // ── Standby failover: if primary session is failing, switch to a hot backup ──
  // _failureCount is incremented in doRefresh on every missed manifest refresh.
  if (session && (session._failureCount || 0) >= 5 && session.standbySessions?.length > 0) {
    for (const standbySid of session.standbySessions) {
      const standby = pupSessions.get(standbySid);
      if (standby && (standby._failureCount || 0) < 5 && standby.latestManifest) {
        console.log(`[manifest/${req.params.id}] Primary session ${sessionId} failing (${session._failureCount} errors) → standby ${standbySid}`);
        session = standby;
        live = standby.latestManifest;
        sessionId = standbySid;
        entry.sessionId = standbySid; // persist switch for subsequent requests
        break;
      }
    }
  }

  const text = live ? live.text : entry.text;
  const baseUrl = live ? live.baseUrl : entry.baseUrl;

  const origin = (() => { try { return new URL(baseUrl).origin; } catch { return ''; } })();

  function proxyUrl(u) {
    u = u.trim();
    if (!u) return u;
    let abs;
    if (u.startsWith('http://') || u.startsWith('https://')) abs = u;
    else if (u.startsWith('//')) abs = 'https:' + u;
    else if (u.startsWith('/')) abs = origin + u;
    else abs = baseUrl + u;
    if (sessionId && pupSessions.has(sessionId)) {
      return `/proxy/pup?sid=${encodeURIComponent(sessionId)}&url=${encodeURIComponent(abs)}`;
    }
    let qs = `ref=${encodeURIComponent(referer || baseUrl)}&url=${encodeURIComponent(abs)}`;
    if (cookie) qs += `&cookie=${encodeURIComponent(cookie)}`;
    return `/proxy/stream?${qs}`;
  }

  // ── Multi-CDN load balancing: swap lb*.host URLs to the fastest measured host ─
  // modifiles.fans uses lb1/lb2/lb3/lb4 etc. Route to the one with lowest EWMA latency.
  let rewritten = text;
  if (session?.cdnLatency?.size > 1) {
    const lbHosts = [...session.cdnLatency.entries()]
      .filter(([h]) => /^lb\d+\./.test(h))
      .sort((a, b) => a[1] - b[1]);
    if (lbHosts.length > 1) {
      const fastest = lbHosts[0][0];
      // Replace any slower lb host with fastest in all segment URLs
      rewritten = rewritten.replace(/https?:\/\/(lb\d+\.[^/]+)/g, (match, host) => {
        if (host === fastest) return match;
        return match.replace(host, fastest);
      });
    }
  }
  rewritten = rewritten.replace(/URI="([^"]+)"/g, (_, uri) => `URI="${proxyUrl(uri)}"`);
  rewritten = rewritten.replace(/^(?!#)(\S.*)$/gm, line => proxyUrl(line));

  res.set('Content-Type', 'application/vnd.apple.mpegurl');
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Cache-Control', 'no-cache');
  res.send(rewritten);
});

// ─── Stream pre-warming ───────────────────────────────────────────────────────
// Silently scan live events in the background when the fight calendar loads.
// When the user clicks Watch Live, the scan result is already cached → instant start.
const preWarmStore = new Map(); // matchId → { hits, embedUrl, title, timestamp }

app.post('/api/prewarm', async (req, res) => {
  const { matchId } = req.body;
  if (!matchId) return res.status(400).json({ error: 'Missing matchId' });

  // Already warm and recent
  const existing = preWarmStore.get(matchId);
  if (existing && Date.now() - existing.timestamp < 20 * 60 * 1000) {
    const alive = existing.hits.some(h => h.sessionId && pupSessions.has(h.sessionId));
    if (alive) return res.json({ status: 'ready' });
  }

  // Respond immediately, scan in background
  res.json({ status: 'warming' });

  try {
    const inputUrl = `https://stream-east.net/watch.html?id=${matchId}`;
    const resolved = await resolveStreamedPk(inputUrl, () => {});
    if (resolved && !resolved.noStream) {
      console.log(`[prewarm] Scanning "${resolved.title}"…`);
      const hits = await puppeteerScan(resolved.embedUrl, null);
      if (hits.length > 0) {
        preWarmStore.set(matchId, { hits, embedUrl: resolved.embedUrl, title: resolved.title, timestamp: Date.now() });
        console.log(`[prewarm] "${resolved.title}" ready — ${hits.length} stream URL(s)`);
      }
    }
  } catch (e) {
    console.log(`[prewarm] Failed for ${matchId}: ${e.message}`);
  }
});

// ─── CDN-direct rescan — recover stream without re-scanning embed site ────────
// When the embed site goes offline, the CDN is often still alive.
// The frontend calls this first before triggering a full re-scan.
// Returns a fresh /proxy/manifest/:id if the current (or a standby) session is healthy.

app.post('/api/cdn-rescan', (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId) return res.json({ success: false, reason: 'no_session_id' });

  const session = pupSessions.get(sessionId);
  if (!session) return res.json({ success: false, reason: 'session_expired' });

  // Helper: create a fresh manifest entry for a live session
  function makeManifestEntry(sid, s) {
    if (!s.latestManifest) return null;
    const { text, baseUrl } = s.latestManifest;
    const id = String(++manifestCounter);
    manifestStore.set(id, {
      text, baseUrl, cookie: '',
      referer: s.embedUrl || baseUrl,
      sessionId: sid,
    });
    setTimeout(() => manifestStore.delete(id), 4 * 60 * 60 * 1000);
    return `/proxy/manifest/${id}`;
  }

  // Try primary session
  if (session.latestManifest && (session._failureCount || 0) < 5) {
    const streamUrl = makeManifestEntry(sessionId, session);
    if (streamUrl) return res.json({ success: true, streamUrl, type: 'hls' });
  }

  // Try standby sessions
  for (const standbySid of (session.standbySessions || [])) {
    const standby = pupSessions.get(standbySid);
    if (standby?.latestManifest && (standby._failureCount || 0) < 5) {
      const streamUrl = makeManifestEntry(standbySid, standby);
      if (streamUrl) {
        console.log(`[cdn-rescan] Primary failing — returning standby session ${standbySid}`);
        return res.json({ success: true, streamUrl, type: 'hls', usedStandby: true });
      }
    }
  }

  // ── Last resort: auto-trigger the first available alt embed scan ────────────
  // Fires when the primary AND all standby sessions are dead but we have unscanned alts.
  const alts = session.altEmbedUrls || [];
  if (alts.length > 0) {
    const first = alts[0];
    console.log(`[cdn-rescan] All sessions dead — auto-scanning alt source "${first.source}"`);
    // Run async; caller gets a holding response so HLS.js doesn't give up
    puppeteerScan(first.embedUrl, null).then(hits => {
      if (!hits.length) return;
      const standbySid = hits.find(h => h.sessionId)?.sessionId;
      if (standbySid) {
        if (!session.standbySessions) session.standbySessions = [];
        session.standbySessions.push(standbySid);
        // Remove from pending list so we don't scan it twice
        session.altEmbedUrls = alts.slice(1);
        console.log(`[cdn-rescan] Auto-scan complete — standby session ${standbySid} active`);
      }
    }).catch(() => {});
  }

  return res.json({ success: false, reason: 'all_sessions_dead' });
});

// ─── On-demand alt source scanner ────────────────────────────────────────────
// Called when the user clicks an alt source button. Runs a Puppeteer scan on
// that one embed URL only — no background Chrome instances are kept alive
// until explicitly needed.

app.post('/api/scan-alt', async (req, res) => {
  const { embedUrl, primarySid } = req.body;
  if (!embedUrl) return res.status(400).json({ success: false, error: 'Missing embedUrl' });

  const wsClient = [...wss.clients].find(c => c.readyState === 1) || null;
  try {
    const hits = await puppeteerScan(embedUrl, wsClient);
    if (!hits.length) {
      return res.json({ success: false, error: 'No stream found at this source' });
    }

    // Register the new session as a standby for the primary if specified
    const standbySid = hits.find(h => h.sessionId)?.sessionId;
    if (standbySid && primarySid) {
      const primarySession = pupSessions.get(primarySid);
      if (primarySession) {
        if (!primarySession.standbySessions) primarySession.standbySessions = [];
        primarySession.standbySessions.push(standbySid);
        // Remove from pending alt list so it isn't auto-scanned again
        if (primarySession.altEmbedUrls) {
          primarySession.altEmbedUrls = primarySession.altEmbedUrls.filter(a => a.embedUrl !== embedUrl);
        }
        console.log(`[scan-alt] Session ${standbySid} registered as standby for ${primarySid}`);
      }
    }

    return res.json(buildCandidateResponse(hits, embedUrl, 'dynamic'));
  } catch (e) {
    return res.json({ success: false, error: e.message });
  }
});

// ─── Past events (for Replays tab) ───────────────────────────────────────────

// ─── UFC event catalogue (ufcstats.com) ──────────────────────────────────────
const POSTERS_INDEX_URL = 'https://raw.githubusercontent.com/itbycory/ufc-event-posters/main/index.json';
let _ufcEventsCache = null;
let _ufcEventsCacheTime = 0;

app.get('/api/ufc-events', async (req, res) => {
  // Cache for 6 hours
  if (_ufcEventsCache && Date.now() - _ufcEventsCacheTime < 6 * 3600000) {
    return res.json(_ufcEventsCache);
  }
  try {
    const raw = await safeFetch(POSTERS_INDEX_URL, 'https://github.com/');
    if (!raw) throw new Error('Empty response from posters index');
    const all = JSON.parse(raw);
    const now = Date.now();
    const events = all
      .map(ev => ({
        slug:      ev.id,
        name:      ev.name,
        date:      new Date(ev.date).getTime(),
        posterUrl: ev.posterUrl,
        wikiTitle: ev.wikiTitle,
        number:    ev.number ?? null,
        upcoming:  new Date(ev.date).getTime() > now,
      }))
      .filter(ev => !isNaN(ev.date))
      .sort((a, b) => {
        // Upcoming events first (soonest at top), then past events newest-first
        if (a.upcoming && !b.upcoming) return -1;
        if (!a.upcoming && b.upcoming) return 1;
        if (a.upcoming && b.upcoming) return a.date - b.date;  // soonest first
        return b.date - a.date;                                 // most recent first
      });
    _ufcEventsCache = events;
    _ufcEventsCacheTime = Date.now();
    res.json(events);
  } catch (e) {
    console.error('[ufc-events]', e.message);
    res.json(_ufcEventsCache || []);
  }
});

// ─── Bellator / PFL event catalogue (Wikipedia) ──────────────────────────────
let _bellatorCache = null, _bellatorCacheTime = 0;

app.get('/api/bellator-events', async (req, res) => {
  if (_bellatorCache && Date.now() - _bellatorCacheTime < 12 * 3600000) return res.json(_bellatorCache);
  try {
    const r = await fetch('https://en.wikipedia.org/wiki/List_of_Bellator_MMA_events', {
      timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    const html = await r.text();
    const now = Date.now();
    const events = [];
    const seen = new Set();
    const pat = /title="(Bellator[^"]+)"[\s\S]{0,600}?data-sort-value="\d+(\d{4}-\d{2}-\d{2})/g;
    let m;
    while ((m = pat.exec(html)) !== null) {
      const name = m[1].trim();
      const dateMs = new Date(m[2]).getTime();
      if (isNaN(dateMs) || dateMs > now) continue;
      if (seen.has(name)) continue;
      seen.add(name);
      const slug = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
      events.push({ slug, name, date: dateMs });
    }
    events.sort((a, b) => b.date - a.date);
    _bellatorCache = events;
    _bellatorCacheTime = Date.now();
    res.json(events);
  } catch (e) {
    console.error('[bellator-events]', e.message);
    res.json(_bellatorCache || []);
  }
});

// ─── ONE Championship event catalogue (Wikipedia) ────────────────────────────
let _oneCache = null, _oneCacheTime = 0;

app.get('/api/one-events', async (req, res) => {
  if (_oneCache && Date.now() - _oneCacheTime < 12 * 3600000) return res.json(_oneCache);
  try {
    const r = await fetch('https://en.wikipedia.org/wiki/List_of_ONE_Championship_events', {
      timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    const html = await r.text();
    const now = Date.now();
    const events = [];
    const seen = new Set();
    // Matches: "ONE Fight Night 38: Andrade vs. Baatarkhuu", "ONE Friday Fights 135: ...", etc.
    const pat = /title="(ONE (?:Fight Night|Friday Fights|Championship)[^"]+)"[\s\S]{0,600}?data-sort-value="\d+(\d{4}-\d{2}-\d{2})/g;
    let m;
    while ((m = pat.exec(html)) !== null) {
      const name = m[1].trim();
      const dateMs = new Date(m[2]).getTime();
      if (isNaN(dateMs) || dateMs > now) continue;
      if (seen.has(name)) continue;
      seen.add(name);
      const slug = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
      events.push({ slug, name, date: dateMs });
    }
    events.sort((a, b) => b.date - a.date);
    _oneCache = events;
    _oneCacheTime = Date.now();
    res.json(events);
  } catch (e) {
    console.error('[one-events]', e.message);
    res.json(_oneCache || []);
  }
});

// ─── Replay finder ────────────────────────────────────────────────────────────
// Searches known replay sites by event name, then falls back to YouTube.
// Uses progressive query simplification so "UFC 309 Jones vs Miocic" →
// "UFC 309" → "Jones Miocic" if the full title doesn't match.

const REPLAY_SITES = [
  {
    name: 'bestsolaris',
    label: 'Best Solaris (HD)',
    buildSearchUrl: q => `https://bestsolaris.com/?s=${encodeURIComponent(q)}`,
  },
  {
    name: 'watchmmafull',
    label: 'Watch MMA Full',
    buildSearchUrl: q => `https://watchmmafull.com/?s=${encodeURIComponent(q)}`,
  },
  {
    name: 'mmastreams',
    label: 'MMA Streams',
    buildSearchUrl: q => `https://mmastreams.me/?s=${encodeURIComponent(q)}`,
  },
];

// Parse a search results page and return the URL most likely to be the right event page.
function findBestSearchResult(html, query, baseUrl) {
  const words = query.toLowerCase()
    .split(/\s+/)
    .filter(w => w.length > 2 && !['the','and','for','with','full','fight','night','event','ufc','vs'].includes(w));

  let baseHost = '';
  try { baseHost = new URL(baseUrl).hostname; } catch {}

  const linkRe = /href="(https?:\/\/[^"#?][^"]*?)"/g;
  let m;
  const candidates = [];
  const seen = new Set();

  while ((m = linkRe.exec(html)) !== null) {
    const href = m[1];
    if (seen.has(href)) continue;
    seen.add(href);
    try {
      const u = new URL(href);
      if (u.hostname !== baseHost) continue;
      const path = u.pathname.toLowerCase();
      if (/\/(tag|category|author|page|feed|wp-|admin|login|search|s=)/.test(path)) continue;
      if (path === '/' || path.length < 4) continue;
      const score = words.filter(w => (path + href.toLowerCase()).includes(w)).length;
      if (score >= Math.max(1, Math.ceil(words.length * 0.35))) candidates.push({ href, score });
    } catch {}
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.href || null;
}

// Build progressively simpler search queries from an event title.
function buildQueryVariants(title) {
  const t = title.trim();
  const variants = [t];
  // "UFC 309 Jones vs Miocic" → "UFC 309"
  const shortMatch = t.match(/^(UFC\s+(?:Fight\s+Night\s+)?[\d]+)/i);
  if (shortMatch) variants.push(shortMatch[1]);
  // Drop "vs ..." half
  const vsStripped = t.replace(/\s+vs\.?\s+.+$/i, '').trim();
  if (vsStripped !== t && vsStripped.length > 3) variants.push(vsStripped);
  // First 3 significant words
  const words3 = t.split(/\s+/).filter(w => w.length > 2).slice(0, 3).join(' ');
  if (!variants.includes(words3) && words3.length > 4) variants.push(words3);
  return [...new Set(variants)];
}

// Extract fight list from a WordPress replay page (for chapter nav).
// Looks for ordered/unordered lists or headings that contain fighter names/fight titles.
function extractFightListFromHtml(html) {
  const fights = [];
  // Match list items or headings that look like "Fighter A vs Fighter B"
  const reVs = /<(?:li|h[2-4]|p|strong|b)[^>]*>([^<]{5,80}?(?:\bvs\.?\b|versus)[^<]{3,60})<\/(?:li|h[2-4]|p|strong|b)>/gi;
  let m;
  while ((m = reVs.exec(html)) !== null) {
    const text = m[1].replace(/<[^>]+>/g, '').trim();
    if (text.length > 5 && text.length < 100 && !fights.includes(text)) {
      fights.push(text);
    }
    if (fights.length >= 12) break;
  }
  return fights;
}

async function tryReplaySite(site, queryVariants, wsLog) {
  for (const query of queryVariants) {
    try {
      wsLog(`${site.label}: searching "${query}"…`);
      const searchUrl = site.buildSearchUrl(query);
      const html = await safeFetch(searchUrl, searchUrl);
      if (!html || html.length < 500) continue;

      const resultUrl = findBestSearchResult(html, query, searchUrl);
      if (!resultUrl) continue;

      wsLog(`${site.label}: found page → ${resultUrl}`);
      // Fetch the result page HTML too (for fight list extraction)
      const pageHtml = await safeFetch(resultUrl, resultUrl).catch(() => '');
      const hits = await puppeteerScan(resultUrl, null);
      if (hits.length > 0) {
        const fightList = extractFightListFromHtml(pageHtml);
        return { site, resultUrl, hits, fightList };
      }

      wsLog(`${site.label}: page found but no stream extracted`);
    } catch (e) {
      wsLog(`${site.label}: ${e.message.slice(0, 80)}`);
    }
  }
  return null;
}

// ─── WatchMMAFull.com ────────────────────────────────────────────────────────
const WMMA_UA  = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';
const WMMA_BASE = 'https://watchmmafull.com';

function embedLabel(url) {
  try {
    const host = new URL(url).hostname.replace('www.', '');
    if (host.includes('vidsonic'))  return 'VidSonic';
    if (host.includes('suisports')) return 'SuiSports';
    if (host.includes('daddylive')) return 'DaddyLive';
    if (host.includes('embedme'))   return 'EmbedMe';
    return host.split('.')[0].charAt(0).toUpperCase() + host.split('.')[0].slice(1);
  } catch { return 'Stream'; }
}

// Pull embed hrefs out of the .watch-link-grid section of a page
function extractWatchMMAEmbeds(html) {
  const gridM = html.match(/class="watch-link-grid">([\s\S]*?)(?:<\/div>\s*<\/div>|<\/section)/i);
  if (!gridM) return [];
  const seen = new Set();
  return [...gridM[1].matchAll(/href="(https?:\/\/[^"]+)"/g)]
    .map(m => m[1])
    .filter(u => !seen.has(u) && seen.add(u));
}

// Fetch a watchmmafull fight page and return embed links.
// Tries the given URL and ±1-day variants to handle timezone skew.
// Fetch embed links for a fight. Uses `pageUrl` if provided (from search discovery),
// otherwise falls back to constructing the URL from parts.
async function fetchFightEmbeds(f1Slug, f2Slug, eventPrefix, month, year, dateMs, pageUrl) {
  // Fast path: we already know the exact page URL
  if (pageUrl) {
    try {
      const r = await fetch(pageUrl, { timeout: 8000, headers: { 'User-Agent': WMMA_UA } });
      if (r.ok) {
        const links = extractWatchMMAEmbeds(await r.text());
        if (links.length > 0) return { url: pageUrl, links };
      }
    } catch {}
  }

  // Fallback: construct URL (for fights where pageUrl wasn't captured)
  const d    = new Date(dateMs);
  const days = [d.getDate(), d.getDate() + 1, d.getDate() - 1];
  for (const day of days) {
    const dd  = String(day).padStart(2, '0');
    for (const slug of [`${f1Slug}-vs-${f2Slug}`, `${f2Slug}-vs-${f1Slug}`]) {
      const url = `${WMMA_BASE}/${eventPrefix}-${slug}-${month}-${dd}-${year}.html`;
      try {
        const r = await fetch(url, { timeout: 7000, headers: { 'User-Agent': WMMA_UA } });
        if (r.ok) {
          const links = extractWatchMMAEmbeds(await r.text());
          if (links.length > 0) return { url, links };
        }
      } catch {}
    }
  }
  return null;
}

// Discover all individual fights on an event card via watchmmafull search page.
// Post links on the search page embed the exact fighter slugs and event prefix,
// e.g. /ufc-328-khamzat-chimaev-vs-sean-strickland-may-09-2026.html
// This is more precise than using tag links (which bleed across events).
async function discoverEventFights(query, dateMs) {
  const d      = new Date(dateMs);
  const month  = d.toLocaleString('en-US', { month: 'long' }).toLowerCase();
  const year   = d.getFullYear();

  const numM   = query.match(/\bUFC\s*(\d+)\b/i);
  const num    = numM?.[1];
  const prefix = num ? `ufc-${num}`
    : query.toLowerCase().replace(/[:'.,]/g,'').replace(/\s+/g,'-').replace(/-+/g,'-').replace(/^-|-$/g,'');
  const searchQ = num ? `ufc ${num}` : query.replace(/[:.]/g,'').replace(/\s+/g,' ').trim().slice(0,40);

  try {
    const sr = await fetch(`${WMMA_BASE}/?s=${encodeURIComponent(searchQ)}`, {
      timeout: 8000, headers: { 'User-Agent': WMMA_UA },
    });
    if (!sr.ok) return [];
    const html = await sr.text();

    // Match post links: both relative (/ufc-328-...) and absolute (https://watchmmafull.com/ufc-328-...)
    // Only keep posts whose path starts with our event prefix.
    const postRe = new RegExp(
      `href="(?:https?://watchmmafull\\.com)?/(${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-[^"]+\\.html)"`,
      'gi'
    );
    const seen   = new Set();
    const fights = [];
    let m;

    while ((m = postRe.exec(html)) !== null) {
      const path = m[1]; // e.g. "ufc-328-khamzat-chimaev-vs-sean-strickland-may-09-2026.html"
      if (seen.has(path)) continue;
      seen.add(path);

      // Strip prefix + leading dash, and trailing .html
      let remainder = path.slice(prefix.length + 1).replace(/\.html$/, '');
      // Strip trailing date: -month-dd-yyyy
      remainder = remainder.replace(
        /-(?:january|february|march|april|may|june|july|august|september|october|november|december)-\d{2}-\d{4}$/i,
        ''
      );
      // Now we have: {f1-slug}-vs-{f2-slug}
      const vsIdx = remainder.indexOf('-vs-');
      if (vsIdx < 0) continue;
      const f1Slug = remainder.slice(0, vsIdx);
      const f2Slug = remainder.slice(vsIdx + 4);
      if (!f1Slug || !f2Slug) continue;

      const label = [f1Slug, f2Slug]
        .map(s => s.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '))
        .join(' vs ');

      const f1 = f1Slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
      const f2 = f2Slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
      fights.push({
        label, f1Slug, f2Slug, f1, f2,
        eventPrefix: prefix, month, year, dateMs,
        pageUrl: `${WMMA_BASE}/${path}`,
      });
    }

    return fights;
  } catch { return []; }
}

// ─── /api/event-fights ────────────────────────────────────────────────────────
// Returns the full fight card for an event.
// Priority: watchmmafull (individual fight pages, streamable now) > torrents (whole-event download)
app.get('/api/event-fights', async (req, res) => {
  const query     = req.query.q?.trim();
  const dateMs    = req.query.date ? parseInt(req.query.date) : null;
  const wikiTitle = req.query.wiki?.trim(); // direct Wikipedia title from posters index
  if (!query && !wikiTitle) return res.json({ type: 'empty' });

  try {
    // 1. Try watchmmafull (individual fight pages — works for ~last 1-2 years)
    if (dateMs && query) {
      const fights = await discoverEventFights(query, dateMs);
      if (fights.length > 0) return res.json({ type: 'fights', fights });
    }

    // 2. Wikipedia fight card — use wikiTitle directly if provided (more reliable),
    //    otherwise fall back to deriving slug from the event name query.
    const wikiFights = await discoverFightsFromWikipedia(wikiTitle || query);
    if (wikiFights.length > 0) return res.json({ type: 'fights', fights: wikiFights });

    return res.json({ type: 'empty' });
  } catch { res.json({ type: 'empty' }); }
});

// ─── /api/fight-streams ───────────────────────────────────────────────────────
// Given a fight's watchmmafull metadata, finds and returns its embed URLs.
app.post('/api/fight-streams', async (req, res) => {
  const { f1Slug, f2Slug, f1, f2, eventPrefix, month, year, dateMs, pageUrl, source, label, eventContext } = req.body;
  if (!f1Slug && !f2Slug && !f1 && !f2) return res.json([]);
  try {
    const streams = [];

    // WatchMMAFull source (has pageUrl or slug data)
    if (pageUrl || (f1Slug && f2Slug)) {
      const result = await fetchFightEmbeds(f1Slug, f2Slug, eventPrefix, month, year, dateMs, pageUrl);
      if (result) {
        streams.push(...result.links.map(url => ({ embedUrl: url, label: embedLabel(url) })));
      }
    }

    // YouTube: search for this fight (primary for Wikipedia-sourced fights, fallback for watchmmafull)
    const ytBase = (f1 && f2) ? `${f1} vs ${f2}` : (label || null);
    if (ytBase) {
      const ytQ = eventContext ? `${ytBase} ${eventContext} full fight` : `${ytBase} UFC full fight`;
      const ytResult = await findFightOnYoutube(ytQ);
      if (ytResult) streams.push({ embedUrl: ytResult.url, label: ytResult.title || `${ytBase} (YouTube)` });
    }

    res.json(streams);
  } catch { res.json([]); }
});

// ─── /api/search-replays (boxing / direct search) ────────────────────────────
// YouTube search — used by the Boxing tab and other direct searches.
app.get('/api/search-replays', async (req, res) => {
  const query = req.query.q?.trim();
  if (!query) return res.json([]);
  try {
    const ytResults = await searchYouTubeMultiple(`${query} full fight`, 5);
    if (!ytResults.length) return res.json([]);
    res.json(ytResults.map(r => ({
      type: 'stream', source: 'youtube',
      embedUrl: r.url, label: r.title || query,
    })));
  } catch { res.json([]); }
});

app.post('/api/find-replay', async (req, res) => {
  const { title } = req.body;
  if (!title) return res.status(400).json({ error: 'Missing title' });

  const wsClient = [...wss.clients].find(c => c.readyState === 1) || null;
  const wsLog = msg => {
    console.log('[find-replay]', msg);
    if (wsClient?.readyState === 1) wsClient.send(JSON.stringify({ type: 'scan_progress', msg }));
  };

  wsLog(`Searching for "${title}"…`);

  try {
    wsLog(`Searching YouTube: "${title} full event"…`);
    const ytInfo = await extractWithYtDlp(`ytsearch1:${title} full event`);
    if (ytInfo?.streamUrl) {
      wsLog(`YouTube: found "${ytInfo.title}"`);
      const streamUrl = ytInfo.streamUrl.includes('.m3u8')
        ? `/proxy/stream?ref=${encodeURIComponent(ytInfo.streamUrl)}&url=${encodeURIComponent(ytInfo.streamUrl)}`
        : ytInfo.streamUrl;
      return res.json({
        success: true, streamUrl, rawUrl: ytInfo.streamUrl,
        type: ytInfo.streamUrl.includes('.m3u8') ? 'hls' : 'direct',
        title: ytInfo.title || title, isLive: false,
        replaySource: 'youtube', quality: 'HD',
        chapters: ytInfo.chapters || [], fightList: [],
      });
    }
  } catch (e) {
    wsLog(`YouTube: ${e.message.slice(0, 80)}`);
  }

  return res.json({
    success: false,
    error: `No replay found for "${title}"`,
    hint: 'Check that yt-dlp is installed (`pip3 install yt-dlp`) and try a specific search like "UFC 309".',
  });
});

// ─── Sport events (multi-backend) ────────────────────────────────────────────

const SPORT_CATEGORIES = {
  mma:      'fight',
  football: 'football',
  afl:      'afl',
  cricket:  'cricket',
  tennis:   'tennis',
  f1:       'motorsport',
};

// Map raw API category strings to display sport keys (for 'all' tab labels)
const CATEGORY_TO_SPORT = {
  fight:          'mma',
  football:       'football',
  soccer:         'football',
  afl:            'afl',
  cricket:        'cricket',
  tennis:         'tennis',
  'motor-sports': 'motorsport',
  motorsport:     'motorsport',
  formula1:       'motorsport',
  f1:             'motorsport',
  motor:          'motorsport',
  motogp:         'motogp',
  moto:           'motogp',
  basketball:     'basketball',
  baseball:       'baseball',
  hockey:         'hockey',
  rugby:          'rugby',
};

async function fetchRawLiveMatches() {
  for (const backend of STREAM_BACKENDS) {
    try {
      const r = await fetch(`${backend.base}/api/matches/live`, {
        headers: browserHeaders('https://stream-east.net/'),
        timeout: 10000,
      });
      if (!r.ok) continue;
      const data = await r.json();
      if (Array.isArray(data) && data.length > 0) return data;
    } catch {}
  }
  throw new Error('All stream backends unavailable');
}

function mapMatch(m) {
  return {
    id: m.id,
    title: m.title,
    date: m.date,
    isLive: true,
    poster: m.poster || null,
    teams: m.teams || null,
    sources: (m.sources || []).map(s => s.source),
    category: m.category || 'other',
    sport: CATEGORY_TO_SPORT[m.category?.toLowerCase()] || m.category || 'other',
  };
}

async function fetchSportEvents(sport) {
  const matches = await fetchRawLiveMatches();

  const filtered = matches.filter(m => {
    if (sport === 'all') return true;
    if (sport === 'mma') return m.category === 'fight';
    if (sport === 'f1') return ['motor-sports', 'motorsport', 'formula1', 'f1', 'motor'].includes(m.category?.toLowerCase());
    const category = SPORT_CATEGORIES[sport];
    if (!category) return false;
    return m.category === category;
  });

  return filtered.map(mapMatch).sort((a, b) => a.date - b.date);
}

app.get('/api/sport-events', async (req, res) => {
  const sport = req.query.sport || 'mma';
  try {
    res.json(await fetchSportEvents(sport));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Legacy alias
app.get('/api/fight-events', async (req, res) => {
  try {
    res.json(await fetchSportEvents('mma'));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Batch stream availability check ─────────────────────────────────────────
// Returns { matchId: true/false } — true means at least one broadcaster is live.
// Called after the event grid renders so cards can show accurate LIVE vs Pre-Match.
app.get('/api/stream-status', async (req, res) => {
  const ids = (req.query.ids || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 25);
  if (!ids.length) return res.json({});

  let matches;
  try { matches = await fetchRawLiveMatches(); } catch { return res.json({}); }

  const results = {};
  await Promise.all(ids.map(async id => {
    const match = matches.find(m => m.id === id);
    if (!match?.sources?.length) { results[id] = false; return; }
    // Check each source until one confirms a live stream
    for (const src of match.sources) {
      try {
        const r = await fetch(`https://streamed.pk/api/stream/${src.source}/${src.id}`, {
          headers: browserHeaders('https://stream-east.net/'), timeout: 5000,
        });
        if (!r.ok) continue;
        const streams = await r.json();
        if (Array.isArray(streams) && streams.length > 0) { results[id] = true; return; }
      } catch {}
    }
    results[id] = false;
  }));

  res.json(results);
});

// ─── Local IP (for Chromecast — device can't reach localhost) ────────────────

app.get('/api/local-ip', (req, res) => {
  let localIp = '127.0.0.1';
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces) {
      if (iface.family === 'IPv4' && !iface.internal) {
        localIp = iface.address;
        break;
      }
    }
    if (localIp !== '127.0.0.1') break;
  }
  res.json({ ip: localIp, port: server.address()?.port || 3847 });
});

// ─── Network speed test ───────────────────────────────────────────────────────

app.get('/api/speedtest', async (req, res) => {
  const t = Date.now();
  try {
    const r = await fetch('https://speed.cloudflare.com/__down?bytes=1048576', { timeout: 10000 });
    const buf = await r.buffer();
    const secs = (Date.now() - t) / 1000;
    res.json({ speedMbps: parseFloat(((buf.length * 8) / secs / 1e6).toFixed(2)) });
  } catch { res.json({ speedMbps: null }); }
});

// ─── Probe ────────────────────────────────────────────────────────────────────

app.post('/api/probe', async (req, res) => {
  const { url, referer } = req.body;
  if (!url) return res.status(400).json({ error: 'Missing url' });
  try {
    const r = await fetch(url, { headers: browserHeaders(referer || url), timeout: 8000, redirect: 'follow' });
    const ct = r.headers.get('content-type') || '';
    res.json({ ok: r.ok, status: r.status, contentType: ct, isStream: ct.includes('mpegurl') || url.includes('.m3u8') });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// ─── Deep diagnostic: fetch manifest, parse it, test a segment ───────────────

app.post('/api/diagnose', async (req, res) => {
  const { url, referer } = req.body;
  if (!url) return res.status(400).json({ error: 'Missing url' });
  const ref = referer || url;
  const steps = [];

  // Step 1: fetch manifest
  let manifestText = null;
  try {
    const t = Date.now();
    const r = await fetch(url, { headers: browserHeaders(ref), timeout: 10000, redirect: 'follow' });
    const ms = Date.now() - t;
    const ct = r.headers.get('content-type') || '';
    const body = await r.text();

    steps.push({
      step: 'Manifest fetch',
      ok: r.ok,
      status: r.status,
      statusText: r.statusText,
      contentType: ct,
      ms,
      detail: r.ok
        ? `Got ${body.length} bytes in ${ms}ms (Content-Type: ${ct || 'none'}, Encoding: ${r.headers.get('content-encoding') || 'none'})`
        : `HTTP ${r.status} — ${r.statusText}`,
      preview: r.ok ? body.slice(0, 200) : undefined,
      hint: r.status === 403
        ? 'CDN blocked the request (403). The Referer/IP does not match what it expects. Make sure you paste the page URL in the "Page URL" field.'
        : r.status === 404
        ? 'URL not found (404). The stream token has likely expired — go back to the site and grab a fresh m3u8 URL.'
        : null,
    });

    if (r.ok) manifestText = body;
  } catch (err) {
    steps.push({ step: 'Manifest fetch', ok: false, detail: `Network error: ${err.message}`,
      hint: 'Could not reach the server. Check your internet connection.' });
    return res.json({ steps });
  }

  if (!manifestText) return res.json({ steps });

  // Step 2: parse manifest — check for JSON embed list first
  const lines = manifestText.split('\n').map(l => l.trim()).filter(Boolean);
  const isM3u8 = lines[0] === '#EXTM3U';

  // Detect JSON response (API returning embed URLs instead of a real manifest)
  if (!isM3u8 && manifestText.trim().startsWith('[') || manifestText.trim().startsWith('{')) {
    let parsed = null;
    try { parsed = JSON.parse(manifestText.trim()); } catch {}
    if (parsed) {
      const items = Array.isArray(parsed) ? parsed : [parsed];
      const embedUrls = items.map(i => i.embedUrl || i.embed_url || i.url || i.src).filter(Boolean);
      const streamUrls = items.map(i => i.streamUrl || i.stream_url || i.hls || i.hlsUrl).filter(Boolean);

      steps.push({
        step: 'Manifest parse',
        ok: false,
        detail: `This URL returned a JSON API response, not an HLS manifest. Found ${items.length} stream entry/entries.`,
        hint: embedUrls.length
          ? `Scanning ${embedUrls.length} embed URL(s) with headless browser to find the real stream…`
          : streamUrls.length
          ? `Found ${streamUrls.length} direct stream URL(s) in the JSON.`
          : 'No embed URLs found in the JSON — the stream may need a different approach.',
        preview: manifestText.slice(0, 300),
      });

      // If there are direct stream URLs in the JSON, return them
      if (streamUrls.length > 0) {
        return res.json({ steps, followUp: { type: 'streams', urls: streamUrls } });
      }

      // Scan embed URLs with Puppeteer
      if (embedUrls.length > 0) {
        const allFound = [];
        for (const embedUrl of embedUrls.slice(0, 3)) {
          const wsClient = [...wss.clients].find(c => c.readyState === 1) || null;
          const found = await puppeteerScan(embedUrl, wsClient);
          allFound.push(...found);
        }
        const unique = [...new Set(allFound.map(h => h.url || h))];
        steps.push({
          step: 'Embed scan (headless browser)',
          ok: unique.length > 0,
          detail: unique.length > 0
            ? `Found ${unique.length} stream URL(s) inside embed player(s).`
            : 'No stream URLs found inside the embed players.',
          hint: unique.length === 0
            ? 'The embed player may use WebSocket or encrypted keys we cannot intercept. Try opening the embed URL directly in your browser and copying the m3u8 from DevTools.'
            : null,
          preview: unique.slice(0, 3).join('\n'),
        });
        return res.json({ steps, followUp: unique.length > 0 ? { type: 'streams', urls: unique, hits: allFound } : null });
      }

      return res.json({ steps });
    }
  }

  const isMaster = lines.some(l => l.startsWith('#EXT-X-STREAM-INF'));
  const segmentLines = lines.filter(l => !l.startsWith('#') && l.length > 0);
  const keyLines = lines.filter(l => l.startsWith('#EXT-X-KEY'));

  steps.push({
    step: 'Manifest parse',
    ok: isM3u8,
    detail: isM3u8
      ? `Valid HLS manifest. ${isMaster ? 'Master playlist' : 'Media playlist'} with ${segmentLines.length} segment(s).${keyLines.length ? ` Encrypted (${keyLines.length} key line(s)).` : ''}`
      : `Not a valid HLS manifest (missing #EXTM3U). First line: "${lines[0]}"`,
    preview: lines.slice(0, 8).join('\n'),
  });

  if (!isM3u8 || segmentLines.length === 0) return res.json({ steps });

  // Step 3: resolve and test first segment/sub-manifest
  const firstLine = segmentLines[0];
  const baseUrl = url.substring(0, url.lastIndexOf('/') + 1);
  const origin = new URL(url).origin;
  let segUrl;
  if (firstLine.startsWith('http')) segUrl = firstLine;
  else if (firstLine.startsWith('//')) segUrl = 'https:' + firstLine;
  else if (firstLine.startsWith('/')) segUrl = origin + firstLine;
  else segUrl = baseUrl + firstLine;

  try {
    const t = Date.now();
    const r = await fetch(segUrl, { headers: browserHeaders(ref), timeout: 8000, redirect: 'follow', method: 'HEAD' });
    const ms = Date.now() - t;
    steps.push({
      step: isMaster ? 'Sub-manifest fetch' : 'First segment fetch',
      ok: r.ok,
      status: r.status,
      ms,
      url: segUrl,
      detail: r.ok
        ? `Reachable in ${ms}ms (${r.headers.get('content-type') || 'unknown type'})`
        : `HTTP ${r.status} — ${r.statusText}`,
      hint: r.status === 403
        ? 'Segment/sub-manifest blocked (403). Token in the URL may be IP-bound or the CDN requires a specific cookie.'
        : r.status === 404
        ? 'Segment not found (404). The stream may have ended or the URL has expired.'
        : null,
    });
  } catch (err) {
    steps.push({ step: 'Segment fetch', ok: false, detail: `Network error: ${err.message}`, url: segUrl });
  }

  res.json({ steps, isMaster, segmentCount: segmentLines.length });
});

// ─── WebSocket ────────────────────────────────────────────────────────────────

wss.on('connection', ws => {
  ws.on('message', data => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
    } catch {}
  });
});

// ─── Puppeteer live session store (keeps browser alive for segment auth) ──────
const pupSessions = new Map();  // sessionId → { browser, pages: [], pageQueue: [], lastUsed }
let sessionCounter = 0;

// ─── Segment cache (serves pre-fetched / CDP-intercepted segments instantly) ──
// 80 entries (≈520MB at 6.5MB/seg worst case), 3 min TTL.
// Populated by: (1) CDP interception of in-page player downloads (free),
//               (2) predictive pre-fetch (before HLS.js asks),
//               (3) pool-page fetch on cache miss.
const segmentCache = new Map();
// Global prefetch concurrency cap — prevents background alt-source activity
// from starving the primary stream's segment fetches.
let _globalPrefetchActive = 0;
const MAX_GLOBAL_PREFETCH = 3;
const SEGMENT_CACHE_MAX = 80;
const SEGMENT_CACHE_TTL = 180000; // 3 minutes

function cacheSegment(url, buf, ct) {
  // Evict oldest if at capacity
  if (segmentCache.size >= SEGMENT_CACHE_MAX) {
    const oldest = segmentCache.keys().next().value;
    segmentCache.delete(oldest);
  }
  segmentCache.set(url, { buf, ct, expires: Date.now() + SEGMENT_CACHE_TTL });
}

function getCachedSegment(url) {
  const entry = segmentCache.get(url);
  if (!entry) return null;
  if (Date.now() > entry.expires) { segmentCache.delete(url); return null; }
  return entry;
}

// ─── Predictive segment pre-fetching ─────────────────────────────────────────
// Parse the live manifest and pre-fetch the next N uncached segments using the
// main page (correct Origin/cookies). By the time HLS.js requests them they're
// already in cache → served in ~0ms, zero IPC overhead on the hot path.

function triggerSegmentPrefetch(session, manifestText, baseUrl) {
  if (!session || !session.mainPage) return;
  const origin = (() => { try { return new URL(baseUrl).origin; } catch { return ''; } })();
  const lines = manifestText.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  // Pre-fetch the last 8 segments — matches the working Windows build config.
  const liveEdge = lines.slice(-8);
  for (const line of liveEdge) {
    let abs;
    if (line.startsWith('http://') || line.startsWith('https://')) abs = line;
    else if (line.startsWith('//')) abs = 'https:' + line;
    else if (line.startsWith('/')) abs = origin + line;
    else abs = baseUrl + line;
    prefetchSegment(session, abs);
  }
}

async function prefetchSegment(session, url) {
  if (!url || getCachedSegment(url)) return;
  if (!session._prefetching) session._prefetching = new Set();
  if (session._prefetching.has(url)) return;
  // Global cap: don't let background prefetches starve the active stream
  if (_globalPrefetchActive >= MAX_GLOBAL_PREFETCH) return;
  _globalPrefetchActive++;
  session._prefetching.add(url);
  try {
    // Try tls-client first (no IPC overhead, wire speed)
    if (tlsSession) {
      try {
        const referer = session.embedUrl || url;
        const origin = (() => { try { return new URL(referer).origin; } catch { return ''; } })();
        const r = await tlsSession.get(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            'Accept': '*/*', 'Accept-Encoding': 'identity',
            'Referer': origin + '/', 'Origin': origin,
          },
        });
        if (r.status >= 200 && r.status < 300) {
          const buf = Buffer.from(r.body, 'binary');
          if (buf.length > 0) {
            cacheSegment(url, buf, 'video/mp2t');
            console.log(`[prefetch/tls] ${url.split('/').pop()} (${(buf.length/1024).toFixed(0)}KB)`);
            return;
          }
        }
      } catch {}
    }
    // Fall back to main page evaluate (correct Origin header)
    if (!session.mainPage) return;
    const result = await session.mainPage.evaluate(async (targetUrl) => {
      function ab2b64(ab) {
        const bytes = new Uint8Array(ab); let s = '';
        for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192));
        return btoa(s);
      }
      try {
        const r = await fetch(targetUrl, { credentials: 'omit' });
        if (!r.ok) return { ok: false };
        const ab = await r.arrayBuffer();
        return { ok: true, b64: ab2b64(ab), ct: r.headers.get('content-type') || 'video/mp2t' };
      } catch { return { ok: false }; }
    }, url);
    if (result.ok) {
      const buf = Buffer.from(result.b64, 'base64');
      cacheSegment(url, buf, result.ct);
      console.log(`[prefetch/page] ${url.split('/').pop()} (${(buf.length/1024).toFixed(0)}KB)`);
    }
  } catch (e) {
    // Non-fatal — segment will be fetched normally if needed
  } finally {
    session._prefetching?.delete(url);
    _globalPrefetchActive--;
  }
}

// Grab an idle page from the pool, or wait for one to become available
async function getSessionPage(session) {
  if (session.pages.length > 0) return session.pages.pop();
  return new Promise(resolve => session.pageQueue.push(resolve));
}

// Return a page to the pool (or hand it to a waiting request)
function releaseSessionPage(session, page) {
  if (session.pageQueue.length > 0) {
    session.pageQueue.shift()(page);
  } else {
    session.pages.push(page);
  }
}

// Clean up sessions idle for > 30 minutes
setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [sid, s] of pupSessions) {
    if (s.lastUsed < cutoff) {
      console.log(`[pup] closing idle session ${sid}`);
      if (s._refreshTimer) s._refreshTimer();
      s.browser.close().catch(() => {});
      pupSessions.delete(sid);
    }
  }
}, 5 * 60 * 1000);

// ─── Puppeteer segment proxy ──────────────────────────────────────────────────
// Strategy:
//   1. Serve from segment cache (CDP-intercepted or pre-fetched) → ~0ms, zero IPC
//   2. Try node-fetch (zero overhead, works for non-fingerprinted CDNs)
//   3. Try tls-client (Chrome JA3/JA4 fingerprint, no IPC, wire speed)
//   4. Chrome pool page fallback (handles everything, but base64 IPC overhead)

app.get('/proxy/pup', async (req, res) => {
  const { url, sid } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing url' });
  if (!sid) return res.status(400).json({ error: 'Missing session id' });

  const session = pupSessions.get(sid);
  if (!session) return res.status(410).json({ error: 'Browser session expired — reload the stream.' });

  session.lastUsed = Date.now();

  // ── 1. Segment cache hit (CDP-intercepted or pre-fetched — ~0ms) ────────────
  const isSegment = !url.includes('.m3u8') && !url.includes('playlist');
  if (isSegment) {
    const cached = getCachedSegment(url);
    if (cached) {
      res.set('Access-Control-Allow-Origin', '*');
      res.set('Cache-Control', 'no-cache');
      res.set('Content-Type', cached.ct || 'application/octet-stream');
      res.set('X-Cache', 'HIT');
      return res.send(cached.buf);
    }
  }

  // Track per-CDN hostname latency for load balancing decisions
  const _t0 = Date.now();
  const _trackLatency = (hostname) => {
    const ms = Date.now() - _t0;
    const prev = session.cdnLatency?.get(hostname) ?? ms;
    // EWMA: weight recent measurements more heavily
    session.cdnLatency?.set(hostname, Math.round(prev * 0.7 + ms * 0.3));
  };
  let _cdnHost = '';
  try { _cdnHost = new URL(url).hostname; } catch {}

  // ── 2. Try node-fetch first (zero base64/IPC overhead) ─────────────────────
  // Skip if this session's CDN has already proven it requires Chrome (TLS fingerprint).
  if (session.nodeFetchWorks !== false) {
    try {
      // Use the embed page origin as the referer — CDN checks this, not the CDN's own origin
      const referer = session.embedUrl || url;
      const headers = { ...browserHeaders(referer), 'Accept-Encoding': 'identity' };
      const r = await fetch(url, { headers, timeout: 15000, redirect: 'follow' });
      if (r.ok) {
        session.nodeFetchWorks = true;
        _trackLatency(_cdnHost);
        const buf = await r.buffer();
        const ct = r.headers.get('content-type') || 'application/octet-stream';
        if (isSegment) cacheSegment(url, buf, ct);
        res.set('Access-Control-Allow-Origin', '*');
        res.set('Cache-Control', 'no-cache');
        res.set('Content-Type', ct);
        return res.send(buf);
      }
      // Non-403 failure (404, 5xx) — surface the error rather than falling back
      if (r.status !== 403 && r.status !== 0) {
        return res.status(r.status).json({ error: `CDN returned ${r.status}` });
      }
      // 403 means TLS fingerprint check — mark session and try tls-client next
      if (session.nodeFetchWorks === undefined) {
        session.nodeFetchWorks = false;
        console.log(`[proxy/pup] CDN fingerprints TLS (got 403) — trying tls-client for session ${sid}`);
      }
    } catch { /* network error — fall through */ }
  }

  // ── 3. tls-client fast path (Chrome JA3/JA4 fingerprint, wire speed, no IPC) ─
  if (session.nodeFetchWorks === false && tlsSession && session.tlsClientWorks !== false) {
    try {
      const referer = session.embedUrl || url;
      const origin = (() => { try { return new URL(referer).origin; } catch { return ''; } })();
      const r = await tlsSession.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          'Accept': '*/*', 'Accept-Encoding': 'identity',
          'Referer': origin + '/', 'Origin': origin,
          'Sec-Fetch-Dest': 'empty', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Site': 'cross-site',
        },
      });
      if (r.status >= 200 && r.status < 300) {
        session.tlsClientWorks = true;
        const buf = Buffer.from(r.body, 'binary');
        const ct = r.headers?.['content-type'] || (isSegment ? 'video/mp2t' : 'application/vnd.apple.mpegurl');
        if (isSegment) cacheSegment(url, buf, ct);
        res.set('Access-Control-Allow-Origin', '*');
        res.set('Cache-Control', 'no-cache');
        // Rewrite manifest URLs if needed
        if (!isSegment) {
          res.set('Content-Type', 'application/vnd.apple.mpegurl');
          // (manifest rewriting handled by caller — this path is mostly for segments)
          return res.send(buf.toString());
        }
        res.set('Content-Type', ct);
        return res.send(buf);
      }
      if (r.status === 403) {
        session.tlsClientWorks = false;
        console.log(`[proxy/pup] tls-client also 403 — falling back to Chrome for session ${sid}`);
      }
    } catch (e) {
      console.log(`[proxy/pup] tls-client error: ${e.message.slice(0, 80)}`);
    }
  }

  // ── 4. Chrome fallback (handles TLS-fingerprinting CDNs with correct Origin) ─
  // Manifests (.m3u8) require the embed-page Origin/Referer — use the main page
  // which is still navigated to the embed site. Pool pages are about:blank and
  // the CDN rejects them (Origin: null). Only segments go to pool pages.
  const useMainPage = isSegment === false && session.mainPage;
  const fetchPage = useMainPage ? session.mainPage : await getSessionPage(session);
  try {
    const result = await fetchPage.evaluate(async (targetUrl) => {
      // Faster base64 encoding: avoid FileReader async overhead by using Uint8Array directly
      function arrayBufferToBase64(ab) {
        const bytes = new Uint8Array(ab);
        let binary = '';
        // Process in 8KB chunks to avoid call stack limits on large segments
        const CHUNK = 8192;
        for (let i = 0; i < bytes.length; i += CHUNK) {
          binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
        }
        return btoa(binary);
      }

      function tryXhr(u) {
        return new Promise(resolve => {
          const xhr = new XMLHttpRequest();
          xhr.open('GET', u, true);
          xhr.withCredentials = true;
          xhr.responseType = 'arraybuffer';
          xhr.timeout = 20000;
          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
              resolve({ ok: true, status: xhr.status, ct: xhr.getResponseHeader('content-type') || '', b64: arrayBufferToBase64(xhr.response) });
            } else {
              resolve({ ok: false, status: xhr.status, error: `XHR ${xhr.status}` });
            }
          };
          xhr.onerror = () => resolve({ ok: false, status: 0, error: 'XHR network error' });
          xhr.ontimeout = () => resolve({ ok: false, status: 0, error: 'XHR timeout' });
          xhr.send();
        });
      }

      let r = await tryXhr(targetUrl);
      if (!r.ok) {
        try {
          const resp = await fetch(targetUrl, { credentials: 'omit' });
          const ab = await resp.arrayBuffer();
          r = { ok: resp.ok, status: resp.status, ct: resp.headers.get('content-type') || '', b64: arrayBufferToBase64(ab) };
        } catch (e2) { r.error = (r.error || '') + ' | fetch: ' + e2.message; }
      }
      return r;
    }, url);

    if (!result.ok) {
      return res.status(result.status || 502).json({ error: result.error || `Upstream ${result.status}` });
    }

    const buf = Buffer.from(result.b64, 'base64');
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Cache-Control', 'no-cache');

    const isManifest = result.ct.includes('mpegurl') || url.includes('.m3u8');
    if (isManifest) {
      res.set('Content-Type', 'application/vnd.apple.mpegurl');
      let text = buf.toString('utf-8');
      const baseUrl = url.substring(0, url.lastIndexOf('/') + 1);
      let origin = '';
      try { origin = new URL(url).origin; } catch {}

      function pupProxyUrl(u) {
        u = u.trim();
        if (!u) return u;
        let abs;
        if (u.startsWith('http://') || u.startsWith('https://')) abs = u;
        else if (u.startsWith('//')) abs = 'https:' + u;
        else if (u.startsWith('/')) abs = origin + u;
        else abs = baseUrl + u;
        return `/proxy/pup?sid=${encodeURIComponent(sid)}&url=${encodeURIComponent(abs)}`;
      }

      text = text.replace(/URI="([^"]+)"/g, (_, uri) => `URI="${pupProxyUrl(uri)}"`);
      text = text.replace(/^(?!#)(\S.*)$/gm, line => pupProxyUrl(line));
      return res.send(text);
    }

    if (isSegment) cacheSegment(url, buf, result.ct);
    res.set('Content-Type', result.ct || 'application/octet-stream');
    res.send(buf);
  } catch (err) {
    console.error('[proxy/pup]', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    // Don't return the main page to the pool — only release pool pages
    if (!useMainPage) releaseSessionPage(session, fetchPage);
  }
});

// ─── Chromecast — server-side mDNS discovery + castv2 control ─────────────────
// The Google Cast SDK requires Chrome's built-in Media Router which isn't
// available in Electron or non-Chrome browsers. We discover devices ourselves
// via mDNS and control them directly with castv2-client.

let _mdns = null;
let _CastClient = null;
let _DefaultMediaReceiver = null;
try {
  _mdns = require('multicast-dns')();
  const castv2 = require('castv2-client');
  _CastClient = castv2.Client;
  _DefaultMediaReceiver = castv2.DefaultMediaReceiver;
} catch (e) {
  console.log('[cast] castv2-client or multicast-dns not installed — Chromecast unavailable');
}

const castDevices = new Map(); // id → { id, name, host, port }
const castSessions = new Map(); // id → { client }

if (_mdns) {
  // Parse TXT record attribute map from multicast-dns buffer array
  const parseTxt = (data) => {
    const attrs = {};
    for (const buf of (data || [])) {
      const s = Buffer.isBuffer(buf) ? buf.toString() : String(buf);
      const eq = s.indexOf('=');
      if (eq > 0) attrs[s.slice(0, eq)] = s.slice(eq + 1);
    }
    return attrs;
  };

  _mdns.on('response', (response) => {
    const all = [...(response.answers || []), ...(response.additionals || [])];
    console.log('[cast] mDNS response records:', all.map(r => `${r.type} ${r.name}`).join(', ') || '(none)');

    // Some Chromecasts send PTR in answers, SRV/A in additionals; others bundle them all.
    // Also handle unicast responses where all records are in answers.
    const ptrs = all.filter(r => r.type === 'PTR' && r.name.includes('_googlecast'));
    for (const ptr of ptrs) {
      const svcName = typeof ptr.data === 'string' ? ptr.data : ptr.data?.toString?.();
      if (!svcName) continue;

      const srv = all.find(r => r.type === 'SRV' && r.name === svcName);
      // Try both direct A match and case-insensitive target match
      const target = srv?.data?.target;
      const a = all.find(r => r.type === 'A' && target && r.name.toLowerCase() === target.toLowerCase());
      const txt = all.find(r => r.type === 'TXT' && r.name === svcName);

      if (!a) {
        // A record may arrive in a separate mDNS packet — store partial and resolve later
        console.log(`[cast] PTR found (${svcName}) but missing A record — will retry`);
        // Queue a targeted query for the SRV target
        if (target) setTimeout(() => _mdns.query({ questions: [{ name: target, type: 'A' }] }), 200);
        continue;
      }

      const host = a.data || a.address;
      const port = srv?.data?.port || 8009;
      const id   = `${host}:${port}`;
      const attrs = parseTxt(txt?.data);
      const name = attrs.fn || svcName.split('.')[0].replace(/^[A-Za-z]+-[0-9a-f]+-?/i, '') || 'Chromecast';
      console.log(`[cast] Found device: ${name} @ ${host}:${port}`);
      castDevices.set(id, { id, name, host, port });
    }
  });

  _mdns.on('error', (err) => console.log('[cast] mDNS error:', err.message));

  // Query immediately and every 8s — send both PTR and unicast hint
  const queryCast = () => {
    _mdns.query({ questions: [{ name: '_googlecast._tcp.local', type: 'PTR' }] });
  };
  queryCast();
  setInterval(queryCast, 8000);
  console.log('[cast] mDNS discovery started');
}

app.get('/api/cast-devices', (req, res) => {
  res.json(Array.from(castDevices.values()));
});

app.post('/api/cast-start', async (req, res) => {
  if (!_CastClient) return res.status(503).json({ error: 'castv2-client not installed' });
  const { deviceId, streamUrl } = req.body;
  const device = castDevices.get(deviceId);
  if (!device) return res.status(404).json({ error: 'Device not found' });

  // Close any existing session on this device
  const existing = castSessions.get(deviceId);
  if (existing) { try { existing.close(); } catch {} castSessions.delete(deviceId); }

  try {
    const client = new _CastClient();
    await new Promise((ok, fail) => {
      client.connect({ host: device.host, port: device.port }, ok);
      client.on('error', fail);
      setTimeout(() => fail(new Error('connect timeout')), 10000);
    });
    const player = await new Promise((ok, fail) =>
      client.launch(_DefaultMediaReceiver, (err, p) => err ? fail(err) : ok(p)));
    await new Promise((ok, fail) =>
      player.load({ contentId: streamUrl, contentType: 'application/x-mpegURL', streamType: 'LIVE' },
        { autoplay: true }, (err) => err ? fail(err) : ok()));
    castSessions.set(deviceId, client);
    client.on('error', () => castSessions.delete(deviceId));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/cast-stop', (req, res) => {
  const { deviceId } = req.body;
  const client = castSessions.get(deviceId);
  if (client) { try { client.close(); } catch {} castSessions.delete(deviceId); }
  res.json({ success: true });
});

const PORT = process.env.PORT || 3847;
server.listen(PORT, () => {
  console.log(`\n🎬  Stream Diagnoser → http://localhost:${PORT}\n`);
});
