import { CalendarDays, Contact, HardDrive, Inbox, MessagesSquare, Server } from "lucide-react";
import type * as React from "react";
import { useTranslation } from "react-i18next";

import { StatusBadge } from "@/components/kit";
import { Skeleton } from "@/components/ui/skeleton";
import { FolderTree } from "@/features/restore/explorer/folder-tree";
import {
  type AreaLink,
  activeArea,
  areasOf,
  type Person,
  type PersonArea,
} from "@/features/restore/lib/people";
import { cn } from "@/lib/utils";

const AREA_ICONS: Record<PersonArea, typeof Inbox> = {
  mail: Inbox,
  calendar: CalendarDays,
  contacts: Contact,
  onedrive: HardDrive,
  imap: Server,
  groupCalendar: CalendarDays,
  conversations: MessagesSquare,
};

/**
 * The second column for a person (#49): what their backups hold — Mail, Calendar and Contacts of
 * the mailbox, the OneDrive, an IMAP account — each leading to the right object, with its own
 * restore points along the bottom. A Microsoft 365 group gets the same column with its group
 * calendar and its conversations;
 * restore points along the bottom. The area shown opens onto its folders.
 */
export function PersonAreas({
  person,
  objectId,
  path,
  snapshotId,
  restorePointsKnown,
  onArea,
  onOpenFolder,
}: {
  person: Person;
  /** The object the explorer shows. */
  objectId: string | null;
  path: string;
  /** The restore point browsed (of the shown object); null while there is none or it loads. */
  snapshotId: string | null;
  /** The shown object's restore points have loaded (an empty list then means none yet). */
  restorePointsKnown: boolean;
  onArea: (link: AreaLink) => void;
  onOpenFolder: (path: string) => void;
}) {
  const { t } = useTranslation("restore");
  const links = areasOf(person);
  const current = activeArea(links, objectId, path);

  return (
    <nav
      aria-label={t("explorer.areas.label")}
      className="space-y-0.5 text-sm"
      data-slot="person-areas"
    >
      {links.map((link) => {
        const Icon = AREA_ICONS[link.area];
        const active = current?.area === link.area && current.object.id === link.object.id;
        const subtree: React.ReactNode = !active ? null : snapshotId ? (
          <div className="pb-1 pl-3">
            <FolderTree
              snapshotId={snapshotId}
              object={link.object}
              currentPath={path}
              onOpen={onOpenFolder}
              rootPath={link.path}
              hideRoot
            />
          </div>
        ) : restorePointsKnown ? (
          <p className="py-1 pl-8 text-xs text-muted-foreground">
            {t("explorer.restorePoint.none")}
          </p>
        ) : (
          <Skeleton className="my-1 ml-8 h-5 w-2/3" />
        );
        return (
          <div key={`${link.object.id}-${link.area}`}>
            <button
              type="button"
              onClick={() => onArea(link)}
              aria-current={active && path === link.path ? "location" : undefined}
              data-slot="person-area"
              data-area={link.area}
              className={cn(
                "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left font-medium",
                "hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                active && "bg-accent text-accent-foreground",
              )}
            >
              <Icon className="size-4 shrink-0 text-primary" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">{t(`explorer.areas.${link.area}`)}</span>
              {link.object.status === "orphaned" && link.object.statusReason ? (
                // Disabled or unlicensed: the account still exists, backups resume with it.
                <StatusBadge tone="muted">
                  {t(`explorer.areas.inactive.${link.object.statusReason}`)}
                </StatusBadge>
              ) : link.object.status === "orphaned" ? (
                <StatusBadge tone="warning">{t("explorer.areas.gone")}</StatusBadge>
              ) : link.object.snapshotCount === 0 ? (
                <StatusBadge tone="muted">{t("explorer.areas.noBackup")}</StatusBadge>
              ) : null}
            </button>
            {subtree}
          </div>
        );
      })}
    </nav>
  );
}
