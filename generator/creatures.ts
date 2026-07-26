import type {
  Cell, Cluster, Crust, EscapeEvent, Particle, SoupPick, SoupRun, SoupState,
} from './types.js';
import { BOARD_RIGHT, FINGERS, GRID_H, GRID_W } from './layout.js';
import { mulberry32, randInt, type Rng } from './rng.js';

// ---------------------------------------------------------------------------
// creatures.ts — §13.3's zero-g soup, and §13.4's qualifying-seed search.
//
// Cody: "it should be more like the pixels are released into a zero g
// environment where they more float around, bouncing off of things, sticking to
// interface on the board, etc. interaction rules form those into entities. like
// the soup part of my codyslater.github.io"
//
// Behaviour re-expressed (never imported, nothing stamped from a template) from
// that sim's own rules — brownian jitter as the thermostat, exponential drag, a
// speed clamp, short-range pairwise chemistry over an asymmetric affinity
// matrix, bonding gated on contact AND low relative speed, rare nucleation vs
// fast accretion, eyes only once a body has enclosed cells. What changes for the
// banner: gravity is removed (zero-g), there is no ground/sedimentation cycle,
// and the left wall is the board's own interface.
//
// §4's archetype/locomotion creature model is superseded by §13.3 and is gone.
// ---------------------------------------------------------------------------

export const SOUP = {
  JITTER: 42,          // cells/s^2 brownian heat
  DRAG: 0.55,          // 1/s — low: in zero g momentum persists and the cloud crosses the void
  TERMINAL: 13,        // cells/s speed clamp
  FORCE_RADIUS: 6,
  GATHER_RADIUS: 40,   // a body is a gravity well: it draws in what drifts past.
  //                      Reaches over half the void (68x75) rather than a 20-cell
  //                      pocket, so a body gathers the matter drifting through its
  //                      neighbourhood instead of only what happens to brush it.
  //                      This is the PRIMARY composition lever (see RATIO_KNOBS):
  //                      at 20 the arc plateaued with ~half its matter permanently
  //                      adrift.
  //                      Capped at 40 by §13.3's OTHER binding requirement — "the
  //                      void must read as inhabited across its whole width, not
  //                      as a lip with a blank far side". The well eats the loose
  //                      grains that inhabit the far side, so reach trades against
  //                      width: at 60 the bonded fraction is barely higher (73.3 %
  //                      vs 72.7 %) but the far quarter of the void is EMPTY on
  //                      11 % of loop frames, and on 57 % of them for the pinned
  //                      seed. At 40 the pinned seed is bare in no quarter at all.
  GATHER: 3.2,         // cells/s^2 at the centre, independent of the body's size.
  //                      Without a well the soup fragments into dozens of 3-cell
  //                      specks; with a per-PAIR long-range force the summed pull
  //                      saturates the speed clamp and BOND_MAX_SPEED then makes
  //                      bonding impossible. The well has to be per-BODY.
  FORCE_STRENGTH: 13,
  BONDED_PULL: 2.6,    // bonded matter attracts harder — how a body gathers stragglers
  SAME_ATTRACT: 0.55,
  RESTITUTION: 0.8,
  CAPTURE_RADIUS: 1.9,
  BOND_MAX_SPEED: 9,
  NUCLEATE_RATE: 0.09, // /s — rare seeds; growth happens by accretion onto a seed
  ACCRETE_RATE: 4.0,   // /s while a free pixel touches a bonded one. The second
  //                      composition lever: what the well delivers to a body, this
  //                      converts into body. Held below the ~5 range where contact
  //                      becomes a certainty and the void loses its loose grains
  //                      altogether.
  DRIFT: 0.22,         // the whole-arc rightward current: the void is a slow river
  WANDER: 3.0,         // cells/s^2 of brownian roam on a whole cluster
  STICK_RATE: 0.9,     // /s chance to stick when nudging the interface
  BOND_EASE: 0.11,     // per frame — how fast a new bond tightens (~9 frames to firm)
  SPRING_K: 34,        // slot spring stiffness, scaled by bond strength
  SPRING_DAMP: 6,
  EYE_MIN_SIZE: 20,
  ASSIMILATE: 2.6,     // /s per eligible minority cell — bodies trend monochrome
  STICKY_PULL_RATE: 0.8,   // /s per unmirrored slot
  STICKY_RADIUS: 7,
  STICKY_ACCEL: 26,    // pull on a free pixel of the body's own colour
  STICKY_BONUS: 9,     // accretion weight multiplier for a mirror slot
  FORMED_MIN: 40, FORMED_MONO: 0.9, FORMED_SYM: 0.8,
  FORM_FROM: 22, FORM_FULL: 40,   // cells over which anatomy takes hold
  FORM_BONUS: 5.0,                // pull toward the profile
  FORM_PENALTY: 8,                // push out of it
  SHED_RATE: 0.8,                 // /s per stray nub outside the silhouette
  UPRIGHT: 0.94,                  // a settled creature stops tumbling and stands up
  MAX_NUCLEI: 4,
  // --- release cadence, GLOBAL ---------------------------------------------
  BEAT: 4,             // frames between release beats — one beat, one finger, 1-2 pixels
  DRAIN_SPAN: 48,      // frames a finger keeps trickling after its stream escapes
  DOUBLE_P: 0.45,      // chance a beat releases 2 pixels rather than 1
  // --- the generation arc ---------------------------------------------------
  COPIES: 4,           // §13.4: 4 overlapping generations; S = COPIES * T
  EXIT_WIND: 6.5,      // cells/s^2 the exit current pushes at full strength...
  SPAN_REF: 360,       // ...when it has this many frames to clear the void in
  EXIT_TERMINAL: 1.5,  // speed-clamp multiplier at full exit
  CRUST_MAX: 12,       // stuck pixels per arc
  CRUST_DWELL_LO: 90,  // frames a stuck pixel dwells on the interface before letting go
  CRUST_DWELL_HI: 380,
  BEATS_REF: 90,       // the 30 s arc's beats-per-arc, ...
  WINDOW_REF: 720,     // ...over this many frames of release window: the reference FLUX
  FEEDERS_MAX: 2,      // §13.4's feeder cap — arcs a beat train may be shared between
  NUCLEI_PER: 26,      // one seed per this many releases an arc receives
  NUCLEI_MIN: 2,
  MERGE_FREE_SIZE: 25, // below this the smaller body fuses on contact...
  MERGE_MATURE_RATE: 0.25,  // ...above it, /s, divided by resistance squared
  SEPARATE: 5.0,       // cells/s^2 two bodies that declined to fuse push apart with
} as const;

/** §13.3's void domain: x ∈ [231, 298], y ∈ [2, 76]. */
export const VOID_X0 = BOARD_RIGHT + 1, VOID_X1 = GRID_W - 2, VOID_Y0 = 2, VOID_Y1 = GRID_H - 4;
export const VOID_CELLS = (VOID_X1 - VOID_X0 + 1) * (VOID_Y1 - VOID_Y0 + 1);

const mod = (a: number, n: number): number => ((a % n) + n) % n;

/** §13.4: one generation arc is `COPIES * T` frames. */
export const genLength = (T: number): number => SOUP.COPIES * T;

/**
 * §13.3's "Nuclei per arc: `floor(releases / 26)`, min 2, max 4 — two at the
 * pinned config, so the void carries a small cast rather than one blob."
 *
 * Split out of `simulateSoup` so BOTH clamps are testable: the pinned
 * configuration releases 72 per arc and lands on the MINIMUM, so the maximum was
 * never exercised by any run the suite makes.
 */
export const nucleiBudgetFor = (releasesPerArc: number): number =>
  Math.max(SOUP.NUCLEI_MIN, Math.min(SOUP.MAX_NUCLEI, Math.floor(releasesPerArc / SOUP.NUCLEI_PER)));

/**
 * §13.4's circular per-particle scheduling, and the reason the seam is exact.
 * At loop frame `t` the void shows generation ages `t`, `t+T`, `t+2T`, `t+3T` —
 * the same simulation observed at four ages at once. The rendered void is a pure
 * function of `t mod T`, so frame T is bit-identical to frame 0.
 */
export function visibleAges(t: number, T: number): number[] {
  const a = mod(t, T), S = genLength(T), out: number[] = [];
  for (let k = a; k < S; k += T) out.push(k);
  return out;
}

export interface Release { finger: number; color: string; }

/**
 * §13.3's GLOBAL beat train. Cody wants every finger trickling AND the cadence
 * to stay "one... two... one...". Those pull against each other if each finger
 * runs its own drain, so the trickle is distributed, not multiplied: one beat
 * every BEAT frames fires 1-2 pixels from exactly ONE finger — whichever fingers
 * are currently draining take turns. Nine live interfaces, one calm countable
 * stream of pixels.
 *
 * Each beat is assigned to one generation copy, capped at FEEDERS_MAX = 2
 * (§13.4's feeder cap): sharing the train between `COPIES - 1` arcs silently cut
 * each arc's material flux to 67 % of the reference at 4 generations, which is
 * what left the 24 s body with almost no formed window. The cap restores the
 * reference flux exactly and changes nothing a viewer can count.
 */
export function buildReleaseSchedule(events: EscapeEvent[], T: number): Map<number, Release[]> {
  const m = new Map<number, Release[]>();
  if (!events.length) return m;
  const feeders = Math.max(1, Math.min(SOUP.FEEDERS_MAX, SOUP.COPIES - 1));
  let bi = 0;
  for (let b = 0; b < T; b += SOUP.BEAT, bi++) {
    const active = events.filter(e => mod(b - e.frame, T) < SOUP.DRAIN_SPAN);
    const pool = active.length ? active : events;
    const e = pool[bi % pool.length];
    const age = b + (bi % feeders) * T;
    m.set(age, [...(m.get(age) ?? []), { finger: e.finger, color: e.color }]);
  }
  return m;
}

/**
 * §13.3's ANATOMY: the site's own creature generator builds every body from a
 * 12-row fill profile, mirrored about the vertical centre.
 *
 *   rows 0-1   0.05 0.15        a narrow crown
 *   rows 2-3   0.80 0.85        the HEAD — wide, and where the eye pair sits
 *   row  4     0.55             a NECK PINCH
 *   rows 5-7   0.95 0.95 0.90   the TORSO, widest part
 *   rows 8-9   0.65 0.55        hips
 *   rows 10-11 0.50 0.45        LEGS — with the centre columns cleared, so the
 *                               body ends in two legs with a gap between them
 *
 * Applied as a WEIGHT on accretion scoring that fades in between FORM_FROM and
 * FORM_FULL cells: a young cluster is unaffected loose goo and the anatomy
 * arrives as late-stage organisation. Nothing is ever stamped from a template.
 */
export const ROW_PROFILE = [0.05, 0.15, 0.80, 0.85, 0.55, 0.95, 0.95, 0.90, 0.65, 0.55, 0.50, 0.45];

/** How strongly a slot at (sx,sy) agrees with the body's silhouette. */
function formFit(sx: number, sy: number, minSy: number, maxSy: number, axis: number, half: number): number {
  const rows = Math.max(1, maxSy - minSy);
  const ri = Math.max(0, Math.min(11, Math.round(((sy - minSy) / rows) * 11)));
  if (sy < minSy || sy > maxSy) return -1;   // outside the anatomy entirely
  const w = ROW_PROFILE[ri] * half;
  const d = Math.abs(sx - axis);
  if (ri >= 10 && d < w * 0.42) return -1;   // the gap between the legs
  return d <= w ? 1 : -1;
}

const N8: readonly (readonly [number, number])[] =
  [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]];
const N4: readonly (readonly [number, number])[] = [[1, 0], [-1, 0], [0, 1], [0, -1]];

interface FormFrame { w: number; minSy: number; maxSy: number; axis: number; half: number; }

const slotKey = (x: number, y: number): string => `${x},${y}`;

/**
 * The ONE place a cell is assigned a slot on a body: packing + mirror repair +
 * anatomy, tie-broken toward where the cell already is. Shared by accretion AND
 * by merging, which is the whole point — a merge that dropped absorbed matter
 * wherever it floated was the single largest source of malformed creatures.
 *
 * Candidates are every empty slot on the WHOLE body boundary, not the eight
 * around the contact point: a slot that completes the body's mirror is almost
 * never adjacent to wherever the pixel happened to touch, so a local-only search
 * can never build symmetry no matter how large the bonus.
 */
function pickSlot(
  occ: Set<string>, sticky: Set<string> | undefined, fit: FormFrame | undefined, rx: number, ry: number,
): { x: number; y: number } | null {
  const seen = new Set<string>();
  let best: { x: number; y: number; score: number } | null = null;
  for (const key of occ) {
    const ci = key.indexOf(',');
    const ox = Number(key.slice(0, ci)), oy = Number(key.slice(ci + 1));
    for (const [ax, ay] of N8) {
      const sx = ox + ax, sy = oy + ay;
      const sk = slotKey(sx, sy);
      if (occ.has(sk) || seen.has(sk)) continue;
      seen.add(sk);
      const nb = N8.filter(([dx, dy]) => occ.has(slotKey(sx + dx, sy + dy))).length;
      const mirrorBonus = sticky?.has(sk) ? SOUP.STICKY_BONUS : 0;
      const f = fit ? formFit(sx, sy, fit.minSy, fit.maxSy, fit.axis, fit.half) : 0;
      const anat = fit ? fit.w * f * (f > 0 ? SOUP.FORM_BONUS : SOUP.FORM_PENALTY) : 0;
      const score = nb * 2.5 + mirrorBonus + anat - Math.hypot(sx - rx, sy - ry);
      if (!best || score > best.score) best = { x: sx, y: sy, score };
    }
  }
  return best;
}

/** The unmirrored slots of a body — the repair targets symmetry grows into. */
function stickyOfSlots(occ: Set<string>, axis2: number): Set<string> {
  const out = new Set<string>();
  for (const key of occ) {
    const ci = key.indexOf(',');
    const sx = Number(key.slice(0, ci)), sy = Number(key.slice(ci + 1));
    const mk = slotKey(axis2 - sx, sy);
    if (!occ.has(mk)) out.add(mk);
  }
  return out;
}

/** §13.3's affinity character: same colour attracts, cross pairs are asymmetric —
 * roughly a quarter attract, the rest mildly repel. That asymmetry is what makes
 * the soup *chase* rather than homogenise. */
export function rollAffinity(rng: Rng, n: number): number[][] {
  return Array.from({ length: n }, (_, a) => Array.from({ length: n }, (_2, b) =>
    a === b ? SOUP.SAME_ATTRACT : rng() < 0.25 ? rng() * 0.6 : -(0.1 + rng() * 0.5)));
}

/**
 * One deterministic pass of the soup across a whole generation arc, recorded per
 * frame. Emergent-looking, exactly replayable: same sub-seed, same frames, every
 * time.
 */
export function simulateSoup(
  rng: Rng, releaseAt: Map<number, Release[]>, S: number, colors: readonly string[],
): SoupState[] {
  const aff = rollAffinity(rng, colors.length);
  const idxOf = new Map(colors.map((c, i) => [c, i]));
  const parts: Particle[] = [];
  const clusters: Cluster[] = [];
  const occupied = new Map<number, Set<string>>();
  let crust: Crust[] = [];
  const frames: SoupState[] = [];
  const dt = 1 / 12;
  let nextCluster = 0, nucleated = 0;

  // A seed only forms if the arc has matter to feed another body.
  const releasesPerArc = [...releaseAt.values()].reduce((n, v) => n + v.length, 0);
  const nucleiBudget = nucleiBudgetFor(releasesPerArc);
  // The flux GUARD. With the feeder cap an arc is fed at the reference rate for
  // any COPIES >= 3 and this resolves to DOUBLE_P unchanged; it only bites if a
  // future config puts the release window somewhere else. Cody pinned the cadence
  // as "just a one two at a time" — the mix of ones and twos inside that is the
  // only free variable, so that is what it moves.
  const releaseWindow = Math.max(...releaseAt.keys(), 0) + SOUP.BEAT;
  const flux = releasesPerArc / Math.max(1, releaseWindow);
  const fluxRef = SOUP.BEATS_REF / SOUP.WINDOW_REF;
  const doubleP = Math.max(0, Math.min(1, (1 + SOUP.DOUBLE_P) * (fluxRef / flux) - 1));

  const stickyOf = new Map<number, Set<string>>();
  const formOf = new Map<number, FormFrame>();

  // §13.4's exit: a current that ramps in over the arc's last S/COPIES frames.
  // It has to actually finish the job — the arc must be empty at age S — so the
  // clamp is lifted with it and the right wall stops reflecting. NOTHING is
  // removed while it is still visible: a particle leaves this world by drifting
  // off the right-hand edge of the canvas, never by dimming out.
  const EXIT_SPAN = S / SOUP.COPIES;
  const EXIT_START = S - EXIT_SPAN;
  const GONE_X = GRID_W + 2;
  // The exit is a FIXED JOB (clear the void) given a span that shrinks with the
  // loop, so the wind is span-scaled; it is a no-op at the reference span.
  const exitWind = SOUP.EXIT_WIND * (SOUP.SPAN_REF / EXIT_SPAN);

  const clusterOf = (id: number): Cluster => clusters.find(c => c.id === id)!;
  const slotWorld = (cl: Cluster, sx: number, sy: number): Cell => {
    const cos = Math.cos(cl.theta), sin = Math.sin(cl.theta);
    return { x: cl.x + sx * cos - sy * sin, y: cl.y + sx * sin + sy * cos };
  };

  for (let t = 0; t < S; t++) {
    // --- release: the metered trickle out of each draining finger ------------
    for (const e of releaseAt.get(t) ?? []) {
      const f = FINGERS[e.finger];
      const ci = idxOf.get(e.color) ?? 0;
      const n = rng() < doubleP ? 2 : 1;   // "just a one two at a time"
      for (let k = 0; k < n; k++) {
        const cling = rng() < 0.25;
        parts.push({
          x: cling ? VOID_X0 : VOID_X0 + 1 + rng() * 1.5,
          y: f.y + 1 + (rng() - 0.5) * 2.5,
          vx: cling ? -0.3 - rng() * 0.4 : 0.8 + rng() * 1.7,
          vy: (rng() - 0.5) * 3.2, c: ci, streak: 0.4,
          cluster: -1, sx: 0, sy: 0, bond: 0, eye: 0,
        });
      }
    }

    // The void exhales. A gentle rightward drift runs for the WHOLE arc, so
    // material migrates away from the interface as it ages and the far side of
    // the void gets inhabited instead of staying blank; it also stratifies the
    // four visible copies in space, so they read as neighbourhoods of one
    // ecosystem rather than four clouds sharing a box. The exit is the same
    // current turned up, which is why leaving never looks like a mode change.
    const exitU = Math.min(1, Math.max(0, (t - EXIT_START) / EXIT_SPAN));
    const exhale = SOUP.DRIFT + exitU * exitWind;
    const terminal = SOUP.TERMINAL * (1 + SOUP.EXIT_TERMINAL * exitU);
    const rightWall = exitU <= 0;

    // --- the crust breathes: stuck pixels let go after their dwell, and the
    //     exit current strips whatever is left, so the interface is bare at S ---
    const strip = Math.min(1, Math.max(0, (t - (EXIT_START + 40)) / 80)) * 0.2;
    if (crust.length) {
      const keep: Crust[] = [];
      for (const cr of crust) {
        if (t - cr.born < cr.dwell && rng() >= strip) { keep.push(cr); continue; }
        parts.push({
          x: VOID_X0 + 0.4, y: cr.y, vx: 1.0 + rng() * 1.6, vy: (rng() - 0.5) * 2.6,
          c: cr.c, streak: 0.25, cluster: -1, sx: 0, sy: 0, bond: 0, eye: 0,
        });
      }
      crust = keep;
    }

    // --- ONE integrator for every particle, bonded or not -------------------
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      const free = p.cluster < 0;
      const jitter = SOUP.JITTER * (1 - 0.85 * p.bond);
      p.vx += (rng() - 0.5) * jitter * dt + exhale * dt;
      p.vy += (rng() - 0.5) * jitter * dt;

      // Chemistry — bonded particles keep exerting and feeling it, which is how a
      // growing body attracts the pixels still adrift. Same rule, no special case.
      for (let j = 0; j < parts.length; j++) {
        if (j === i) continue;
        const q = parts[j];
        // Particles of the SAME body do not pull on each other — their geometry
        // is the lattice, and letting them attract as well collapses a 58-cell
        // creature into a 2x3 stack.
        if (p.cluster >= 0 && p.cluster === q.cluster) continue;
        const dx = q.x - p.x, dy = q.y - p.y;
        const d2 = dx * dx + dy * dy;
        const R = SOUP.FORCE_RADIUS;
        if (d2 > R * R || d2 < 0.01) continue;
        const d = Math.sqrt(d2);
        // Free pairs feel the signed affinity — that asymmetry is what makes the
        // soup chase. Bonded matter is *sticky*: it attracts regardless of colour,
        // which is why a body gathers stragglers of every colour instead of
        // same-colour clumps repelling each other into a shoal.
        const a = q.cluster >= 0 ? Math.abs(aff[p.c][q.c]) * SOUP.BONDED_PULL : aff[p.c][q.c];
        const fmag = SOUP.FORCE_STRENGTH * a * (1 - d / R) * dt * (1 - 0.6 * p.bond);
        p.vx += (dx / d) * fmag; p.vy += (dy / d) * fmag;
      }

      // The gravity well of every body in range — per BODY, not per pair.
      if (free)
        for (const cl of clusters) {
          const dx = cl.x - p.x, dy = cl.y - p.y;
          const d = Math.hypot(dx, dy);
          if (d > SOUP.GATHER_RADIUS || d < 0.5) continue;
          const f = SOUP.GATHER * (1 - d / SOUP.GATHER_RADIUS) * dt;
          p.vx += (dx / d) * f; p.vy += (dy / d) * f;
        }

      // Spring toward the slot — a bonded particle eases into place along its own
      // trajectory instead of being repositioned. Stiffness grows with the bond.
      if (!free) {
        const cl = clusterOf(p.cluster);
        const w = slotWorld(cl, p.sx, p.sy);
        const k = SOUP.SPRING_K * p.bond;
        p.vx += ((w.x - p.x) * k - p.vx * SOUP.SPRING_DAMP * p.bond) * dt;
        p.vy += ((w.y - p.y) * k - p.vy * SOUP.SPRING_DAMP * p.bond) * dt;
        p.bond = Math.min(1, p.bond + SOUP.BOND_EASE);
      }

      const drag = Math.exp(-SOUP.DRAG * dt);
      p.vx *= drag; p.vy *= drag;
      const sp = Math.hypot(p.vx, p.vy);
      if (sp > terminal) { p.vx *= terminal / sp; p.vy *= terminal / sp; }
      p.x += p.vx * dt; p.y += p.vy * dt;
      if (p.streak > 0) p.streak -= dt;

      // Walls — the left one is the board's own interface, and a pixel nudging it
      // slowly may simply stay there.
      if (p.x < VOID_X0) {
        p.x = VOID_X0; p.vx = Math.abs(p.vx) * SOUP.RESTITUTION;
        if (free && exitU === 0 && rng() < SOUP.STICK_RATE * dt * 12 && crust.length < SOUP.CRUST_MAX) {
          crust.push({
            x: BOARD_RIGHT, y: Math.round(p.y), c: p.c, born: t,
            dwell: randInt(rng, SOUP.CRUST_DWELL_LO, SOUP.CRUST_DWELL_HI),
          });
          parts.splice(i--, 1); continue;
        }
      } else if (p.x > VOID_X1 && rightWall) { p.x = VOID_X1; p.vx = -Math.abs(p.vx) * SOUP.RESTITUTION; }
      if (p.y < VOID_Y0) { p.y = VOID_Y0; p.vy = Math.abs(p.vy) * SOUP.RESTITUTION; }
      else if (p.y > VOID_Y1) { p.y = VOID_Y1; p.vy = -Math.abs(p.vy) * SOUP.RESTITUTION; }
    }

    // --- bonding: what interactions sometimes do, not a stage ---------------
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (p.cluster >= 0) continue;
      for (let j = 0; j < parts.length; j++) {
        if (j === i) continue;
        const q = parts[j];
        if (Math.abs(p.x - q.x) > SOUP.CAPTURE_RADIUS || Math.abs(p.y - q.y) > SOUP.CAPTURE_RADIUS) continue;
        if (Math.hypot(p.vx - q.vx, p.vy - q.vy) > SOUP.BOND_MAX_SPEED) continue;
        if (q.cluster < 0 && aff[p.c][q.c] <= 0) continue;   // compatibility gates nucleation only
        if (q.cluster < 0 && nucleated >= nucleiBudget) continue;
        const rate = q.cluster >= 0 ? SOUP.ACCRETE_RATE : SOUP.NUCLEATE_RATE;
        if (rng() >= rate * dt) continue;

        if (q.cluster < 0) {
          const cl: Cluster = {
            id: nextCluster++, x: (p.x + q.x) / 2, y: (p.y + q.y) / 2,
            vx: (p.vx + q.vx) / 2, vy: (p.vy + q.vy) / 2,
            theta: 0, omega: (rng() - 0.5) * 0.3, n: 2, maturity: 0, blink: 0,
            dominant: p.c, axis2: 0, mono: 0, sym: 0, formed: false, form: 0,
            originSy: 0, half: 3.4, anchored: false,
          };
          clusters.push(cl);
          nucleated++;
          const occ = new Set<string>();
          occupied.set(cl.id, occ);
          const dirx = p.x <= q.x ? -1 : 1;
          q.cluster = cl.id; q.sx = 0; q.sy = 0; q.bond = 0; occ.add(slotKey(0, 0));
          p.cluster = cl.id; p.sx = dirx; p.sy = 0; p.bond = 0; occ.add(slotKey(dirx, 0));
        } else {
          // Accretion is EDEN-like: of the open slots on the body's boundary, take
          // the one with the most occupied neighbours, breaking ties toward where
          // this particle actually is. Taking the nearest open slot instead grows
          // stringy filaments; preferring concave positions makes lumpy bodies,
          // which is what the reference soup's packing looks like.
          const cl = clusterOf(q.cluster);
          const occ = occupied.get(cl.id)!;
          const cos = Math.cos(-cl.theta), sin = Math.sin(-cl.theta);
          const rx = (p.x - cl.x) * cos - (p.y - cl.y) * sin;
          const ry = (p.x - cl.x) * sin + (p.y - cl.y) * cos;
          const best = pickSlot(occ, stickyOf.get(cl.id), formOf.get(cl.id), rx, ry);
          if (!best) break;
          // REPAIR TISSUE: a pixel that completes the mirror arrives as body
          // matter regardless of its own colour. This is most of what drives mono
          // and symmetry up together instead of trading one against the other.
          if (stickyOf.get(cl.id)?.has(slotKey(best.x, best.y))) p.c = cl.dominant;
          p.cluster = cl.id; p.sx = best.x; p.sy = best.y; p.bond = 0;
          occ.add(slotKey(best.x, best.y));
          cl.n++;
          cl.vx = cl.vx * 0.92 + p.vx * 0.08; cl.vy = cl.vy * 0.92 + p.vy * 0.08;
        }
        break;
      }
    }

    // --- clusters: drift, tumble, mature ------------------------------------
    for (const cl of clusters) {
      // A body roams. Without this, clusters freeze where they nucleated and the
      // far half of the void stays blank no matter how much material arrives.
      cl.vx += exhale * dt + (rng() - 0.5) * SOUP.WANDER * dt;
      cl.vy += (rng() - 0.5) * SOUP.WANDER * dt;
      cl.vx *= 0.985; cl.vy *= 0.985;
      const csp = Math.hypot(cl.vx, cl.vy), cmax = terminal * 0.8;
      if (csp > cmax) { cl.vx *= cmax / csp; cl.vy *= cmax / csp; }
      cl.x += cl.vx * dt * 0.75; cl.y += cl.vy * dt * 0.75;
      cl.theta += cl.omega * dt;
      cl.omega *= 0.99;
      // `n` is the LIVE particle count, recomputed every frame: trusting the
      // accretion counter over-reports badly, because particles carried off the
      // canvas are never subtracted and the size band then measures a fiction.
      const mine = parts.filter(p => p.cluster === cl.id);
      cl.n = mine.length;
      cl.maturity = Math.min(1, cl.n / 46);
      const occ0 = occupied.get(cl.id)!;

      // ---- body meta: species colour, mirror axis, unmirrored slots ---------
      const counts = new Array(colors.length).fill(0);
      let sumSx = 0, minSy = Infinity, maxSy = -Infinity, bodyN = 0;
      const bySlot = new Map<string, Particle>();
      for (const q of mine) {
        bySlot.set(slotKey(q.sx, q.sy), q);
        sumSx += q.sx;
        if (q.sy < minSy) minSy = q.sy;
        if (q.sy > maxSy) maxSy = q.sy;
        if (q.eye === 0) { counts[q.c]++; bodyN++; }
      }
      if (mine.length) {
        let dom = cl.dominant, bestN = -1;
        counts.forEach((v, i) => { if (v > bestN) { bestN = v; dom = i; } });
        cl.dominant = dom;
        cl.axis2 = Math.round((2 * sumSx) / mine.length);
        let mirrored = 0;
        const sticky: string[] = [];
        for (const q of mine) {
          const mk = slotKey(cl.axis2 - q.sx, q.sy);
          if (bySlot.has(mk)) mirrored++; else sticky.push(mk);
        }
        cl.sym = mirrored / mine.length;
        cl.mono = bodyN ? counts[dom] / bodyN : 0;
        stickyOf.set(cl.id, new Set(sticky));

        // ---- anatomy: fades in with size, so goo first, creature later -----
        const fw = Math.max(0, Math.min(1,
          (cl.n - SOUP.FORM_FROM) / (SOUP.FORM_FULL - SOUP.FORM_FROM)));
        cl.form = fw;
        // The anatomical frame is ANCHORED the moment form engages, not
        // recomputed from the live bounding box: a rescaling frame chases itself
        // (symmetry fell 0.97 -> 0.82) and the shed rule then eats the body from
        // the outside in. The half-width ratchets so the silhouette scales with
        // the creature without the frame ever chasing itself.
        if (!cl.anchored && fw > 0) {
          cl.anchored = true;
          cl.originSy = minSy - 1;
          cl.half = 3.2;
        }
        if (cl.anchored) cl.half = Math.max(cl.half, Math.min(5.2, cl.n / 13));
        if (cl.anchored)
          formOf.set(cl.id, { w: fw, minSy: cl.originSy, maxSy: cl.originSy + 11, axis: cl.axis2 / 2, half: cl.half });

        // A creature that has found its shape stops tumbling and stands up — a
        // head only reads as a head if it is on top.
        if (fw > 0.5) { cl.omega *= SOUP.UPRIGHT; cl.theta *= SOUP.UPRIGHT; }

        // ---- lone-nub shedding: matter conserved, as the reference does it --
        if (fw > 0.6)
          for (const q of mine) {
            if (q.eye > 0) continue;
            const nbs = N4.filter(([dx, dy]) => bySlot.has(slotKey(q.sx + dx, q.sy + dy))).length;
            if (nbs > 1) continue;
            if (formFit(q.sx, q.sy, cl.originSy, cl.originSy + 11, cl.axis2 / 2, cl.half) > 0) continue;
            if (rng() >= SOUP.SHED_RATE * dt) continue;
            // Vacate the slot BEFORE clearing the coordinates: zeroing first
            // deleted the nucleus key "0,0" instead, which both leaked the shed
            // slot (nothing could ever be accreted back into it) and wrongly
            // freed the body's origin cell for a second occupant.
            occ0.delete(slotKey(q.sx, q.sy));
            q.cluster = -1; q.bond = 0; q.sx = 0; q.sy = 0;
          }

        // ---- assimilation: a minority cell well inside dominant matter turns.
        //      The reference needs 3 dominant neighbours, but its bodies have far
        //      more interior than ours; at 3 the conversion never cascades past a
        //      merged seam. 2 is the same rule at our scale. ------------------
        for (const q of mine) {
          if (q.c === dom || q.eye > 0) continue;
          let domN = 0;
          for (const [dx, dy] of N4) {
            const nb = bySlot.get(slotKey(q.sx + dx, q.sy + dy));
            if (nb && nb.eye === 0 && nb.c === dom) domN++;
          }
          if (domN >= 2 && rng() < SOUP.ASSIMILATE * dt) q.c = dom;
        }

        // ---- mirror pull: an unmirrored slot lures the nearest free pixel of
        //      the body's own colour. Bilateral symmetry emerges; nothing is
        //      placed by template. --------------------------------------------
        for (const mk of sticky) {
          if (rng() >= SOUP.STICKY_PULL_RATE * dt) continue;
          const ci = mk.indexOf(',');
          const msx = Number(mk.slice(0, ci)), msy = Number(mk.slice(ci + 1));
          const w = slotWorld(cl, msx, msy);
          let best: Particle | null = null, bestD = SOUP.STICKY_RADIUS ** 2;
          for (const q of parts) {
            if (q.cluster >= 0 || q.c !== dom) continue;
            const dx = w.x - q.x, dy = w.y - q.y, d2 = dx * dx + dy * dy;
            if (d2 < bestD) { bestD = d2; best = q; }
          }
          if (!best) continue;
          const d = Math.sqrt(bestD) || 1;
          best.vx += ((w.x - best.x) / d) * SOUP.STICKY_ACCEL * dt;
          best.vy += ((w.y - best.y) / d) * SOUP.STICKY_ACCEL * dt;
        }
      }

      // Keep the body's own frame with its mass — if the centre runs away from
      // the particles the springs stretch and it reads as a yank.
      const xs = mine.map(p => p.x), ys = mine.map(p => p.y);
      if (xs.length) {
        const cx = mine.reduce((a, q) => a + q.x, 0) / mine.length;
        const cy = mine.reduce((a, q) => a + q.y, 0) / mine.length;
        cl.x += (cx - cl.x) * 0.05; cl.y += (cy - cl.y) * 0.05;
        if (Math.min(...xs) < VOID_X0) { cl.x += VOID_X0 - Math.min(...xs); cl.vx = Math.abs(cl.vx) * 0.6; }
        // The right wall opens with the exit current — a clamped body kept being
        // bounced back and the void never emptied.
        if (rightWall && Math.max(...xs) > VOID_X1) { cl.x -= Math.max(...xs) - VOID_X1; cl.vx = -Math.abs(cl.vx) * 0.6; }
        if (Math.min(...ys) < VOID_Y0) { cl.y += VOID_Y0 - Math.min(...ys); cl.vy = Math.abs(cl.vy) * 0.6; }
        if (Math.max(...ys) > VOID_Y1) { cl.y -= Math.max(...ys) - VOID_Y1; cl.vy = -Math.abs(cl.vy) * 0.6; }
      }

      // §13.3's eyes: a MIRRORED PAIR OF 2x1 BLOCKS — four cells — on *enclosed*
      // cells in the upper third, on a column and its distinct mirror column.
      if (cl.n >= SOUP.EYE_MIN_SIZE && !mine.some(p => p.eye > 0)) {
        const upper = minSy + Math.ceil((maxSy - minSy + 1) / 3);
        const solid = (sx: number, sy: number): boolean => {
          const q = bySlot.get(slotKey(sx, sy));
          return !!q && q.eye === 0;
        };
        const enclosed = (sx: number, sy: number): boolean => solid(sx, sy)
          && N4.every(([dx, dy]) => bySlot.has(slotKey(sx + dx, sy + dy)));
        const cands = [...mine].sort((a, b) => a.sy - b.sy || a.sx - b.sx);
        for (const q of cands) {
          if (q.sy > upper) continue;
          const mc = cl.axis2 - q.sx;
          if (mc === q.sx) continue;   // needs a distinct mirror column
          if (!(enclosed(q.sx, q.sy) && enclosed(q.sx, q.sy + 1)
            && enclosed(mc, q.sy) && enclosed(mc, q.sy + 1))) continue;
          for (const [ex, ey] of [[q.sx, q.sy], [q.sx, q.sy + 1], [mc, q.sy], [mc, q.sy + 1]]) {
            const e = bySlot.get(slotKey(ex, ey));
            if (e) e.eye = 0.01;   // eases open; never snaps
          }
          break;
        }
      }
      cl.formed = mine.some(p => p.eye > 0.5) && cl.n >= SOUP.FORMED_MIN
        && cl.mono >= SOUP.FORMED_MONO && cl.sym >= SOUP.FORMED_SYM;
      // Blink and breath are draw-time only, and only once the creature is formed.
      if (cl.formed) {
        cl.blink -= dt;
        if (cl.blink < -0.18) cl.blink = 2 + rng() * 4;
      } else cl.blink = 1;
      for (const p of mine) if (p.eye > 0) p.eye = Math.min(1, p.eye + 0.06);
    }

    // --- merging: GATED, which is what stops mono collapsing -----------------
    //
    // Compatibility first — the averaged affinity of the two DOMINANTS must be
    // positive; then resistance — below MERGE_FREE_SIZE the smaller body fuses on
    // contact, above it the chance is MERGE_MATURE_RATE·dt / resist², so big late
    // fusions are rare. A merge dumps ~n foreign cells into a body at once and
    // assimilation can only convert them layer by layer from the seam inward; on
    // a finite arc with an exit coming, it often never catches up.
    for (let a = 0; a < clusters.length; a++)
      for (let b = clusters.length - 1; b > a; b--) {
        const A = clusters[a], B = clusters[b];
        const pa = parts.filter(p => p.cluster === A.id), pb = parts.filter(p => p.cluster === B.id);
        if (!pa.length || !pb.length) continue;
        const touch = pa.some(p => pb.some(q => Math.abs(p.x - q.x) <= 3.4 && Math.abs(p.y - q.y) <= 3.4));
        if (!touch) continue;
        const affAB = (aff[A.dominant][B.dominant] + aff[B.dominant][A.dominant]) / 2;
        const small = Math.min(A.n, B.n);
        const resist = small / SOUP.MERGE_FREE_SIZE;
        const fuse = affAB > 0
          && (resist <= 1 || rng() < (SOUP.MERGE_MATURE_RATE * dt) / (resist * resist));
        if (!fuse) {
          // Declining to fuse has to mean something physically, or the two bodies
          // interpenetrate and read as one mush.
          const dx = A.x - B.x, dy = A.y - B.y, d = Math.hypot(dx, dy) || 1;
          const f = SOUP.SEPARATE * dt;
          A.vx += (dx / d) * f; A.vy += (dy / d) * f;
          B.vx -= (dx / d) * f; B.vy -= (dy / d) * f;
          continue;
        }
        // A merge REBUILDS the absorbed matter into the body's own anatomy: every
        // absorbed particle is re-slotted through the same scorer accretion uses,
        // nearest-first so the shape stays plausible.
        const occA = occupied.get(A.id)!;
        const cos = Math.cos(-A.theta), sin = Math.sin(-A.theta);
        const incoming = pb.map(q => ({
          q,
          rx: (q.x - A.x) * cos - (q.y - A.y) * sin,
          ry: (q.x - A.x) * sin + (q.y - A.y) * cos,
        })).sort((u, v) => Math.hypot(u.rx, u.ry) - Math.hypot(v.rx, v.ry));
        for (const { q, rx: qx, ry: qy } of incoming) {
          const slot = pickSlot(occA, stickyOfSlots(occA, A.axis2), formOf.get(A.id), qx, qy);
          if (!slot) break;
          occA.add(slotKey(slot.x, slot.y));
          q.cluster = A.id; q.sx = slot.x; q.sy = slot.y; q.bond = Math.min(q.bond, 0.35);
        }
        A.n += B.n;
        A.vx = (A.vx + B.vx) / 2; A.vy = (A.vy + B.vy) / 2;
        occupied.delete(B.id);
        clusters.splice(b, 1);
      }

    // Anything carried clear off the canvas has left the world. The cull line is
    // two cells BEYOND the right edge, so no pixel is ever removed while a viewer
    // can still see it — the only way out is to keep moving.
    for (let i = parts.length - 1; i >= 0; i--) if (parts[i].x >= GONE_X) parts.splice(i, 1);
    for (let i = clusters.length - 1; i >= 0; i--)
      if (!parts.some(p => p.cluster === clusters[i].id)) { occupied.delete(clusters[i].id); clusters.splice(i, 1); }

    frames.push({
      parts: parts.map(p => ({ ...p })),
      clusters: clusters.map(c => ({ ...c })),
      crust: crust.map(c => ({ ...c })),
    });
  }
  return frames;
}

// ---------------------------------------------------------------------------
// §13.4 — the qualifying-seed search
// ---------------------------------------------------------------------------

export const biggestCluster = (st: SoupState): number => Math.max(0, ...st.clusters.map(c => c.n));

/**
 * The arc's own report card. POP and BODIES are summed over the COPIES ages
 * visible together, i.e. over what a viewer actually sees; PEAK is measured over
 * the *formative* part of the arc only, because a body that only reaches size
 * while it is already being carried out of frame is not a body anyone sees.
 */
export function assess(frames: SoupState[], T: number): SoupRun {
  const S = frames.length;
  const formative = S - S / SOUP.COPIES;
  let peak = 0, peakAt = 0;
  frames.slice(0, formative).forEach((st, i) => {
    const b = biggestCluster(st); if (b > peak) { peak = b; peakAt = i; }
  });
  // POP is the PER-LOOP-FRAME total over the visible ages, measured by the one
  // shared `voidPopulation` the sweep also gates on, and the search keeps both
  // extremes: §13.5's "standing population 130-340" is a bound on what the void
  // holds in every frame, so testing the mean would let a candidate whose
  // population dips out of band average its way back into it.
  const pop = voidPopulation(frames, T);
  let bodySum = 0;
  for (let t = 0; t < T; t++)
    for (const age of visibleAges(t, T)) bodySum += frames[age].clusters.filter(c => c.n >= 8).length;
  // How far back from the end the arc has been continuously empty — the wrap
  // needs at least the final frame bare.
  let tail = S;
  while (tail > 0) {
    const st = frames[tail - 1];
    if (st.parts.length || st.clusters.length || st.crust.length) break;
    tail--;
  }
  const big = frames.map(st => st.clusters.slice().sort((x, y) => y.n - x.n)[0]).filter(Boolean) as Cluster[];
  const grown = big.filter(c => c.n >= 24);
  // §13.3's formed-frame expectation is a RATIO over the ripe frames, so the
  // denominator has to travel with the numerator: `formed` already implies
  // `n >= FORMED_MIN`, so these two count the same frames the sweep counts.
  const ripe = big.filter(c => c.n >= SOUP.FORMED_MIN).length;
  const bonded = bondedFraction(frames, T);
  const { fill, bareQuarter } = voidOccupancy(frames, T);
  return {
    frames, peak, peakAt,
    formedFrames: big.filter(c => c.formed).length, ripeFrames: ripe,
    mono: grown.length ? grown.reduce((s, c) => s + c.mono, 0) / grown.length : 0,
    sym: grown.length ? grown.reduce((s, c) => s + c.sym, 0) / grown.length : 0,
    meanPop: pop.mean, minPop: pop.min, maxPop: pop.max, meanBodies: bodySum / T,
    eyes: frames.some(st => st.parts.some(p => p.eye > 0.5)),
    empty: tail <= S - 1,
    tailEmptyFrom: tail,
    bondedMean: bonded.mean, bondedMin: bonded.min,
    fillMean: fill.reduce((a, b) => a + b, 0) / T, fillPeak: Math.max(...fill),
    bareQuarter,
  };
}

/** §13.3's binding size band, and §13.5's binding population bounds. */
export const BAND: [number, number] = [45, 70];
export const POP_BAND: [number, number] = [130, 340];
/**
 * §13.3's "the void carries a small cast rather than one blob", as a searched AND
 * gated number.
 *
 * RAISED 1.8 -> 4.0 at Cody's 2026-07-25 gate. At 1.8 the bound was nearly
 * inert: seed 20260101 shipped a rung-0 pick measuring **2.90** mean coexisting
 * bodies against 5.27-5.68 on the other three gate seeds, and its void read as
 * *one excellent creature plus confetti* rather than as a population — the
 * failure mode a daily-regenerating banner must not be able to have.
 *
 * 4.0 is chosen from the candidate corpus, not from taste (40 date seeds x 28
 * candidates = 1120 assessments, `review/gate/probe-bodies-cal.ts`):
 *
 *   * rung-0 qualifiers under the OLD floor already measure p10 **4.87**, median
 *     5.50 — so 4.0 sits below the tenth percentile of what the search was
 *     picking anyway, and does not fight it.
 *   * it excludes the 20260101 look (2.90) with a full point of margin.
 *   * it costs essentially nothing: 1 seed of 40 moves rung 0 -> rung 1, and the
 *     mean simulations per seed is **unchanged at 3.30** (worst case 9).
 *   * every seed sampled has a candidate at **>= 5.76**, so the floor is never
 *     structurally unreachable — it changes which candidate ships, not whether
 *     one exists.
 *
 * The relaxed rungs below hold **>= 3.0**, so even the loosest rung a date can
 * ship on still excludes the thin look. Only 4.7 % of all candidates fall under
 * 3.0, so the tighter tail costs the ladder almost no headroom.
 */
export const MIN_MEAN_BODIES = 4.0;
export const MIN_FORMED_FRAMES = 120;
/**
 * §13.3's formed-frame expectation: "of the frames in which the generation's
 * biggest body is at or above `FORMED_MIN`, >= 70 % must satisfy `formed`".
 *
 * It is a RATIO, and the ladder previously searched only on the absolute count —
 * so a candidate could carry a long ripe window that was mostly unformed and
 * still qualify, which `checkInvariants` then rejected. Searched here at rung 0
 * on §13.3's own 70 %, and relaxed with the other richness targets below.
 */
export const FORMED_FRAME_FRACTION = 0.70;

/**
 * §13.3's SHIPPED-LOOP acceptance means, and the ONE place they are decided.
 *
 * §13.3 is explicit that these are a different gate from the per-body
 * `FORMED_MONO` / `FORMED_SYM` inside the `formed` predicate, that both must
 * hold, and that a build "may not raise FORMED_SYM to 0.9 to make the acceptance
 * number easier". They are compared at the two decimal places §13.3 quotes them
 * to ("mono 0.93", "symmetry 0.99"), so a run measuring 0.8996 passes: failing on
 * the third decimal would be an artefact of printing.
 *
 * They are tested by the LADDER as well as by the sweep. Before this round only
 * the sweep tested them, so the search could — and on 3 of 24 sampled date seeds
 * did — ship a candidate that `checkInvariants` then rejected. A bound the sweep
 * asserts must be a bound the search can satisfy.
 */
export const SHIPPED_MONO = 0.9, SHIPPED_SYM = 0.9;
export const meetsShippedForm = (r: SoupRun): boolean =>
  Math.round(r.mono * 100) / 100 >= SHIPPED_MONO && Math.round(r.sym * 100) / 100 >= SHIPPED_SYM;

/**
 * §13.4's RELAXATION LADDER. One threshold set plus a fallback is a shipped
 * failure waiting for a date — production regenerates daily, and at the previous
 * calibration 2 of 8 corpus seeds satisfied nothing inside 20 candidates. Rungs
 * are walked in order; each extends the SAME chain further and tests it against
 * slightly looser bounds.
 *
 *   * BAND widens both ways, but its floor never drops below FORMED_MIN — a body
 *     under 40 cells cannot satisfy the soup's own `formed` test at all.
 *   * FORMED FRAMES, POP, BODIES, BONDED, FILL and BARE relax: they are richness
 *     targets. A slightly looser, thinner or more lopsided void on a hard date is
 *     worse than the benchmark, not broken — §13.4's own reasoning for population
 *     and body count. FILL is here because §13.5 pinned a mean floor that the
 *     search had no way to satisfy: on a 61-date sample 2 seeds ship under 2.5 %
 *     purely as arc-to-arc variance, and a bound the sweep asserts must be a
 *     bound the search can meet (§13.5's own open question named this fix first).
 *     BARE is §13.3's whole-width requirement, and it is nearly free: the
 *     candidate population is strongly bimodal — 86 % of all candidates and 88 %
 *     of rung-0 qualifiers already sit at <= 2 %, and the rest are badly bare
 *     (up to 60 %) rather than marginal, so a tight bound rejects the failures
 *     without costing the good candidates.
 *   * The void-fill CEILINGS (`VOID_FILL_MEAN_MAX`, `VOID_FILL_PEAK_MAX`) do not
 *     relax — they are restraint bounds, not richness ones.
 *   * MONO/SYM never relax above the last resort: §13.3 forbids trading them.
 *   * EYES never relaxes above the last resort. A creature is a face.
 *   * EMPTY never relaxes at all. An arc that is not bare at age S pops at the
 *     wrap — the one defect a viewer cannot un-see.
 */
export interface Rung {
  upto: number; grow: [number, number]; formed: number; formedFrac: number;
  pop: [number, number]; bodies: number; bonded: number; fill: number; bare: number;
}

export const RUNGS: readonly Rung[] = [
  { upto: 6, grow: [0, 0], formed: MIN_FORMED_FRAMES, formedFrac: FORMED_FRAME_FRACTION, pop: POP_BAND, bodies: MIN_MEAN_BODIES, bonded: 0.60, fill: 0.025, bare: 0.02 },
  { upto: 12, grow: [-3, 8], formed: 90, formedFrac: 0.62, pop: [120, 360], bodies: 3.6, bonded: 0.55, fill: 0.023, bare: 0.05 },
  { upto: 20, grow: [-5, 18], formed: 60, formedFrac: 0.55, pop: [110, 380], bodies: 3.2, bonded: 0.50, fill: 0.021, bare: 0.10 },
  { upto: 28, grow: [-5, 1e9], formed: 30, formedFrac: 0.45, pop: [100, 420], bodies: 3.0, bonded: 0.45, fill: 0.020, bare: 0.15 },
];

export const rungBand = (band: [number, number], g: [number, number]): [number, number] =>
  [Math.max(SOUP.FORMED_MIN, band[0] + g[0]), band[1] + g[1]];

/**
 * The rung predicate — and, by construction, the whole of what the frame sweep
 * gates. Every bound `timeline.checkInvariants` asserts about the soup is tested
 * here first, on the same statistic, so the search can never hand the sweep a
 * pick the sweep rejects. The population bounds are the per-frame MIN and MAX,
 * not the mean, because that is what the sweep gates: a candidate whose
 * population dips below the floor for part of the loop must not be able to
 * average its way back into band.
 */
export const meets = (r: SoupRun, band: [number, number], rung: Rung): boolean => {
  const [lo, hi] = rungBand(band, rung.grow);
  return r.peak >= lo && r.peak <= hi && r.empty && r.eyes && meetsShippedForm(r)
    && r.minPop >= rung.pop[0] && r.maxPop <= rung.pop[1]
    && r.meanBodies >= rung.bodies
    && r.formedFrames >= rung.formed
    && (!r.ripeFrames || r.formedFrames / r.ripeFrames >= rung.formedFrac)
    && r.bondedMean >= rung.bonded
    && r.fillMean >= rung.fill
    && r.fillMean <= VOID_FILL_MEAN_MAX
    && r.fillPeak <= VOID_FILL_PEAK_MAX
    && r.bareQuarter <= rung.bare;
};

/** Rung 0 — the strict set. */
export const qualifies = (r: SoupRun, band: [number, number]): boolean => meets(r, band, RUNGS[0]);

/**
 * Walk the ladder over a candidate chain reachable through `get`.
 *
 * Each rung raises the candidate budget AND loosens the bounds, but inside a
 * rung's budget the STRICTEST bounds are always tried first — so the ladder never
 * ships a relaxed candidate when a strict one exists at a cost it was already
 * willing to pay. Assessments are cached by the caller, so the whole walk costs
 * exactly `highest candidate index reached + 1` simulations.
 */
export function walkLadder(band: [number, number], budget: number, get: (i: number) => SoupRun):
{ rung: number; cand: number; sims: number } {   // rung -1 => nothing met any rung
  let deepest = -1;
  const fetch = (i: number): SoupRun => { deepest = Math.max(deepest, i); return get(i); };
  for (let k = 0; k < RUNGS.length; k++) {
    const upto = Math.min(RUNGS[k].upto, budget);
    for (let j = 0; j <= k; j++)
      for (let i = 0; i < upto; i++)
        if (meets(fetch(i), band, RUNGS[j])) return { rung: j, cand: i, sims: deepest + 1 };
    if (RUNGS[k].upto >= budget) break;
  }
  return { rung: -1, cand: -1, sims: deepest + 1 };
}

/** §13.4's deterministic hash chain of candidate sub-seeds off the date seed. */
export const subSeeds = (seed: number, n: number): number[] => {
  const chain = mulberry32(seed ^ 0x50a9);
  return Array.from({ length: n }, () => (chain() * 4294967296) >>> 0);
};

export const LADDER_MAX_TRIES = RUNGS[RUNGS.length - 1].upto;

/**
 * Walk the ladder and return the arc that ships. `tries` caps the total number
 * of simulations; the last-resort rung then RANKS whatever was simulated, so
 * this ALWAYS returns a pick for any seed and any `tries >= 1`. Candidates are
 * simulated once and reused across rungs — a rung costs only the candidates it
 * adds. Everything stays a pure function of the date.
 */
export function findSoup(
  seed: number, releaseAt: Map<number, Release[]>, S: number, T: number, colors: readonly string[],
  band: [number, number] = BAND, tries = LADDER_MAX_TRIES,
): SoupPick {
  const budget = Math.max(1, Math.min(tries, LADDER_MAX_TRIES));
  const cands = subSeeds(seed, budget);
  const runs: SoupRun[] = [];
  const simulate = (i: number): SoupRun => {
    while (runs.length <= i)
      runs.push(assess(simulateSoup(mulberry32(cands[runs.length]), releaseAt, S, colors), T));
    return runs[i];
  };

  const hit = walkLadder(band, budget, simulate);
  if (hit.rung >= 0)
    return {
      ...runs[hit.cand], candidate: hit.cand, subSeed: cands[hit.cand],
      qualified: hit.rung === 0, rung: hit.rung, sims: hit.sims,
    };

  // Last resort: nothing met even the loosest rung. Rank what was simulated —
  // seam first (never trade the wrap away), then the longest formed window, then
  // nearest the requested band centre. Deterministic and total.
  const mid = (band[0] + band[1]) / 2;
  const best = runs.map((r, i) => ({ r, i }))
    .sort((a, b) => Number(b.r.empty) - Number(a.r.empty)
      || (b.r.empty ? 0 : a.r.tailEmptyFrom - b.r.tailEmptyFrom)
      || b.r.formedFrames - a.r.formedFrames
      || Math.abs(a.r.peak - mid) - Math.abs(b.r.peak - mid))[0];
  return {
    ...best.r, candidate: best.i, subSeed: cands[best.i],
    qualified: false, rung: RUNGS.length, sims: hit.sims,
  };
}

/**
 * THE FREE-vs-BONDED RATIO KNOBS.
 *
 * Cody, 2026-07-25, on the approved reference: *"looking fantastic, i'd say lean
 * toward having lower ratio of floating pixels vs part of some life form."*
 *
 * ANSWERED, 2026-07-25 (tuning round): `GATHER_RADIUS` 20 -> 40 and
 * `ACCRETE_RATE` 3.0 -> 4.0. Corpus mean bonded fraction 48.8 % -> 67.4 %.
 * `GATHER_RADIUS` is the primary lever by a wide margin and is capped at 40 by
 * §13.3's whole-width requirement rather than by the ratio (see the constant's
 * own comment). The ladder's per-candidate rung-0 qualify rate falls 37.5 % ->
 * 22.9 %, which is the cost of this plus the criteria added alongside it; it is
 * paid in simulations (mean 3.8/seed, worst 12, budget 28), not in quality.
 * Everything else in the list was measured and left alone; the measurements are
 * in the task-2d report.
 *
 * The list stays because composition is now a SEARCHED and GATED property
 * (RUNGS[k].bonded, `timeline.BONDED_MEAN_MIN`), so a future change that
 * quietly dissolves the bodies fails the suite instead of passing quietly — and
 * these are the constants to reach for when it needs moving again. Every one of
 * them lives in the single `SOUP` object above; this is the index.
 *
 *   NUCLEATE_RATE   how readily two free pixels seed a NEW body. Up => more
 *                   bodies competing for the same matter; §13.3 cut it hard
 *                   because a shoal of rival lumps is worse than a small cast.
 *   ACCRETE_RATE    how readily a free pixel joins an EXISTING body on contact.
 *                   The SECOND lever: it converts what the well delivers, so it
 *                   does little on its own (measured: +0 points of bonded
 *                   fraction at 4.0 with the old 20-cell well). Above ~5 contact
 *                   becomes a certainty and the void loses its loose grains.
 *   CAPTURE_RADIUS  how close "contact" has to be before either can fire.
 *   BOND_MAX_SPEED  the relative-speed gate on bonding; raising it lets faster
 *                   passers-by be caught instead of bouncing off.
 *   BONDED_PULL     how much harder bonded matter attracts free matter.
 *   GATHER /        the per-body gravity well: strength and reach. This is what
 *   GATHER_RADIUS   brings stragglers to a body at all in zero g, and
 *                   GATHER_RADIUS is THE PRIMARY composition lever — nothing else
 *                   measured close. It is two-sided: raising it also empties the
 *                   far side of the void, so re-measure `bareQuarter`, not just
 *                   the ratio, before moving it.
 *   STICKY_ACCEL /  the mirror-repair lure — pulls specifically the free pixels
 *   STICKY_PULL_RATE / STICKY_RADIUS   a body needs to complete its symmetry.
 *   MERGE_FREE_SIZE / MERGE_MATURE_RATE   how readily two bodies fuse (moves
 *                   body COUNT more than the ratio, but changes what free matter
 *                   has to attach to).
 *   SHED_RATE       the only rule that returns bonded matter to the soup.
 *   CRUST_MAX /     matter parked on the interface rather than in a body.
 *   CRUST_DWELL_*
 *
 * `bondedFraction` below is the metric to move: it is what "ratio of floating
 * pixels vs part of some life form" means numerically.
 */
export const RATIO_KNOBS = [
  'NUCLEATE_RATE', 'ACCRETE_RATE', 'CAPTURE_RADIUS', 'BOND_MAX_SPEED', 'BONDED_PULL',
  'GATHER', 'GATHER_RADIUS', 'STICKY_ACCEL', 'STICKY_PULL_RATE', 'STICKY_RADIUS',
  'MERGE_FREE_SIZE', 'MERGE_MATURE_RATE', 'SHED_RATE', 'CRUST_MAX', 'CRUST_DWELL_LO', 'CRUST_DWELL_HI',
] as const satisfies readonly (keyof typeof SOUP)[];

/**
 * The composition metric: cluster-member pixels / total void pixels, per loop
 * frame. Crust is counted in the denominator — it is standing void population a
 * viewer sees — but never in the numerator: a pixel stuck to the interface is
 * parked, not part of a life form.
 *
 * Cody, 2026-07-25: *"lean toward having lower ratio of floating pixels vs part
 * of some life form."* This is now a SEARCHED and GATED property, not just a
 * reported one — `assess` puts `bondedMean` on every run, `meets` tests it
 * against `RUNGS[k].bonded`, and `timeline.checkInvariants` gates it at the floor
 * the shipped pick's own rung searched on (`BONDED_MEAN_MIN` is the strict rung's
 * value; a relaxed pick is held to its own).
 */
export function bondedFraction(frames: SoupState[], T: number): { min: number; mean: number; max: number } {
  let min = Infinity, max = 0, sum = 0;
  for (const c of voidCensus(frames, T)) {
    const total = c.free + c.bonded + c.crust;
    const f = total ? c.bonded / total : 0;
    min = Math.min(min, f); max = Math.max(max, f); sum += f;
  }
  return { min: Number.isFinite(min) ? min : 0, mean: sum / T, max };
}

/** §13.5's void-fill ceilings. Defined here, beside the measurement, so the
 * ladder can test them without importing the sweep. The FLOOR is `RUNGS[k].fill`
 * — it relaxes, these do not. */
export const VOID_FILL_PEAK_MAX = 0.06;
export const VOID_FILL_MEAN_MAX = 0.06;

/**
 * §13.3's whole-width requirement, measured the way it READS: the void split into
 * four vertical quarters, a quarter counted **bare** in a frame when it holds
 * fewer than `BARE_QUARTER_CELLS` distinct occupied cells.
 *
 * The obvious metric — each quarter's share of the *particles* — is wrong here,
 * and measuring it that way cost this project a whole tuning round: a 50-cell
 * body sitting in the far quarter contributes 50 particles and reads as one
 * object, so a void that had visibly emptied scored as better spread than the one
 * it replaced. Distinct cells, per quarter, is what a viewer sees.
 */
export const VOID_QUARTERS = 4;
export const BARE_QUARTER_CELLS = 2;

/**
 * §13.5's void fill and §13.3's whole-width spread, in one pass.
 *
 * `fill[t]` is the DISTINCT occupied cells inside the void at loop frame `t`, as
 * a fraction of the void's own cells; crust sits on the board's interface at
 * `x = BOARD_RIGHT`, so it is not a void cell and is not counted. `bareQuarter`
 * is the worst quarter's share of frames in which it is bare.
 *
 * The single definition of both measurements — `assess` (so the ladder can search
 * on them), `timeline.checkInvariants` (so the gates are on the same numbers) and
 * `timeline.measureTraffic` all read them here rather than each counting cells
 * their own way.
 */
export function voidOccupancy(frames: SoupState[], T: number): { fill: number[]; bareQuarter: number } {
  const W = VOID_X1 - VOID_X0 + 1;
  const fill: number[] = [];
  const bare = new Array<number>(VOID_QUARTERS).fill(0);
  for (let t = 0; t < T; t++) {
    // The quarters partition the void by x, so their cell sets are disjoint and
    // the whole-void count is just their sum.
    const q = Array.from({ length: VOID_QUARTERS }, () => new Set<string>());
    for (const age of visibleAges(t, T))
      for (const p of frames[age].parts) {
        const x = Math.round(p.x), y = Math.round(p.y);
        if (x < VOID_X0 || x > VOID_X1 || y < VOID_Y0 || y > VOID_Y1) continue;
        q[Math.min(VOID_QUARTERS - 1, Math.floor(((x - VOID_X0) / W) * VOID_QUARTERS))].add(`${x},${y}`);
      }
    let total = 0;
    for (let i = 0; i < VOID_QUARTERS; i++) {
      total += q[i].size;
      if (q[i].size < BARE_QUARTER_CELLS) bare[i]++;
    }
    fill.push(total / VOID_CELLS);
  }
  return { fill, bareQuarter: Math.max(...bare) / T };
}

/** §13.5's void fill per loop frame — `voidOccupancy`'s fill series. */
export const voidFillPerFrame = (frames: SoupState[], T: number): number[] =>
  voidOccupancy(frames, T).fill;

/**
 * §13.5's standing void population, per LOOP frame — and the ONE definition of
 * it. "Standing population is the per-frame minimum and maximum, not the mean —
 * it is what §13.5's sweep gates, and a candidate that dips out of band for part
 * of the loop must not be able to average its way back in."
 *
 * `assess` (so the ladder searches on it), `timeline.checkInvariants` (so the
 * gate reads the same statistic the search did) and `timeline.measureTraffic`
 * (so the report agrees with both) all call this rather than each summing the
 * visible ages their own way — three copies of one loop is three chances for
 * the searched and the gated number to drift apart.
 */
export function voidPopulation(frames: SoupState[], T: number): { min: number; mean: number; max: number } {
  let min = Infinity, max = 0, sum = 0;
  for (let t = 0; t < T; t++) {
    let pop = 0;
    for (const age of visibleAges(t, T)) pop += frames[age].parts.length + frames[age].crust.length;
    min = Math.min(min, pop); max = Math.max(max, pop); sum += pop;
  }
  return { min: Number.isFinite(min) ? min : 0, mean: sum / T, max };
}

/** Void population at each loop frame — the standing-population check (§13.5). */
export function voidCensus(frames: SoupState[], T: number): { free: number; bonded: number; crust: number; body: number }[] {
  return Array.from({ length: T }, (_, t) => {
    let free = 0, bonded = 0, crust = 0, body = 0;
    for (const age of visibleAges(t, T)) {
      const st = frames[age];
      free += st.parts.filter(p => p.cluster < 0).length;
      bonded += st.parts.filter(p => p.cluster >= 0).length;
      crust += st.crust.length;
      body = Math.max(body, biggestCluster(st));
    }
    return { free, bonded, crust, body };
  });
}
