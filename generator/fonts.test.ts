import { createCanvas } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import { registerFonts } from './fonts.js';

describe('fonts', () => {
  it('registers JetBrains Mono and measures text', () => {
    registerFonts();
    const ctx = createCanvas(100, 40).getContext('2d');
    ctx.font = 'bold 28px "JetBrains Mono"';
    const w = ctx.measureText('cody_slater').width;
    expect(w).toBeGreaterThan(100); // monospace 11 chars at 28px ≈ 185px
  });
});
