/**
 * Which objects of a snapshot a verify run reads back.
 *
 * docs/TESTING.md fixes the weekly proof at 20 mails and 20 files drawn at
 * random from the latest snapshot. Mailboxes also carry calendar and contact
 * items; they are restored by different code paths, so a smaller share of
 * them is drawn as well. A health check reads every object instead.
 *
 * Only objects that hold content are eligible: folders, placeholders
 * (OneNote packages, shortcuts), historical file versions and attachments of
 * split messages are either empty or verified through their parent.
 */
import type { ManifestObject } from "../manifest.js";
import { objectTypeOf } from "../restore/conventions.js";
import { type RandomSource, pickRandom } from "./random.js";

export const SAMPLE_CATEGORIES = ["mail", "file", "event", "contact"] as const;

export type SampleCategory = (typeof SAMPLE_CATEGORIES)[number];

/** How many objects to draw per category. */
export type SampleQuota = Readonly<Record<SampleCategory, number>>;

/** Per-category counts (eligible objects, sampled objects, ...). */
export type CategoryCounts = Record<SampleCategory, number>;

/** docs/TESTING.md: 20 mails and 20 files per weekly run. */
export const DEFAULT_SAMPLE_SIZE = 20;

/** Calendar and contact items are drawn at this fraction of the main quota. */
const SECONDARY_SHARE = 0.25;

/** The sampling category of a manifest object, or null when it carries no content of its own. */
export function sampleCategoryOf(object: ManifestObject): SampleCategory | null {
  if (object.chunks.length === 0 || object.size <= 0) {
    return null;
  }
  switch (objectTypeOf(object)) {
    case "mail":
      return "mail";
    case "file":
      return "file";
    case "event":
      return "event";
    case "contact":
      return "contact";
    default:
      return null;
  }
}

/** The quota for a requested sample size: full size for mails and files, a quarter for the rest. */
export function quotaFor(sampleSize: number = DEFAULT_SAMPLE_SIZE): SampleQuota {
  const main = Math.max(1, Math.floor(sampleSize));
  const secondary = Math.max(1, Math.ceil(main * SECONDARY_SHARE));
  return { mail: main, file: main, event: secondary, contact: secondary };
}

export function emptyCounts(): CategoryCounts {
  return { mail: 0, file: 0, event: 0, contact: 0 };
}

export interface SampledObject {
  readonly category: SampleCategory;
  readonly object: ManifestObject;
}

export interface SamplePlan {
  /** Objects to read back, grouped by category in snapshot order. */
  readonly items: readonly SampledObject[];
  /** How many eligible objects the snapshot holds per category. */
  readonly eligible: CategoryCounts;
}

/** Group a snapshot's eligible objects by category, in snapshot order. */
export function eligibleObjects(
  objects: readonly ManifestObject[],
): Record<SampleCategory, ManifestObject[]> {
  const groups: Record<SampleCategory, ManifestObject[]> = {
    mail: [],
    file: [],
    event: [],
    contact: [],
  };
  for (const object of objects) {
    const category = sampleCategoryOf(object);
    if (category) {
      groups[category].push(object);
    }
  }
  return groups;
}

function countsOf(groups: Record<SampleCategory, ManifestObject[]>): CategoryCounts {
  const counts = emptyCounts();
  for (const category of SAMPLE_CATEGORIES) {
    counts[category] = groups[category].length;
  }
  return counts;
}

/** Draw a random sample: up to `quota[category]` objects per category. */
export function planSample(
  objects: readonly ManifestObject[],
  quota: SampleQuota,
  random: RandomSource,
): SamplePlan {
  const groups = eligibleObjects(objects);
  const items: SampledObject[] = [];
  for (const category of SAMPLE_CATEGORIES) {
    for (const object of pickRandom(groups[category], quota[category], random)) {
      items.push({ category, object });
    }
  }
  return { items, eligible: countsOf(groups) };
}

/** Every eligible object (health check). */
export function planFull(objects: readonly ManifestObject[]): SamplePlan {
  const groups = eligibleObjects(objects);
  const items: SampledObject[] = [];
  for (const category of SAMPLE_CATEGORIES) {
    for (const object of groups[category]) {
      items.push({ category, object });
    }
  }
  return { items, eligible: countsOf(groups) };
}
