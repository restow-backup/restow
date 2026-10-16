import { Link, type LinkProps } from "@tanstack/react-router";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";

import { Progress } from "@/components/ui/progress";
import { formatBytes, formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

import type { PveGuest, PveNode, PveRunNode, PveRunProgress } from "./api.js";
import { PVE_NAMESPACE } from "./i18n.js";

/** The percentage of a backup's progress; null while its total is not known. */
export function progressPercent(progress: PveRunProgress | null | undefined): number | null {
  if (!progress || progress.bytesTotal === null || progress.bytesTotal <= 0) {
    return null;
  }
  return Math.min(100, Math.max(0, Math.floor((progress.bytesDone / progress.bytesTotal) * 100)));
}

/** The restow-pve version from which a node reports the progress of a backup. */
export const PROGRESS_HELPER_VERSION = "0.4.0";

/**
 * Whether a restow-pve version is older than `minimum` (both `x.y.z`). An unknown version or
 * a development build is not called older.
 */
export function helperOlderThan(version: string | null | undefined, minimum: string): boolean {
  const parse = (value: string) => /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value.trim());
  const found = version ? parse(version) : null;
  const wanted = parse(minimum);
  if (!found || !wanted) {
    return false;
  }
  for (let index = 1; index <= 3; index++) {
    const difference = Number(found[index]) - Number(wanted[index]);
    if (difference !== 0) {
      return difference < 0;
    }
  }
  return false;
}

/**
 * The line under the bar: "34 % · 3.2 of 9.4 GiB · 85 MB/s", or what was read
 * while the total is not known yet, or that no figure came in yet: on a node
 * whose restow-pve is too old to report one, that it needs an update.
 */
export function progressLine(
  t: TFunction,
  language: string,
  progress: PveRunProgress | null | undefined,
  node?: PveRunNode | null,
): string {
  if (!progress) {
    return node && helperOlderThan(node.helperVersion, PROGRESS_HELPER_VERSION)
      ? t("guests.progressOldHelper", {
          node: node.name,
          version: node.helperVersion,
          required: PROGRESS_HELPER_VERSION,
        })
      : t("guests.progressNone");
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
 * guest's page. `node` is the node the backup runs on, which names an outdated
 * restow-pve while no progress came in.
 */
export function BackupProgress({
  progress,
  name,
  node,
  to,
  className,
}: {
  progress: PveRunProgress | null | undefined;
  name: string;
  node?: PveRunNode | null;
  to?: { to: LinkProps["to"] };
  className?: string;
}) {
  const { t, i18n } = useTranslation(PVE_NAMESPACE);
  const language = i18n.resolvedLanguage ?? i18n.language;
  const percent = progressPercent(progress);
  const line = progressLine(t, language, progress, node);
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
