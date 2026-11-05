/**
 * What a snapshot holds besides its structure: the bytes and the number of objects that are
 * not folders or placeholders (packages, shortcuts). Zero bytes is an empty object (an empty
 * mailbox or OneDrive), which the restore check rates on its own (verify/readiness.ts).
 */
import type { ManifestObject } from "../manifest.js";
import { objectTypeOf } from "../restore/conventions.js";

/** Object types that structure a snapshot but hold no content of their own. */
const STRUCTURE_TYPES: ReadonlySet<string> = new Set(["folder", "package", "shortcut"]);

/** What a snapshot holds besides folders and placeholders: bytes and objects. */
export function contentOf(
  source: { readonly objects: Iterable<ManifestObject> } | Iterable<ManifestObject>,
): {
  bytes: number;
  objects: number;
} {
  const objects = Symbol.iterator in source ? source : source.objects;
  let bytes = 0;
  let count = 0;
  for (const object of objects) {
    if (STRUCTURE_TYPES.has(objectTypeOf(object))) {
      continue;
    }
    count += 1;
    bytes += Math.max(0, object.size);
  }
  return { bytes, objects: count };
}
