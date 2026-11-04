import { useTranslation } from "react-i18next";

import type { NewDataPoint } from "@/components/kit";
import { formatBytes, formatDateTime } from "@/lib/format";

import type { PveBackupSize, PveGuest, PveGuestBackupSizes, PveRestorePoint } from "./api.js";
import { PVE_NAMESPACE } from "./i18n.js";

/** A short date in the user's language: "3 Oct" / "3. Okt.". */
export function shortDate(value: string, language: string): string {
  return new Intl.DateTimeFormat(language, { day: "numeric", month: "short" }).format(
    new Date(value),
  );
}

/**
 * The newest restore point when it is a follow-up backup that recorded what it added (#58);
 * null while the first backup is the only one, or when the point did not record it. Servers
 * from 0.5.0 on send each point's sequence; older ones are compared by their time.
 */
export function lastFollowUp(
  backups: PveGuestBackupSizes | null | undefined,
): (PveBackupSize & { added: number }) | null {
  const first = backups?.first ?? null;
  const last = backups?.last ?? null;
  if (!first || !last || last.added === null) {
    return null;
  }
  const after =
    first.sequence !== undefined && last.sequence !== undefined
      ? last.sequence > first.sequence
      : last.at !== first.at;
  return after ? { ...last, added: last.added } : null;
}

/** How many restore points the "new data per backup" chart shows, newest last. */
export const NEW_DATA_POINTS = 30;

/**
 * The bars of the "new data per backup" chart (#58): what each of the newest
 * {@link NEW_DATA_POINTS} restore points added, oldest first, with its type (first backup,
 * incremental, a VM's full read). Points that did not record it are left out.
 */
export function newDataPoints(
  points: readonly PveRestorePoint[],
  limit = NEW_DATA_POINTS,
): NewDataPoint[] {
  return [...points]
    .filter((point) => point.added !== null && point.added !== undefined)
    .sort((a, b) => a.sequence - b.sequence)
    .slice(-limit)
    .map((point) => ({
      id: point.id,
      at: point.backupAt,
      added: point.added ?? 0,
      type: point.backupType ?? "incremental",
    }));
}

/**
 * What a guest's backups hold, in its inventory row (#58, #61): how large the first (full)
 * backup was and when ("First backup: 32 GB on 3 Oct"), what the last follow-up backup added
 * ("Last follow-up: +210 MB") and what a follow-up adds on average. Shown as text, not only in a
 * tooltip, so it can be read and copied; the tooltip adds the first backup's full time and what
 * the newest restore point contains. Everything comes with the overview (one query per figure
 * for all guests), nothing is loaded per row.
 */
export function BackupSizeCell({ guest }: { guest: Pick<PveGuest, "backups"> }) {
  const { t, i18n } = useTranslation(PVE_NAMESPACE);
  const language = i18n.resolvedLanguage ?? i18n.language;
  const last = guest.backups?.last ?? null;
  const first = guest.backups?.first ?? null;
  if (!last && !first) {
    return <span className="text-muted-foreground">{t("guests.backupNone")}</span>;
  }
  const firstSize = first ? formatBytes(first.added ?? first.contains, language) : "";
  const firstLine = first
    ? t("guests.backupSizes.first", { size: firstSize, date: shortDate(first.at, language) })
    : null;
  const followUp = lastFollowUp(guest.backups);
  const onlyFirst =
    first !== null &&
    last !== null &&
    (first.sequence !== undefined && last.sequence !== undefined
      ? first.sequence === last.sequence
      : first.at === last.at);
  const followUpLine = followUp
    ? t("guests.backupSizes.lastFollowUp", { size: formatBytes(followUp.added, language) })
    : onlyFirst
      ? t("guests.backupSizes.noFollowUp")
      : null;
  const average = guest.backups?.followUp ?? null;
  const averageLine = average
    ? t("guests.backupSizes.average", {
        size: formatBytes(average.added, language),
        count: average.points,
      })
    : null;
  const title = [
    first
      ? t("guests.backupFirst", { date: formatDateTime(first.at, language) ?? "", size: firstSize })
      : null,
    followUpLine,
    averageLine,
    last ? t("guests.backupContains", { size: formatBytes(last.contains, language) }) : null,
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <div className="space-y-0.5" title={title} data-slot="pve-backup-size">
      <div className="tabular-nums" data-slot="pve-backup-first">
        {firstLine ??
          (last
            ? t("guests.backupContains", { size: formatBytes(last.contains, language) })
            : null)}
      </div>
      {followUpLine ? (
        <div
          className="text-xs text-muted-foreground tabular-nums"
          data-slot="pve-backup-last-follow-up"
        >
          {followUpLine}
        </div>
      ) : null}
      {averageLine ? (
        <div
          className="text-xs text-muted-foreground tabular-nums"
          data-slot="pve-backup-follow-up"
        >
          {averageLine}
        </div>
      ) : null}
    </div>
  );
}
