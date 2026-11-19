import { describe, expect, it } from 'vitest';
import {
  ANSWER_FADE, ANSWER_HOLD, ANSWER_SPEED, WAKE_FRAMES, WAKE_STEPS,
  answerSpikeAt, answerWashAt, answeringComponent, buildAnswers, buildWake, wakeCellsAt,
  type Recording,
} from './boardlife.js';
import { BOARD_RIGHT, FINGERS, FINGER_W, GRID_H, GRID_W, TEXT_ZONES, inRect } from './layout.js';
import { SLOTS_PER_FRAME, flowDrawn } from './signals.js';
import { DEFAULT_T, buildWorld, copperCells } from './timeline.js';
import type { Cell, World } from './types.js';

const T = DEFAULT_T;
const mod = (a: number, n: number): number => ((a % n) + n) % n;
const key = (c: Cell): string => `${c.x},${c.y}`;

// Worlds are heavy: build lazily, only these three seeds, once each.
const SEEDS = [20260724, 20260101, 20261111];
const worlds = new Map<number, World>();
const worldOf = (seed: number): World => {
  if (!worlds.has(seed)) worlds.set(seed, buildWorld(seed, T));
  return worlds.get(seed)!;
};
const wakes = new Map<number, ReturnType<typeof buildWake>>();
const wakeOf = (seed: number): ReturnType<typeof buildWake> => {
  if (!wakes.has(seed)) wakes.set(seed, buildWake(worldOf(seed)));
  return wakes.get(seed)!;
};

const inBody = (w: World, x: number, y: number): boolean => w.components.some(c => inRect(x, y, c.rect));
const inFinger = (x: number, y: number): boolean =>
  FINGERS.some(f => x >= f.x && x < f.x + FINGER_W && y >= f.y && y < f.y + f.h);
const inText = (x: number, y: number): boolean => TEXT_ZONES.some(z => inRect(x, y, z));
const netCells = (w: World): Set<string> => new Set(w.nets.flatMap(n => n.cells.map(key)));

describe.each(SEEDS)('wake (seed %i)', seed => {
  it('only marks net copper outside bodies, fingers, text and the void, with legal steps and colours', () => {
    const w = worldOf(seed), wake = wakeOf(seed);
    const copper = netCells(w);
    const colors = new Set(w.flows.map(f => f.color));
    let seen = 0;
    for (let t = 0; t < T; t += 3) {
      for (const c of wakeCellsAt(wake, t)) {
        seen++;
        expect(copper.has(key(c))).toBe(true);
        expect(inBody(w, c.x, c.y)).toBe(false);
        expect(inFinger(c.x, c.y)).toBe(false);
        expect(inText(c.x, c.y)).toBe(false);
        expect(c.x).toBeLessThanOrEqual(BOARD_RIGHT);
        expect(c.x).toBeLessThan(BOARD_RIGHT);
        expect(c.x).toBeGreaterThanOrEqual(0);
        expect(c.y).toBeGreaterThanOrEqual(0);
        expect(c.y).toBeLessThan(GRID_H);
        expect(Number.isInteger(c.step)).toBe(true);
        expect(c.step).toBeGreaterThanOrEqual(0);
        expect(c.step).toBeLessThan(WAKE_STEPS);
        expect(colors.has(c.color)).toBe(true);
      }
    }
    expect(seen).toBeGreaterThan(0);
  });

  it('lists each cell once (the fresher flow wins)', () => {
    const wake = wakeOf(seed);
    for (let t = 0; t < T; t += 11) {
      const cells = wakeCellsAt(wake, t);
      expect(new Set(cells.map(key)).size).toBe(cells.length);
    }
  });

  it('stays behind the trail: never on a cell any flow currently draws', () => {
    const w = worldOf(seed), wake = wakeOf(seed);
    for (let t = 0; t < T; t += 7) {
      const drawn = new Set(w.flows.flatMap(f => flowDrawn(f, t, T).map(key)));
      for (const c of wakeCellsAt(wake, t)) expect(drawn.has(key(c))).toBe(false);
    }
  });

  it('fades monotonically after the trail leaves, then is gone', () => {
    const w = worldOf(seed), wake = wakeOf(seed);
    const copper = netCells(w);
    const N = T * SLOTS_PER_FRAME;
    const weightOf = new Map<string, number>();
    for (const n of w.nets) for (const c of n.cells) weightOf.set(key(c), Math.max(weightOf.get(key(c)) ?? 0, n.weight));
    // slot occupancy per cell, over every flow
    const occ = new Map<string, { f: number; s: number }[]>();
    w.flows.forEach((f, fi) => f.slots.forEach((p, s) => {
      if (p) occ.set(key(p), [...(occ.get(key(p)) ?? []), { f: fi, s }]);
    }));
    let checked = 0;
    for (let fi = 0; fi < w.flows.length && checked < 6; fi++) {
      const f = w.flows[fi];
      for (let s = 0; s < N && checked < 6; s += 5) {
        const p = f.slots[s];
        if (!p || !copper.has(key(p)) || inBody(w, p.x, p.y) || inFinger(p.x, p.y) || inText(p.x, p.y)) continue;
        if (p.x >= BOARD_RIGHT || (weightOf.get(key(p)) ?? 1) > 1) continue;
        const o = occ.get(key(p))!;
        if (o.length !== 1) continue; // one flow, one visit: nobody else refreshes it
        // also keep clear of neighbours of weight-2 trunks painting onto this cell
        const leave = Math.ceil((s + f.trail) / SLOTS_PER_FRAME);
        let prev = -1;
        for (let age = 0; age < WAKE_FRAMES; age++) {
          const hit = wakeCellsAt(wake, leave + age).find(c => c.x === p.x && c.y === p.y);
          expect(hit, `age ${age}`).toBeDefined();
          expect(hit!.color).toBe(f.color);
          expect(hit!.step).toBeGreaterThanOrEqual(prev);
          prev = hit!.step;
        }
        expect(prev).toBe(WAKE_STEPS - 1);
        // gone from age WAKE_FRAMES until just before the flow comes round again
        const again = Math.floor(s / SLOTS_PER_FRAME) + T; // next loop's arrival at the cell
        for (let t = leave + WAKE_FRAMES; t < again; t += 3)
          expect(wakeCellsAt(wake, t).some(c => c.x === p.x && c.y === p.y), `t ${t}`).toBe(false);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('is exactly T-periodic, including across the loop end', () => {
    const wake = wakeOf(seed);
    for (const t of [0, 1, 100, 287]) expect(wakeCellsAt(wake, t + T)).toEqual(wakeCellsAt(wake, t));
    expect(wakeCellsAt(wake, -1)).toEqual(wakeCellsAt(wake, T - 1));
    expect(wakeCellsAt(wake, -T)).toEqual(wakeCellsAt(wake, 0));
  });

  it('is alive and bounded at every frame', () => {
    const wake = wakeOf(seed);
    const cap = Math.floor(0.09 * 18320);
    let min = Infinity, max = 0, sum = 0;
    for (let t = 0; t < T; t++) {
      const n = wakeCellsAt(wake, t).length;
      min = Math.min(min, n); max = Math.max(max, n); sum += n;
    }
    const pct = (n: number): string => `${((100 * n) / 18320).toFixed(2)}%`;
    console.log(`wake ${seed}: min ${min} (${pct(min)}) mean ${(sum / T).toFixed(1)} (${pct(sum / T)}) max ${max} (${pct(max)})`);
    expect(min).toBeGreaterThanOrEqual(20);
    expect(max).toBeLessThanOrEqual(cap);
  });
});

// ---------------------------------------------------------------------------

const ACCENT = '#ff2d78';
const rec = (frame: number, finger: number, accent = ACCENT): Recording => ({ frame, finger, accent });
const RECS: Recording[] = [rec(3, 7), rec(104, 7), rec(221, 7), rec(3, 1), rec(104, 4)];

/** The selection rule, recomputed independently of the module (edge-spine lengths,
 * never routing through another finger). */
function expectedComponent(w: World): number {
  const g = w.graph;
  const INF = Infinity;
  const dist = g.nodes.map(() => INF);
  const fingers = g.nodes.map((n, i) => (n.finger >= 0 ? i : -1)).filter(i => i >= 0);
  for (const src of fingers) {
    const d = g.nodes.map(() => INF);
    d[src] = 0;
    for (let changed = true; changed;) {
      changed = false;
      for (const e of g.edges) {
        for (const [a, b] of [[e.a, e.b], [e.b, e.a]]) {
          if (d[a] === INF || (g.nodes[a].finger >= 0 && a !== src)) continue;
          if (d[a] + e.cells.length < d[b]) { d[b] = d[a] + e.cells.length; changed = true; }
        }
      }
    }
    d.forEach((v, i) => { dist[i] = Math.min(dist[i], v); });
  }
  const comps = g.nodes.map((n, i) => ({ n, i })).filter(({ n, i }) => n.comp >= 0 && dist[i] < INF);
  const area = (i: number): number => w.components[g.nodes[i].comp].rect.w * w.components[g.nodes[i].comp].rect.h;
  const far = comps.filter(({ i }) => dist[i] >= 60);
  const pool = far.length ? far : comps.filter(({ i }) => dist[i] === Math.max(...comps.map(c => dist[c.i])));
  const key2 = (i: number): [number, number, number, number] => {
    const r = w.components[g.nodes[i].comp].rect;
    return [far.length ? -area(i) : 0, far.length ? r.x : 0, far.length ? r.y : 0, 0];
  };
  pool.sort((p, q) => {
    const a = key2(p.i), b = key2(q.i);
    return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  });
  return g.nodes[pool[0].i].comp;
}

describe.each(SEEDS)('answers (seed %i)', seed => {
  const w = (): World => worldOf(seed);

  it('answers every recording at one prominent component, by the selection rule', () => {
    const world = w();
    const answers = buildAnswers(world, RECS);
    expect(answers).toHaveLength(RECS.length);
    const want = expectedComponent(world);
    expect(answeringComponent(world)).toBe(want);
    for (const a of answers) expect(a.component).toBe(want);
    const r = world.components[want].rect;
    const lens = [1, 4, 7].map(f => buildAnswers(world, [rec(0, f)])[0].path.length);
    console.log(`answer ${seed}: ${world.components[want].kind} rect ${JSON.stringify(r)} path from fingers 1/4/7 = ${lens.join('/')}`);
  });

  it('runs a contiguous copper path from the finger to the component', () => {
    const world = w();
    const copper = copperCells(world);
    for (const a of buildAnswers(world, RECS)) {
      const f = FINGERS[a.recording.finger];
      const p = a.path;
      expect(p.length).toBeGreaterThan(20);
      expect(inRect(p[0].x, p[0].y, { x: f.x, y: f.y, w: FINGER_W, h: f.h })).toBe(true);
      for (const c of p) expect(copper.has(key(c))).toBe(true);
      for (let i = 1; i < p.length; i++) {
        const dx = Math.abs(p[i].x - p[i - 1].x), dy = Math.abs(p[i].y - p[i - 1].y);
        expect(Math.max(dx, dy), `step ${i}`).toBe(1);
      }
      const rect = world.components[a.component].rect;
      const last = p[p.length - 1];
      expect(inRect(last.x, last.y, { x: rect.x - 1, y: rect.y - 1, w: rect.w + 2, h: rect.h + 2 })).toBe(true);
    }
  });

  it('computes arriveFrame from the path length, wrapped on the loop', () => {
    for (const a of buildAnswers(w(), [...RECS, rec(280, 7)]))
      expect(a.arriveFrame).toBe(mod(a.recording.frame + Math.ceil(a.path.length / ANSWER_SPEED), T));
  });

  it('moves the spike ANSWER_SPEED cells per frame and removes it on arrival', () => {
    const world = w();
    for (const r of [rec(3, 7), rec(280, 1)]) {
      const [a] = buildAnswers(world, [r]);
      const L = a.path.length;
      const arriveAge = Math.ceil(L / ANSWER_SPEED);
      let headSeen = 0;
      for (let age = 0; age < arriveAge; age++) {
        const h = Math.floor(age * ANSWER_SPEED);
        const spike = answerSpikeAt([a], r.frame + age, T);
        const hidden = (c: Cell): boolean =>
          inBody(world, c.x, c.y) || inFinger(c.x, c.y) || inText(c.x, c.y) || c.x >= BOARD_RIGHT;
        for (let d = 0; d < 10; d++) {
          const i = h - d;
          const at = spike.find(s => s.d === d);
          if (i < 0 || i >= L || hidden(a.path[i])) { expect(at, `age ${age} d ${d}`).toBeUndefined(); continue; }
          expect(at, `age ${age} d ${d}`).toBeDefined();
          expect(at!.x).toBe(a.path[i].x);
          expect(at!.y).toBe(a.path[i].y);
          expect(at!.accent).toBe(r.accent);
          if (d === 0) headSeen++;
        }
        expect(spike.every(s => s.d >= 0 && s.d < 10)).toBe(true);
      }
      expect(headSeen).toBeGreaterThan(arriveAge * 0.4);
      // head moves 2.5 cells per frame: two consecutive frames are 2 or 3 apart
      for (let age = 1; age < arriveAge; age++)
        expect(Math.floor(age * ANSWER_SPEED) - Math.floor((age - 1) * ANSWER_SPEED)).toBeGreaterThanOrEqual(2);
      // gone on arrival and until the next recording comes round
      for (let age = arriveAge; age < T; age += 9) expect(answerSpikeAt([a], r.frame + age, T)).toEqual([]);
    }
  });

  it('lights the component: empty, k = 1 for HOLD, then 0.75 / 0.5 / 0.25, then empty', () => {
    const world = w();
    for (const r of [rec(3, 7), rec(104, 4), rec(280, 7)]) {
      const [a] = buildAnswers(world, [r]);
      const arrive = a.arriveFrame;
      for (let age = -40; age < 0; age++) expect(answerWashAt([a], arrive + age, T)).toEqual([]);
      const ks: number[] = [];
      for (let age = 0; age < ANSWER_HOLD + ANSWER_FADE + 20; age++) {
        const wash = answerWashAt([a], arrive + age, T);
        if (age >= ANSWER_HOLD + ANSWER_FADE) { expect(wash).toEqual([]); continue; }
        expect(wash).toHaveLength(1);
        expect(wash[0].component).toBe(a.component);
        expect(wash[0].accent).toBe(r.accent);
        ks.push(wash[0].k);
      }
      expect(ks.slice(0, ANSWER_HOLD)).toEqual(new Array(ANSWER_HOLD).fill(1));
      const fade = ks.slice(ANSWER_HOLD);
      expect(fade).toHaveLength(ANSWER_FADE);
      expect(fade[0]).toBe(0.75);
      expect(fade[fade.length - 1]).toBe(0.25);
      expect([...new Set(fade)]).toEqual([0.75, 0.5, 0.25]);
      for (let i = 1; i < fade.length; i++) expect(fade[i]).toBeLessThanOrEqual(fade[i - 1]);
    }
  });

  it('is T-periodic, including a recording at 280 whose answer wraps the loop end', () => {
    const answers = buildAnswers(w(), [...RECS, rec(280, 7)]);
    const wrapped = answers.find(a => a.recording.frame === 280)!;
    expect(wrapped.arriveFrame).toBeLessThan(280);
    for (let t = 0; t < T; t += 2) {
      expect(answerSpikeAt(answers, t + T, T)).toEqual(answerSpikeAt(answers, t, T));
      expect(answerWashAt(answers, t + T, T)).toEqual(answerWashAt(answers, t, T));
    }
    expect(answerSpikeAt(answers, -1, T)).toEqual(answerSpikeAt(answers, T - 1, T));
    // the wrapped answer really is alive on both sides of the seam
    expect(answerSpikeAt([wrapped], 285, T).length).toBeGreaterThan(0);
    expect(answerWashAt([wrapped], wrapped.arriveFrame, T)).toHaveLength(1);
  });

  it('keeps one wash entry per component, the freshest accent', () => {
    const [a, b] = buildAnswers(w(), [rec(3, 7, '#111111'), rec(10, 7, '#222222')]);
    const t = a.arriveFrame + 8;
    const wash = answerWashAt([a, b], t, T);
    expect(wash).toHaveLength(1);
    expect(wash[0].accent).toBe(mod(t - a.arriveFrame, T) <= mod(t - b.arriveFrame, T) ? '#111111' : '#222222');
  });
});
