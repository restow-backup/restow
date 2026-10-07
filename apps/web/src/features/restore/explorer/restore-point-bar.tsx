import { Layers } from "lucide-react";
import { useTranslation } from "react-i18next";

import { type ListedSnapshot, RESTORE_POINT_LIMIT } from "@/features/restore/api";
import { RestorePointList } from "@/features/restore/explorer/restore-point-list";
import { cn } from "@/lib/utils";

interface RestorePointBarProps {
  /** Newest first, as the API lists them. `undefined` until they are loaded. */
  restorePoints: readonly ListedSnapshot[] | undefined;
  loading: boolean;
  /** Loading the restore points failed. */
  failed: boolean;
  value: string | null;
  onChange: (restorePointId: string) => void;
}

/**
 * The bottom edge of the explorer: one slim row with the restore point
 * timeline ({@link RestorePointList}) across the full width. An account
 * without a restore point, or one whose restore points could not be loaded,
 * says so here in words instead of showing an empty timeline.
 */
export function RestorePointBar({
  restorePoints,
  loading,
  failed,
  value,
  onChange,
}: RestorePointBarProps) {
  const { t } = useTranslation("restore");
  const unavailable = !loading && (failed || (restorePoints?.length ?? 0) === 0);

  return (
    // `min-h-14` is the height of the loaded timeline, so the panes above do
    // not jump when a message or the loading placeholder takes its place.
    <section
      aria-label={t("explorer.restorePoint.fieldLabel")}
      className={cn(
        "flex min-h-14 shrink-0 gap-3 rounded-lg border border-border bg-card px-3",
        unavailable ? "items-center" : "items-start",
      )}
    >
      {/* Lines up with the timeline's marker row (17px, under its 6px padding). */}
      <span
        className={cn(
          "flex h-[17px] shrink-0 items-center gap-1.5 text-xs font-medium text-muted-foreground",
          unavailable ? null : "mt-1.5",
        )}
      >
        <Layers aria-hidden="true" className="size-3.5" />
        <span className="hidden sm:inline">{t("explorer.restorePoint.fieldLabel")}</span>
      </span>
      {unavailable ? (
        <p className="text-sm text-muted-foreground">
          {t(failed ? "explorer.restorePoint.loadError" : "explorer.restorePoint.none")}
        </p>
      ) : (
        <RestorePointList
          restorePoints={restorePoints}
          loading={loading}
          value={value}
          onChange={onChange}
        />
      )}
      {!unavailable && (restorePoints?.length ?? 0) >= RESTORE_POINT_LIMIT ? (
        // Older restore points exist beyond what was loaded: say so instead of hiding them.
        <p
          className="mt-1.5 shrink-0 text-xs text-muted-foreground"
          title={t("explorer.restorePoint.truncatedHint", { count: RESTORE_POINT_LIMIT })}
          data-slot="restore-points-truncated"
        >
          {t("explorer.restorePoint.truncated", { count: RESTORE_POINT_LIMIT })}
        </p>
      ) : null}
    </section>
  );
}
