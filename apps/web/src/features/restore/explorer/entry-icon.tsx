import {
  CalendarDays,
  Contact,
  FileText,
  Folder,
  HardDrive,
  Inbox,
  Mail,
  Server,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import type { EntryKind, ObjectKind } from "@/features/restore/api";
import { cn } from "@/lib/utils";

const ENTRY_ICONS = {
  folder: Folder,
  file: FileText,
  mail: Mail,
  event: CalendarDays,
  contact: Contact,
} as const;

/** Icon for a tree entry, with the kind as accessible label. */
export function EntryIcon({ kind, className }: { kind: EntryKind; className?: string }) {
  const { t } = useTranslation("restore");
  const Icon = ENTRY_ICONS[kind];
  return (
    <Icon
      className={cn(
        "size-4 shrink-0",
        kind === "folder" ? "text-primary" : "text-muted-foreground",
        className,
      )}
      aria-label={t(`explorer.kinds.${kind}`)}
      role="img"
    />
  );
}

const OBJECT_ICONS = {
  mailbox: Inbox,
  onedrive: HardDrive,
  imap: Server,
} as const;

/** Icon for a protected object (mailbox, drive, IMAP account). */
export function ObjectIcon({ kind, className }: { kind: ObjectKind; className?: string }) {
  const { t } = useTranslation("restore");
  const Icon = OBJECT_ICONS[kind];
  return (
    <Icon
      className={cn("size-4 shrink-0 text-muted-foreground", className)}
      aria-label={t(`explorer.object.kinds.${kind}`)}
      role="img"
    />
  );
}

/**
 * Display name of a protected object: its name, else its owner's address,
 * else its external id — in that order, because `externalId` is only ever a
 * human-meaningful address for an IMAP account; for a mailbox or OneDrive it
 * is Entra's own opaque object id or driveId, which "never show raw ids"
 * rules out whenever a better fallback exists.
 */
export function objectLabel(object: {
  displayName: string | null;
  externalId: string;
  ownerEmail?: string | null;
}): string {
  return object.displayName?.trim() || object.ownerEmail?.trim() || object.externalId;
}
