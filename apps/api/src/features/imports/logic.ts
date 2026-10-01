import { mailfiles } from "@restow/core";
import { normalizeFolderPath } from "./schemas.js";

/** Pure helpers of the import feature (no I/O), unit tested on their own. */

/** Run `work` over `items` with at most `limit` in flight; results keep the input order. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index] as T);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Effective segment size for an upload: the client's proposal, never above the server's setting. */
export function effectiveSegmentSize(requested: number | undefined, serverSetting: number): number {
  const wanted = requested === undefined ? serverSetting : Math.min(requested, serverSetting);
  return mailfiles.clampSegmentSize(wanted);
}

/** A directory that is selected together with something inside it would be read twice. */
export function findOverlappingFolderEntries(paths: readonly string[]): [string, string] | null {
  const normalized = paths.map(normalizeFolderPath);
  for (const outer of normalized) {
    for (const inner of normalized) {
      if (outer === inner) {
        continue;
      }
      if (outer === "" || inner.startsWith(`${outer}/`)) {
        return [outer, inner];
      }
    }
  }
  return null;
}

/**
 * A tenant's server-side import folder is the subdirectory `<IMPORT_DIR>/<tenant slug>/`:
 * tenants never see each other's files. The slug is a URL-safe name (lowercase letters,
 * digits and single hyphens); anything else is refused so it can never act as a path.
 */
export function assertSafeTenantSlug(slug: string): void {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw new Error("the tenant slug is not usable as a folder name");
  }
}

/**
 * How a folder path is stored in `mail_imports.files`: relative to the import folder,
 * with the tenant's `<slug>/` prefix (the worker resolves against IMPORT_DIR and refuses a
 * path outside the tenant's own subdirectory). `relative` is tenant-relative; "" is the
 * tenant's folder itself.
 */
export function storedFolderPath(slug: string, relative: string): string {
  return `${slug}/${normalizeFolderPath(relative)}`;
}

/** The tenant-relative form of a stored folder path ("" for the tenant's folder itself). */
export function tenantRelativeFolderPath(slug: string, stored: string): string {
  if (stored === slug || stored === `${slug}/`) {
    return "";
  }
  return stored.startsWith(`${slug}/`) ? stored.slice(slug.length + 1) : stored;
}
