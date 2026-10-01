/**
 * OneDrive resources: the user's drive, root delta with token (deletions arrive
 * as the `deleted` facet), streaming downloads through the short-lived
 * pre-authenticated `@microsoft.graph.downloadUrl`, optional versions, and the
 * restore side: simple upload (≤ 4 MiB), upload sessions with 5–60 MiB fragments,
 * conflict behaviour, folder paths and `fileSystemInfo` timestamps.
 */
import type { Readable } from "node:stream";
import type {
  Drive,
  DriveItem,
  DriveItemVersion,
  FileSystemInfo,
} from "@microsoft/microsoft-graph-types";
import type { GraphClient, GraphRequest } from "../client.js";
import { type DeltaBatch, type DeltaSummary, type DeltaTokenStore, syncDelta } from "../delta.js";
import { GraphError, isGraphError, isNotFound } from "../errors.js";
import { paginate, query, requestOk, splitPath, userPath } from "./common.js";
import {
  DRIVE_DEFAULT_FRAGMENT_BYTES,
  DRIVE_FRAGMENT_BOUNDS,
  type UploadOptions,
  type UploadSessionInfo,
  type UploadSource,
  uploadToSession,
} from "./upload-session.js";

export const DRIVE_SELECT = ["id", "driveType", "name", "owner", "quota", "webUrl"] as const;

export type DriveInfo = Pick<Drive, (typeof DRIVE_SELECT)[number]> & { id: string };

/** Graph error codes meaning the user has no OneDrive (yet). */
const DRIVE_UNAVAILABLE_CODES = new Set([
  "ResourceNotFound",
  "itemNotFound",
  "UserNotFound",
  "MySiteNotFound",
]);

/**
 * True when the error says this user has no provisioned OneDrive: a 404, one of
 * the known codes, or the 400 "Unable to retrieve user's mysite URL" wording.
 */
export function isDriveUnavailable(error: unknown): boolean {
  if (!isGraphError(error)) {
    return false;
  }
  if (error.status === 404) {
    return true;
  }
  const code = error.code ?? error.innerCode ?? "";
  return (
    DRIVE_UNAVAILABLE_CODES.has(code) || /mysite|not provisioned|no onedrive/i.test(error.message)
  );
}

/**
 * The user's OneDrive, or null when none is provisioned. OneDrive is created on
 * first sign-in to a OneDrive-enabled licence; unlicensed and shared accounts
 * have none, which is shown as "no OneDrive", not as a failure.
 */
export async function getUserDrive(client: GraphClient, userId: string): Promise<DriveInfo | null> {
  try {
    return await requestOk<DriveInfo>(client, {
      method: "GET",
      url: `${userPath(userId)}/drive${query({ $select: DRIVE_SELECT.join(",") })}`,
    });
  } catch (error) {
    if (isDriveUnavailable(error)) {
      return null;
    }
    throw error;
  }
}

/** The download URL Graph attaches to file items. Pre-authenticated, valid ~1 hour. */
export const DOWNLOAD_URL_KEY = "@microsoft.graph.downloadUrl" as const;

export type DriveDeltaItem = DriveItem & {
  id: string;
  [DOWNLOAD_URL_KEY]?: string;
};

export function driveDeltaKey(driveId: string): string {
  return `drive:${driveId}`;
}

/** No `$select`: delta must keep the facets (`deleted`, `file`, `folder`, `package`) and the download URL. */
export function driveDeltaUrl(driveId: string): string {
  return `/drives/${encodeURIComponent(driveId)}/root/delta`;
}

/** Root delta of a drive; first run enumerates everything, later runs only changes. */
export function driveDelta(
  client: GraphClient,
  store: DeltaTokenStore,
  driveId: string,
  options: { key?: string; onResync?: () => void } = {},
): AsyncGenerator<DeltaBatch<DriveDeltaItem>, DeltaSummary, unknown> {
  return syncDelta<DriveDeltaItem>({
    client,
    store,
    key: options.key ?? driveDeltaKey(driveId),
    initialUrl: driveDeltaUrl(driveId),
    onResync: options.onResync,
  });
}

export function isDeletedItem(item: DriveItem): boolean {
  return item.deleted !== undefined && item.deleted !== null;
}

export function isFolderItem(item: DriveItem): boolean {
  return item.folder !== undefined && item.folder !== null;
}

export function isFileItem(item: DriveItem): boolean {
  return item.file !== undefined && item.file !== null && !isDeletedItem(item);
}

/** OneNote notebooks and similar arrive as packages: no content to download. */
export function isPackageItem(item: DriveItem): boolean {
  return item.package !== undefined && item.package !== null;
}

/**
 * Path of an item relative to the drive root, e.g. `Documents/Reports/q3.xlsx`.
 * `parentReference.path` looks like `/drive/root:/Documents/Reports`; the root
 * item itself has no parent path and yields an empty string.
 */
export function driveItemPath(item: DriveItem): string {
  const parentPath = item.parentReference?.path ?? "";
  const marker = parentPath.indexOf("root:");
  const parent = marker === -1 ? "" : safeDecode(parentPath.slice(marker + "root:".length));
  const trimmed = parent.replace(/^\/+/, "");
  if (item.root !== undefined && item.root !== null) {
    return "";
  }
  return trimmed.length === 0 ? (item.name ?? "") : `${trimmed}/${item.name ?? ""}`;
}

/** Graph percent-encodes `parentReference.path`; a stray `%` must not crash the walk. */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function itemBase(driveId: string, itemId: string): string {
  const drive = `/drives/${encodeURIComponent(driveId)}`;
  return itemId === "root" ? `${drive}/root` : `${drive}/items/${encodeURIComponent(itemId)}`;
}

export const DRIVE_ITEM_SELECT = [
  "id",
  "name",
  "size",
  "eTag",
  "cTag",
  "file",
  "folder",
  "package",
  "deleted",
  "parentReference",
  "fileSystemInfo",
  "createdDateTime",
  "lastModifiedDateTime",
  "webUrl",
  "root",
] as const;

export async function getItem(
  client: GraphClient,
  driveId: string,
  itemId: string,
): Promise<DriveDeltaItem> {
  return requestOk<DriveDeltaItem>(client, {
    method: "GET",
    url: `${itemBase(driveId, itemId)}${query({ $select: `${DRIVE_ITEM_SELECT.join(",")},content.downloadUrl` })}`,
  });
}

/** A file download: the stream plus what the headers say about it. */
export interface ItemDownload {
  stream: Readable;
  contentLength: number | null;
  contentType: string | null;
}

async function streamDownloadUrl(
  client: GraphClient,
  url: string,
): Promise<ItemDownload | GraphError> {
  const req: GraphRequest = { method: "GET", url, auth: false, headers: { Accept: "*/*" } };
  const response = await client.stream(req);
  if (!response.body) {
    return new GraphError({
      status: response.status,
      method: req.method,
      url: req.url,
      headers: response.headers,
      payload: response.error,
    });
  }
  const length = response.headers["content-length"];
  return {
    stream: response.body,
    contentLength: length !== undefined && /^\d+$/.test(length) ? Number(length) : null,
    contentType: response.headers["content-type"] ?? null,
  };
}

/**
 * Open a streaming download of a file item. Uses the download URL carried by the
 * delta item when present; when that URL has expired (401/403/404), the item is
 * fetched once more for a fresh URL. Never buffers the file.
 */
export async function openItemDownload(
  client: GraphClient,
  driveId: string,
  item: DriveDeltaItem | string,
): Promise<ItemDownload> {
  const itemId = typeof item === "string" ? item : item.id;
  let url = typeof item === "string" ? undefined : item[DOWNLOAD_URL_KEY];
  if (url) {
    const first = await streamDownloadUrl(client, url);
    if (!(first instanceof GraphError)) {
      return first;
    }
    if (![401, 403, 404, 410].includes(first.status)) {
      throw first;
    }
  }
  const fresh = await getItem(client, driveId, itemId);
  url = fresh[DOWNLOAD_URL_KEY];
  if (!url) {
    throw new GraphError({
      status: 404,
      method: "GET",
      url: itemBase(driveId, itemId),
      payload: {
        error: { code: "noDownloadUrl", message: "Item has no download URL (folder or package)" },
      },
    });
  }
  const second = await streamDownloadUrl(client, url);
  if (second instanceof GraphError) {
    throw second;
  }
  return second;
}

export function listItemVersions(
  client: GraphClient,
  driveId: string,
  itemId: string,
): AsyncGenerator<DriveItemVersion, void, unknown> {
  return paginate<DriveItemVersion>(client, `${itemBase(driveId, itemId)}/versions`);
}

/**
 * Stream one historical version. Graph answers with a redirect to a
 * pre-authenticated URL; fetch follows it and drops the bearer token on the
 * cross-origin hop.
 */
export async function openVersionDownload(
  client: GraphClient,
  driveId: string,
  itemId: string,
  versionId: string,
): Promise<ItemDownload> {
  const req: GraphRequest = {
    method: "GET",
    url: `${itemBase(driveId, itemId)}/versions/${encodeURIComponent(versionId)}/content`,
    headers: { Accept: "*/*" },
  };
  const response = await client.stream(req);
  if (!response.body) {
    throw new GraphError({
      status: response.status,
      method: req.method,
      url: req.url,
      headers: response.headers,
      payload: response.error,
    });
  }
  const length = response.headers["content-length"];
  return {
    stream: response.body,
    contentLength: length !== undefined && /^\d+$/.test(length) ? Number(length) : null,
    contentType: response.headers["content-type"] ?? null,
  };
}

// ---------------------------------------------------------------------------
// Restore

export type ConflictBehavior = "fail" | "rename" | "replace";

/** Simple `PUT .../content` is limited to 4 MiB; larger files need a session. */
export const SIMPLE_UPLOAD_LIMIT_BYTES = 4 * 1024 * 1024;

export interface UploadFileOptions extends UploadOptions {
  conflictBehavior?: ConflictBehavior;
  /** Original timestamps; restored so the file keeps its modified date. */
  fileSystemInfo?: Pick<FileSystemInfo, "createdDateTime" | "lastModifiedDateTime">;
}

/** Path addressing of a child by name: `/drives/{d}/items/{p}:/{name}`. */
function childByName(driveId: string, parentId: string, name: string): string {
  return `${itemBase(driveId, parentId)}:/${encodeURIComponent(name)}`;
}

/** The same address with the closing colon, for appending an action or `/content`. */
function childByNamePath(driveId: string, parentId: string, name: string): string {
  return `${childByName(driveId, parentId, name)}:`;
}

export async function createUploadSession(
  client: GraphClient,
  driveId: string,
  parentId: string,
  name: string,
  options: Pick<UploadFileOptions, "conflictBehavior" | "fileSystemInfo"> = {},
): Promise<UploadSessionInfo> {
  const session = await requestOk<UploadSessionInfo>(client, {
    method: "POST",
    url: `${childByNamePath(driveId, parentId, name)}/createUploadSession`,
    body: {
      item: {
        "@microsoft.graph.conflictBehavior": options.conflictBehavior ?? "fail",
        name,
        ...(options.fileSystemInfo ? { fileSystemInfo: options.fileSystemInfo } : {}),
      },
    },
  });
  if (!session.uploadUrl) {
    throw new Error("Graph returned an upload session without uploadUrl");
  }
  return session;
}

async function readAll(source: UploadSource, size: number): Promise<Buffer> {
  if (Buffer.isBuffer(source)) {
    return source;
  }
  if (typeof source === "function") {
    return source(0, size);
  }
  const chunks: Buffer[] = [];
  for await (const chunk of source) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks);
}

/**
 * Upload a file below `parentId`: one PUT for small files, an upload session for
 * everything else. Timestamps are applied in the same step where Graph supports
 * it (session) or with a PATCH afterwards (simple upload).
 */
export async function uploadFile(
  client: GraphClient,
  driveId: string,
  parentId: string,
  name: string,
  source: UploadSource,
  size: number,
  options: UploadFileOptions = {},
): Promise<DriveItem> {
  const conflictBehavior = options.conflictBehavior ?? "fail";
  if (size <= SIMPLE_UPLOAD_LIMIT_BYTES) {
    const bytes = await readAll(source, size);
    const created = await requestOk<DriveItem & { id: string }>(client, {
      method: "PUT",
      url: `${childByNamePath(driveId, parentId, name)}/content${query({
        "@microsoft.graph.conflictBehavior": conflictBehavior,
      })}`,
      headers: { "Content-Type": "application/octet-stream" },
      rawBody: bytes,
    });
    options.onProgress?.({ uploadedBytes: size, totalBytes: size });
    return options.fileSystemInfo
      ? setFileSystemInfo(client, driveId, created.id, options.fileSystemInfo)
      : created;
  }
  const session = await createUploadSession(client, driveId, parentId, name, options);
  const outcome = await uploadToSession<DriveItem>(client, session, source, size, {
    fragmentSize: options.fragmentSize ?? DRIVE_DEFAULT_FRAGMENT_BYTES,
    bounds: DRIVE_FRAGMENT_BOUNDS,
    onProgress: options.onProgress,
  });
  if (!outcome.result) {
    throw new Error(`Upload session finished with ${outcome.status} but returned no item`);
  }
  return outcome.result;
}

export async function setFileSystemInfo(
  client: GraphClient,
  driveId: string,
  itemId: string,
  fileSystemInfo: Pick<FileSystemInfo, "createdDateTime" | "lastModifiedDateTime">,
): Promise<DriveItem> {
  return requestOk<DriveItem>(client, {
    method: "PATCH",
    url: itemBase(driveId, itemId),
    body: { fileSystemInfo },
  });
}

/** The child named `name` below `parentId`, or null. */
export async function getChildByName(
  client: GraphClient,
  driveId: string,
  parentId: string,
  name: string,
): Promise<DriveDeltaItem | null> {
  try {
    return await requestOk<DriveDeltaItem>(client, {
      method: "GET",
      url: `${childByName(driveId, parentId, name)}${query({ $select: DRIVE_ITEM_SELECT.join(",") })}`,
    });
  } catch (error) {
    if (isNotFound(error)) {
      return null;
    }
    throw error;
  }
}

export async function createFolder(
  client: GraphClient,
  driveId: string,
  parentId: string,
  name: string,
  conflictBehavior: ConflictBehavior = "fail",
): Promise<DriveItem & { id: string }> {
  return requestOk<DriveItem & { id: string }>(client, {
    method: "POST",
    url: `${itemBase(driveId, parentId)}/children`,
    body: { name, folder: {}, "@microsoft.graph.conflictBehavior": conflictBehavior },
  });
}

/**
 * Walk (and create where missing) a folder path below `parentId` (default: root)
 * and return the id of the last folder. A file in the way is an error, not
 * silently replaced.
 */
export async function ensureDriveFolderPath(
  client: GraphClient,
  driveId: string,
  path: string | string[],
  options: { parentId?: string; cache?: Map<string, string> } = {},
): Promise<string> {
  const cache = options.cache ?? new Map<string, string>();
  let parentId = options.parentId ?? "root";
  for (const segment of splitPath(path)) {
    const cacheKey = `${parentId}/${segment.toLowerCase()}`;
    let id = cache.get(cacheKey);
    if (!id) {
      const existing = await getChildByName(client, driveId, parentId, segment);
      if (existing && !isFolderItem(existing)) {
        throw new Error(`Cannot create folder "${segment}": a file with that name exists`);
      }
      if (existing) {
        id = existing.id;
      } else {
        try {
          id = (await createFolder(client, driveId, parentId, segment)).id;
        } catch (error) {
          // Another worker created it in the meantime: look it up instead.
          if (!(isGraphError(error) && error.status === 409)) {
            throw error;
          }
          const raced = await getChildByName(client, driveId, parentId, segment);
          if (!raced) {
            throw error;
          }
          id = raced.id;
        }
      }
      cache.set(cacheKey, id);
    }
    parentId = id;
  }
  return parentId;
}

/** Delete an item (moves it to the recycle bin). Missing items are not an error. */
export async function deleteItem(
  client: GraphClient,
  driveId: string,
  itemId: string,
): Promise<void> {
  try {
    await requestOk(client, { method: "DELETE", url: itemBase(driveId, itemId) });
  } catch (error) {
    if (!isNotFound(error)) {
      throw error;
    }
  }
}
