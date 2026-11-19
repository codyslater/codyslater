import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeGif } from './gif-decode.js';
import { diffFrame, encodeGif, quantizeFrames } from './gif.js';
import { HEIGHT, WIDTH } from './layout.js';
import { createRenderer } from './render.js';
import { DEFAULT_T, buildWorld } from './timeline.js';

/** The pinned production configuration (§13.4 / §13.6's reference command). */
const PINNED = { seed: 20260724, T: DEFAULT_T, fps: 12 };

let cachedFrames: Uint8ClampedArray[] | undefined;
function pinnedFrames(): Uint8ClampedArray[] {
  if (cachedFrames) return cachedFrames;
  const world = buildWorld(PINNED.seed, PINNED.T);
  const render = createRenderer(world);
  const frames: Uint8ClampedArray[] = [];
  for (let t = 0; t < PINNED.T; t++)
    frames.push(render(t).getContext('2d').getImageData(0, 0, WIDTH, HEIGHT).data);
  cachedFrames = frames;
  return frames;
}

let cached: Uint8Array | undefined;
function pinnedGif(): Uint8Array {
  if (cached) return cached;
  cached = encodeGif(pinnedFrames(), WIDTH, HEIGHT, PINNED.fps);
  return cached;
}

/** A tiny animation with a still background, a moving block, a colour change
 * and one frame identical to its predecessor (an all-unchanged difference). */
function toyFrames(w: number, h: number): Uint8ClampedArray[] {
  const colours = [[200, 40, 40], [40, 200, 40], [40, 40, 200], [220, 220, 40]];
  const frames: Uint8ClampedArray[] = [];
  for (let f = 0; f < 6; f++) {
    const step = f === 3 ? 2 : f > 3 ? f - 1 : f;   // frame 3 repeats frame 2
    const px = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) px.set([16, 16, 16, 255], i * 4);
    for (let y = 2; y < 6; y++) for (let x = 0; x < 4; x++) {
      const c = colours[step % colours.length];
      px.set([c[0], c[1], c[2], 255], (y * w + x + step * 5) * 4);
    }
    frames.push(px);
  }
  return frames;
}

/** Count the pixels where the played-back file and the quantized source frame
 * show different colours. Compared as RGB, not as indices: the file's table has
 * one extra slot (the transparent index) the quantizer's palette does not. */
function playbackMismatches(bytes: Uint8Array, frames: Uint8ClampedArray[], w: number, h: number): number {
  const decoded = decodeGif(bytes);
  const q = quantizeFrames(frames, w, h);
  expect(decoded.canvases).toHaveLength(frames.length);
  let bad = 0;
  for (let f = 0; f < frames.length; f++) {
    const canvas = decoded.canvases[f];
    const want = q.indexed[f];
    for (let i = 0; i < w * h; i++) {
      const a = decoded.palette[canvas[i]];
      const b = q.palette[want[i]];
      if (a[0] !== b[0] || a[1] !== b[1] || a[2] !== b[2]) bad++;
    }
  }
  return bad;
}

/** GIF89a: the logical screen descriptor's packed byte carries the global
 * colour table's size as 2^(N+1) entries. */
function globalPalette(bytes: Uint8Array): { entries: number; distinct: number } {
  expect(Buffer.from(bytes.subarray(0, 6)).toString('latin1')).toBe('GIF89a');
  const packed = bytes[10];
  expect(packed & 0x80).toBeTruthy();   // a global colour table must be present
  const entries = 2 ** ((packed & 7) + 1);
  const seen = new Set<number>();
  for (let i = 0; i < entries; i++) {
    const o = 13 + i * 3;
    seen.add((bytes[o] << 16) | (bytes[o + 1] << 8) | bytes[o + 2]);
  }
  return { entries, distinct: seen.size };
}

describe('encodeGif', () => {
  it('produces a valid looping GIF from real frames', () => {
    const frames = [0, 1, 2].map(() => new Uint8ClampedArray(WIDTH * HEIGHT * 4).fill(20));
    const bytes = encodeGif(frames, WIDTH, HEIGHT, 12);
    expect(Buffer.from(bytes.subarray(0, 6)).toString('latin1')).toBe('GIF89a');
    expect(bytes[bytes.length - 1]).toBe(0x3b);   // trailer
    expect(Buffer.from(bytes).includes(Buffer.from('NETSCAPE2.0', 'latin1'))).toBe(true);
  });

  it('§6: the loop flag is INFINITE, not a finite repeat count', () => {
    // "gifenc with the fixed <= 64-colour palette from §3, no dithering,
    // INFINITE LOOP FLAG." The Netscape application extension carries the loop
    // count in the two bytes after its `03 01` sub-block header; 0 means forever.
    const frames = [0, 1, 2].map(() => new Uint8ClampedArray(WIDTH * HEIGHT * 4).fill(20));
    const bytes = Buffer.from(encodeGif(frames, WIDTH, HEIGHT, 12));
    const at = bytes.indexOf(Buffer.from('NETSCAPE2.0', 'latin1'));
    expect(at).toBeGreaterThan(0);
    expect(bytes[at + 11]).toBe(0x03);          // sub-block length
    expect(bytes[at + 12]).toBe(0x01);          // sub-block id
    expect(bytes.readUInt16LE(at + 13)).toBe(0); // loop count 0 = forever
  });
});

describe('§6 / §13.5 the size gate (real, not skipped)', () => {
  it('the pinned configuration encodes inside the 8 MB hard gate and the 1.5 MB differenced target', () => {
    const mb = pinnedGif().length / 1024 / 1024;
    console.log(`pinned GIF (seed ${PINNED.seed}, T=${PINNED.T} @ ${PINNED.fps}fps): ${mb.toFixed(2)} MB`);
    expect(mb).toBeLessThanOrEqual(8);      // §6's hard gate — CI fails above it
    // Full frames measured 6.98 MB for this configuration; storing only the
    // changed pixels measured 0.87 MB. A regression to full frames lands far
    // above this line.
    expect(mb).toBeLessThanOrEqual(1.5);
  });

  it('§13.2: the encoded palette stays inside §3\'s 64 colours', () => {
    const { entries, distinct } = globalPalette(pinnedGif());
    console.log(`encoded global colour table: ${entries} entries, ${distinct} distinct triples`);
    expect(entries).toBeLessThanOrEqual(64);
    expect(distinct).toBeLessThanOrEqual(64);
  });
});

describe('inter-frame differencing', () => {
  it('diffFrame keeps a changed pixel and blanks an unchanged one', () => {
    const prev = Uint8Array.from([1, 2, 3, 4, 5]);
    const cur = Uint8Array.from([1, 9, 3, 0, 5]);
    expect(Array.from(diffFrame(prev, cur, 63))).toEqual([63, 9, 63, 0, 63]);
  });

  it('a small animation plays back to exactly its quantized frames', () => {
    const w = 40, h = 12;
    const frames = toyFrames(w, h);
    expect(playbackMismatches(encodeGif(frames, w, h, 12), frames, w, h)).toBe(0);
  });

  it('every frame after the first is a difference left in place over the last', () => {
    const w = 40, h = 12;
    const { controls, loop } = decodeGif(encodeGif(toyFrames(w, h), w, h, 12));
    expect(loop).toBe(0);
    expect(controls[0].transparent).toBeNull();   // the first frame is the whole picture
    for (const c of controls) expect(c.disposal).toBe(1);
    for (const c of controls.slice(1)) expect(c.transparent).not.toBeNull();
    for (const c of controls) expect(c.delayCs).toBe(8);   // 12 fps -> 83 ms -> 8 cs
  });

  it('the pinned loop plays back pixel-identical to its quantized frames', () => {
    expect(playbackMismatches(pinnedGif(), pinnedFrames(), WIDTH, HEIGHT)).toBe(0);
  });
});

describe('§5 / §9.1 the committed reference render', () => {
  // §5: "Same seed + same options => byte-identical GIF." The reference asset in
  // the spec's `assets/` directory is what §13 is written against, so this is the
  // one determinism check with an EXTERNAL fixture — the others compare a render
  // to another render in the same process and cannot catch a change that moves
  // every pixel consistently.
  //
  // The asset is matched by PATTERN, not by a hard-coded name: §13.6 names it for
  // the commit that produces it, so re-pinning it renames the file. Exactly one
  // must exist, which is what keeps a stale reference from lingering beside a new
  // one and quietly passing.
  const assetDir = new URL('../assets/', import.meta.url);

  it('is the byte-identical output of the pinned configuration', () => {
    const names = readdirSync(assetDir).filter(f => /^banner-reference-[0-9a-f]{7}\.gif$/.test(f));
    expect(names, 'exactly one banner-reference-<commit>.gif must be committed').toHaveLength(1);
    const committed = readFileSync(new URL(names[0], assetDir));
    const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
    console.log(`reference asset ${names[0]}: ${committed.length} bytes, sha256 ${sha(committed)}`);
    expect(committed.length).toBe(pinnedGif().length);
    expect(sha(pinnedGif())).toBe(sha(committed));
  });
});
