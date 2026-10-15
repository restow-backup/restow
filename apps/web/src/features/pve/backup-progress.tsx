import { Link, type LinkProps } from "@tanstack/react-router";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";

import { Progress } from "@/components/ui/progress";
import { formatBytes, formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

import type { PveGuest, PveNode, PveRunProgress } from "./api.js";
import { PVE_NAMESPACE } from "./i18n.js";

/** The percentage of a backup's progress; null while its total is not known. */
export function progressPercent(progress: PveRunProgress | null | undefined): number | null {
  if (!progress || progress.bytesTotal === null || progress.bytesTotal <= 0) {
    return null;
  }
  return Math.min(100, Math.max(0, Math.floor((progress.bytesDone / progress.bytesTotal) * 100)));
}

/**
 * The line under the bar: "34 % · 3.2 of 9.4 GiB · 85 MB/s", or what was read
 * while the total is not known yet, or that no figure came in yet.
 */
export function progressLine(
  t: TFunction,
  language: string,
  progress: PveRunProgress | null | undefined,
): string {
  if (!progress) {
    return t("guests.progressNone");
  }
  const percent = progressPercent(progress);
  const done = formatBytes(progress.bytesDone, language);
  return [
    percent === null ? null : t("guests.progressPercent", { percent }),
    progress.bytesTotal === null || percent === null
      ? t("guests.progressRead", { done })
      : t("guests.progressOf", { done, total: formatBytes(progress.bytesTotal, language) }),
    progress.bytesPerSecond === null
      ? null
      : t("guests.progressRate", { rate: formatBytes(progress.bytesPerSecond, language) }),
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
}

/**
 * The progress of a running guest backup (#51): a bar (pulsing while the total
 * is unknown) and the figures under it. With `to` the whole block links to the
 * guest's page.
 */
export function BackupProgress({
  progress,
  name,
  to,
  className,
}: {
  progress: PveRunProgress | null | undefined;
  name: string;
  to?: { to: LinkProps["to"] };
  className?: string;
}) {
  const { t, i18n } = useTranslation(PVE_NAMESPACE);
  const language = i18n.resolvedLanguage ?? i18n.language;
  const percent = progressPercent(progress);
  const line = progressLine(t, language, progress);
  const uploaded =
    progress?.bytesUploaded === null || progress?.bytesUploaded === undefined
      ? undefined
      : t("guests.progressUploaded", { size: formatBytes(progress.bytesUploaded, language) });
  const body = (
    <>
      <Progress
        value={percent ?? undefined}
        aria-label={t("guests.progressLabel", { name })}
        aria-valuetext={line}
        className={cn("h-1.5", percent === null && "animate-pulse")}
      />
      <p className="text-xs text-muted-foreground tabular-nums">{line}</p>
    </>
  );
  const classes = cn("block w-full min-w-32 max-w-64 space-y-1", className);
  return to ? (
    <Link
      {...to}
      className={cn(classes, "hover:underline")}
      title={uploaded}
      data-slot="pve-backup-progress"
    >
      {body}
    </Link>
  ) : (
    <div className={classes} title={uploaded} data-slot="pve-backup-progress">
      {body}
    </div>
  );
}

/**
 * The tooltip of a guest's activity badge: since when it waits for its node
 * and whether that node still reports (a disconnected node starts nothing),
 * or since when its backup runs.
 */
export function activityHint(
  t: TFunction,
  language: string,
  guest: Pick<PveGuest, "activity" | "activitySince" | "node">,
  node: Pick<PveNode, "name" | "online" | "lastSeenAt"> | null | undefined,
): string | undefined {
  const since = formatDateTime(guest.activitySince ?? null, language);
  if (guest.activity === "running") {
    return since ? t("guests.runningSince", { time: since }) : undefined;
  }
  if (guest.activity !== "queued") {
    return undefined;
  }
  const lastSeen = formatDateTime(node?.lastSeenAt ?? null, language) ?? t("nodes.never");
  return (
    [
      since ? t("guests.queuedSince", { time: since }) : null,
      node
        ? node.online
          ? t("guests.nodeLastReport", { time: lastSeen })
          : t("guests.nodeOffline", { node: node.name, time: lastSeen })
        : null,
    ]
      .filter((line): line is string => line !== null)
      .join("\n") || undefined
  );
}
