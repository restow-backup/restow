/**
 * SharePoint Online resources (docs/MICROSOFT.md, SharePoint): the tenant's
 * sites, a site's document libraries (drives, backed up and restored through
 * the drive resources in ./drive.ts) and its lists with their columns and
 * items. Application permission `Sites.Read.All` reads all of it,
 * `Sites.ReadWrite.All` is needed to write list items and files back.
 *
 * Only Graph v1.0. What Graph does not offer for SharePoint (list item
 * attachments, site designs and themes, workflows) is left out on purpose and
 * documented, never reached through the SharePoint REST API: that would need a
 * second token audience and, app-only, a certificate instead of a secret.
 */
import type {
  ColumnDefinition,
  Drive,
  List,
  ListItem,
  Permission,
  Site,
} from "@microsoft/microsoft-graph-types";
import type { GraphClient } from "../client.js";
import { isGraphError } from "../errors.js";
import { paginate, query, requestOk } from "./common.js";

/** `/sites/{id}` with the composite id (`host,siteCollectionId,webId`) safely encoded. */
export function sitePath(siteId: string): string {
  return `/sites/${encodeURIComponent(siteId)}`;
}

export const SITE_SELECT = [
  "id",
  "name",
  "displayName",
  "description",
  "webUrl",
  "createdDateTime",
  "lastModifiedDateTime",
  "siteCollection",
  "sharepointIds",
  "isPersonalSite",
] as const;

export type SiteInfo = Pick<Site, (typeof SITE_SELECT)[number]> & {
  id: string;
  /** v1.0 property not yet in every graph-types release. */
  isPersonalSite?: boolean | null;
};

/**
 * True when a site is a user's OneDrive ("personal site"). Those are protected
 * as OneDrives through the directory, never a second time as sites.
 */
export function isPersonalSite(site: Pick<SiteInfo, "webUrl" | "isPersonalSite">): boolean {
  if (site.isPersonalSite === true) {
    return true;
  }
  const url = site.webUrl ?? "";
  return /-my\.sharepoint\.[a-z.]+\/personal\//i.test(url);
}

/**
 * Every site of the tenant, page by page. `getAllSites` is the documented way
 * to enumerate sites app-only (search=* misses sites the search index has not
 * crawled yet); group-connected sites of Microsoft 365 groups and Teams are
 * ordinary sites in it. OneDrives (personal sites) are filtered by the caller.
 */
export function listAllSites(client: GraphClient): AsyncGenerator<SiteInfo, void, unknown> {
  return paginate<SiteInfo>(
    client,
    `/sites/getAllSites${query({ $select: SITE_SELECT.join(","), $top: 500 })}`,
  );
}

/** One site, or null when it no longer exists (deleted, or the URL moved). */
export async function getSite(client: GraphClient, siteId: string): Promise<SiteInfo | null> {
  try {
    return await requestOk<SiteInfo>(client, {
      method: "GET",
      url: `${sitePath(siteId)}${query({ $select: SITE_SELECT.join(",") })}`,
    });
  } catch (error) {
    if (isGraphError(error) && (error.status === 404 || error.status === 410)) {
      return null;
    }
    throw error;
  }
}

export const SITE_DRIVE_SELECT = [
  "id",
  "name",
  "description",
  "driveType",
  "webUrl",
  "createdDateTime",
  "lastModifiedDateTime",
] as const;

export type SiteDrive = Pick<Drive, (typeof SITE_DRIVE_SELECT)[number]> & { id: string };

/** The document libraries of a site (each one a drive, including Site Pages and Site Assets). */
export function listSiteDrives(
  client: GraphClient,
  siteId: string,
): AsyncGenerator<SiteDrive, void, unknown> {
  return paginate<SiteDrive>(
    client,
    `${sitePath(siteId)}/drives${query({ $select: SITE_DRIVE_SELECT.join(",") })}`,
  );
}

/**
 * Sharing permissions on a library's root (who the library is shared with).
 * Recorded as information; Restow never writes permissions back.
 */
export function listDriveRootPermissions(
  client: GraphClient,
  driveId: string,
): AsyncGenerator<Permission, void, unknown> {
  return paginate<Permission>(client, `/drives/${encodeURIComponent(driveId)}/root/permissions`);
}

export const SITE_LIST_SELECT = [
  "id",
  "name",
  "displayName",
  "description",
  "webUrl",
  "createdDateTime",
  "lastModifiedDateTime",
  "list",
] as const;

export type SiteList = Pick<List, (typeof SITE_LIST_SELECT)[number]> & { id: string };

/** Every list of a site, libraries and hidden system lists included (the caller filters). */
export function listSiteLists(
  client: GraphClient,
  siteId: string,
): AsyncGenerator<SiteList, void, unknown> {
  return paginate<SiteList>(
    client,
    `${sitePath(siteId)}/lists${query({ $select: SITE_LIST_SELECT.join(",") })}`,
  );
}

/**
 * A list that holds files is a document library: its content is a drive and
 * is backed up as one. Graph names library templates `documentLibrary`,
 * `webPageLibrary` (Site Pages), `pictureLibrary`, ... and generic lists
 * `genericList`, `events`, `contacts`, `tasks`, ...
 */
export function isLibraryList(list: Pick<SiteList, "list">): boolean {
  return /library$/i.test(list.list?.template ?? "");
}

/** Hidden lists are SharePoint's own bookkeeping (workflow history, user information, ...). */
export function isHiddenList(list: Pick<SiteList, "list">): boolean {
  return list.list?.hidden === true;
}

/** The column definitions of a list: the schema its items' fields follow. */
export function listListColumns(
  client: GraphClient,
  siteId: string,
  listId: string,
): AsyncGenerator<ColumnDefinition, void, unknown> {
  return paginate<ColumnDefinition>(
    client,
    `${sitePath(siteId)}/lists/${encodeURIComponent(listId)}/columns`,
  );
}

export type SiteListItem = ListItem & {
  id: string;
  fields?: Record<string, unknown> & { "@odata.etag"?: string };
};

/** Items per page; Graph caps list item pages well above this. */
export const LIST_ITEM_PAGE_SIZE = 200;

/** Every item of a list with all its field values (`expand=fields`). */
export function listListItems(
  client: GraphClient,
  siteId: string,
  listId: string,
): AsyncGenerator<SiteListItem, void, unknown> {
  return paginate<SiteListItem>(
    client,
    `${sitePath(siteId)}/lists/${encodeURIComponent(listId)}/items${query({
      expand: "fields",
      $top: LIST_ITEM_PAGE_SIZE,
    })}`,
  );
}

/** Create a list item from field values; SharePoint assigns a new id. */
export async function createListItem(
  client: GraphClient,
  siteId: string,
  listId: string,
  fields: Record<string, unknown>,
): Promise<SiteListItem> {
  return requestOk<SiteListItem>(client, {
    method: "POST",
    url: `${sitePath(siteId)}/lists/${encodeURIComponent(listId)}/items`,
    body: { fields },
  });
}

/** Overwrite field values of an existing item; null when the item is gone. */
export async function updateListItemFields(
  client: GraphClient,
  siteId: string,
  listId: string,
  itemId: string,
  fields: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  try {
    return await requestOk<Record<string, unknown>>(client, {
      method: "PATCH",
      url: `${sitePath(siteId)}/lists/${encodeURIComponent(listId)}/items/${encodeURIComponent(itemId)}/fields`,
      body: fields,
    });
  } catch (error) {
    if (isGraphError(error) && error.status === 404) {
      return null;
    }
    throw error;
  }
}

/** One list item with its fields, or null when it does not exist. */
export async function getListItem(
  client: GraphClient,
  siteId: string,
  listId: string,
  itemId: string,
): Promise<SiteListItem | null> {
  try {
    return await requestOk<SiteListItem>(client, {
      method: "GET",
      url: `${sitePath(siteId)}/lists/${encodeURIComponent(listId)}/items/${encodeURIComponent(itemId)}${query({ expand: "fields" })}`,
    });
  } catch (error) {
    if (isGraphError(error) && error.status === 404) {
      return null;
    }
    throw error;
  }
}

/** The library (drive) of a site by its drive id, or null when it is gone. */
export async function getDrive(client: GraphClient, driveId: string): Promise<SiteDrive | null> {
  try {
    return await requestOk<SiteDrive>(client, {
      method: "GET",
      url: `/drives/${encodeURIComponent(driveId)}${query({ $select: SITE_DRIVE_SELECT.join(",") })}`,
    });
  } catch (error) {
    if (isGraphError(error) && error.status === 404) {
      return null;
    }
    throw error;
  }
}
