// Generate PWA icons (192, 512, maskable-512, apple-touch 180) from a
// simple programmatic design: dark rounded square + lightning bolt.
// Run once: node scripts/gen-icons.mjs  (from packages/web)

import { createCanvas } from 'canvas';
import { mkdirSync, writeFileSync } from 'node:fs';

const OUT = 'public';

function drawIcon(size, { maskable = false, apple = false } = {}) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');

  // Background
  ctx.fillStyle = '#1a1a18';
  if (maskable) {
    ctx.fillRect(0, 0, size, size); // full-bleed for maskable
  } else if (apple) {
    ctx.fillRect(0, 0, size, size); // iOS applies its own mask
  } else {
    const r = size * 0.22;
    ctx.beginPath();
    ctx.roundRect(0, 0, size, size, r);
    ctx.fill();
  }

  // Lightning bolt (the airelay ⚡ motif)
  ctx.fillStyle = apple ? '#ffffff' : '#f0ede8';
  const s = size / 100;
  ctx.beginPath();
  ctx.moveTo(56 * s, 14 * s);
  ctx.lineTo(30 * s, 56 * s);
  ctx.lineTo(46 * s, 56 * s);
  ctx.lineTo(40 * s, 86 * s);
  ctx.lineTo(70 * s, 42 * s);
  ctx.lineTo(52 * s, 42 * s);
  ctx.closePath();
  ctx.fill();

  return canvas.toBuffer('image/png');
}

mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/icon-192.png`, drawIcon(192));
writeFileSync(`${OUT}/icon-512.png`, drawIcon(512));
writeFileSync(`${OUT}/icon-maskable-512.png`, drawIcon(512, { maskable: true }));
writeFileSync(`${OUT}/apple-touch-icon.png`, drawIcon(180, { apple: true }));
console.log('icons written to', OUT);
