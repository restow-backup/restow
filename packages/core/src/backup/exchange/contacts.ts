/**
 * Contacts phase: the default contacts folder and every user-created folder
 * below it, each contact as Graph JSON. Like calendars, contacts are listed in
 * full on every run and unchanged ones are carried forward by their bytes.
 * Contact photos are a separate Graph resource and are not backed up in v1.
 */
import type { Contact } from "@microsoft/microsoft-graph-types";
import {
  type ContactFolderNode,
  listContactFolderTree,
  listContacts,
} from "../../graph/resources/contacts.js";
import {
  folderObjectAt,
  reconcileGroupFolders,
  removeGroupItems,
  removeUnseenItems,
  storeJsonItem,
} from "./folders.js";
import { CONTACTS_ROOT, assignFolderPaths, contactObjectPath, displayFolderPath } from "./paths.js";
import {
  type BackupRun,
  META,
  OBJECT_TYPES,
  contactsGroup,
  isItemLevelError,
  isVanished,
  toMailboxAccessError,
} from "./run.js";
import { toMillis } from "./time.js";

export const FOLDER_KIND_CONTACTS = "contacts";

/** State/metadata key of a contact folder (the default folder has no Graph id). */
export function contactFolderKey(folder: ContactFolderNode): string {
  return folder.id ?? "";
}

interface PlannedContactFolder {
  readonly folder: ContactFolderNode;
  /** Object path, e.g. `contacts/Suppliers` (`contacts` for the default folder). */
  readonly path: string;
  /** Folder names below the default folder (`""` for the default folder itself). */
  readonly displayPath: string;
}

/** Metadata every contact of a folder carries (and gets again when the folder moves). */
function contactLocation(planned: PlannedContactFolder): Record<string, string> {
  return {
    [META.folderId]: contactFolderKey(planned.folder),
    [META.folderPath]: planned.displayPath,
  };
}

function contactFolderObject(planned: PlannedContactFolder) {
  const { folder } = planned;
  return folderObjectAt(planned.path, folder.id ?? undefined, {
    ...contactLocation(planned),
    [META.folderKind]: FOLDER_KIND_CONTACTS,
    displayName: folder.displayName,
    parentFolderId: folder.parentFolderId ?? "",
    isDefault: String(folder.id === null),
  });
}

export function contactMetadata(
  contact: Contact,
  location: Record<string, string>,
): Record<string, string> {
  return {
    ...location,
    displayName: contact.displayName ?? "",
    givenName: contact.givenName ?? "",
    surname: contact.surname ?? "",
    companyName: contact.companyName ?? "",
    emailAddress: contact.emailAddresses?.[0]?.address ?? "",
    changeKey: contact.changeKey ?? "",
    lastModifiedDateTime: contact.lastModifiedDateTime ?? "",
  };
}

/** A contact folder deleted while the backup ran: its contacts go with it. */
function dropContactFolder(run: BackupRun, planned: PlannedContactFolder): void {
  const key = contactFolderKey(planned.folder);
  removeGroupItems(run, contactsGroup(key));
  run.index.removePath(planned.path);
  delete run.state.contactFolders[key];
  run.logger.info("contact folder deleted while the backup ran", { folderId: key });
}

async function syncContactFolder(run: BackupRun, planned: PlannedContactFolder): Promise<void> {
  const seen = new Set<string>();
  const location = contactLocation(planned);
  try {
    for await (const contact of listContacts(run.client, run.userId, planned.folder.id)) {
      run.throwIfAborted();
      if (!contact.id) {
        continue;
      }
      seen.add(contact.id);
      run.expectMore(1);
      const itemRef = contactObjectPath(planned.path, contact.displayName, contact.id);
      try {
        await storeJsonItem(run, {
          type: OBJECT_TYPES.contact,
          id: contact.id,
          path: itemRef,
          mtime: toMillis(contact.lastModifiedDateTime) || toMillis(contact.createdDateTime),
          metadata: contactMetadata(contact, location),
          payload: contact,
        });
      } catch (error) {
        if (!isItemLevelError(error)) {
          throw error;
        }
        run.fail(itemRef, error);
      }
      await run.maybeCheckpoint();
    }
  } catch (error) {
    if (isVanished(error)) {
      dropContactFolder(run, planned);
      return;
    }
    if (!isItemLevelError(error)) {
      throw error;
    }
    // The listing broke off: keep what the snapshot has, do not prune on a partial view.
    run.fail(planned.path, error);
    return;
  }
  removeUnseenItems(
    run,
    contactsGroup(contactFolderKey(planned.folder)),
    OBJECT_TYPES.contact,
    seen,
  );
}

export async function backupContacts(run: BackupRun): Promise<void> {
  if (run.progress.contactsDone) {
    return;
  }
  run.enterPhase("contacts");
  let tree: ContactFolderNode[];
  try {
    tree = await listContactFolderTree(run.client, run.userId);
  } catch (error) {
    const wrapped = toMailboxAccessError(error, "contact folders");
    if (!isItemLevelError(wrapped)) {
      throw wrapped;
    }
    run.fail(CONTACTS_ROOT, error);
    return;
  }

  const userFolders = tree.filter(
    (folder): folder is ContactFolderNode & { id: string } => typeof folder.id === "string",
  );
  const paths = assignFolderPaths(
    CONTACTS_ROOT,
    userFolders.map((folder) => ({
      id: folder.id,
      parentId: folder.parentFolderId,
      name: folder.displayName,
    })),
  );
  const planned: PlannedContactFolder[] = tree.map((folder) => ({
    folder,
    path: folder.id === null ? CONTACTS_ROOT : (paths.get(folder.id) ?? CONTACTS_ROOT),
    displayPath: displayFolderPath(folder.path),
  }));

  run.state.contactFolders = reconcileGroupFolders(run, {
    groupPrefix: "contacts:",
    folderKind: FOLDER_KIND_CONTACTS,
    keyMetadata: META.folderId,
    previousPaths: run.state.contactFolders,
    current: planned.map((entry) => ({
      key: contactFolderKey(entry.folder),
      path: entry.path,
      object: contactFolderObject(entry),
      itemMetadata: contactLocation(entry),
    })),
  });
  run.logger.info("contact folders enumerated", { folders: tree.length });

  for (const entry of planned) {
    run.throwIfAborted();
    await syncContactFolder(run, entry);
  }
  run.progress.contactsDone = true;
  await run.checkpoint();
}
