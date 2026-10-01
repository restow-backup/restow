import { Archive, Cloud, DatabaseBackup, type LucideIcon, Mail, MailOpen } from "lucide-react";
import { useTranslation } from "react-i18next";

import { RelativeTime, StatusBadge, useMinuteClock } from "@/components/kit";
import { Skeleton } from "@/components/ui/skeleton";

import type { LastBackupWidget as LastBackupData } from "../api.js";
import { LinkButton } from "../components/link-button.js";
import { WidgetCard, type WidgetStateProps } from "../components/widget-frame.js";
import { PATHS, to } from "../paths.js";
import { isStale } from "../presenters.js";

type BackupType = "mail" | "onedrive" | "imap" | "archive";

const TYPE_ICON: Readonly<Record<BackupType, LucideIcon>> = {
  mail: Mail,
  onedrive: Cloud,
  imap: MailOpen,
  archive: Archive,
};

interface TypeRow {
  type: BackupType;
  at: string | null;
  /** Objects of this type under protection; null for the archive, which has none of its own. */
  protectedCount: number | null;
}

/**
 * The types to list: every protected type, plus the archive once it captured
 * something. A type nobody uses is not presented as "never backed up".
 */
export function backupTypeRows(data: LastBackupData): TypeRow[] {
  const rows: TypeRow[] = [
    { type: "mail", at: data.lastSuccess.mail, protectedCount: data.protectedKinds.mailbox },
    {
      type: "onedrive",
      at: data.lastSuccess.onedrive,
      protectedCount: data.protectedKinds.onedrive,
    },
    { type: "imap", at: data.lastSuccess.imap, protectedCount: data.protectedKinds.imap },
  ];
  const used = rows.filter((row) => (row.protectedCount ?? 0) > 0 || row.at !== null);
  if (data.lastSuccess.archive) {
    used.push({ type: "archive", at: data.lastSuccess.archive, protectedCount: null });
  }
  return used;
}

function LastBackupSkeleton() {
  return (
    <div className="space-y-3">
      {[0, 1, 2].map((row) => (
        <div key={row} className="flex items-center justify-between gap-3">
          <Skeleton className="h-4 w-36" />
          <Skeleton className="h-4 w-24" />
        </div>
      ))}
    </div>
  );
}

function LastBackupBody({ rows }: { rows: TypeRow[] }) {
  const { t } = useTranslation("dashboard");
  useMinuteClock();
  const now = Date.now();
  return (
    <ul className="divide-y">
      {rows.map((row) => {
        const Icon = TYPE_ICON[row.type];
        return (
          <li
            key={row.type}
            data-type={row.type}
            className="flex flex-wrap items-center justify-between gap-2 py-2.5 first:pt-0 last:pb-0"
          >
            <span className="flex items-center gap-2 text-sm">
              <Icon className="size-4 text-muted-foreground" aria-hidden="true" />
              {t(`lastBackup.types.${row.type}`)}
            </span>
            <span className="flex items-center gap-2 text-sm">
              {row.at === null ? (
                <StatusBadge tone="warning" icon>
                  {t("lastBackup.never")}
                </StatusBadge>
              ) : (
                <>
                  {isStale(row.at, now) ? (
                    <StatusBadge tone="warning">{t("lastBackup.stale")}</StatusBadge>
                  ) : null}
                  <RelativeTime value={row.at} />
                </>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The newest successful backup per data type. A run that left items behind
 * is not a success and does not count here.
 */
export function LastBackupWidget({
  canAdminister,
  ...props
}: WidgetStateProps<LastBackupData> & { canAdminister: boolean }) {
  const { t } = useTranslation("dashboard");
  return (
    <WidgetCard
      id="lastBackup"
      {...props}
      title={t("lastBackup.title")}
      description={t("lastBackup.description")}
      icon={DatabaseBackup}
      skeleton={<LastBackupSkeleton />}
      action={
        canAdminister ? (
          <LinkButton to={to(PATHS.backup)} variant="ghost">
            {t("actions.details")}
          </LinkButton>
        ) : null
      }
      empty={(data) =>
        backupTypeRows(data).length === 0
          ? {
              icon: DatabaseBackup,
              title: t("lastBackup.empty.title"),
              description: t("lastBackup.empty.description"),
              action: canAdminister ? (
                <LinkButton to={to(PATHS.sources)}>{t("lastBackup.empty.action")}</LinkButton>
              ) : undefined,
            }
          : null
      }
    >
      {(data) => <LastBackupBody rows={backupTypeRows(data)} />}
    </WidgetCard>
  );
}
