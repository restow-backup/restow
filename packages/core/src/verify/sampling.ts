/**
 * Which objects of a snapshot a verify run reads back.
 *
 * docs/TESTING.md fixes the weekly proof at 20 mails and 20 files drawn at
 * random from the latest snapshot. Mailboxes also carry calendar and contact
 * items; they are restored by different code paths, so a smaller share of
 * them is drawn as well. A health check reads every object instead.
 *
 * Only objects that hold content are eligible: folders and placeholders
 * (OneNote packages, shortcuts) are not. The attachments of a message stored as
 * JSON parts (a message too large for MIME, backup/exchange/mail.ts) and the
 * historical versions of a OneDrive file are separate objects with chunks of
 * their own: they are not drawn on their own but read back as `parts` of their
 * message or file, and a part that fails fails the item (0.5.0; before, they
 * were never read, not even by a health check). A health check reads every
 * part, an attachment or version whose owner the snapshot does not name too.
 *
 * A SharePoint site also records its own metadata (`site.json`), its lists'
 * schemas and their items as JSON objects with chunks of their own: they are
 * read back like any other object (category `site`, a small share like the
 * calendar items), so a site whose content is only that is verified too. They
 * are never handed to a test restore (engine.ts): site metadata and list
 * schemas are recorded as information, not restored.
 */
import { SITE_OBJECT_TYPES } from "../backup/sharepoint/layout.js";
import type { ManifestObject } from "../manifest.js";
import { objectTypeOf } from "../restore/conventions.js";
import { pickRandom, type RandomSource } from "./random.js";

export const SAMPLE_CATEGORIES = ["mail", "file", "event", "contact", "site"] as const;

export type SampleCategory = (typeof SAMPLE_CATEGORIES)[number];

/** How many objects to draw per category. */
export type SampleQuota = Readonly<Record<SampleCategory, number>>;

/** Per-category counts (eligible objects, sampled objects, ...). */
export type CategoryCounts = Record<SampleCategory, number>;

/** docs/TESTING.md: 20 mails and 20 files per weekly run. */
export const DEFAULT_SAMPLE_SIZE = 20;

/** Calendar, contact and site items are drawn at this fraction of the main quota. */
const SECONDARY_SHARE = 0.25;

/** The JSON objects a SharePoint site records besides its libraries' files. */
const SITE_TYPES: ReadonlySet<string> = new Set(Object.values(SITE_OBJECT_TYPES));

/** Categories a test restore can put into a target; site objects are read back only. */
export const PROBE_CATEGORIES: ReadonlySet<SampleCategory> = new Set([
  "mail",
  "file",
  "event",
  "contact",
]);

/** The sampling category of a manifest object, or null when it carries no content of its own. */
export function sampleCategoryOf(object: ManifestObject): SampleCategory | null {
  if (object.chunks.length === 0 || object.size <= 0) {
    return null;
  }
  if (object.type !== undefined && SITE_TYPES.has(object.type)) {
    return "site";
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

/**
 * The quota for a requested sample size: full size for mails and files, a quarter (at least
 * one) for the rest, so a site that holds nothing but `site.json` still has that read back.
 */
export function quotaFor(sampleSize: number = DEFAULT_SAMPLE_SIZE): SampleQuota {
  const main = Math.max(1, Math.floor(sampleSize));
  const secondary = Math.max(1, Math.ceil(main * SECONDARY_SHARE));
  return { mail: main, file: main, event: secondary, contact: secondary, site: secondary };
}

export function emptyCounts(): CategoryCounts {
  return { mail: 0, file: 0, event: 0, contact: 0, site: 0 };
}

export interface SampledObject {
  readonly category: SampleCategory;
  readonly object: ManifestObject;
  /**
   * Objects read back with this one, whose failure counts against it: the attachments of a
   * JSON-format message, the historical versions of a file.
   */
  readonly parts?: readonly ManifestObject[];
}

/** Whether an object carries content to read back (chunks and a size). */
function hasContent(object: ManifestObject): boolean {
  return object.chunks.length > 0 && object.size > 0;
}

const VERSION_MARKER = ":versions/";

/**
 * The parts of a snapshot's objects by the path of their owner: attachments by their message
 * (`messagePath`, or `messageItemId` resolved through the messages' ids, as
 * RestoreCatalog.attachmentOwner does), file versions by their file (`<file>:versions/<id>`).
 * Parts whose owner is not an item of its own (not in the snapshot, or without content: a file
 * emptied to 0 bytes whose versions hold the real data) are returned separately, so a health
 * check still reads them.
 */
export function partsByOwner(objects: readonly ManifestObject[]): {
  readonly byOwner: ReadonlyMap<string, readonly ManifestObject[]>;
  readonly orphans: readonly SampledObject[];
} {
  // Only owners that are read as items themselves (planSample, planFull draw eligible ones).
  const paths = new Set<string>();
  const pathById = new Map<string, string>();
  for (const object of objects) {
    if (sampleCategoryOf(object) !== null) {
      paths.add(object.path);
    }
    const kind = objectTypeOf(object);
    if (kind === "mail" && object.id !== undefined) {
      pathById.set(object.id, object.path);
    }
  }
  const byOwner = new Map<string, ManifestObject[]>();
  const orphans: SampledObject[] = [];
  for (const object of objects) {
    const kind = objectTypeOf(object);
    if ((kind !== "attachment" && kind !== "version") || !hasContent(object)) {
      continue;
    }
    let owner: string | undefined;
    if (kind === "attachment") {
      const metadata = object.metadata ?? {};
      const byPath = metadata.messagePath?.trim();
      const byId = metadata.messageItemId?.trim();
      owner = byPath ? byPath : byId ? pathById.get(byId) : undefined;
    } else {
      const at = object.path.lastIndexOf(VERSION_MARKER);
      owner = at > 0 ? object.path.slice(0, at) : undefined;
    }
    if (owner !== undefined && paths.has(owner)) {
      const list = byOwner.get(owner);
      if (list) {
        list.push(object);
      } else {
        byOwner.set(owner, [object]);
      }
    } else {
      orphans.push({ category: kind === "attachment" ? "mail" : "file", object });
    }
  }
  return { byOwner, orphans };
}

/**
 * Versions of one sampled file a sample reads: the newest, the oldest and one more drawn at
 * random. OneDrive keeps up to 500 versions and the backup stores them all: reading every one
 * of a sampled 1 GB file would read hundreds of GB and let the quota bound nothing. A health
 * check reads them all ({@link planFull}).
 */
export const SAMPLED_VERSIONS_PER_FILE = 3;

function withParts(
  item: SampledObject,
  byOwner: ReadonlyMap<string, readonly ManifestObject[]>,
  random?: RandomSource,
): SampledObject {
  const all = byOwner.get(item.object.path);
  if (!all || all.length === 0) {
    return item;
  }
  return { ...item, parts: random ? boundedParts(all, random) : all };
}

/** A sample's share of a file's versions (attachments of a message are all read). */
function boundedParts(parts: readonly ManifestObject[], random: RandomSource): ManifestObject[] {
  const versions = parts.filter((part) => objectTypeOf(part) === "version");
  if (versions.length <= SAMPLED_VERSIONS_PER_FILE) {
    return [...parts];
  }
  const byAge = [...versions].sort((a, b) => a.mtime - b.mtime || a.path.localeCompare(b.path));
  const oldest = byAge[0] as ManifestObject;
  const newest = byAge[byAge.length - 1] as ManifestObject;
  const between = pickRandom(byAge.slice(1, -1), SAMPLED_VERSIONS_PER_FILE - 2, random);
  const kept = new Set<ManifestObject>([newest, oldest, ...between]);
  return parts.filter((part) => objectTypeOf(part) !== "version" || kept.has(part));
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
    site: [],
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
  const { byOwner } = partsByOwner(objects);
  const items: SampledObject[] = [];
  for (const category of SAMPLE_CATEGORIES) {
    for (const object of pickRandom(groups[category], quota[category], random)) {
      items.push(withParts({ category, object }, byOwner, random));
    }
  }
  return { items, eligible: countsOf(groups) };
}

/**
 * Every object with content (health check): each eligible object with its parts, and the
 * attachments and versions whose owner the snapshot does not name as items of their own.
 */
export function planFull(objects: readonly ManifestObject[]): SamplePlan {
  const groups = eligibleObjects(objects);
  const { byOwner, orphans } = partsByOwner(objects);
  const items: SampledObject[] = [];
  for (const category of SAMPLE_CATEGORIES) {
    for (const object of groups[category]) {
      items.push(withParts({ category, object }, byOwner));
    }
  }
  const eligible = countsOf(groups);
  for (const orphan of orphans) {
    items.push(orphan);
    eligible[orphan.category]++;
  }
  return { items, eligible };
}
