import { useTranslation } from "react-i18next";

import { formatBytes, formatDateTime } from "@/lib/format";

import type { PveGuest } from "./api.js";
import { PVE_NAMESPACE } from "./i18n.js";

/**
 * What a guest's backups hold, next to its disk size (#58, #61): everything the
 * newest restore point contains, what the last run added to the repository, how
 * large the first backup was and what a follow-up backup adds on average (shown,
 * not only in a tooltip, so it can be read and copied). A container's disk size is
 * what is allocated; the backup holds what is in use, unchanged data only once.
 */
export function BackupSizeCell({ guest }: { guest: Pick<PveGuest, "backups"> }) {
  const { t, i18n } = useTranslation(PVE_NAMESPACE);
  const language = i18n.resolvedLanguage ?? i18n.language;
  const last = guest.backups?.last ?? null;
  const first = guest.backups?.first ?? null;
  if (!last) {
    return <span className="text-muted-foreground">{t("guests.backupNone")}</span>;
  }
  const firstLine = first
    ? t("guests.backupFirst", {
        date: formatDateTime(first.at, language) ?? "",
        size: formatBytes(first.added ?? first.contains, language),
      })
    : null;
  const followUp = guest.backups?.followUp ?? null;
  const followUpLine = followUp
    ? t("guests.backupFollowUp", {
        size: formatBytes(followUp.added, language),
        count: followUp.points,
      })
    : null;
  const title = [firstLine, followUpLine].filter(Boolean).join("\n") || undefined;
  return (
    <div className="space-y-0.5" title={title} data-slot="pve-backup-size">
      <div className="tabular-nums">
        {t("guests.backupContains", { size: formatBytes(last.contains, language) })}
      </div>
      {last.added !== null ? (
        <div className="text-xs text-muted-foreground tabular-nums">
          {t("guests.backupAdded", { size: formatBytes(last.added, language) })}
        </div>
      ) : null}
      {firstLine ? (
        <div className="text-xs text-muted-foreground tabular-nums" data-slot="pve-backup-first">
          {firstLine}
        </div>
      ) : null}
      {followUpLine ? (
        <div
          className="text-xs text-muted-foreground tabular-nums"
          data-slot="pve-backup-follow-up"
        >
          {followUpLine}
        </div>
      ) : null}
    </div>
  );
}
