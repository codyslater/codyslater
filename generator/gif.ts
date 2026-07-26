import { createRequire } from 'node:module';
import type * as GifEnc from 'gifenc';

// Node's ESM/CJS interop (cjs-module-lexer) fails to statically detect gifenc's
// esbuild-bundled named exports (`__export(exports, { name: () => name })` pattern),
// so a plain `import { GIFEncoder, ... } from 'gifenc'` resolves the named bindings
// to `undefined` under plain Node/tsx execution (vitest's own transform masks this).
// Load via createRequire instead, which sees the real CJS exports object.
const require = createRequire(import.meta.url);
const { GIFEncoder, applyPalette, quantize }: typeof GifEnc = require('gifenc');

export function encodeGif(frames: Uint8ClampedArray[], width: number, height: number, fps: number): Uint8Array {
  // sample up to 4 spread frames for the global palette
  const idxs = [0, Math.floor(frames.length / 4), Math.floor(frames.length / 2), Math.floor((3 * frames.length) / 4)]
    .filter((v, i, a) => a.indexOf(v) === i);
  const sample = new Uint8Array(width * height * 4 * idxs.length);
  idxs.forEach((fi, i) => sample.set(frames[fi], i * width * height * 4));
  const palette = quantize(sample, 64, { format: 'rgb444' });

  const gif = GIFEncoder();
  const delay = Math.round(1000 / fps); // gifenc takes ms
  frames.forEach((frame, i) => {
    const index = applyPalette(frame, palette, 'rgb444');
    gif.writeFrame(index, width, height, i === 0 ? { palette, delay, repeat: 0 } : { delay });
  });
  gif.finish();
  return gif.bytes();
}
