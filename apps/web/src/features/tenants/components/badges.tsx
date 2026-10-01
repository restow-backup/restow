import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDateTime, formatRelative } from "@/lib/format";

import type { HealthState } from "../hooks";
import { type MailboxUsage, healthDetail, readinessBadge, statusBadge } from "../presenters";
import type { Readiness, TenantStatus } from "../types";

/**
 * Small status displays shared by the tenant list and the detail page. Each
 * one states "unknown" or "unavailable" honestly instead of rendering a zero.
 */

export function TenantStatusBadge({ status }: { status: TenantStatus }) {
  const { t } = useTranslation("tenants");
  const badge = statusBadge(status);
  return <Badge variant={badge.variant}>{t(badge.labelKey)}</Badge>;
}

export function ReadinessBadge({ readiness }: { readiness: Readiness | null }) {
  const { t } = useTranslation("tenants");
  const badge = readinessBadge(readiness);
  return <Badge variant={badge.variant}>{t(badge.labelKey)}</Badge>;
}

interface HealthSummaryProps {
  state: HealthState | undefined;
  /** Tenants being deleted are not checked any more. */
  deleting?: boolean;
}

/** Readiness badge with one explanatory line (what is wrong, or all proven). */
export function HealthSummary({ state, deleting = false }: HealthSummaryProps) {
  const { t } = useTranslation("tenants");
  if (deleting) {
    return <span className="text-sm text-muted-foreground">{t("readiness.deleting")}</span>;
  }
  if (!state || state.status === "pending") {
    return (
      <div aria-busy="true" className="flex flex-col gap-1.5">
        <Skeleton className="h-5 w-20" />
        <Skeleton className="h-3 w-32" />
        <span className="sr-only">{t("readiness.loading")}</span>
      </div>
    );
  }
  if (state.status === "error" || !state.data) {
    return (
      <span className="flex flex-col items-start gap-1">
        <Badge variant="outline">{t("readiness.unavailable")}</Badge>
        <span className="text-xs text-muted-foreground">{t("readiness.unavailableHint")}</span>
      </span>
    );
  }
  const detail = healthDetail(state.data);
  return (
    <span className="flex flex-col items-start gap-1">
      <ReadinessBadge readiness={state.data.readiness} />
      <span className="text-xs text-muted-foreground">{t(detail.key, detail.values)}</span>
    </span>
  );
}

/** "3 hours ago" with the exact time as tooltip, or "No backup yet". */
export function LastBackup({ state, deleting = false }: HealthSummaryProps) {
  const { t, i18n } = useTranslation("tenants");
  if (deleting) {
    return <span className="text-sm text-muted-foreground">{t("lastBackup.notTracked")}</span>;
  }
  if (!state || state.status === "pending") {
    return (
      <div aria-busy="true">
        <Skeleton className="h-4 w-24" />
        <span className="sr-only">{t("readiness.loading")}</span>
      </div>
    );
  }
  if (state.status === "error" || !state.data) {
    return <span className="text-sm text-muted-foreground">{t("lastBackup.unavailable")}</span>;
  }
  const at = state.data.lastBackupAt;
  const relative = formatRelative(at, i18n.language);
  if (!relative) {
    return <span className="text-sm text-muted-foreground">{t("lastBackup.never")}</span>;
  }
  return (
    <time dateTime={at ?? undefined} title={formatDateTime(at, i18n.language) ?? undefined}>
      {relative}
    </time>
  );
}

/** Protected mailboxes of a tenant, next to the cap agreed with its customer. */
export function MailboxUsageText({ usage }: { usage: MailboxUsage }) {
  const { t } = useTranslation("tenants");
  if (usage.used === null) {
    return (
      <span className="text-sm text-muted-foreground" title={t("mailboxes.unknownHint")}>
        {t("mailboxes.unknown")}
      </span>
    );
  }
  return (
    <span className="flex flex-col items-start gap-1">
      <span className="tabular-nums">
        {usage.cap === null
          ? t("mailboxes.count", { count: usage.used })
          : t("mailboxes.ofCap", { used: usage.used, cap: usage.cap })}
      </span>
      {usage.overCap ? (
        <Badge variant="warning">{t("mailboxes.overCap")}</Badge>
      ) : usage.cap === null ? null : (
        <span className="text-xs text-muted-foreground">{t("mailboxes.capHint")}</span>
      )}
    </span>
  );
}
