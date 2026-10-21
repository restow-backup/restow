import type { ObjectKind, SnapshotObject } from "@/features/restore/api";
import { objectLabel } from "@/features/restore/explorer/entry-icon";
import type { ObjectState } from "@/features/verify/api";

import { type AccountTypeFilter, accountAddress } from "./accounts";
import { normalizePath } from "./paths";

/**
 * The explorer's left column groups by person (#49): a person's mailbox, OneDrive and IMAP
 * account are one entry, and the second column shows that person's areas (mail, calendar,
 * contacts, OneDrive), each leading to the right object and its own restore points. Objects
 * belong to a person through the directory user they are tied to (`ownerKey`, the API's
 * `protected_objects.user_id`); an object of no one known stands on its own, under its own name.
 * A OneDrive for Business always belongs to exactly one user and stays, orphaned, after the
 * account is deleted: it is listed under that person's name, marked so. SharePoint sites (and
 * the Teams files in them) belong to no person and have a section of their own.
 */

export interface Person {
  /** `user:<ownerKey>`, or `object:<id>` for an object of no known person. */
  key: string;
  name: string;
  /** The person's address (the owner's primary address, an IMAP login), or null. */
  address: string | null;
  /** The signed-in person's own entry (self-service restore). */
  own: boolean;
  /** Mailbox first, then OneDrive, then IMAP accounts. */
  objects: SnapshotObject[];
  /** Every object of the person is orphaned: the account is gone from the directory. */
  accountDeleted: boolean;
}

export interface People {
  people: Person[];
  sites: SnapshotObject[];
}

const KIND_ORDER: Readonly<Record<ObjectKind, number>> = {
  mailbox: 0,
  onedrive: 1,
  imap: 2,
  site: 3,
};

function personKey(object: SnapshotObject): string {
  return object.ownerKey ? `user:${object.ownerKey}` : `object:${object.id}`;
}

function byLabel(a: { name: string; own: boolean }, b: { name: string; own: boolean }): number {
  if (a.own !== b.own) {
    return a.own ? -1 : 1;
  }
  return a.name.localeCompare(b.name);
}

/** Group the explorer's objects into people and sites, each sorted: own entry first, then by name. */
export function groupPeople(objects: readonly SnapshotObject[]): People {
  const groups = new Map<string, SnapshotObject[]>();
  const sites: SnapshotObject[] = [];
  for (const object of objects) {
    if (object.kind === "site") {
      sites.push(object);
      continue;
    }
    const key = personKey(object);
    const list = groups.get(key);
    if (list) {
      list.push(object);
    } else {
      groups.set(key, [object]);
    }
  }
  const people = [...groups.entries()].map(([key, list]): Person => {
    const sorted = [...list].sort(
      (a, b) =>
        KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || objectLabel(a).localeCompare(objectLabel(b)),
    );
    const first = sorted[0] as SnapshotObject;
    const named = sorted.find((object) => object.ownerName) ?? first;
    return {
      key,
      name: named.ownerName ?? objectLabel(sorted.find((o) => o.displayName) ?? first),
      address: first.ownerEmail ?? accountAddress(first),
      own: sorted.some((object) => object.own),
      objects: sorted,
      accountDeleted: sorted.every((object) => object.status === "orphaned"),
    };
  });
  people.sort(byLabel);
  const sortedSites = [...sites].sort((a, b) =>
    byLabel({ name: objectLabel(a), own: a.own }, { name: objectLabel(b), own: b.own }),
  );
  return { people, sites: sortedSites };
}

/** The person an object belongs to, or null (a site, or an object not in the list). */
export function personOfObject(people: readonly Person[], objectId: string | null): Person | null {
  if (!objectId) {
    return null;
  }
  return people.find((person) => person.objects.some((object) => object.id === objectId)) ?? null;
}

function normalized(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

/** Whether a person matches the search text (name, addresses, account ids) and the type filter. */
export function matchesPerson(person: Person, query: string, filter: AccountTypeFilter): boolean {
  if (filter !== "all" && !person.objects.some((object) => object.kind === filter)) {
    return false;
  }
  const words = normalized(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return true;
  }
  const haystack = normalized(
    [
      person.name,
      person.address ?? "",
      ...person.objects.flatMap((object) => [
        object.displayName ?? "",
        object.externalId,
        object.ownerEmail ?? "",
      ]),
    ].join(" "),
  );
  return words.every((word) => haystack.includes(word));
}

/** Whether a site matches the search text and the type filter. */
export function matchesSite(
  site: SnapshotObject,
  query: string,
  filter: AccountTypeFilter,
): boolean {
  if (filter !== "all" && filter !== "site") {
    return false;
  }
  const words = normalized(query).split(/\s+/).filter(Boolean);
  const haystack = normalized(`${objectLabel(site)} ${site.externalId}`);
  return words.every((word) => haystack.includes(word));
}

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
export type PersonArea = "mail" | "calendar" | "contacts" | "onedrive" | "imap";

export interface AreaLink {
  area: PersonArea;
  object: SnapshotObject;
  /** The folder the area opens at (`mail`, `calendar`, ... of a mailbox; the root otherwise). */
  path: string;
}

/** The person's areas in order: Mail, Calendar, Contacts of the mailbox, OneDrive, IMAP mail. */
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
