import { createRequire } from 'node:module';
import type * as GifEnc from 'gifenc';

// Node's ESM/CJS interop (cjs-module-lexer) fails to statically detect gifenc's
// esbuild-bundled named exports (`__export(exports, { name: () => name })` pattern),
// so a plain `import { GIFEncoder, ... } from 'gifenc'` resolves the named bindings
// to `undefined` under plain Node/tsx execution (vitest's own transform masks this).
// Load via createRequire instead, which sees the real CJS exports object.
const require = createRequire(import.meta.url);
const { GIFEncoder, nearestColorIndex, quantize }: typeof GifEnc = require('gifenc');

/** The encoded colour table: 63 picture colours plus the transparent index
 * that marks "unchanged since the last frame" (§3's 64-entry ceiling). */
export const PICTURE_COLOURS = 63;

export interface Quantized {
  /** Picture colours only, as [r, g, b]; at most PICTURE_COLOURS entries. */
  palette: number[][];
  /** Every frame as indices into `palette`. */
  indexed: Uint8Array[];
}

/** Map every pixel of every frame onto `palette` through ONE cache that lives
 * for the whole encode, keyed by the exact 24-bit colour. A colour's index is
 * therefore a function of that colour and the palette only: the nearest entry
 * by true distance, lowest index on a tie. gifenc's own `applyPalette` keys its
 * per-call cache by a 12-bit bin, so the first pixel of a bin in raster order
 * decided the index for every colour in it, and that changed frame to frame
 * (a static colour flickered between two palette entries). */
export function mapToPalette(frames: Uint8ClampedArray[], palette: number[][]): Uint8Array[] {
  const cache = new Map<number, number>();
  return frames.map(frame => {
    const index = new Uint8Array(frame.length / 4);
    let lastKey = -1, lastIdx = 0;
    for (let i = 0, p = 0; i < index.length; i++, p += 4) {
      const key = (frame[p] << 16) | (frame[p + 1] << 8) | frame[p + 2];
      if (key !== lastKey) {
        let idx = cache.get(key);
        if (idx === undefined) {
          idx = nearestColorIndex(palette, [frame[p], frame[p + 1], frame[p + 2]]);
          cache.set(key, idx);
        }
        lastKey = key;
        lastIdx = idx;
      }
      index[i] = lastIdx;
    }
    return index;
  });
}

/** One global palette from up to 4 spread frames, then every frame mapped onto
 * it with no dithering. Exported so a test can compare the played-back file
 * against exactly what the encoder was asked to show. */
export function quantizeFrames(frames: Uint8ClampedArray[], width: number, height: number): Quantized {
  const idxs = [0, Math.floor(frames.length / 4), Math.floor(frames.length / 2), Math.floor((3 * frames.length) / 4)]
    .filter((v, i, a) => a.indexOf(v) === i);
  const sample = new Uint8Array(width * height * 4 * idxs.length);
  idxs.forEach((fi, i) => sample.set(frames[fi], i * width * height * 4));
  const palette = quantize(sample, PICTURE_COLOURS, { format: 'rgb444' });
  return { palette, indexed: mapToPalette(frames, palette) };
}

/** What a frame stores: its pixel where the picture changed since `prev`, the
 * transparent index where it did not. */
export function diffFrame(prev: Uint8Array, cur: Uint8Array, transparent: number): Uint8Array {
  const out = new Uint8Array(cur.length);
  for (let i = 0; i < cur.length; i++) out[i] = cur[i] === prev[i] ? transparent : cur[i];
  return out;
}

// Inter-frame differencing. The first frame is the whole picture; every later
// frame stores only the pixels that changed and is drawn over the last one
// (disposal 1, "leave in place"). About 1.6 % of pixels change per frame on the
// board, so the long runs of the transparent index compress to almost nothing:
// the pinned configuration measured 6.98 MB as full frames and 0.87 MB this way,
// playing back pixel-identical (gif.test.ts decodes the file to prove it).
export function encodeGif(frames: Uint8ClampedArray[], width: number, height: number, fps: number): Uint8Array {
  const { palette, indexed } = quantizeFrames(frames, width, height);
  const transparentIndex = palette.length;        // one past the picture colours
  const table = [...palette, [0, 0, 0]];

  const gif = GIFEncoder();
  const delay = Math.round(1000 / fps); // gifenc takes ms
  indexed.forEach((index, i) => {
    if (i === 0) {
      gif.writeFrame(index, width, height, { palette: table, delay, repeat: 0, dispose: 1 });
    } else {
      gif.writeFrame(diffFrame(indexed[i - 1], index, transparentIndex), width, height,
        { delay, transparent: true, transparentIndex, dispose: 1 });
    }
  });
  gif.finish();
  return gif.bytes();
}
