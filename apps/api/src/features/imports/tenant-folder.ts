import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { mailfiles } from "@restow/core";
import { assertSafeTenantSlug } from "./logic.js";

/**
 * A tenant's view of the server-side import folder (docs/IMPORT.md): the
 * subdirectory `<IMPORT_DIR>/<tenant slug>/`, always, also on a single-tenant
 * installation. Everything a tenant lists, selects or imports is resolved
 * against this directory with {@link mailfiles.ImportFolder}, so neither `..`
 * nor a link inside it can reach a sibling tenant's folder.
 */
export interface TenantFolder {
  /** `<IMPORT_DIR>/<slug>`, for display. */
  readonly path: string;
  /** IMPORT_DIR itself is a readable directory (the feature is available on this server). */
  readonly enabled: boolean;
  /** The tenant's subdirectory exists. False while it is missing or is itself a link elsewhere. */
  readonly exists: boolean;
  /** Rooted at the tenant's directory; null unless it exists. */
  readonly folder: mailfiles.ImportFolder | null;
}

export async function openTenantFolder(importDir: string, slug: string): Promise<TenantFolder> {
  assertSafeTenantSlug(slug);
  const path = join(importDir, slug);
  if (!(await new mailfiles.ImportFolder(importDir).isAvailable())) {
    return { path, enabled: false, exists: false, folder: null };
  }
  try {
    // A tenant directory that is a link (to a sibling tenant's folder, say) is not the tenant's own.
    const [realRoot, realTenant] = await Promise.all([realpath(importDir), realpath(path)]);
    if (realTenant !== join(realRoot, slug)) {
      return { path, enabled: true, exists: false, folder: null };
    }
  } catch {
    return { path, enabled: true, exists: false, folder: null };
  }
  const folder = new mailfiles.ImportFolder(path);
  return (await folder.isAvailable())
    ? { path, enabled: true, exists: true, folder }
    : { path, enabled: true, exists: false, folder: null };
}
