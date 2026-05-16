// Renders the app icon at multiple sizes using Puppeteer, then builds .icns
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

puppeteer.use(StealthPlugin());

const SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#1a1e2e"/>
      <stop offset="100%" style="stop-color:#0d0f18"/>
    </linearGradient>
    <linearGradient id="dish" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#6c9fff"/>
      <stop offset="100%" style="stop-color:#4f6ef7"/>
    </linearGradient>
    <filter id="glow">
      <feGaussianBlur stdDeviation="8" result="blur"/>
      <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>

  <!-- Rounded square background -->
  <rect width="1024" height="1024" rx="230" ry="230" fill="url(#bg)"/>

  <!-- Subtle grid lines -->
  <g opacity="0.06" stroke="#fff" stroke-width="1">
    <line x1="0" y1="256" x2="1024" y2="256"/>
    <line x1="0" y1="512" x2="1024" y2="512"/>
    <line x1="0" y1="768" x2="1024" y2="768"/>
    <line x1="256" y1="0" x2="256" y2="1024"/>
    <line x1="512" y1="0" x2="512" y2="1024"/>
    <line x1="768" y1="0" x2="768" y2="1024"/>
  </g>

  <!-- Signal arcs emanating from dish focal point -->
  <g fill="none" stroke="#4f8ef7" stroke-linecap="round" filter="url(#glow)" opacity="0.5">
    <path d="M 540 480 A 60 60 0 0 1 600 540"  stroke-width="12"/>
    <path d="M 520 440 A 110 110 0 0 1 630 560" stroke-width="9"/>
    <path d="M 498 398 A 165 165 0 0 1 663 580" stroke-width="6"/>
  </g>

  <!-- Satellite dish body -->
  <g transform="translate(340, 340)" filter="url(#glow)">
    <!-- Dish bowl -->
    <path d="M 40 260
             C 0 200, 0 80, 80 20
             C 160 -40, 280 -20, 320 60
             C 360 140, 320 220, 260 260 Z"
          fill="url(#dish)" opacity="0.95"/>
    <!-- Dish shine -->
    <path d="M 70 240
             C 40 190, 44 100, 108 50
             C 140 26, 180 20, 210 30"
          fill="none" stroke="rgba(255,255,255,0.3)" stroke-width="14" stroke-linecap="round"/>
    <!-- Dish rim -->
    <path d="M 40 260
             C 0 200, 0 80, 80 20
             C 160 -40, 280 -20, 320 60
             C 360 140, 320 220, 260 260 Z"
          fill="none" stroke="rgba(255,255,255,0.15)" stroke-width="6"/>
    <!-- Support arm -->
    <line x1="180" y1="140" x2="260" y2="60" stroke="#6c9fff" stroke-width="14" stroke-linecap="round"/>
    <!-- Focal point -->
    <circle cx="260" cy="60" r="20" fill="#4f8ef7"/>
    <circle cx="260" cy="60" r="10" fill="white" opacity="0.9"/>
    <!-- Base pole -->
    <line x1="180" y1="260" x2="180" y2="320" stroke="#3a3f5c" stroke-width="20" stroke-linecap="round"/>
    <ellipse cx="180" cy="320" rx="50" ry="14" fill="#2a2f45"/>
  </g>

  <!-- LIVE indicator dot -->
  <circle cx="760" cy="280" r="28" fill="#f0524f" opacity="0.9"/>
  <circle cx="760" cy="280" r="16" fill="white" opacity="0.9"/>

  <!-- Bottom label -->
  <text x="512" y="870"
        font-family="-apple-system, BlinkMacSystemFont, 'SF Pro Display', Helvetica, sans-serif"
        font-size="72" font-weight="700" fill="white" opacity="0.85"
        text-anchor="middle" letter-spacing="-1">STREAM</text>
</svg>
`;

const HTML = `<!DOCTYPE html><html><head><style>
  * { margin:0; padding:0; }
  body { width:1024px; height:1024px; overflow:hidden; background:transparent; }
  svg { width:1024px; height:1024px; }
</style></head><body>${SVG}</body></html>`;

(async () => {
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1024, height: 1024, deviceScaleFactor: 2 });
  await page.setContent(HTML, { waitUntil: 'networkidle0' });

  const outDir = path.join(__dirname, '..', 'assets');
  const iconset = path.join(outDir, 'icon.iconset');
  fs.mkdirSync(iconset, { recursive: true });

  // Render sizes needed for .icns
  const sizes = [16, 32, 64, 128, 256, 512, 1024];
  for (const size of sizes) {
    await page.setViewport({ width: size, height: size, deviceScaleFactor: size >= 512 ? 2 : 1 });
    const buf = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: size, height: size }, omitBackground: true });
    const name = `icon_${size}x${size}`;
    fs.writeFileSync(path.join(iconset, `${name}.png`), buf);
    if (size <= 512) {
      // @2x version
      await page.setViewport({ width: size * 2, height: size * 2, deviceScaleFactor: 2 });
      const buf2x = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: size * 2, height: size * 2 }, omitBackground: true });
      fs.writeFileSync(path.join(iconset, `${name}@2x.png`), buf2x);
    }
  }

  // Also save a 1024px PNG for Electron's icon property
  await page.setViewport({ width: 1024, height: 1024, deviceScaleFactor: 1 });
  const png1024 = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: 1024, height: 1024 }, omitBackground: true });
  fs.writeFileSync(path.join(outDir, 'icon.png'), png1024);
  console.log('✓ icon.png saved');

  await browser.close();

  // Build .icns using macOS iconutil
  try {
    execSync(`iconutil -c icns "${iconset}" -o "${path.join(outDir, 'icon.icns')}"`, { stdio: 'inherit' });
    console.log('✓ icon.icns built');
  } catch (e) {
    console.log('iconutil not available (non-macOS). PNG icon only.');
  }

  console.log('Done!');
})();
