/**
 * Reconciliation of folder sets (calendars, contact folders) against the
 * objects a snapshot already holds, plus the JSON item store shared by the
 * calendar and contacts phases.
 */
import { createHash } from "node:crypto";
import type { ManifestObject } from "../../manifest.js";
import { rebasePath } from "./paths.js";
import {
  type BackupRun,
  type ExchangeObjectType,
  FOLDERS_GROUP,
  META,
  OBJECT_TYPES,
} from "./run.js";

export interface GroupFolder {
  /** Stable key of the folder (Graph id; `""` for the default contacts folder). */
  readonly key: string;
  readonly path: string;
  readonly object: ManifestObject;
  /** Location metadata of the folder's items (`folderPath`, ...), applied when the folder moves. */
  readonly itemMetadata: Record<string, string>;
}

export interface ReconcileGroupFoldersInput {
  /** Group prefix as used by {@link groupOf}, e.g. `calendar:`. */
  readonly groupPrefix: string;
  /** `folderKind` metadata value of these folders' objects. */
  readonly folderKind: string;
  /** Metadata key that holds the folder key on a folder object. */
  readonly keyMetadata: string;
  readonly current: readonly GroupFolder[];
  /** Folder key -> path as the previous run recorded it. */
  readonly previousPaths: Record<string, string>;
}

/**
 * Remove what belongs to vanished folders, re-path the contents of renamed
 * folders, and (re)write every current folder object. Returns the new
 * key -> path map for the engine state.
 */
export function reconcileGroupFolders(
  run: BackupRun,
  input: ReconcileGroupFoldersInput,
): Record<string, string> {
  const current = new Map(input.current.map((folder) => [folder.key, folder]));

  for (const group of run.index.groups(input.groupPrefix)) {
    if (!current.has(group.slice(input.groupPrefix.length))) {
      removeGroupItems(run, group);
    }
  }
  for (const member of run.index.members(FOLDERS_GROUP)) {
    const metadata = member.metadata ?? {};
    if (metadata[META.folderKind] !== input.folderKind) {
      continue;
    }
    if (!current.has(metadata[input.keyMetadata] ?? "")) {
      run.index.removePath(member.path);
    }
  }

  // Two phases so that swapped names (A -> B, B -> A) never overwrite each other.
  const moves: ManifestObject[] = [];
  for (const folder of input.current) {
    const previous = input.previousPaths[folder.key];
    if (previous === undefined || previous === folder.path) {
      continue;
    }
    for (const member of run.index.members(`${input.groupPrefix}${folder.key}`)) {
      run.index.removePath(member.path);
      moves.push({
        ...member,
        path: rebasePath(member.path, previous, folder.path),
        metadata: { ...(member.metadata ?? {}), ...folder.itemMetadata },
      });
    }
  }
  for (const moved of moves) {
    run.index.put(moved);
    run.counters.updated++;
  }

  const paths: Record<string, string> = {};
  for (const folder of input.current) {
    run.index.put(folder.object);
    paths[folder.key] = folder.path;
  }
  return paths;
}

/** Remove every item of a group (its folder no longer exists). */
export function removeGroupItems(run: BackupRun, group: string): void {
  for (const member of run.index.members(group)) {
    run.removeItem(member);
  }
}

export interface JsonItem {
  readonly type: Extract<ExchangeObjectType, "event" | "contact">;
  readonly id: string;
  readonly path: string;
  readonly mtime: number;
  readonly metadata: Record<string, string>;
  readonly payload: unknown;
}

/**
 * Store a Graph resource as a JSON object. The fingerprint is the digest of
 * the exact bytes, so an unchanged item is carried forward without touching
 * the chunk store and a changed one is rewritten (deduplicated per chunk).
 */
export async function storeJsonItem(
  run: BackupRun,
  item: JsonItem,
): Promise<"written" | "updated" | "unchanged"> {
  const bytes = Buffer.from(JSON.stringify(item.payload), "utf8");
  const fingerprint = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  const metadata: Record<string, string> = {
    ...item.metadata,
    [META.format]: "json",
    [META.contentType]: "application/json",
    [META.fingerprint]: fingerprint,
  };
  const existing = run.index.get(item.type, item.id);
  if (run.reusable(existing, fingerprint)) {
    return run.carryForward(existing, { path: item.path, mtime: item.mtime, metadata });
  }
  await run.storeBytes(bytes, {
    path: item.path,
    id: item.id,
    type: item.type,
    mtime: item.mtime,
    metadata,
  });
  return "written";
}

/** Drop the items of a group that a complete listing did not mention. */
export function removeUnseenItems(
  run: BackupRun,
  group: string,
  type: ExchangeObjectType,
  seen: ReadonlySet<string>,
): void {
  for (const member of run.index.members(group)) {
    if (member.type === type && member.id !== undefined && !seen.has(member.id)) {
      run.removeItem(member);
    }
  }
}

/** A folder object without content. */
export function folderObjectAt(
  path: string,
  id: string | undefined,
  metadata: Record<string, string>,
): ManifestObject {
  return {
    path,
    ...(id !== undefined ? { id } : {}),
    type: OBJECT_TYPES.folder,
    size: 0,
    mtime: 0,
    chunks: [],
    metadata,
  };
}
