import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { encodeGif } from './gif.js';
import { HEIGHT, WIDTH } from './layout.js';
import { createRenderer } from './render.js';
import { DEFAULT_T, buildWorld } from './timeline.js';

/** The pinned production configuration (§13.4 / §13.6's reference command). */
const PINNED = { seed: 20260724, T: DEFAULT_T, fps: 12 };

let cached: Uint8Array | undefined;
function pinnedGif(): Uint8Array {
  if (cached) return cached;
  const world = buildWorld(PINNED.seed, PINNED.T);
  const render = createRenderer(world);
  const frames: Uint8ClampedArray[] = [];
  for (let t = 0; t < PINNED.T; t++)
    frames.push(render(t).getContext('2d').getImageData(0, 0, WIDTH, HEIGHT).data);
  cached = encodeGif(frames, WIDTH, HEIGHT, PINNED.fps);
  return cached;
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
  it('the pinned configuration encodes inside the 8 MB hard gate and the 7.5 MB target', () => {
    const mb = pinnedGif().length / 1024 / 1024;
    console.log(`pinned GIF (seed ${PINNED.seed}, T=${PINNED.T} @ ${PINNED.fps}fps): ${mb.toFixed(2)} MB`);
    expect(mb).toBeLessThanOrEqual(8);      // §6's hard gate — CI fails above it
    expect(mb).toBeLessThanOrEqual(7.5);    // §13.5's working target for this config
  });

  it('§13.2: the encoded palette stays inside §3\'s 64 colours', () => {
    const { entries, distinct } = globalPalette(pinnedGif());
    console.log(`encoded global colour table: ${entries} entries, ${distinct} distinct triples`);
    expect(entries).toBeLessThanOrEqual(64);
    expect(distinct).toBeLessThanOrEqual(64);
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
