/**
 * How a SharePoint site lies in its snapshot (one manifest per site):
 *
 *   site.json                          type `site-info`: the site's own metadata,
 *                                      its libraries (with their root sharing
 *                                      permissions) and lists
 *   Libraries/<library>                type `folder`, `metadata.siteRole` = library,
 *                                      `metadata.driveId` names the drive
 *   Libraries/<library>/...            the library exactly as the OneDrive engine
 *                                      records a drive: files, folders, shortcuts,
 *                                      historical versions (`<file>:versions/<id>`)
 *   Lists/<list>                       type `folder`, `metadata.siteRole` = list,
 *                                      `metadata.listId` names the list
 *   Lists/<list>/_list.json            type `list-schema`: the list and its columns
 *   Lists/<list>/<title> (<id>).json   type `list-item`: one item with all field
 *                                      values as JSON (`expand=fields`)
 *
 * Folder names are the library's and list's display names made safe for a
 * path (no `/`, no `:`) and unique within the site; the ids in the metadata are
 * what restore and the next backup go by, so a renamed library or list keeps
 * its history. Pure functions, no I/O.
 */
import type { ManifestObject } from "../../manifest.js";

/** `ManifestObject.type` values the SharePoint engine adds to the drive vocabulary. */
export const SITE_OBJECT_TYPES = {
  info: "site-info",
  listSchema: "list-schema",
  listItem: "list-item",
} as const;

/** `metadata.siteRole` of the folders (and items) that structure a site's snapshot. */
export const SITE_ROLES = {
  library: "library",
  list: "list",
  listItem: "listItem",
} as const;

export const SITE_INFO_PATH = "site.json";
export const LIBRARIES_FOLDER = "Libraries";
export const LISTS_FOLDER = "Lists";
export const LIST_SCHEMA_NAME = "_list.json";

/** A display name as one path segment: no separators, never empty. */
export function safeSegment(name: string | null | undefined, fallback = "Untitled"): string {
  const cleaned = (name ?? "")
    .replace(/[/\\:]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length === 0 || cleaned === "." || cleaned === ".." ? fallback : cleaned;
}

/**
 * Unique folder names for named things, in the order given: a second
 * "Documents" becomes "Documents (2)". Matching is case-insensitive, as
 * SharePoint's own names are.
 */
export function uniqueSegments<T>(
  entries: readonly T[],
  nameOf: (entry: T) => string | null | undefined,
): Map<T, string> {
  const taken = new Set<string>();
  const result = new Map<T, string>();
  for (const entry of entries) {
    const base = safeSegment(nameOf(entry));
    let candidate = base;
    for (let n = 2; taken.has(candidate.toLowerCase()); n++) {
      candidate = `${base} (${n})`;
    }
    taken.add(candidate.toLowerCase());
    result.set(entry, candidate);
  }
  return result;
}

export function libraryPath(folder: string): string {
  return `${LIBRARIES_FOLDER}/${folder}`;
}

export function listPath(folder: string): string {
  return `${LISTS_FOLDER}/${folder}`;
}

export function listSchemaPath(folder: string): string {
  return `${listPath(folder)}/${LIST_SCHEMA_NAME}`;
}

/** Longest title kept in an item's file name. */
const MAX_TITLE_IN_NAME = 80;

/**
 * `Lists/<list>/<title> (<id>).json`: readable in the explorer and a ZIP, unique
 * through the id. The title is only a label; restore goes by `metadata.listItemId`.
 */
export function listItemPath(folder: string, itemId: string, title?: string | null): string {
  const label = safeSegment(title?.slice(0, MAX_TITLE_IN_NAME), "Item");
  return `${listPath(folder)}/${label} (${itemId}).json`;
}

/** Manifest id of a list item (drive item ids and list item ids never collide this way). */
export function listItemObjectId(listId: string, itemId: string): string {
  return `list:${listId}:${itemId}`;
}

/** Where an object of a site snapshot belongs. */
export type SiteArea =
  | { readonly area: "info" }
  | { readonly area: "library"; readonly folder: string; readonly rest: string }
  | { readonly area: "list"; readonly folder: string; readonly rest: string };

/**
 * The area of a site snapshot path: `rest` is the path below the library or
 * list folder ("" for the folder itself). Null for anything else.
 */
export function siteAreaOf(path: string): SiteArea | null {
  if (path === SITE_INFO_PATH) {
    return { area: "info" };
  }
  const [top, folder, ...rest] = path.split("/");
  if (folder === undefined || folder.length === 0) {
    return null;
  }
  if (top === LIBRARIES_FOLDER) {
    return { area: "library", folder, rest: rest.join("/") };
  }
  if (top === LISTS_FOLDER) {
    return { area: "list", folder, rest: rest.join("/") };
  }
  return null;
}

/** The objects of one library or list folder with paths relative to it (the folder itself left out). */
export function objectsBelow(objects: Iterable<ManifestObject>, prefix: string): ManifestObject[] {
  const head = `${prefix}/`;
  const result: ManifestObject[] = [];
  for (const object of objects) {
    if (object.path.startsWith(head)) {
      result.push({ ...object, path: object.path.slice(head.length) });
    }
  }
  return result;
}

/** Objects relative to a folder, placed below it again. */
export function prefixObjects(objects: Iterable<ManifestObject>, prefix: string): ManifestObject[] {
  return [...objects].map((object) => ({ ...object, path: `${prefix}/${object.path}` }));
}

/** Writable fields of a list item never include these (SharePoint fills them itself). */
export const SYSTEM_LIST_FIELDS: ReadonlySet<string> = new Set([
  "id",
  "ID",
  "ContentType",
  "Created",
  "Modified",
  "Author",
  "Editor",
  "AuthorLookupId",
  "EditorLookupId",
  "_UIVersionString",
  "_UIVersion",
  "Attachments",
  "Edit",
  "LinkTitle",
  "LinkTitleNoMenu",
  "DocIcon",
  "ItemChildCount",
  "FolderChildCount",
  "_ComplianceFlags",
  "_ComplianceTag",
  "_ComplianceTagWrittenTime",
  "_ComplianceTagUserId",
  "_IsRecord",
  "AppAuthorLookupId",
  "AppEditorLookupId",
  "ComplianceAssetId",
  "_ModerationStatus",
  "_ModerationComments",
  "FileLeafRef",
  "FileRef",
  "FileDirRef",
  "GUID",
  "UniqueId",
  "Order",
  "WorkflowVersion",
  "WorkflowInstanceID",
  "SelectTitle",
  "SelectFilename",
  "ServerUrl",
  "EncodedAbsUrl",
  "BaseName",
  "MetaInfo",
  "owshiddenversion",
  "_HasCopyDestinations",
  "_CopySource",
  "_Level",
  "ParentVersionString",
  "ParentLeafName",
  "SortBehavior",
  "PermMask",
  "PrincipalCount",
  "SMLastModifiedDate",
  "SMTotalSize",
  "SMTotalFileStreamSize",
  "SMTotalFileCount",
  "ScopeId",
  "HTML_x0020_File_x0020_Type",
  "ProgId",
  "FSObjType",
  "File_x0020_Type",
  "InstanceID",
  "_EditMenuTableStart",
  "_EditMenuTableStart2",
  "_EditMenuTableEnd",
  "Restricted",
  "OriginatorId",
  "NoExecute",
  "ContentVersion",
  "_VirusStatus",
  "_VirusVendorID",
  "_VirusInfo",
  "AccessPolicy",
  "_CommentFlags",
  "_CommentCount",
  "_LikeCount",
  "_DisplayName",
]);

/** A column as the list schema records it (the part of Graph's columnDefinition restore reads). */
export interface ListColumnFacts {
  readonly name?: string | null;
  readonly readOnly?: boolean | null;
  readonly hidden?: boolean | null;
  readonly calculated?: unknown;
}

/**
 * The field values of a backed-up item that may be written to a list:
 * annotations, system fields and the values of read-only, hidden or
 * calculated columns are left out. Lookup and person columns arrive as
 * `<Name>LookupId` and are written back the same way. Without a schema (an
 * older or unreadable `_list.json`) only the system fields are dropped.
 */
export function writableFields(
  fields: Readonly<Record<string, unknown>>,
  columns: readonly ListColumnFacts[] | null,
): Record<string, unknown> {
  const byName = new Map<string, ListColumnFacts>();
  for (const column of columns ?? []) {
    if (column.name) {
      byName.set(column.name, column);
    }
  }
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (key.includes("@") || key.startsWith("_") || SYSTEM_LIST_FIELDS.has(key)) {
      continue;
    }
    if (value === null || value === undefined) {
      continue;
    }
    const base = key.endsWith("LookupId") ? key.slice(0, -"LookupId".length) : key;
    const column = byName.get(key) ?? byName.get(base);
    if (columns !== null && column === undefined && key !== "Title") {
      // A field no column describes is computed by SharePoint (a projection or a link).
      continue;
    }
    if (column && (column.readOnly === true || column.hidden === true || column.calculated)) {
      continue;
    }
    if (key.endsWith("LookupId") && Array.isArray(value)) {
      // A multi-value lookup is written through its own `@odata.type` annotation.
      result[`${key}@odata.type`] = "Collection(Edm.String)";
      result[key] = value.map(String);
      continue;
    }
    result[key] = value;
  }
  return result;
}
