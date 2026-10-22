import type { PersonEntry, SnapshotObject } from "@/features/restore/api";
import type { ObjectState } from "@/features/verify/api";

import { normalizePath } from "./paths";

/**
 * The explorer's left column groups by person (#49): a person's mailbox, OneDrive and IMAP
 * account are one entry, and the second column shows that person's areas (mail, calendar,
 * contacts, OneDrive), each leading to the right object and its own restore points. Objects
 * belong to a person through the directory user they are tied to (`ownerKey`, the API's
 * `protected_objects.user_id`); an object of no one known stands on its own, under its own name.
 * A OneDrive for Business always belongs to exactly one user and stays, orphaned, after the
 * account is deleted: it is listed under that person's name, marked so. SharePoint sites (and
 * the Teams files in them) belong to no person and have a section of their own. The grouping,
 * the order, the search and the paging happen in the API (`GET /snapshots/people`); this module
 * holds what the page derives from an entry.
 */

/** A person (or a site) as the API lists it ({@link PersonEntry}). */
export type Person = PersonEntry;

/** A person's or a site's newest restore point, for the list. */
export function latestBackupOf(objects: readonly SnapshotObject[]): string | null {
  let latest: string | null = null;
  for (const object of objects) {
    if (object.latestSnapshotAt && (!latest || object.latestSnapshotAt > latest)) {
      latest = object.latestSnapshotAt;
    }
  }
  return latest;
}

const STATE_RANK: Readonly<Record<ObjectState, number>> = {
  red: 0,
  yellow: 1,
  unverified: 2,
  green: 3,
  no_backup: 4,
};

/** The least proven readiness among the person's objects that have a restore point. */
export function readinessOf(objects: readonly SnapshotObject[]): ObjectState {
  const backed = objects.filter((object) => object.snapshotCount > 0);
  if (backed.length === 0) {
    return "no_backup";
  }
  return backed.reduce<ObjectState>(
    (worst, object) =>
      STATE_RANK[object.readiness] < STATE_RANK[worst] ? object.readiness : worst,
    "no_backup",
  );
}

// --- The second column: a person's areas --------------------------------------------------------

/** What a person's backups hold, as the second column lists it. */
export type PersonArea =
  | "mail"
  | "calendar"
  | "contacts"
  | "onedrive"
  | "imap"
  | "groupCalendar"
  | "conversations";

export interface AreaLink {
  area: PersonArea;
  object: SnapshotObject;
  /** The folder the area opens at (`mail`, `calendar`, ... of a mailbox; the root otherwise). */
  path: string;
}

/**
 * The person's areas in order: Mail, Calendar, Contacts of the mailbox, OneDrive, IMAP mail; for a
 * group entry its group calendar and conversations.
 */
export function areasOf(person: Person): AreaLink[] {
  const links: AreaLink[] = [];
  for (const object of person.objects) {
    if (object.kind === "mailbox") {
      links.push(
        { area: "mail", object, path: "mail" },
        { area: "calendar", object, path: "calendar" },
        { area: "contacts", object, path: "contacts" },
      );
    } else if (object.kind === "onedrive") {
      links.push({ area: "onedrive", object, path: "" });
    } else if (object.kind === "imap") {
      links.push({ area: "imap", object, path: "" });
    } else if (object.kind === "group") {
      // A Microsoft 365 group mailbox: its calendar and its conversations (packages/core backup/groups).
      links.push(
        { area: "groupCalendar", object, path: "calendar" },
        { area: "conversations", object, path: "mail" },
      );
    }
  }
  return links;
}

/** The area the explorer shows: the object and the first folder of the path. */
export function activeArea(
  links: readonly AreaLink[],
  objectId: string | null,
  path: string,
): AreaLink | null {
  const top = normalizePath(path).split("/")[0] ?? "";
  const own = links.filter((link) => link.object.id === objectId);
  if (own.length === 1) {
    return own[0] ?? null;
  }
  return own.find((link) => link.path === top) ?? null;
}

/** Where choosing a person leads: their mailbox's mail, else their first object. */
export function firstAreaOf(person: Person): AreaLink | null {
  return areasOf(person)[0] ?? null;
}
