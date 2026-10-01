/**
 * Reproducible randomness for sampling.
 *
 * A verify run draws its sample from a seeded generator and records the seed
 * in its report, so the exact choice of items can be replayed when a finding
 * needs to be investigated. The seed itself comes from the OS CSPRNG; the
 * generator only has to spread picks evenly, not resist prediction.
 */
import { randomBytes } from "node:crypto";

/** A source of uniformly distributed numbers in [0, 1). */
export type RandomSource = () => number;

/** A fresh 32-bit seed from the operating system's CSPRNG. */
export function newSeed(): number {
  return randomBytes(4).readUInt32BE(0);
}

/** mulberry32: small, fast and well distributed; identical output for identical seeds. */
export function seededRandom(seed: number): RandomSource {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A uniformly distributed integer in [0, bound). */
export function randomIndex(random: RandomSource, bound: number): number {
  return Math.min(bound - 1, Math.floor(random() * bound));
}

/**
 * Pick `count` distinct items uniformly at random (partial Fisher-Yates). The
 * result keeps the items' original order, so reports list them the way the
 * snapshot does rather than in draw order.
 */
export function pickRandom<T>(items: readonly T[], count: number, random: RandomSource): T[] {
  const wanted = Math.max(0, Math.min(Math.floor(count), items.length));
  if (wanted === items.length) {
    return [...items];
  }
  const indexes = items.map((_, index) => index);
  for (let i = 0; i < wanted; i++) {
    const j = i + randomIndex(random, indexes.length - i);
    [indexes[i], indexes[j]] = [indexes[j], indexes[i]];
  }
  return indexes
    .slice(0, wanted)
    .sort((a, b) => a - b)
    .map((index) => items[index]);
}
