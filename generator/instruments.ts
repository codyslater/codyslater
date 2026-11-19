import type { Rect } from './types.js';

// ---------------------------------------------------------------------------
// instruments.ts — four small instruments on the board, as PURE DATA (no canvas, no world):
//
//   SCOPE        a three-row raster the board draws from the neurons' firings, scrolling right to left
//   REPRESSILATOR three status lights running the Elowitz-Leibler 2000 gene circuit (levels only)
//   RNA          a codon stream down each memory slot: the owner's name, start to stop
//   STRIP        fourteen days of contribution levels, the last light pulsing
//
// Everything is a pure function of the frame; nothing keeps per-frame state, every period divides 288, and
// every brightness change is a discrete step. A renderer paints what these return, dynamic cells over static.
// ---------------------------------------------------------------------------

export interface InstrumentCell { x: number; y: number; color: string }

const mod = (a: number, n: number): number => ((a % n) + n) % n;
const hexOf = (r: number, g: number, b: number): string =>
  `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
const rgb = (hex: string): [number, number, number] => {
  const n = parseInt(hex.slice(1), 16);
  return [n >> 16, (n >> 8) & 255, n & 255];
};
/** `hex` at alpha `a` over `bg` (the same arithmetic as render.mixOnBg, which this module does not import) */
function mix(hex: string, a: number, bg: string): string {
  const [r, g, b] = rgb(hex), [br, bgc, bb] = rgb(bg);
  const m = (c: number, d: number): number => Math.round(c * a + d * (1 - a));
  return hexOf(m(r, br), m(g, bgc), m(b, bb));
}

// ---------------------------------------------------------------- colours
const BODY = '#111111', BEZEL = '#2a2a2a', PIN = '#888888';
/** level 0..4: unlit, then four greens rising to the board's neural green. At 4 bits per channel (what the GIF
 * encoder keeps) they read (0,1,0) (1,4,1) (1,8,1) (2,12,1) (3,15,1): distinct, and apart from #0a0a0a (0,0,0)
 * and #111111 (1,1,1). */
export const STRIP_GREENS: readonly [string, string, string, string, string] =
  ['#0e1a0e', '#164a14', '#1f8a1a', '#2fc417', '#39ff14'];
/** Every colour this module emits EXCEPT the caller-supplied accents (and the scope's baseline tints of them,
 * and the RNA base colours, which are the caller's). 3 + 5 = 8. */
export const INSTRUMENT_COLOURS: readonly string[] = [BODY, BEZEL, PIN, ...STRIP_GREENS];

// ---------------------------------------------------------------- 1. spike scope
export const SCOPE: Rect = { x: 82, y: 66, w: 50, h: 11 };
export const SCOPE_COLS = 46;
export const SCOPE_FRAMES_PER_COL = 2;
const SCOPE_ROWS = 7;
const SCOPE_DOT_X = SCOPE.x + 2, SCOPE_DOT_Y = SCOPE.y + 2;
const BASELINE_ALPHA = 0.22;
/** neuron s keeps its baseline on dot row 2s + 1; a tick is that cell and the one above it */
const baselineRow = (s: number): number => 2 * s + 1;

/** The resting display: body, bezel, corner pins, padding, and the three dim baselines. */
export function scopeStaticCells(accents: readonly [string, string, string]): InstrumentCell[] {
  const dim = accents.map(a => mix(a, BASELINE_ALPHA, BODY));
  const out: InstrumentCell[] = [];
  for (let j = 0; j < SCOPE.h; j++)
    for (let i = 0; i < SCOPE.w; i++) {
      const edgeX = i === 0 || i === SCOPE.w - 1, edgeY = j === 0 || j === SCOPE.h - 1;
      let color = BODY;
      if (edgeX && edgeY) color = PIN;
      else if (edgeX || edgeY) color = BEZEL;
      else if (i >= 2 && i < 2 + SCOPE_COLS && j >= 2 && j < 2 + SCOPE_ROWS) {
        const row = j - 2;
        for (let s = 0; s < 3; s++) if (row === baselineRow(s)) color = dim[s];
      }
      out.push({ x: SCOPE.x + i, y: SCOPE.y + j, color });
    }
  return out;
}

/** The ticks alone: a firing of neuron s at frame tf sits at column COLS - 1 - floor(age / 2) for ages
 * 0 .. COLS * 2 - 1, entering at the right edge on its frame and leaving after 92 frames. */
export function scopeCellsAt(
  firings: readonly { soma: number; t: number }[], accents: readonly [string, string, string], t: number, T: number,
): InstrumentCell[] {
  const seen = new Map<string, InstrumentCell>();
  for (const f of firings) {
    if (f.soma < 0 || f.soma > 2) continue;
    const age = mod(t - f.t, T);
    if (age >= SCOPE_COLS * SCOPE_FRAMES_PER_COL) continue;
    const x = SCOPE_DOT_X + SCOPE_COLS - 1 - Math.floor(age / SCOPE_FRAMES_PER_COL);
    for (const row of [baselineRow(f.soma) - 1, baselineRow(f.soma)]) {
      const y = SCOPE_DOT_Y + row;
      seen.set(`${x},${y}`, { x, y, color: accents[f.soma] });
    }
  }
  return [...seen.values()];
}

// ---------------------------------------------------------------- 2. repressilator
export const REPRESSILATOR_PERIOD = 96;
export const REPRESSILATOR_LEVELS = 5;

// Elowitz & Leibler 2000, dimensionless: dm_i/dt = -m_i + alpha / (1 + p_j^n) + alpha0, dp_i/dt = -beta (p_i - m_i),
// with j the repressor of i. State: m_A m_B m_C p_A p_B p_C. A is repressed by C, B by A, C by B.
const ALPHA = 216, ALPHA0 = 0.216, BETA = 5;   // n = 2
const REPRESSOR = [2, 0, 1];

function deriv(s: Float64Array, d: Float64Array): void {
  for (let i = 0; i < 3; i++) {
    const p = s[3 + REPRESSOR[i]];
    d[i] = -s[i] + ALPHA / (1 + p * p) + ALPHA0;
    d[3 + i] = -BETA * (s[3 + i] - s[i]);
  }
}

/** One RK4 step in place. `k` is 4 derivative buffers plus a stage buffer, preallocated by the caller. */
function rk4(s: Float64Array, h: number, k: Float64Array[]): void {
  const [k1, k2, k3, k4, tmp] = k;
  deriv(s, k1);
  for (let i = 0; i < 6; i++) tmp[i] = s[i] + 0.5 * h * k1[i];
  deriv(tmp, k2);
  for (let i = 0; i < 6; i++) tmp[i] = s[i] + 0.5 * h * k2[i];
  deriv(tmp, k3);
  for (let i = 0; i < 6; i++) tmp[i] = s[i] + h * k3[i];
  deriv(tmp, k4);
  for (let i = 0; i < 6; i++) s[i] += (h / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]);
}

const ODE_H = 0.005, ODE_TRANSIENT_STEPS = 80000, ODE_RECORD_STEPS = 60000;
const RESAMPLE_N = REPRESSILATOR_PERIOD * 25;   // 25 fine samples per frame, so frames are exact grid points

/** The ODE's own period (dimensionless time units), measured before resampling to 96 frames. */
export let REPRESSILATOR_ODE_PERIOD = 0;

const LEVEL_TABLE: [number, number, number][] = (() => {
  const s = Float64Array.from([1, 2, 3, 5, 10, 20]);   // asymmetric start
  const k = Array.from({ length: 5 }, () => new Float64Array(6));
  for (let i = 0; i < ODE_TRANSIENT_STEPS; i++) rk4(s, ODE_H, k);   // t = 400: well onto the limit cycle
  const rec = [new Float64Array(ODE_RECORD_STEPS + 1), new Float64Array(ODE_RECORD_STEPS + 1), new Float64Array(ODE_RECORD_STEPS + 1)];
  for (let i = 0; i <= ODE_RECORD_STEPS; i++) {
    for (let g = 0; g < 3; g++) rec[g][i] = s[3 + g];
    rk4(s, ODE_H, k);
  }
  const mean = rec[0].reduce((a, b) => a + b, 0) / rec[0].length;
  const cross: number[] = [];   // upward crossings of the mean of p_A, in step units, linearly interpolated
  for (let i = 1; i <= ODE_RECORD_STEPS; i++)
    if (rec[0][i - 1] < mean && rec[0][i] >= mean)
      cross.push(i - 1 + (mean - rec[0][i - 1]) / (rec[0][i] - rec[0][i - 1]));
  if (cross.length < 4) throw new Error('repressilator: no limit cycle found');
  const period = (cross[cross.length - 1] - cross[1]) / (cross.length - 2);   // steps per cycle
  REPRESSILATOR_ODE_PERIOD = period * ODE_H;
  const at = (g: number, pos: number): number => {   // linear interpolation, in step units
    const i = Math.min(Math.floor(pos), ODE_RECORD_STEPS - 1), f = pos - i;
    return rec[g][i] * (1 - f) + rec[g][i + 1] * f;
  };
  // one cycle from the second crossing, resampled finely, rotated so p_A peaks at sample 0
  const fine = [0, 1, 2].map(g => Float64Array.from({ length: RESAMPLE_N }, (_, j) => at(g, cross[1] + (j / RESAMPLE_N) * period)));
  let peak = 0;
  for (let j = 1; j < RESAMPLE_N; j++) if (fine[0][j] > fine[0][peak]) peak = j;
  const step = RESAMPLE_N / REPRESSILATOR_PERIOD;
  const frames = fine.map(f => Float64Array.from({ length: REPRESSILATOR_PERIOD }, (_, t) => f[(peak + t * step) % RESAMPLE_N]));
  const lv = frames.map(f => {
    let lo = Infinity, hi = -Infinity;
    for (const v of f) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    return Array.from(f, v => Math.min(REPRESSILATOR_LEVELS - 1, Math.floor(((v - lo) / (hi - lo)) * REPRESSILATOR_LEVELS)));
  });
  return Array.from({ length: REPRESSILATOR_PERIOD }, (_, t) => [lv[0][t], lv[1][t], lv[2][t]] as [number, number, number]);
})();

/** Level 0..4 of proteins A, B, C at frame t (period 96). */
export function repressilatorLevelsAt(t: number): [number, number, number] {
  const row = LEVEL_TABLE[mod(Math.floor(t), REPRESSILATOR_PERIOD)];
  return [row[0], row[1], row[2]];
}

// ---------------------------------------------------------------- 3. RNA stream
/** AUG UGC UAG GAC UAC UCU CUG GCU ACC GAG CGU UAA: M C O(pyrrolysine, UAG) D Y S L A T E R, stop. */
export const RNA_SEQUENCE = 'AUGUGCUAGGACUACUCUCUGGCUACCGAGCGUUAA';
export const RNA_FRAMES_PER_BASE = 4;
const RNA_SLOT_OFFSET = 9;

/** Every base cell of every slot: down the centre column, rows y + 1 .. y + h - 2, flowing downward. */
export function rnaCellsAt(
  slots: readonly Rect[], baseColours: Readonly<Record<'A' | 'U' | 'G' | 'C', string>>, t: number,
): InstrumentCell[] {
  const n = RNA_SEQUENCE.length, shift = Math.floor(t / RNA_FRAMES_PER_BASE);
  const out: InstrumentCell[] = [];
  slots.forEach((s, k) => {
    const x = s.x + Math.floor(s.w / 2);
    for (let r = 1; r <= s.h - 2; r++) {
      const base = RNA_SEQUENCE[mod(k * RNA_SLOT_OFFSET + r - shift, n)] as 'A' | 'U' | 'G' | 'C';
      out.push({ x, y: s.y + r, color: baseColours[base] });
    }
  });
  return out;
}

// ---------------------------------------------------------------- 4. activity strip
export const STRIP: Rect = { x: 137, y: 70, w: 41, h: 2 };
const STRIP_LIGHTS = 14, STRIP_PULSE_PERIOD = 48, STRIP_PULSE_FRAMES = 6;

function checkLevels(levels: readonly number[]): void {
  if (levels.length !== STRIP_LIGHTS) throw new Error(`strip: expected ${STRIP_LIGHTS} levels, got ${levels.length}`);
  for (const l of levels)
    if (!Number.isInteger(l) || l < 0 || l > 4) throw new Error(`strip: level ${l} outside 0..4`);
}
const lightCells = (i: number, color: string): InstrumentCell[] => {
  const x0 = STRIP.x + 3 * i;
  return [0, 1].flatMap(dy => [0, 1].map(dx => ({ x: x0 + dx, y: STRIP.y + dy, color })));
};

/** The fourteen lights at rest, oldest first (leftmost): each 2 x 2 cells with a 1-cell gap. */
export function stripStaticCells(levels: readonly number[]): InstrumentCell[] {
  checkLevels(levels);
  return levels.flatMap((l, i) => lightCells(i, STRIP_GREENS[l]));
}

/** Today's light (the last) shows one level brighter for 6 frames in every 48; level 4 never pulses. */
export function stripCellsAt(levels: readonly number[], t: number): InstrumentCell[] {
  checkLevels(levels);
  const last = levels[STRIP_LIGHTS - 1];
  if (last >= 4 || mod(t, STRIP_PULSE_PERIOD) >= STRIP_PULSE_FRAMES) return [];
  return lightCells(STRIP_LIGHTS - 1, STRIP_GREENS[last + 1]);
}
