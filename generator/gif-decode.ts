// A minimal GIF89a decoder, used by the tests to check the ENCODED artifact
// rather than the encoder's inputs: with inter-frame differencing a frame's
// stored pixels are not its picture, so the only honest check that the file
// shows the right thing is to play it back the way a browser does.
//
// Scope: what `encodeGif` writes and no more. Global colour table, full-canvas
// frames, graphic control extensions with a transparent index, disposal
// "leave in place" (1) or unspecified (0). Anything else throws.

export interface DecodedGif {
  width: number;
  height: number;
  /** Global colour table as [r, g, b] triples. */
  palette: number[][];
  /** The composited canvas after each frame, as global-palette indices. */
  canvases: Uint8Array[];
  /** Per frame: the graphic control extension's fields. */
  controls: { disposal: number; transparent: number | null; delayCs: number }[];
  /** Netscape loop count (0 = forever), or null when absent. */
  loop: number | null;
}

function lzwDecode(minCodeSize: number, data: Uint8Array, pixelCount: number): Uint8Array {
  const out = new Uint8Array(pixelCount);
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  // The dictionary as parallel arrays: each code is (prefix code, last byte).
  const prefix = new Int32Array(4096);
  const suffix = new Uint8Array(4096);
  const stack = new Uint8Array(4097);
  let codeSize = minCodeSize + 1;
  let next = eoi + 1;
  let prev = -1;
  let first = 0;
  let bits = 0, nbits = 0, pos = 0, o = 0;
  for (let i = 0; i < clear; i++) { prefix[i] = -1; suffix[i] = i; }

  while (o < pixelCount) {
    while (nbits < codeSize) {
      if (pos >= data.length) throw new Error('gif-decode: LZW stream ended early');
      bits |= data[pos++] << nbits;
      nbits += 8;
    }
    const code = bits & ((1 << codeSize) - 1);
    bits >>>= codeSize;
    nbits -= codeSize;

    if (code === clear) { codeSize = minCodeSize + 1; next = eoi + 1; prev = -1; continue; }
    if (code === eoi) break;

    let cur = code;
    let sp = 0;
    if (prev === -1) {
      if (code >= clear) throw new Error('gif-decode: first code after clear is not a literal');
      out[o++] = code;
      first = code;
      prev = code;
      continue;
    }
    if (code >= next) {
      if (code !== next) throw new Error(`gif-decode: code ${code} beyond dictionary ${next}`);
      stack[sp++] = first;   // the KwKwK case
      cur = prev;
    }
    while (cur >= clear) { stack[sp++] = suffix[cur]; cur = prefix[cur]; }
    first = suffix[cur];
    stack[sp++] = first;
    while (sp > 0 && o < pixelCount) out[o++] = stack[--sp];
    if (next < 4096) {
      prefix[next] = prev;
      suffix[next] = first;
      next++;
      if (next === (1 << codeSize) && codeSize < 12) codeSize++;
    }
    prev = code;
  }
  if (o !== pixelCount) throw new Error(`gif-decode: decoded ${o} of ${pixelCount} pixels`);
  return out;
}

export function decodeGif(bytes: Uint8Array): DecodedGif {
  const sig = String.fromCharCode(...bytes.subarray(0, 6));
  if (sig !== 'GIF89a') throw new Error(`gif-decode: not GIF89a (${sig})`);
  const width = bytes[6] | (bytes[7] << 8);
  const height = bytes[8] | (bytes[9] << 8);
  const packed = bytes[10];
  if (!(packed & 0x80)) throw new Error('gif-decode: no global colour table');
  const entries = 2 ** ((packed & 7) + 1);
  const palette: number[][] = [];
  let p = 13;
  for (let i = 0; i < entries; i++, p += 3) palette.push([bytes[p], bytes[p + 1], bytes[p + 2]]);

  const readSubBlocks = (): Uint8Array => {
    const parts: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const len = bytes[p++];
      if (len === 0) break;
      parts.push(bytes.subarray(p, p + len));
      total += len;
      p += len;
    }
    const joined = new Uint8Array(total);
    let at = 0;
    for (const part of parts) { joined.set(part, at); at += part.length; }
    return joined;
  };

  const canvases: Uint8Array[] = [];
  const controls: DecodedGif['controls'] = [];
  let loop: number | null = null;
  let pending = { disposal: 0, transparent: null as number | null, delayCs: 0 };
  let canvas = new Uint8Array(width * height);

  for (;;) {
    const block = bytes[p++];
    if (block === 0x3b) break;                     // trailer
    if (block === 0x21) {                          // extension
      const label = bytes[p++];
      if (label === 0xf9) {                        // graphic control
        if (bytes[p] !== 4) throw new Error('gif-decode: bad graphic control size');
        const flags = bytes[p + 1];
        pending = {
          disposal: (flags >> 2) & 7,
          transparent: flags & 1 ? bytes[p + 4] : null,
          delayCs: bytes[p + 2] | (bytes[p + 3] << 8),
        };
        p += 5;
        if (bytes[p++] !== 0) throw new Error('gif-decode: graphic control not terminated');
      } else if (label === 0xff) {                 // application (Netscape loop)
        const len = bytes[p++];
        const id = String.fromCharCode(...bytes.subarray(p, p + len));
        p += len;
        const data = readSubBlocks();
        if (id === 'NETSCAPE2.0' && data[0] === 1) loop = data[1] | (data[2] << 8);
      } else {
        readSubBlocks();
      }
      continue;
    }
    if (block !== 0x2c) throw new Error(`gif-decode: unexpected block 0x${block.toString(16)} at ${p - 1}`);
    const x = bytes[p] | (bytes[p + 1] << 8);
    const y = bytes[p + 2] | (bytes[p + 3] << 8);
    const w = bytes[p + 4] | (bytes[p + 5] << 8);
    const h = bytes[p + 6] | (bytes[p + 7] << 8);
    const ipacked = bytes[p + 8];
    p += 9;
    if (x !== 0 || y !== 0 || w !== width || h !== height) throw new Error('gif-decode: sub-rectangle frames unsupported');
    if (ipacked & 0x80) throw new Error('gif-decode: local colour tables unsupported');
    if (ipacked & 0x40) throw new Error('gif-decode: interlaced frames unsupported');
    if (pending.disposal > 1) throw new Error(`gif-decode: disposal ${pending.disposal} unsupported`);
    const minCodeSize = bytes[p++];
    const pixels = lzwDecode(minCodeSize, readSubBlocks(), w * h);
    canvas = new Uint8Array(canvas);               // each frame gets its own copy
    const t = pending.transparent;
    for (let i = 0; i < pixels.length; i++) if (pixels[i] !== t) canvas[i] = pixels[i];
    canvases.push(canvas);
    controls.push(pending);
    pending = { disposal: 0, transparent: null, delayCs: 0 };
  }
  return { width, height, palette, canvases, controls, loop };
}
