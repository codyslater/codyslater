import { createCanvas } from '@napi-rs/canvas';
import fs from 'node:fs';
import { encodeGif } from './gif.js';
import { HEIGHT, WIDTH } from './layout.js';
import { createRenderer } from './render.js';
import {
  DEFAULT_FPS, DEFAULT_OUT, DEFAULT_SECONDS, buildWorld, gateWorld, measureMovingCells,
} from './timeline.js';

const USAGE = 'usage: npm run render -- [--seed YYYYMMDD] [--fps N] [--seconds N] '
  + '[--out FILE.gif] [--contact-sheet FILE.png]';

function die(msg: string): never {
  console.error(`render: ${msg}`);
  console.error(USAGE);
  process.exit(2);
}

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  // A flag given last used to read `undefined` here and, for the numeric ones,
  // become NaN — which built a silently garbage world rather than failing. A
  // flag that swallows the next flag is the same bug wearing a value.
  if (v === undefined || v.startsWith('--')) die(`--${name} needs a value`);
  return v;
}

function intArg(name: string, fallback: number): number {
  const raw = arg(name, String(fallback))!;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) die(`--${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  return n;
}

// The seed is a date (§13.8); `revFromSeed` rejects a non-date downstream.
const seed = intArg('seed', 20260725);
// §13.5 supersedes §5's `--fps 15 --seconds 30`: the pinned configuration is
// T = 288 frames = 24 s at 12 fps (§13.4). The 30 s / 3-generation build
// measured 8.48 MB — over §6's hard gate — which is the measurement that decided
// T = 288.
const fps = intArg('fps', DEFAULT_FPS);
const seconds = intArg('seconds', DEFAULT_SECONDS);
const out = arg('out', DEFAULT_OUT)!;
const sheet = arg('contact-sheet');

const T = fps * seconds;
const t0 = Date.now();
const world = buildWorld(seed, T);
console.log(`world: ladder rung ${world.soup.rung} at candidate ${world.soup.candidate} `
  + `(${world.soup.sims} simulation${world.soup.sims === 1 ? '' : 's'}), body peak ${world.soup.peak} cells, `
  + `${world.flows.length} flows, ${world.events.length} escapes, ${world.takeovers.size} responsive nodes `
  + `— ${((Date.now() - t0) / 1000).toFixed(1)} s`);
const render = createRenderer(world);

const frames: Uint8ClampedArray[] = [];
for (let t = 0; t < T; t++) {
  frames.push(render(t).getContext('2d').getImageData(0, 0, WIDTH, HEIGHT).data);
  if (t % 50 === 0) console.log(`rendered ${t}/${T}`);
}
// §13.5/§13.6's full-loop sweep, run in PRODUCTION and not only in the suite:
// the daily workflow renders whatever §13.8's activity date is, a seed no corpus
// covers. Measured on the frames just rendered, so the gate costs no second
// render pass, and run before the encode so a violating world never reaches
// `out`. A LAST-RESORT (rung 4) pick warns from inside the sweep and passes.
const code = gateWorld(world, measureMovingCells(world, frames));
if (code !== 0) {
  console.error(`${out} NOT written.`);
  process.exit(code);
}
console.log(`invariants: clean over all ${T} frames`);

const bytes = encodeGif(frames, WIDTH, HEIGHT, fps);
fs.writeFileSync(out, bytes);
console.log(`${out}: ${(bytes.length / 1024 / 1024).toFixed(2)} MB, ${T} frames @ ${fps}fps`);

if (sheet) {
  const cols = 5, rows = 3, scale = 0.5;
  const sc = createCanvas(WIDTH * scale * cols, HEIGHT * scale * rows);
  const sctx = sc.getContext('2d');
  for (let i = 0; i < cols * rows; i++) {
    const t = Math.floor((i * T) / (cols * rows));
    sctx.drawImage(render(t), (i % cols) * WIDTH * scale, Math.floor(i / cols) * HEIGHT * scale, WIDTH * scale, HEIGHT * scale);
  }
  fs.writeFileSync(sheet, sc.toBuffer('image/png'));
  console.log(`contact sheet: ${sheet}`);
}
