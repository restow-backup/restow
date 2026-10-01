import { KeyRound, RefreshCw, ShieldAlert } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { PasskeyReady } from "@/lib/api";
import { formatDateTime, formatRelative } from "@/lib/format";
import type { ReachabilityProbe } from "../api";
import { usePasskeyReadiness } from "../hooks";
import { probeTone, settingsErrorKey } from "../presenters";

/**
 * Passkey readiness, stated plainly: whether passkeys are offered, every
 * reason they are not, and what the server saw when it tried its own public
 * address (docs/ARCHITECTURE.md: the state is announced, not hidden).
 */

interface ReadinessSummaryProps {
  readiness: PasskeyReady;
  /** Title override, e.g. for the preview of unsaved changes. */
  title?: string;
}

/** Ready/not-ready with reasons and the derived passkey domain and origin. */
export function ReadinessSummary({ readiness, title }: ReadinessSummaryProps) {
  const { t } = useTranslation("settings");
  return (
    <Alert variant={readiness.ready ? "default" : "info"}>
      {readiness.ready ? <KeyRound /> : <ShieldAlert />}
      <AlertTitle>{title ?? t("readiness.title")}</AlertTitle>
      <AlertDescription className="space-y-2">
        <p>{readiness.ready ? t("readiness.ready") : t("readiness.notReady")}</p>
        {readiness.reasons.length > 0 ? (
          <ul className="list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
            {readiness.reasons.map((reason) => (
              <li key={reason}>{t(`readiness.reasons.${reason}`)}</li>
            ))}
          </ul>
        ) : null}
        {readiness.rpId ? (
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
            <dt>{t("readiness.rpId")}</dt>
            <dd className="break-all font-mono">{readiness.rpId}</dd>
            {readiness.origin ? (
              <>
                <dt>{t("readiness.origin")}</dt>
                <dd className="break-all font-mono">{readiness.origin}</dd>
              </>
            ) : null}
          </dl>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}

const TONE_BADGE = {
  neutral: "outline",
  warning: "warning",
  destructive: "destructive",
  muted: "muted",
} as const;

function ProbeResult({ probe }: { probe: ReachabilityProbe }) {
  const { t, i18n } = useTranslation("settings");
  const tone = probeTone(probe.status);
  return (
    <div className="space-y-2 rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">{t("readiness.probe.label")}</p>
        <Badge variant={TONE_BADGE[tone]}>{t(`readiness.probe.badge.${probe.status}`)}</Badge>
      </div>
      <p className="text-sm text-muted-foreground">{t(`readiness.probe.status.${probe.status}`)}</p>
      {probe.url || probe.detail ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
          {probe.url ? (
            <>
              <dt>{t("readiness.probe.url")}</dt>
              <dd className="break-all font-mono">{probe.url}</dd>
            </>
          ) : null}
          {probe.detail ? (
            <>
              <dt>{t("readiness.probe.detail")}</dt>
              <dd className="break-all font-mono">{probe.detail}</dd>
            </>
          ) : null}
        </dl>
      ) : null}
      <p className="text-xs text-muted-foreground">
        <time
          dateTime={probe.checkedAt}
          title={formatDateTime(probe.checkedAt, i18n.language) ?? ""}
        >
          {t("readiness.checkedAt", {
            time: formatRelative(probe.checkedAt, i18n.language) ?? probe.checkedAt,
          })}
        </time>
      </p>
    </div>
  );
}

interface ReadinessCardProps {
  /** The gate as last returned with the settings, shown until the check answers. */
  fallback: PasskeyReady;
}

/** The server-side re-check of the passkey gate, with "check again". */
export function ReadinessCard({ fallback }: ReadinessCardProps) {
  const { t } = useTranslation("settings");
  const { t: tc } = useTranslation();
  const check = usePasskeyReadiness();

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
        <div className="space-y-1.5">
          <CardTitle>{t("readiness.title")}</CardTitle>
          <CardDescription>{t("readiness.description")}</CardDescription>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="shrink-0"
          onClick={() => void check.refetch()}
          loading={check.isFetching}
        >
          {check.isFetching ? null : <RefreshCw />}
          {t("readiness.recheck")}
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        <ReadinessSummary readiness={check.data?.passkeyReady ?? fallback} />
        {check.data ? (
          <ProbeResult probe={check.data.probe} />
        ) : check.isError ? (
          <Alert variant="destructive">
            <ShieldAlert />
            <AlertTitle>{t("readiness.checkFailed")}</AlertTitle>
            <AlertDescription>{tc(settingsErrorKey(check.error))}</AlertDescription>
          </Alert>
        ) : (
          <div className="space-y-2 rounded-lg border border-border p-4" aria-busy="true">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-3 w-2/3" />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
