import {
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleHelp,
  Download,
  RefreshCw,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { RelativeTime } from "@/components/kit/relative-time";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { toast } from "@/components/ui/sonner";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

import type { CheckError, UpdatesView } from "../api";
import { useCheckNow } from "../hooks";
import {
  type CheckStatus,
  checkErrorKey,
  checkStatusOf,
  formatReleaseDate,
  updatesErrorKey,
} from "../presenters";

const STATUS_ICON = {
  off: CircleDashed,
  pending: CircleDashed,
  upToDate: CircleCheck,
  available: Download,
  comparisonUnavailable: CircleHelp,
  failed: CircleAlert,
} as const;

const ICON_TONE: Record<CheckStatus["tone"], string> = {
  success: "text-success-text bg-success/10",
  neutral: "text-foreground bg-muted",
  warning: "text-warning-text bg-warning/10",
  destructive: "text-destructive-text bg-destructive/10",
  info: "text-info-text bg-info/10",
  muted: "text-muted-foreground bg-muted",
};

/** The running version, what the update check found and when it ran. */
export function VersionCard({
  view,
  canChange,
}: {
  view: UpdatesView;
  canChange: boolean;
}) {
  const { t, i18n } = useTranslation("updates");
  const checkNow = useCheckNow();
  const status = checkStatusOf(view);
  const Icon = STATUS_ICON[status.kind];
  const language = i18n.resolvedLanguage ?? i18n.language;
  const latest = view.latest;
  const channel = t(`source.channel.${view.settings.channel}.label`);
  const date = formatReleaseDate(latest?.publishedAt, language);

  const runCheck = () =>
    checkNow.mutate(undefined, { onError: (error) => toast.error(t(updatesErrorKey(error))) });

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("version.title")}</CardTitle>
        <CardDescription>{t("version.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span
            className="font-mono text-2xl font-semibold tabular-nums"
            data-slot="running-version"
          >
            {view.running ?? t("version.runningUnknown")}
          </span>
          <span className="text-sm text-muted-foreground">{t("version.running")}</span>
        </div>
        {view.running === null ? (
          <p className="text-sm text-muted-foreground">{t("version.runningUnknownHint")}</p>
        ) : null}

        <div
          className="flex items-start gap-3 rounded-lg border border-border p-4"
          aria-live="polite"
          data-slot="check-status"
          data-kind={status.kind}
        >
          <span
            className={cn(
              "flex size-9 shrink-0 items-center justify-center rounded-full",
              ICON_TONE[status.tone],
            )}
          >
            <Icon className="size-5" aria-hidden="true" />
          </span>
          <div className="min-w-0 space-y-1">
            <p className="font-medium [overflow-wrap:anywhere]">
              {t(`check.status.${status.kind}.title`, {
                version: latest?.version ?? "",
              })}
            </p>
            {status.kind === "failed" && view.check.error ? (
              <CheckFailure error={view.check.error} />
            ) : (
              <p className="text-sm text-muted-foreground">
                {status.kind === "available"
                  ? latest
                    ? date
                      ? t("check.status.available.detailDated", { tag: latest.tag, date })
                      : t("check.status.available.detail", { tag: latest.tag })
                    : null
                  : t(`check.status.${status.kind}.description`, { channel })}
              </p>
            )}
          </div>
        </div>

        {status.kind === "failed" && latest ? (
          <p className="text-sm text-muted-foreground" data-slot="last-known">
            {view.updateAvailable === true
              ? t("check.lastKnown.available", { version: latest.version, tag: latest.tag })
              : view.updateAvailable === false
                ? t("check.lastKnown.upToDate")
                : t("check.lastKnown.latest", { version: latest.version })}
          </p>
        ) : null}

        <dl className="grid gap-4 text-sm sm:grid-cols-3">
          <div className="space-y-1">
            <dt className="text-muted-foreground">{t("version.lastChecked")}</dt>
            <dd>
              <RelativeTime value={view.check.checkedAt} fallback={t("version.neverChecked")} />
            </dd>
          </div>
          <div className="space-y-1">
            <dt className="text-muted-foreground">{t("version.nextCheck")}</dt>
            <dd>
              {view.check.enabled && view.check.nextCheckAt ? (
                <RelativeTime value={view.check.nextCheckAt} />
              ) : (
                <span className="text-muted-foreground">{t("version.nextCheckNone")}</span>
              )}
            </dd>
          </div>
          <div className="space-y-1">
            <dt className="text-muted-foreground">{t("version.source")}</dt>
            <dd className="[overflow-wrap:anywhere]">
              {view.source.repository ?? view.source.url}
              <span className="text-muted-foreground">
                {" "}
                ({t(`source.providers.${view.source.provider}`)})
              </span>
            </dd>
          </div>
        </dl>
      </CardContent>
      <CardFooter className="flex flex-col items-start gap-2 border-t border-border pt-6 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-muted-foreground">
          {view.check.enabled ? t("version.checkNowHint") : t("version.checkNowOff")}
        </p>
        <Button
          variant="outline"
          onClick={runCheck}
          disabled={!canChange || !view.check.enabled}
          loading={checkNow.isPending}
        >
          <RefreshCw />
          {t("version.checkNow")}
        </Button>
      </CardFooter>
    </Card>
  );
}

/** Why the last check failed, honestly, with the technical hint the api gave. */
function CheckFailure({ error }: { error: CheckError }) {
  const { t, i18n } = useTranslation("updates");
  const language = i18n.resolvedLanguage ?? i18n.language;
  const retryAt = error.code === "rate_limited" ? formatDateTime(error.retryAt, language) : null;
  const key =
    error.code === "rate_limited" && retryAt
      ? "check.errors.rate_limitedUntil"
      : checkErrorKey(error.code);
  const technical = [
    error.status !== null ? t("check.errorStatus", { status: error.status }) : null,
    error.detail,
  ].filter((part): part is string => Boolean(part));
  return (
    <div className="space-y-1" data-slot="check-error" data-code={error.code}>
      <p className="text-sm text-muted-foreground">{t(key, { time: retryAt ?? "" })}</p>
      {technical.length > 0 ? (
        <p className="font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]">
          {technical.join(" | ")}
        </p>
      ) : null}
    </div>
  );
}
