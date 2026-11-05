/**
 * Gmail backups restored once per message (docs/IMAP.md, "Gmail").
 *
 * Gmail shows one message in every mailbox that is one of its labels, and in
 * `[Gmail]/All Mail` (`\All`). Restoring the mailboxes one by one therefore
 * writes a message once per label and once more for All Mail. Two snapshot
 * layouts carry Gmail mail:
 *
 * - the Gmail layout: messages of `[Gmail]/All Mail` (and of Spam and Trash,
 *   which Gmail keeps apart) with their labels in `metadata.gmailLabels`, a
 *   JSON array as `X-GM-LABELS` names them (`\Inbox`, `\Sent`, `\Draft`,
 *   `\Important`, `\Starred`, `Work/Projects`); label mailboxes may be in the
 *   snapshot as folder objects, without messages;
 * - the earlier layout: one message object per label mailbox, recognised by a
 *   `[Gmail]/All Mail` with `\All` in the snapshot. The objects of one message
 *   are found by Message-ID and SHA-256 (Gmail serves the same bytes in every
 *   label).
 *
 * Either way each message is written once, into one home mailbox chosen by
 * its labels (`\Inbox`, then `\Sent`, `\Draft`, `\Trash`, `\Spam`, then the
 * first user label, else All Mail), and the other labels follow: into a Gmail
 * account by COPY to the label's mailbox (which adds the label, Gmail keeps
 * one message), elsewhere as keywords (IMAP) or categories (Microsoft 365).
 * `\Starred` becomes `\Flagged`. The other objects of the earlier layout are
 * reported against the one message that was written.
 */
import type { ManifestObject } from "../manifest.js";
import type { SnapshotCatalog } from "./catalog.js";
import { imapFlagsOf, objectTypeOf } from "./conventions.js";
import type { RestoreItemResult, RestoreLedger } from "./results.js";

/** Metadata key of a Gmail-layout message: its labels, a JSON array. */
export const GMAIL_LABELS_KEY = "gmailLabels";

const GMAIL_PREFIX = /^\[(gmail|google mail)\](\/|$)/i;

/** Whether a mailbox path is one of Gmail's own (`[Gmail]/...`, `[Google Mail]/...`). */
export function isGmailSystemMailbox(path: string): boolean {
  return GMAIL_PREFIX.test(path);
}

/** Where a restore writes a Gmail message: Gmail, another IMAP server, or Microsoft 365. */
export type GmailTargetKind = "gmail" | "imap" | "exchange";

/** A label's mailbox in the snapshot's terms, for the folder chain of the catalog. */
export interface GmailLabelMailbox {
  readonly label: string;
  readonly mailbox: string;
  readonly delimiter: string;
  readonly specialUse: string | undefined;
}

/** One Gmail message of the restore, written once. */
export interface GmailUnit {
  /** What is written: the message, placed into its home mailbox, with the flags that follow. */
  readonly object: ManifestObject;
  /** The home mailbox's label (`\Inbox`, a user label), or null for All Mail. */
  readonly home: string | null;
  /** Labels a Gmail target gets by COPY (empty for other targets). */
  readonly copyLabels: readonly GmailLabelMailbox[];
  /** Labels set as keywords (IMAP) or categories (Microsoft 365); empty for a Gmail target. */
  readonly keywords: ReadonlyArray<{ readonly label: string; readonly keyword: string }>;
  /** The other objects of this message in the earlier layout, with the label each stood for. */
  readonly copies: ReadonlyArray<{
    readonly object: ManifestObject;
    readonly label: string | null;
  }>;
}

export interface GmailMailPlan {
  /** The messages to write, in plan order: each Gmail message once. */
  readonly mail: readonly ManifestObject[];
  /** Gmail messages by the path of their {@link GmailUnit.object}. */
  readonly units: ReadonlyMap<string, GmailUnit>;
}

function specialUseOf(object: ManifestObject): string | undefined {
  const value = object.metadata?.specialUse?.trim();
  return value ? value : undefined;
}

function mailboxOf(object: ManifestObject): string | undefined {
  const value = object.metadata?.mailbox;
  return value !== undefined && value.length > 0 ? value : undefined;
}

/** Whether a mail object or folder is Gmail's All Mail. */
function isAllMail(object: ManifestObject): boolean {
  const mailbox = mailboxOf(object);
  return (
    specialUseOf(object)?.toLowerCase() === "\\all" &&
    mailbox !== undefined &&
    isGmailSystemMailbox(mailbox)
  );
}

/** Whether the snapshot holds Gmail mail in either layout. */
export function isGmailSnapshot(objects: readonly ManifestObject[]): boolean {
  return objects.some(
    (object) => object.metadata?.[GMAIL_LABELS_KEY] !== undefined || isAllMail(object),
  );
}

/** The labels a Gmail-layout message carries, or undefined for another object. */
export function gmailLabelsOf(object: ManifestObject): string[] | undefined {
  const raw = object.metadata?.[GMAIL_LABELS_KEY];
  if (raw === undefined) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((entry): entry is string => typeof entry === "string");
    }
  } catch {
    // Not JSON: a whitespace list (labels without spaces).
  }
  return raw.split(/\s+/).filter((entry) => entry.length > 0);
}

/** SPECIAL-USE of the mailbox behind a system label. */
const SYSTEM_LABEL_USE: Readonly<Record<string, string>> = {
  "\\inbox": "\\Inbox",
  "\\sent": "\\Sent",
  "\\draft": "\\Drafts",
  "\\drafts": "\\Drafts",
  "\\trash": "\\Trash",
  "\\spam": "\\Junk",
  "\\junk": "\\Junk",
  "\\important": "\\Important",
  "\\starred": "\\Flagged",
  "\\flagged": "\\Flagged",
};

/** The canonical spelling of a system label by the SPECIAL-USE of its mailbox. */
const LABEL_BY_USE: Readonly<Record<string, string>> = {
  "\\inbox": "\\Inbox",
  "\\sent": "\\Sent",
  "\\drafts": "\\Draft",
  "\\trash": "\\Trash",
  "\\junk": "\\Spam",
  "\\important": "\\Important",
  "\\flagged": "\\Starred",
};

/** Mailbox names for a system label whose mailbox the snapshot does not name. */
const DEFAULT_MAILBOX: Readonly<Record<string, string>> = {
  "\\Inbox": "INBOX",
  "\\Sent": "Sent",
  "\\Drafts": "Drafts",
  "\\Trash": "Trash",
  "\\Junk": "Spam",
  "\\Important": "Important",
  "\\Flagged": "Starred",
};

/** Home mailbox priority among the system labels. */
const HOME_PRIORITY = ["\\Inbox", "\\Sent", "\\Draft", "\\Trash", "\\Spam"];

function canonicalLabel(label: string): string {
  if (label.toUpperCase() === "INBOX") {
    return "\\Inbox";
  }
  if (!label.startsWith("\\")) {
    return label;
  }
  const use = SYSTEM_LABEL_USE[label.toLowerCase()];
  return use === undefined ? label : (LABEL_BY_USE[use.toLowerCase()] ?? label);
}

/** The label a message object of the earlier layout stood for (null: All Mail). */
function labelOfObject(object: ManifestObject): string | null {
  if (isAllMail(object)) {
    return null;
  }
  const mailbox = mailboxOf(object);
  if (mailbox?.toUpperCase() === "INBOX") {
    return "\\Inbox";
  }
  const use = specialUseOf(object)?.toLowerCase();
  if (use !== undefined && LABEL_BY_USE[use] !== undefined) {
    return LABEL_BY_USE[use] as string;
  }
  if (use === "\\all") {
    return null;
  }
  return mailbox ?? null;
}

function isSystemLabel(label: string): boolean {
  return label.startsWith("\\");
}

/**
 * An IMAP keyword for a label: an atom without spaces, brackets, wildcards
 * or quotes (RFC 3501 `flag-keyword`), without the backslash of a system
 * label (`\Important` becomes `Important`).
 */
export function keywordForLabel(label: string): string {
  const bare = label.replace(/^\\+/, "");
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are not allowed in an atom
  const atom = bare.replace(/[\s(){%*"\\\]\u0000-\u001f\u007f-￿]/g, "_");
  return atom.length > 0 ? atom : "_";
}

class LabelMailboxes {
  private readonly byUse = new Map<string, ManifestObject>();
  private readonly byMailbox = new Map<string, ManifestObject>();
  private readonly allMail: ManifestObject | undefined;

  constructor(objects: readonly ManifestObject[]) {
    let allMail: ManifestObject | undefined;
    for (const object of objects) {
      const mailbox = mailboxOf(object);
      if (mailbox === undefined) {
        continue;
      }
      if (objectTypeOf(object) === "folder" || !this.byMailbox.has(mailbox)) {
        this.byMailbox.set(mailbox, object);
      }
      const use = specialUseOf(object)?.toLowerCase();
      if (use !== undefined && !this.byUse.has(use)) {
        this.byUse.set(use, object);
      }
      if (isAllMail(object)) {
        allMail ??= object;
      }
    }
    this.allMail = allMail;
  }

  /** Where the snapshot keeps `label` (null: All Mail). */
  resolve(label: string | null, fallbackDelimiter: string): GmailLabelMailbox {
    if (label === null) {
      const all = this.allMail;
      return {
        label: "\\All",
        mailbox: (all && mailboxOf(all)) ?? "[Gmail]/All Mail",
        delimiter: all?.metadata?.delimiter ?? fallbackDelimiter,
        specialUse: "\\All",
      };
    }
    if (label === "\\Inbox") {
      return { label, mailbox: "INBOX", delimiter: fallbackDelimiter, specialUse: "\\Inbox" };
    }
    if (isSystemLabel(label)) {
      const use = SYSTEM_LABEL_USE[label.toLowerCase()];
      const known = use !== undefined ? this.byUse.get(use.toLowerCase()) : undefined;
      const mailbox = known ? mailboxOf(known) : undefined;
      return {
        label,
        mailbox: mailbox ?? DEFAULT_MAILBOX[use ?? ""] ?? keywordForLabel(label),
        delimiter: known?.metadata?.delimiter ?? fallbackDelimiter,
        specialUse: use,
      };
    }
    const known = this.byMailbox.get(label);
    return {
      label,
      mailbox: label,
      delimiter: known?.metadata?.delimiter ?? fallbackDelimiter,
      specialUse: known ? specialUseOf(known) : undefined,
    };
  }
}

/** The message placed into `place`: mailbox, delimiter and SPECIAL-USE of that mailbox. */
export function placedIn(object: ManifestObject, place: GmailLabelMailbox): ManifestObject {
  const metadata: Record<string, string> = {
    ...object.metadata,
    mailbox: place.mailbox,
    delimiter: place.delimiter,
  };
  if (place.specialUse !== undefined) {
    metadata.specialUse = place.specialUse;
  } else {
    delete metadata.specialUse;
  }
  return { ...object, metadata };
}

function identityOf(object: ManifestObject): string {
  if (object.sha256 === undefined) {
    return `path\n${object.path}`;
  }
  return `${object.metadata?.messageId ?? ""}\n${object.sha256}\n${object.size}`;
}

/**
 * Each Gmail message of `mail` once, placed into its home mailbox with the
 * flags that carry its other labels for `target`. Mail of a snapshot that is
 * not Gmail's comes back as it is.
 */
export function planGmailMail(
  mail: readonly ManifestObject[],
  catalog: SnapshotCatalog,
  target: GmailTargetKind,
): GmailMailPlan {
  const objects = catalog.objects();
  if (!isGmailSnapshot(objects)) {
    return { mail, units: new Map() };
  }
  const mailboxes = new LabelMailboxes(objects);
  const groups = new Map<string, ManifestObject[]>();
  const order: Array<string | ManifestObject> = [];
  for (const object of mail) {
    // Spam and Trash hold messages that have no other label; mail of a
    // non-Gmail mailbox of the snapshot (an imported folder) stays apart too.
    const key = identityOf(object);
    const group = groups.get(key);
    if (group) {
      group.push(object);
      continue;
    }
    groups.set(key, [object]);
    order.push(key);
  }

  const result: ManifestObject[] = [];
  const units = new Map<string, GmailUnit>();
  for (const key of order) {
    const members = groups.get(key as string) ?? [];
    const first = members[0];
    if (first === undefined) {
      continue;
    }
    const labels: string[] = [];
    const add = (label: string | null) => {
      if (label !== null && !labels.includes(label)) {
        labels.push(label);
      }
    };
    for (const member of members) {
      for (const label of gmailLabelsOf(member) ?? []) {
        add(canonicalLabel(label));
      }
      add(labelOfObject(member));
    }
    const home =
      HOME_PRIORITY.find((label) => labels.includes(label)) ??
      labels.find((label) => !isSystemLabel(label)) ??
      null;
    const delimiter = first.metadata?.delimiter ?? "/";
    const homeMailbox = mailboxes.resolve(home, delimiter);
    const primary =
      members.find((member) => labelOfObject(member) === home) ??
      members.find((member) => labelOfObject(member) === null) ??
      first;
    const others = labels.filter((label) => label !== home && label !== "\\Starred");
    const flags = new Set(imapFlagsOf(primary));
    if (labels.includes("\\Starred")) {
      flags.add("\\Flagged");
    }
    const keywords =
      target === "gmail"
        ? []
        : others.map((label) => ({
            label,
            keyword: target === "imap" ? keywordForLabel(label) : label.replace(/^\\+/, ""),
          }));
    for (const { keyword } of keywords) {
      flags.add(keyword);
    }
    const placed = placedIn(primary, homeMailbox);
    const object: ManifestObject = {
      ...placed,
      metadata: { ...placed.metadata, flags: JSON.stringify([...flags]) },
    };
    if (members.length === 1 && others.length === 0 && home === labelOfObject(primary)) {
      // One object, one label, already where it belongs: nothing to consolidate.
      result.push(primary);
      continue;
    }
    result.push(object);
    units.set(object.path, {
      object,
      home,
      copyLabels:
        target === "gmail" ? others.map((label) => mailboxes.resolve(label, delimiter)) : [],
      keywords,
      copies: members
        .filter((member) => member !== primary)
        .map((member) => ({ object: member, label: labelOfObject(member) })),
    });
  }
  return { mail: result, units };
}

function describeLabel(label: string | null): string {
  return label === null ? "All Mail" : `"${label.replace(/^\\+/, "")}"`;
}

/**
 * What the restore did with a Gmail message's other labels, for the note on
 * the message: added as labels, kept as keywords or categories, or lost.
 */
export interface GmailLabelOutcome {
  /** Labels the target holds now, by label. */
  readonly kept: ReadonlyMap<string, string>;
  /** Labels the target could not take, by label, with the reason. */
  readonly lost: ReadonlyMap<string, string>;
}

/**
 * Report the other objects of a Gmail message (earlier layout) once the
 * message itself has its outcome: they were not written again, so each is
 * skipped with what became of its label, or failed with the message.
 */
export function reportGmailCopies(
  unit: GmailUnit,
  outcome: RestoreItemResult | undefined,
  labels: GmailLabelOutcome,
  ledger: RestoreLedger,
): void {
  const where = outcome?.targetRef ?? "the target";
  for (const copy of unit.copies) {
    if (outcome === undefined || outcome.status === "failed") {
      ledger.failed(
        copy.object,
        new Error(
          `the same Gmail message (restored once for all its labels) failed: ${outcome?.reason ?? "no outcome"}`,
        ),
        outcome?.code ?? "error",
      );
      continue;
    }
    if (outcome.status === "skipped") {
      ledger.skipped(
        copy.object,
        outcome.code === "restored" || outcome.code === "unverified" ? "exists" : outcome.code,
        `the same Gmail message as ${unit.object.path} (restored once for all its labels): ${outcome.reason ?? "skipped"}`,
        outcome.targetRef,
      );
      continue;
    }
    const label = copy.label;
    const lost = label === null ? undefined : labels.lost.get(label);
    if (lost !== undefined) {
      ledger.skipped(
        copy.object,
        "exists",
        `the same Gmail message is restored once, as ${where}; its label ${describeLabel(label)} is not kept: ${lost}`,
        outcome.targetRef,
      );
      continue;
    }
    const kept =
      label === "\\Starred"
        ? "is kept as the flag \\Flagged (Gmail shows it as a star)"
        : label === null
          ? undefined
          : labels.kept.get(label);
    ledger.skipped(
      copy.object,
      "exists",
      label === null
        ? `Gmail's All Mail holds every message; this one is restored once, as ${where}`
        : label === unit.home
          ? `the same Gmail message is restored once, as ${where}`
          : `the same Gmail message is restored once, as ${where}; its label ${describeLabel(label)} ${kept ?? "is kept"}`,
      outcome.targetRef,
    );
  }
}

/**
 * Why a folder object of a Gmail backup is not created in a target that is
 * not Gmail: Important and Starred are labels there, carried by each message
 * as a keyword or category (Important) or the flag (Starred). Undefined for
 * every other folder.
 */
export function gmailLabelFolderNote(
  folder: ManifestObject,
  catalog: SnapshotCatalog,
  target: GmailTargetKind,
): string | undefined {
  if (target === "gmail" || !isGmailSnapshot(catalog.objects())) {
    return undefined;
  }
  const use = specialUseOf(folder)?.toLowerCase();
  const mailbox = mailboxOf(folder) ?? folder.path;
  if (use === "\\important") {
    return target === "exchange"
      ? `Gmail's "${mailbox}" is a label, not a folder: its messages carry the category "Important"`
      : `Gmail's "${mailbox}" is a label, not a folder: its messages carry the keyword "Important"`;
  }
  if (use === "\\flagged") {
    return target === "exchange"
      ? `Gmail's "${mailbox}" is a label, not a folder: its messages are flagged for follow-up`
      : `Gmail's "${mailbox}" is a label, not a folder: its messages carry the flag \\Flagged`;
  }
  return undefined;
}

/**
 * Microsoft 365 after a Gmail message was written once: what became of its
 * labels (categories), on the message and on the objects that stood for them.
 * `flagsApplied` is whether the PATCH that sets categories and the follow-up
 * flag went through; when it did not, the labels are lost, not kept.
 */
export function finishGmailMessageForExchange(
  unit: GmailUnit,
  ledger: RestoreLedger,
  flagsApplied = true,
): void {
  const outcome = ledger.resultOf(unit.object.path);
  const kept = new Map<string, string>();
  const lost = new Map<string, string>();
  if (outcome?.status === "restored" && !flagsApplied) {
    const reason =
      "Exchange did not take the categories and the flag of the restored message (see its reason)";
    for (const { label } of unit.keywords) {
      lost.set(label, reason);
    }
    lost.set("\\Starred", reason);
  } else if (outcome?.status === "restored" && unit.keywords.length > 0) {
    for (const { label, keyword } of unit.keywords) {
      kept.set(label, `is kept as the category "${keyword}"`);
    }
    ledger.amendRestored(
      unit.object.path,
      `Gmail labels kept as categories: ${unit.keywords.map((entry) => entry.keyword).join(", ")}`,
    );
  }
  reportGmailCopies(unit, outcome, { kept, lost }, ledger);
}
