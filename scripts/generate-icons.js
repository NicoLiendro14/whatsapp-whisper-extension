const sharp = require('sharp');
const path = require('path');

const ICONS_DIR = path.join(__dirname, '..', 'icons');

const svg128 = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  <defs>
    <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#075E54"/>
      <stop offset="100%" style="stop-color:#128C7E"/>
    </linearGradient>
  </defs>
  <circle cx="64" cy="64" r="56" fill="url(#bgGrad)"/>
  <g transform="translate(38, 28)">
    <rect x="16" y="0" width="16" height="36" rx="8" fill="white"/>
    <path d="M8 28 Q8 52 24 52 Q40 52 40 28" fill="none" stroke="white" stroke-width="5" stroke-linecap="round"/>
    <line x1="24" y1="52" x2="24" y2="64" stroke="white" stroke-width="5" stroke-linecap="round"/>
    <line x1="14" y1="64" x2="34" y2="64" stroke="white" stroke-width="5" stroke-linecap="round"/>
  </g>
  <g stroke="#25D366" stroke-width="3" stroke-linecap="round">
    <line x1="96" y1="54" x2="96" y2="74"/>
    <line x1="104" y1="48" x2="104" y2="80"/>
    <line x1="112" y1="56" x2="112" y2="72"/>
  </g>
</svg>`;

const sizes = [16, 32, 48, 128];

async function generate() {
  for (const size of sizes) {
    const output = path.join(ICONS_DIR, `icon${size}.png`);
    const info = await sharp(Buffer.from(svg128))
      .resize(size, size)
      .png()
      .toFile(output);
    console.log(`Generated icon${size}.png (${info.size} bytes)`);
  }
}

generate().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
