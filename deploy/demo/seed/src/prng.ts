/**
 * A small, dependency-free deterministic pseudo-random generator
 * (mulberry32) for the synthetic mail generator: the same numeric seed
 * always produces the same corpus, byte for byte, which is what
 * generate-mail.test.ts checks. Not for anything security-sensitive.
 */
export type Rng = () => number;

/** A `Rng` seeded from a 32-bit integer; call it to get the next float in [0, 1). */
export function mulberry32(seed: number): Rng {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A 32-bit seed derived from a text string (FNV-1a), so callers can seed with a name. */
export function seedFrom(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** A random integer in [min, max], inclusive. */
export function randomInt(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

/** A uniformly picked element of `items` (must be non-empty). */
export function pick<T>(rng: Rng, items: readonly T[]): T {
  const item = items[randomInt(rng, 0, items.length - 1)];
  if (item === undefined) {
    throw new Error("pick() needs a non-empty list");
  }
  return item;
}

/** True with probability `p` (0..1). */
export function chance(rng: Rng, p: number): boolean {
  return rng() < p;
}
