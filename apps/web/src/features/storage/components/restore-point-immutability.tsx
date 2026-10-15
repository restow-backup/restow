import { Lock, LockOpen, Timer } from "lucide-react";
import { useTranslation } from "react-i18next";

import { StatusBadge } from "@/components/kit";
import { formatDateTime } from "@/lib/format";
import { restorePointBadge } from "../immutability";
import { useRestorePointImmutability } from "../use-storage";

/**
 * Whether a restore point is immutable, as its storage reports it right now
 * (S3 HeadObject retention of its manifest or restic snapshot file). Green
 * only when the storage itself confirmed a COMPLIANCE retention beyond now:
 * that is proof nobody can delete it before then. A GOVERNANCE lock and a
 * directory's deletion delay are shown, but neutral. Nothing is shown for a
 * tenant without an immutable repository, or while the answer is not in.
 */
export function RestorePointImmutabilityBadge({
  snapshotId,
  endpointId,
}: {
  snapshotId: string | null;
  /** Set for a machine's restore point (a restic snapshot). */
  endpointId?: string;
}) {
  const { t, i18n } = useTranslation("storage");
  const query = useRestorePointImmutability(snapshotId, endpointId);
  const badge = restorePointBadge(query.data);
  if (!badge) {
    return null;
  }
  const date = badge.until ? formatDateTime(badge.until, i18n.language) : null;
  const label = t(badge.key, { date: date ?? "" });
  const hint = t(`${badge.key}Hint`, { date: date ?? "" });
  return (
    <StatusBadge
      tone={badge.tone === "proven" ? "success" : badge.tone === "neutral" ? "neutral" : "muted"}
      icon={badge.tone === "proven" ? Lock : badge.tone === "neutral" ? Timer : LockOpen}
      title={hint}
      data-immutability={query.data?.state}
      className="shrink-0"
    >
      {label}
    </StatusBadge>
  );
}
