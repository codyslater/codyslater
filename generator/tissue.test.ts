import { describe, expect, it } from 'vitest';
import { ACCENT_LIST, FINGERS, GRID_W, VOID_BG } from './layout.js';
import { mulberry32, shuffled } from './rng.js';
import { buildWorld } from './timeline.js';
import {
  CONE_COLOUR, DENDRITE_COLOUR, INPUT_FINGERS, RECORD_FINGER, TISSUE_COLOURS, buildTissue, tissueCellsAt,
  type Tissue, type TissueCell,
} from './tissue.js';
import type { Cell, EscapeEvent, World } from './types.js';

const T = 288;
const SEEDS = [20260724, 20260101, 20261111];
const BUDGET = 110;
const WHITE = '#ffffff';

// Worlds are heavy: build each of the three seeds once, lazily.
const worlds = new Map<number, World>();
const worldOf = (seed: number): World => {
  if (!worlds.has(seed)) worlds.set(seed, buildWorld(seed, T));
  return worlds.get(seed)!;
};
const tissues = new Map<number, Tissue>();
const tissueOf = (seed: number): Tissue => {
  if (!tissues.has(seed)) { const w = worldOf(seed); tissues.set(seed, buildTissue(seed, w.events, w.accents, T)); }
  return tissues.get(seed)!;
};

/** Cheap stand-ins for a world: one escape per finger at shuffled frames, like the real timeline
 * (checked above: 9 events, one per finger), so the rhythm rules can be hit with many more seeds. */
function synth(seed: number): { events: EscapeEvent[]; accents: string[] } {
  const r = mulberry32(seed * 7919 + 13);
  const fingers = shuffled(r, FINGERS.map((_, i) => i));
  const events = fingers.map(finger => ({ frame: Math.floor(r() * T), finger, color: '#fff' }))
    .sort((a, b) => a.frame - b.frame);
  return { events, accents: shuffled(r, ACCENT_LIST) };
}
const SYNTH_SEEDS = Array.from({ length: 60 }, (_, i) => 1000 + i * 37);
const synthCache = new Map<number, Tissue>();
const synthTissue = (seed: number): Tissue => {
  if (!synthCache.has(seed)) { const s = synth(seed); synthCache.set(seed, buildTissue(seed, s.events, s.accents, T)); }
  return synthCache.get(seed)!;
};

const key = (c: Cell): number => c.y * GRID_W + c.x;
const mod = (a: number, n: number): number => ((a % n) + n) % n;
const cheb = (a: Cell, b: Cell): number => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
const reduce4 = (hex: string): string => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) >> 4).join(',');
const isContact = (t: Tissue, c: Cell): boolean =>
  t.neurites.some(n => n.contact?.some(q => q.x === c.x && q.y === c.y));

/** Longest run of identical steps, in cells. */
function straightRun(p: Cell[]): number {
  let best = 1, run = 1, last = '';
  for (let i = 1; i < p.length; i++) {
    const d = `${p[i].x - p[i - 1].x},${p[i].y - p[i - 1].y}`;
    if (d === last) run++; else { run = 1; last = d; }
    best = Math.max(best, run + 1);
  }
  return best;
}
function connected8(cells: Cell[]): boolean {
  if (!cells.length) return false;
  const left = new Map(cells.map(c => [key(c), c]));
  const stack = [cells[0]];
  left.delete(key(cells[0]));
  while (stack.length) {
    const c = stack.pop()!;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const k = (c.y + dy) * GRID_W + c.x + dx;
      const n = left.get(k);
      if (n) { left.delete(k); stack.push(n); }
    }
  }
  return left.size === 0;
}

describe('tissue: determinism and frozen anatomy', () => {
  it('is deterministic: same inputs, deep-equal output', () => {
    const w = worldOf(20260724);
    const a = buildTissue(20260724, w.events, w.accents, T);
    const b = buildTissue(20260724, w.events, w.accents, T);
    expect(a).toEqual(b);
    for (const t of [0, 5, 100, 287]) expect(tissueCellsAt(a, t)).toEqual(tissueCellsAt(b, t));
  });

  it('the anatomy does not depend on the seed', () => {
    const positions = (t: Tissue): number[] => t.staticCells.map(key).sort((x, y) => x - y);
    const ref = tissueOf(SEEDS[0]);
    for (const s of SEEDS.slice(1)) {
      const t = tissueOf(s);
      expect(positions(t)).toEqual(positions(ref));
      expect(t.somas.map(q => [q.cx, q.cy])).toEqual(ref.somas.map(q => [q.cx, q.cy]));
      expect(t.neurites.map(n => n.cells)).toEqual(ref.neurites.map(n => n.cells));
    }
    // ... including for the synthetic seeds
    const p0 = positions(ref);
    for (const s of SYNTH_SEEDS.slice(0, 10)) expect(positions(synthTissue(s))).toEqual(p0);
  });

  it('the somas wear three different accents of the world, and the colours follow them', () => {
    const seen = new Set<string>();
    for (const s of SEEDS) {
      const t = tissueOf(s), accents = worldOf(s).accents;
      const worn = t.somas.map(q => q.accent);
      expect(new Set(worn).size).toBe(3);
      for (const a of worn) expect(accents).toContain(a);
      worn.forEach(a => seen.add(a));
    }
    for (const s of SYNTH_SEEDS.slice(0, 20)) synthTissue(s).somas.forEach(q => seen.add(q.accent));
    expect(seen.size).toBeGreaterThan(3);   // the seed really varies which accents
  });

  it('seeds change the schedule, not just the accents', () => {
    const sig = (t: Tissue): string => JSON.stringify([t.firings, t.recordings]);
    expect(new Set(SEEDS.map(s => sig(tissueOf(s)))).size).toBe(3);
  });
});

describe('tissue: bounds and colours', () => {
  const allCells = (t: Tissue): TissueCell[] => {
    const out = [...t.staticCells];
    for (let f = 0; f < T; f++) out.push(...tissueCellsAt(t, f));
    return out;
  };

  it.each(SEEDS)('every cell sits in the void margins, only contacts reach the connector (seed %i)', seed => {
    const t = tissueOf(seed);
    for (const c of allCells(t)) {
      if (isContact(t, c)) { expect(c.x).toBeGreaterThanOrEqual(231); expect(c.x).toBeLessThanOrEqual(232); continue; }
      expect(c.x).toBeGreaterThanOrEqual(232);
      expect(c.x).toBeLessThanOrEqual(297);
      expect(c.y).toBeGreaterThanOrEqual(2);
      expect(c.y).toBeLessThanOrEqual(77);
    }
    // nothing at x <= 230 at all (the board), and the somas are inside the margins too
    expect(allCells(t).every(c => c.x > 230)).toBe(true);
    for (const q of t.somas) for (const c of q.cells) {
      expect(c.x).toBeGreaterThanOrEqual(232); expect(c.y).toBeGreaterThanOrEqual(2); expect(c.y).toBeLessThanOrEqual(77);
    }
  });

  it('TISSUE_COLOURS has at most 16 entries, distinct and visible after rgb444', () => {
    expect(TISSUE_COLOURS.length).toBeLessThanOrEqual(16);
    expect(new Set(TISSUE_COLOURS).size).toBe(TISSUE_COLOURS.length);
    const reduced = TISSUE_COLOURS.map(reduce4);
    expect(new Set(reduced).size).toBe(reduced.length);
    for (const bg of [VOID_BG, '#0a0a0a']) expect(reduced).not.toContain(reduce4(bg));
    for (const c of TISSUE_COLOURS) expect(c).toMatch(/^#[0-9a-f]{6}$/);
  });

  it.each(SEEDS)('every emitted colour is in TISSUE_COLOURS (seed %i)', seed => {
    const used = new Set(allCells(tissueOf(seed)).map(c => c.color));
    for (const c of used) expect(TISSUE_COLOURS).toContain(c);
    expect(used.has(WHITE)).toBe(true);
  });

  it('holds for the synthetic seeds too (every accent permutation)', () => {
    for (const s of SYNTH_SEEDS.slice(0, 25)) {
      for (const c of allCells(synthTissue(s))) expect(TISSUE_COLOURS).toContain(c.color);
    }
  });
});

describe('tissue: anatomy', () => {
  const t = tissueOf(SEEDS[0]);

  it('has three 7x7 somas, top / middle / bottom, near the connector', () => {
    expect(t.somas).toHaveLength(3);
    const [a, b, c] = t.somas;
    expect(a.cy).toBeLessThan(b.cy);
    expect(b.cy).toBeLessThan(c.cy);
    for (const q of t.somas) {
      expect(q.cx).toBeGreaterThanOrEqual(248); expect(q.cx).toBeLessThanOrEqual(264);
      expect(q.cells.length).toBeGreaterThanOrEqual(33);          // a disc inside a 7x7 box
      for (const k of q.cells) { expect(Math.abs(k.x - q.cx)).toBeLessThanOrEqual(3); expect(Math.abs(k.y - q.cy)).toBeLessThanOrEqual(3); }
      expect(q.nucleus).toHaveLength(9);
    }
  });

  it('wires one input finger per soma (the nearest in y) and one different recording finger', () => {
    const inputs = t.neurites.filter(n => n.kind === 'input');
    const recs = t.neurites.filter(n => n.kind === 'rec');
    expect(inputs).toHaveLength(3);
    expect(recs).toHaveLength(1);
    expect(inputs.map(n => n.to)).toEqual([0, 1, 2]);
    expect(recs[0].from).toBe(2);
    const fingers = [...inputs.map(n => n.finger), recs[0].finger];
    expect(new Set(fingers).size).toBe(4);
    expect(inputs.map(n => n.finger)).toEqual([...INPUT_FINGERS]);
    expect(recs[0].finger).toBe(RECORD_FINGER);
    // nearest finger in y to each soma, among the fingers of the 9
    inputs.forEach((n, i) => {
      const exitY = (f: number): number => FINGERS[f].y + 1;
      const best = Math.min(...FINGERS.map((_, f) => Math.abs(exitY(f) - t.somas[i].cy)));
      expect(Math.abs(exitY(n.finger) - t.somas[i].cy)).toBeLessThanOrEqual(best + 2);
    });
    // each contact is a 2x2 sitting on its finger's exit row
    for (const n of [...inputs, ...recs]) {
      expect(n.contact).toHaveLength(4);
      const xs = new Set(n.contact!.map(c => c.x)), ys = new Set(n.contact!.map(c => c.y));
      expect(xs.size).toBe(2); expect(ys.size).toBe(2);
      expect(ys.has(FINGERS[n.finger].y + 1)).toBe(true);
    }
  });

  it('chains soma 1 -> 2 -> 3 with long, right-bowing soma-to-soma axons ending in a bouton', () => {
    const links = t.neurites.filter(n => n.kind === 'link');
    expect(links.map(n => [n.from, n.to])).toEqual([[0, 1], [1, 2]]);
    for (const n of links) {
      expect(n.path.length).toBeGreaterThanOrEqual(22);
      expect(n.bouton).toHaveLength(4);
      const target = t.somas[n.to];
      const gap = Math.min(...n.bouton!.flatMap(b => target.cells.map(c => cheb(b, c))));
      expect(gap).toBe(2);                                         // exactly a one-cell cleft
      const maxX = Math.max(...n.path.map(c => c.x));
      expect(maxX).toBeGreaterThan(Math.max(t.somas[n.from].cx, target.cx) + 6);
      expect(maxX).toBeLessThanOrEqual(284);
      // starts on the source soma's wall
      expect(Math.min(...t.somas[n.from].cells.map(c => cheb(c, n.path[0])))).toBe(1);
    }
  });

  it('draws every neurite as an 8-connected line or tuft', () => {
    for (const n of t.neurites) expect(connected8([...n.cells, ...(n.ext ?? [])]), `${n.kind} ${n.id}`).toBe(true);
    for (const n of t.neurites.filter(q => q.kind !== 'dendrite')) {
      // the spike path is a chain: consecutive cells touch
      for (let i = 1; i < n.path.length; i++) expect(cheb(n.path[i], n.path[i - 1])).toBe(1);
    }
  });

  it('axons are smooth thin curves, dendrites short tufts, in different colours', () => {
    const colour = new Map(t.staticCells.map(c => [key(c), c.color]));
    for (const n of t.neurites.filter(q => q.kind !== 'dendrite')) {
      expect(straightRun(n.path), `${n.kind}`).toBeLessThanOrEqual(6);
      // 1 cell thick: a path cell has at most 2 axon-path neighbours that are not its chain neighbours
      const own = new Set(n.path.map(key));
      for (const c of n.path) {
        let near = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && own.has((c.y + dy) * GRID_W + c.x + dx)) near++;
        expect(near).toBeLessThanOrEqual(3);
      }
    }
    const dends = t.neurites.filter(n => n.kind === 'dendrite');
    expect(dends).toHaveLength(9);
    for (const q of t.somas) expect(dends.filter(d => d.owner === q.index)).toHaveLength(3);
    for (const d of dends) {
      expect(d.path.length).toBeGreaterThanOrEqual(6);
      expect(d.path.length + (d.branch?.length ?? 0)).toBeLessThanOrEqual(12);
      expect(d.thick!.length).toBeGreaterThanOrEqual(3);
      expect(d.thick!.length).toBeLessThanOrEqual(4);              // 2 cells thick for the first 3-4 cells
    }
    // colours: dendrites share one teal-green, axons wear their owner's dim tint, and they differ
    const dendColours = new Set(dends.flatMap(d => d.path.map(c => colour.get(key(c)))));
    expect(dendColours.size).toBe(1);
    for (const n of t.neurites.filter(q => q.kind !== 'dendrite')) {
      const ends = new Set([...(n.bouton ?? []), ...(n.contact ?? [])].map(key));
      const axCol = new Set(n.path.filter(c => !ends.has(key(c))).map(c => colour.get(key(c))));
      expect(axCol.size).toBe(1);
      expect(axCol.has([...dendColours][0])).toBe(false);
    }
    const byOwner = (o: number): string | undefined => colour.get(key(t.neurites.find(n => n.kind === 'link' && n.owner === o)!.path[5]));
    expect(byOwner(0)).not.toBe(byOwner(1));                        // each cell's output is identifiable
  });

  it('breathes four or five dendrite tips on periods dividing T', () => {
    const tips = t.neurites.filter(n => n.ext);
    expect(tips.length).toBeGreaterThanOrEqual(4);
    expect(tips.length).toBeLessThanOrEqual(5);
    for (const n of tips) {
      expect(n.ext!.length).toBeGreaterThanOrEqual(4);
      expect(n.ext!.length).toBeLessThanOrEqual(6);
      expect(T % n.period!).toBe(0);
    }
  });

  it('lets no two different neurites share or touch a cell, nor touch a foreign soma', () => {
    const groups = t.neurites.map(n => ({ n, cells: [...n.cells, ...(n.ext ?? [])] }));
    const nearSoma = (c: Cell): boolean => t.somas.some(q => q.cells.some(k => cheb(k, c) <= 1));
    for (let i = 0; i < groups.length; i++) for (let j = i + 1; j < groups.length; j++) {
      for (const a of groups[i].cells) for (const b of groups[j].cells) {
        if (cheb(a, b) <= 1) {
          // allowed only where both roots join their own soma (the roots hug the body)
          expect(nearSoma(a) && nearSoma(b), `${groups[i].n.kind}${groups[i].n.id} x ${groups[j].n.kind}${groups[j].n.id} at ${a.x},${a.y}`).toBe(true);
        }
      }
    }
    for (const { n, cells } of groups) for (const c of cells) for (const q of t.somas) {
      if (q.cells.some(k => cheb(k, c) === 0)) throw new Error('neurite cell on a soma');
      if (q.index !== n.owner && !(n.kind === 'input' && q.index === n.to) && !(n.kind === 'link' && q.index === n.to)) {
        expect(q.cells.every(k => cheb(k, c) >= 2), `${n.kind}${n.id} touches soma ${q.index}`).toBe(true);
      }
    }
  });

  it('keeps growth cones and extensions off every other neurite at every moment', () => {
    const reach = (n: { cells: Cell[]; ext?: Cell[] }): Cell[] => [...n.cells, ...(n.ext ?? [])];
    let seen = 0;
    for (let f = 0; f < T; f++) for (const c of tissueCellsAt(t, f)) {
      if (c.color !== CONE_COLOUR && c.color !== DENDRITE_COLOUR) continue;
      seen++;
      const touching = t.neurites.filter(n => reach(n).some(q => cheb(q, c) <= 1));
      expect(touching.length, `cone/ext cell ${c.x},${c.y} at ${f}`).toBeLessThanOrEqual(1);
      expect(t.somas.every(q => q.cells.every(k => cheb(k, c) >= 2))).toBe(true);
    }
    expect(seen).toBeGreaterThan(T);
  });
});

describe('tissue: periodicity', () => {
  it.each(SEEDS)('is a pure function of t mod T (seed %i)', seed => {
    const t = tissueOf(seed);
    for (const f of [0, 1, 17, 63, 100, 143, 200, 250, 287]) {
      expect(tissueCellsAt(t, f + T)).toEqual(tissueCellsAt(t, f));
      expect(tissueCellsAt(t, f - T)).toEqual(tissueCellsAt(t, f));
      expect(tissueCellsAt(t, f + 5 * T)).toEqual(tissueCellsAt(t, f));
    }
    expect(tissueCellsAt(t, -1)).toEqual(tissueCellsAt(t, T - 1));
  });

  it('the schedule is steady: the loop closes on itself, a firing across the seam continues', () => {
    for (const s of SYNTH_SEEDS.slice(0, 30)) {
      const t = synthTissue(s);
      expect(t.steady, `synthetic ${s}`).toBe(true);
    }
    for (const s of SEEDS) expect(tissueOf(s).steady).toBe(true);
  });
});

describe('tissue: direction and rhythm', () => {
  const check = (t: Tissue, events: readonly EscapeEvent[], label: string): void => {
    const neurite = (id: number) => t.neurites.find(n => n.id === id)!;
    const firesAt = (soma: number, frame: number): boolean => t.firings.some(f => f.soma === soma && f.t === mod(frame, T));
    const recentFire = (soma: number, frame: number, within: number): boolean =>
      t.firings.some(f => f.soma === soma && mod(frame - f.t, T) < within && mod(frame - f.t, T) > 0);

    for (const sp of t.spikes) {
      const n = neurite(sp.neurite);
      expect(n.kind, label).not.toBe('dendrite');
      if (n.kind === 'input') {
        expect(events.some(e => e.finger === n.finger && mod(e.frame, T) === sp.t0), `${label} input spike has an event`).toBe(true);
        // soma follows the arrival, or is refractory
        expect(firesAt(n.to, sp.arrive + 1) || recentFire(n.to, sp.arrive + 1, t.refractory[n.to]), `${label} soma after input`).toBe(true);
        expect(cheb(n.path[0], n.contact![0]) <= 2 || n.contact!.some(c => cheb(c, n.path[0]) <= 1)).toBe(true);
        expect(t.somas[n.to].cells.some(c => cheb(c, n.path[n.path.length - 1]) === 1)).toBe(true);
      } else if (n.kind === 'link') {
        expect(firesAt(n.from, sp.t0 - 2), `${label} link spike follows a firing of its source`).toBe(true);
        expect(firesAt(n.to, sp.arrive + 2) || recentFire(n.to, sp.arrive + 2, t.refractory[n.to]), `${label} next soma fires`).toBe(true);
        expect(n.to).toBe(n.from + 1);
      } else {
        expect(n.from).toBe(2);
        expect(firesAt(2, sp.t0 - 2), `${label} recording spike follows soma 3`).toBe(true);
        expect(n.contact!.some(c => cheb(c, n.path[n.path.length - 1]) <= 1)).toBe(true);
      }
      expect(sp.color).toBe(t.somas[n.owner].accent);
    }
    // every firing has a cause: an arriving spike, or (soma 1 only) a spontaneous firing
    for (const f of t.firings) {
      const caused = t.spikes.some(sp => {
        const n = neurite(sp.neurite);
        if (n.to !== f.soma) return false;
        return mod(sp.arrive + (n.kind === 'input' ? 1 : 2), T) === f.t;
      });
      if (!caused) { expect(f.soma, `${label} uncaused firing`).toBe(0); expect(t.spontaneous).toContain(f.t); }
    }
    // a soma never fires twice within its refractory period (18; the recording soma adapts for 48)
    for (const q of t.somas) {
      const ts = t.firings.filter(f => f.soma === q.index).map(f => f.t).sort((a, b) => a - b);
      ts.forEach((v, i) => {
        const nxt = ts[(i + 1) % ts.length];
        if (ts.length > 1) expect(mod(nxt - v, T), `${label} soma ${q.index} refractory`).toBeGreaterThanOrEqual(18);
      });
    }
    expect(t.refractory.slice(0, 2)).toEqual([18, 18]);

    // recordings
    const rs = t.recordings;
    expect(rs.length, `${label} recordings per loop`).toBeGreaterThanOrEqual(3);
    expect(rs.length).toBeLessThanOrEqual(5);
    const frames = rs.map(r => r.frame).sort((a, b) => a - b);
    frames.forEach((f, i) => expect(mod(frames[(i + 1) % frames.length] - f, T), `${label} recording gap`).toBeGreaterThanOrEqual(48));
    for (const r of rs) {
      expect(r.finger).toBe(RECORD_FINGER);
      expect(r.accent).toBe(t.somas[2].accent);
      const sp = t.spikes.find(s => neurite(s.neurite).kind === 'rec' && mod(s.arrive, T) === r.frame);
      expect(sp, `${label} recording ${r.frame} has a spike arriving`).toBeDefined();
      // ... and the head really is on the contact: the axon's last cell and the contact are white that frame
      const cells = tissueCellsAt(t, r.frame);
      const rec = neurite(sp!.neurite);
      const last = rec.path[rec.path.length - 1];
      expect(cells.find(c => c.x === last.x && c.y === last.y)?.color).toBe(WHITE);
      for (const c of rec.contact!) expect(cells.find(q => q.x === c.x && q.y === c.y)?.color, `${label} contact flash`).toBe(WHITE);
    }
    // a full cascade is shown at least once: the loop carries soma 1 -> 2 -> 3 -> recording
    expect(t.spikes.some(s => neurite(s.neurite).kind === 'link' && neurite(s.neurite).from === 1)).toBe(true);
  };

  it.each(SEEDS)('obeys direction, refractory and recording rules (seed %i)', seed => {
    check(tissueOf(seed), worldOf(seed).events, `seed ${seed}`);
  });

  it('holds across 60 synthetic seeds (rhythm is adjusted per seed, deterministically)', () => {
    for (const s of SYNTH_SEEDS) check(synthTissue(s), synth(s).events, `synthetic ${s}`);
  });

  it('every input event on soma 1\'s finger starts a cascade and the spikes move 1.5 cells per frame', () => {
    const t = tissueOf(SEEDS[0]);
    for (const sp of t.spikes) {
      const n = t.neurites.find(q => q.id === sp.neurite)!;
      expect(sp.arrive - sp.t0).toBe(Math.ceil((n.path.length - 1) / 1.5));
    }
    const ev = worldOf(SEEDS[0]).events.find(e => e.finger === INPUT_FINGERS[0])!;
    expect(t.firings.some(f => f.soma === 0 && f.t > ev.frame && f.t < ev.frame + 40)).toBe(true);
  });
});

describe('tissue: budget and liveliness', () => {
  const sweep = (t: Tissue, label: string): void => {
    let peak = 0, still = 0, worstStill = 0;
    for (let f = 0; f < T; f++) {
      const n = tissueCellsAt(t, f).length;
      peak = Math.max(peak, n);
      still = n === 0 ? still + 1 : 0;
      worstStill = Math.max(worstStill, still);
      const cells = tissueCellsAt(t, f);
      expect(new Set(cells.map(key)).size, `${label}: unique positions at ${f}`).toBe(cells.length);
    }
    expect(peak, `${label} peak`).toBeLessThanOrEqual(BUDGET);
    expect(worstStill, `${label} stillness`).toBeLessThanOrEqual(36);
  };

  it.each(SEEDS)('never exceeds 110 dynamic cells and is never still for long (seed %i)', seed => sweep(tissueOf(seed), `seed ${seed}`));

  it('holds for 60 synthetic seeds', () => {
    for (const s of SYNTH_SEEDS) sweep(synthTissue(s), `synthetic ${s}`);
  });

  it('really changes: consecutive frames differ somewhere (the tips breathe, spikes run)', () => {
    const t = tissueOf(SEEDS[0]);
    let changes = 0;
    for (let f = 0; f < T; f++) {
      if (JSON.stringify(tissueCellsAt(t, f)) !== JSON.stringify(tissueCellsAt(t, f + 1))) changes++;
    }
    expect(changes).toBeGreaterThan(T / 2);
  });

  it('only overlays what differs from rest', () => {
    const t = tissueOf(SEEDS[0]);
    const rest = new Map(t.staticCells.map(c => [key(c), c.color]));
    for (let f = 0; f < T; f += 7) for (const c of tissueCellsAt(t, f)) expect(rest.get(key(c))).not.toBe(c.color);
  });
});
