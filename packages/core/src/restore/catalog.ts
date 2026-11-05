/**
 * Folder chains: where in the target an object belongs, level by level, with
 * the levels that have a counterpart by meaning marked as anchors.
 *
 * A restore into another mailbox, another language or another server anchors
 * on those levels instead of creating a second "Posteingang" next to the
 * target's Inbox: Exchange items name the well-known folder their path starts
 * in (inbox, sentitems, ...), IMAP mailboxes their SPECIAL-USE (\Sent,
 * \Trash, ...).
 *
 * The {@link SnapshotCatalog} holds what only the whole snapshot knows: the
 * real display names of folders (a `/` inside a name does not survive a
 * `/`-separated path), the SPECIAL-USE of an IMAP message's parent mailboxes,
 * the message a JSON-format attachment belongs to, and the calendar folders.
 */
import type { ManifestObject, SnapshotManifest } from "../manifest.js";
import {
  type CalendarFacts,
  calendarFactsOf,
  folderSegmentsOf,
  imapDelimiterOf,
  imapMailboxComponentsOf,
  imapSpecialUseOf,
  type MailboxArea,
  mailboxAreaOf,
  objectTypeOf,
  parseBoolean,
  pathSegments,
  unescapeImapComponent,
  wellKnownFolderOf,
} from "./conventions.js";

/** One level of a folder path as it should exist in the target. */
export interface FolderStep {
  /** Display name to look up or create. */
  readonly name: string;
  /**
   * Well-known name (Exchange) or SPECIAL-USE (IMAP) of this level: the
   * target's own equivalent is used instead of a folder by this name.
   */
  readonly anchor?: string;
}

/** A folder chain split at its deepest anchor. */
export interface AnchoredChain {
  /** The deepest anchor in the chain, if any. */
  readonly anchor: string | undefined;
  /** Names below the anchor (the whole chain when there is none). */
  readonly below: readonly string[];
  /** Every name of the chain from the top. */
  readonly names: readonly string[];
}

export function splitAtAnchor(steps: readonly FolderStep[]): AnchoredChain {
  const names = steps.map((step) => step.name);
  for (let index = steps.length - 1; index >= 0; index--) {
    const anchor = steps[index]?.anchor;
    if (anchor !== undefined) {
      return { anchor, below: names.slice(index + 1), names };
    }
  }
  return { anchor: undefined, below: names, names };
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.trim().length > 0 ? value.trim() : undefined;
}

const INBOX_ANCHOR = "\\Inbox";

/** The Graph well-known folder for an IMAP SPECIAL-USE (and INBOX). */
const SPECIAL_USE_WELL_KNOWN: Readonly<Record<string, string>> = {
  "\\inbox": "inbox",
  "\\sent": "sentitems",
  "\\drafts": "drafts",
  "\\trash": "deleteditems",
  "\\junk": "junkemail",
  "\\archive": "archive",
  // Gmail's All Mail: a mailbox for mail that has no other folder (./gmail.ts).
  "\\all": "archive",
};

/** An object an IMAP backup or a mailbox import wrote (docs: conventions, IMAP). */
function isImapLayout(object: ManifestObject): boolean {
  const metadata = object.metadata ?? {};
  return metadata.mailbox !== undefined || metadata.uidValidity !== undefined;
}

/** The first mailbox component as the source named it, before INBOX is normalised. */
function rawImapFirstComponent(object: ManifestObject): string | undefined {
  const mailbox = nonEmpty(object.metadata?.mailbox);
  const delimiter = imapDelimiterOf(object);
  const first =
    mailbox !== undefined
      ? delimiter === undefined
        ? mailbox
        : mailbox.split(delimiter)[0]
      : folderSegmentsOf(object, "mail")[0];
  return first === undefined || first.length === 0 ? undefined : unescapeImapComponent(first);
}

function displayNameKey(area: MailboxArea, segments: readonly string[]): string {
  return `${area}\n${segments.join("/")}`;
}

export class SnapshotCatalog {
  private readonly foldersByPath = new Map<string, ManifestObject>();
  private readonly calendarsById = new Map<string, ManifestObject>();
  private readonly messagePathById = new Map<string, string>();
  private readonly eventPathById = new Map<string, string>();
  /** Paths of the events that have event-attachment objects in the snapshot. */
  private readonly eventsWithAttachments = new Set<string>();
  private readonly imapFoldersByMailbox = new Map<string, ManifestObject>();
  /** Real display names of mail and contact folders by area and recorded folder path. */
  private readonly displayNames = new Map<string, string>();

  private constructor(private readonly all: readonly ManifestObject[]) {
    for (const object of all) {
      const type = objectTypeOf(object);
      if (type === "mail" && object.id !== undefined) {
        this.messagePathById.set(object.id, object.path);
      }
      if (type === "event" && object.id !== undefined) {
        this.eventPathById.set(object.id, object.path);
      }
      if (type === "folder") {
        this.addFolder(object);
      }
    }
    for (const object of all) {
      if (objectTypeOf(object) === "event-attachment") {
        const owner = this.eventAttachmentOwner(object);
        if (owner !== undefined) {
          this.eventsWithAttachments.add(owner);
        }
      }
    }
  }

  private addFolder(folder: ManifestObject): void {
    this.foldersByPath.set(folder.path, folder);
    const metadata = folder.metadata ?? {};
    const calendarId = nonEmpty(metadata.calendarId);
    if (calendarId !== undefined) {
      this.calendarsById.set(calendarId, folder);
    }
    const mailbox = nonEmpty(metadata.mailbox);
    if (mailbox !== undefined) {
      this.imapFoldersByMailbox.set(mailbox, folder);
    }
    const kind = metadata.folderKind;
    const displayName = metadata.displayName;
    if (
      (kind === "mail" || kind === "contacts") &&
      displayName !== undefined &&
      displayName.length > 0
    ) {
      const segments = folderSegmentsOf(folder, kind);
      if (segments.length > 0) {
        this.displayNames.set(displayNameKey(kind, segments), displayName);
      }
    }
  }

  static of(manifest: Pick<SnapshotManifest, "objects">): SnapshotCatalog {
    return new SnapshotCatalog(manifest.objects);
  }

  /** Every object of the snapshot. */
  objects(): readonly ManifestObject[] {
    return this.all;
  }

  /**
   * The folder names of a recorded path, each level replaced by the real
   * display name its folder object carries: a `/` inside a name cannot
   * survive a `/`-separated path, the folder object keeps it.
   */
  private realNames(area: MailboxArea, segments: readonly string[]): string[] {
    return segments.map(
      (segment, index) =>
        this.displayNames.get(displayNameKey(area, segments.slice(0, index + 1))) ?? segment,
    );
  }

  /**
   * Exchange mail folders from the mailbox root down to the folder of an
   * item (or to a folder object itself), the first level anchored on its
   * well-known name when the backup recorded one.
   */
  mailFolderChain(object: ManifestObject): FolderStep[] {
    if (isImapLayout(object)) {
      return this.imapFolderChainForExchange(object);
    }
    const anchor = wellKnownFolderOf(object);
    return this.realNames("mail", folderSegmentsOf(object, "mail")).map((name, index) =>
      index === 0 && anchor !== undefined ? { name, anchor } : { name },
    );
  }

  /**
   * The Exchange folders of an object in the IMAP layout (an IMAP backup or
   * an imported mailbox): the real mailbox names, not their percent-escaped
   * path segments ("100%", "A/B"), and the levels the source marked as
   * INBOX or with a SPECIAL-USE anchored on the matching well-known folder.
   */
  private imapFolderChainForExchange(object: ManifestObject): FolderStep[] {
    const steps = this.imapFolderChain(object);
    // INBOX is spelled INBOX on the wire; the name the source gave it (an
    // import's "Inbox") is what a rename-mode restore folder shows.
    const firstRaw = rawImapFirstComponent(object);
    return steps.map((step, index) => {
      const name = index === 0 && step.name === "INBOX" && firstRaw ? firstRaw : step.name;
      const anchor =
        step.anchor === undefined ? undefined : SPECIAL_USE_WELL_KNOWN[step.anchor.toLowerCase()];
      return anchor !== undefined ? { name, anchor } : { name };
    });
  }

  /** Exchange contact folders below the default contacts folder (empty: the default folder). */
  contactFolderNames(object: ManifestObject): string[] {
    return this.realNames("contacts", folderSegmentsOf(object, "contacts"));
  }

  /** Path of the message an attachment belongs to, if the snapshot names it. */
  attachmentOwner(attachment: ManifestObject): string | undefined {
    const metadata = attachment.metadata ?? {};
    const byPath = nonEmpty(metadata.messagePath);
    if (byPath !== undefined) {
      return byPath;
    }
    const byId = nonEmpty(metadata.messageItemId);
    return byId === undefined ? undefined : this.messagePathById.get(byId);
  }

  /** Path of the event an event attachment belongs to, if the snapshot names it. */
  eventAttachmentOwner(attachment: ManifestObject): string | undefined {
    const metadata = attachment.metadata ?? {};
    const byPath = nonEmpty(metadata.eventPath);
    if (byPath !== undefined) {
      return byPath;
    }
    const byId = nonEmpty(metadata.eventItemId);
    return byId === undefined ? undefined : this.eventPathById.get(byId);
  }

  /** Whether the snapshot holds attachment objects for the event at `path`. */
  hasEventAttachments(path: string): boolean {
    return this.eventsWithAttachments.has(path);
  }

  /**
   * The calendar an event (or calendar folder object) belongs to: what the
   * object records, completed from its calendar's folder object.
   */
  calendarOf(object: ManifestObject): CalendarFacts {
    const own = calendarFactsOf(object);
    const calendarId = nonEmpty(object.metadata?.calendarId);
    const folder =
      (calendarId !== undefined ? this.calendarsById.get(calendarId) : undefined) ??
      this.foldersByPath.get(["calendar", ...folderSegmentsOf(object, "calendar")].join("/"));
    if (!folder || folder === object) {
      return own;
    }
    const facts = calendarFactsOf(folder);
    return { name: own.name ?? facts.name, isDefault: own.isDefault || facts.isDefault };
  }

  /**
   * IMAP mailboxes from the top down to the object's mailbox (of a folder
   * object: itself), with the SPECIAL-USE each level had on the source.
   */
  imapFolderChain(object: ManifestObject): FolderStep[] {
    const components = imapMailboxComponentsOf(object);
    const delimiter = imapDelimiterOf(object);
    const steps: FolderStep[] = components.map((name, index) => {
      if (index === 0 && name === "INBOX") {
        return { name, anchor: INBOX_ANCHOR };
      }
      const mailbox =
        delimiter === undefined ? undefined : components.slice(0, index + 1).join(delimiter);
      const folder = mailbox !== undefined ? this.imapFoldersByMailbox.get(mailbox) : undefined;
      const anchor = folder ? imapSpecialUseOf(folder) : undefined;
      return { name, ...(anchor !== undefined ? { anchor } : {}) };
    });
    const last = steps[steps.length - 1];
    const ownAnchor = imapSpecialUseOf(object);
    if (last !== undefined && last.anchor === undefined && ownAnchor !== undefined) {
      steps[steps.length - 1] = { ...last, anchor: ownAnchor };
    }
    return steps;
  }
}

/** What a folder object holds: mail, calendar or contacts, or "root" / "attachments" for structure. */
export function folderKindOf(folder: ManifestObject): string {
  const recorded = nonEmpty(folder.metadata?.folderKind);
  if (recorded !== undefined) {
    return recorded;
  }
  const area = mailboxAreaOf(folder);
  const segments = pathSegments(folder.path);
  return segments.length === 1 && segments[0] === area ? "root" : area;
}

/** Whether a contact folder object stands for the default contacts folder. */
export function isDefaultContactFolder(folder: ManifestObject): boolean {
  return (
    parseBoolean(folder.metadata?.isDefault) === true ||
    folderSegmentsOf(folder, "contacts").length === 0
  );
}

/** Whether a mail folder object stands for the mailbox root. */
export function isMailRoot(folder: ManifestObject): boolean {
  return folderSegmentsOf(folder, "mail").length === 0;
}
