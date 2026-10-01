/**
 * Contact resources: the contact folder tree (the default folder is addressed as
 * `/contacts`), contacts as Graph JSON, and creation for restore.
 */
import type { Contact, ContactFolder } from "@microsoft/microsoft-graph-types";
import type { GraphClient } from "../client.js";
import {
  odataString,
  paginate,
  query,
  requestOk,
  splitPath,
  stripReadOnly,
  userPath,
} from "./common.js";

export const CONTACT_FOLDER_SELECT = ["id", "displayName", "parentFolderId"] as const;

const CONTACTS_PAGE_SIZE = 200;

/** A contact folder with its path; the default folder has `id === null`. */
export interface ContactFolderNode {
  /** Graph folder id, or null for the default contacts folder (`/contacts`). */
  id: string | null;
  displayName: string;
  parentFolderId: string | null;
  path: string[];
  depth: number;
}

/** The default contacts folder as the tree root. */
export const DEFAULT_CONTACT_FOLDER: ContactFolderNode = {
  id: null,
  displayName: "Contacts",
  parentFolderId: null,
  path: [],
  depth: 0,
};

type RawContactFolder = Pick<ContactFolder, (typeof CONTACT_FOLDER_SELECT)[number]> & {
  id: string;
};

/** The default folder followed by every user-created folder, depth first. */
export async function listContactFolderTree(
  client: GraphClient,
  userId: string,
): Promise<ContactFolderNode[]> {
  const nodes: ContactFolderNode[] = [DEFAULT_CONTACT_FOLDER];
  const select = query({ $select: CONTACT_FOLDER_SELECT.join(","), $top: CONTACTS_PAGE_SIZE });
  const visit = async (parent: ContactFolderNode): Promise<void> => {
    const url = parent.id
      ? `${userPath(userId)}/contactFolders/${encodeURIComponent(parent.id)}/childFolders${select}`
      : `${userPath(userId)}/contactFolders${select}`;
    for await (const raw of paginate<RawContactFolder>(client, url)) {
      const node: ContactFolderNode = {
        id: raw.id,
        displayName: raw.displayName ?? "",
        parentFolderId: raw.parentFolderId ?? parent.id,
        path: [...parent.path, raw.displayName ?? ""],
        depth: parent.depth + 1,
      };
      nodes.push(node);
      await visit(node);
    }
  };
  await visit(DEFAULT_CONTACT_FOLDER);
  return nodes;
}

/** Contacts of a folder (`null` = default folder) as full Graph JSON. */
export function listContacts(
  client: GraphClient,
  userId: string,
  folderId: string | null,
): AsyncGenerator<Contact, void, unknown> {
  const base = folderId
    ? `${userPath(userId)}/contactFolders/${encodeURIComponent(folderId)}/contacts`
    : `${userPath(userId)}/contacts`;
  return paginate<Contact>(client, `${base}${query({ $top: CONTACTS_PAGE_SIZE })}`);
}

export async function getContact(
  client: GraphClient,
  userId: string,
  contactId: string,
): Promise<Contact> {
  return requestOk<Contact>(client, {
    method: "GET",
    url: `${userPath(userId)}/contacts/${encodeURIComponent(contactId)}`,
  });
}

/** Properties Graph rejects or regenerates when a contact is created. */
const CONTACT_READ_ONLY = [
  "id",
  "changeKey",
  "createdDateTime",
  "lastModifiedDateTime",
  "parentFolderId",
  "photo",
  "extensions",
  "multiValueExtendedProperties",
  "singleValueExtendedProperties",
] as const;

export function toCreatableContact(contact: Contact): Partial<Contact> {
  return stripReadOnly(contact as Record<string, unknown>, CONTACT_READ_ONLY) as Partial<Contact>;
}

export async function createContact(
  client: GraphClient,
  userId: string,
  folderId: string | null,
  contact: Partial<Contact>,
): Promise<Contact> {
  const url = folderId
    ? `${userPath(userId)}/contactFolders/${encodeURIComponent(folderId)}/contacts`
    : `${userPath(userId)}/contacts`;
  return requestOk<Contact>(client, { method: "POST", url, body: contact });
}

/**
 * Walk (and create where missing) a contact folder path below the default folder
 * and return the id of the last folder (`null` for an empty path = default folder).
 */
export async function ensureContactFolderPath(
  client: GraphClient,
  userId: string,
  path: string | string[],
  options: { cache?: Map<string, string> } = {},
): Promise<string | null> {
  const cache = options.cache ?? new Map<string, string>();
  let parentId: string | null = null;
  for (const segment of splitPath(path)) {
    const cacheKey = `${parentId ?? ""}/${segment.toLowerCase()}`;
    const cached = cache.get(cacheKey);
    const id: string =
      cached ?? (await findOrCreateContactFolder(client, userId, parentId, segment));
    cache.set(cacheKey, id);
    parentId = id;
  }
  return parentId;
}

async function findOrCreateContactFolder(
  client: GraphClient,
  userId: string,
  parentId: string | null,
  displayName: string,
): Promise<string> {
  const base: string = parentId
    ? `${userPath(userId)}/contactFolders/${encodeURIComponent(parentId)}/childFolders`
    : `${userPath(userId)}/contactFolders`;
  const lookup = `${base}${query({
    $filter: `displayName eq ${odataString(displayName)}`,
    $select: "id",
  })}`;
  for await (const folder of paginate<{ id: string }>(client, lookup)) {
    return folder.id;
  }
  const created = await requestOk<{ id: string }>(client, {
    method: "POST",
    url: base,
    body: { displayName },
  });
  return created.id;
}
