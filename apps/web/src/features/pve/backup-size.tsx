import { useTranslation } from "react-i18next";

import { formatBytes, formatDateTime } from "@/lib/format";

import type { PveGuest } from "./api.js";
import { PVE_NAMESPACE } from "./i18n.js";

/**
 * What a guest's backups hold, next to its disk size (#58, #61): everything the
 * newest restore point contains, what the last run added to the repository, and
 * in the tooltip how large the first backup was. A container's disk size is
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
    : undefined;
  return (
    <div className="space-y-0.5" title={firstLine} data-slot="pve-backup-size">
      <div className="tabular-nums">
        {t("guests.backupContains", { size: formatBytes(last.contains, language) })}
      </div>
      {last.added !== null ? (
        <div className="text-xs text-muted-foreground tabular-nums">
          {t("guests.backupAdded", { size: formatBytes(last.added, language) })}
        </div>
      ) : null}
    </div>
  );
}
