/**
 * Deterministic seeded PRNG (mulberry32) used by StubAdapter's synthetic price walk and
 * placement-ambiguity simulation. A seeded stream is used specifically so a stub-paper soak run
 * is reproducible if something fails — same seed, same call sequence, same fills/prices every
 * time, unlike N1PaperAdapter's real-trade-tape-driven behavior which can't be replayed exactly.
 */
export type SeededRng = () => number;

/** Returns a function producing numbers in [0, 1), seeded deterministically from `seed`. */
export function createSeededRng(seed: number): SeededRng {
  let state = seed >>> 0;
  return function next(): number {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), state | 1);
    t = (t + Math.imul(t ^ (t >>> 7), t | 61)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
