import { type FileShareSettings, fileShareSettingsOf } from "@restow/core";
import { settings } from "@restow/db";
import { db } from "../../db.js";

/**
 * The installation's file share settings (docs/FILESHARES.md 7.4) as the api needs them (the
 * budgets of the restic route), cached briefly: the restic route asks on every upload.
 */
const TTL_MS = 30_000;
let cached: { value: FileShareSettings; at: number } | null = null;

export async function fileShareSettings(now = Date.now()): Promise<FileShareSettings> {
  if (cached && now - cached.at < TTL_MS) {
    return cached.value;
  }
  const [row] = await db
    .select({ fileShareSettings: settings.fileShareSettings })
    .from(settings)
    .limit(1);
  const value = fileShareSettingsOf(row?.fileShareSettings ?? {});
  cached = { value, at: now };
  return value;
}

/** Forget the cached settings (tests, and after they changed). */
export function forgetFileShareSettings(): void {
  cached = null;
}
