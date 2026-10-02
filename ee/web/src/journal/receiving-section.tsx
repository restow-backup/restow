import { CircleCheck, ExternalLink, Info, TriangleAlert } from "lucide-react";
import type * as React from "react";
import { useTranslation } from "react-i18next";

import { ErrorState } from "@/components/error-state";
import { RelativeTime, StatusBadge } from "@/components/kit";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import "@/features/archive/i18n";

import type { JournalReceiver } from "./api";
import { useJournalReceiver } from "./hooks";
import {
  type ChecklistState,
  STATUS_TONE,
  checklistItems,
  isNotSetUp,
  receiverStatus,
} from "./presenters";

const CHECKLIST_ICON = {
  ok: { Icon: CircleCheck, className: "text-foreground" },
  warn: { Icon: TriangleAlert, className: "text-warning-text" },
  todo: { Icon: Info, className: "text-muted-foreground" },
} as const satisfies Record<ChecklistState, unknown>;

/**
 * Installation, Journal receiving (Business, `archive.journalReceiver`): the
 * SMTP receiver that takes Exchange Online journal reports for every tenant:
 * whether it listens and, if not, why (including the restart a newly installed
 * license key needs), the port, the TLS certificate, the journal host and the
 * size limit as the server environment sets them, and what Exchange Online
 * needs from this server. The address of a tenant, its rotation, its last report
 * and the Exchange Online guide are per tenant and stay on that tenant's Archive
 * page. Nothing here is changed from the interface: the receiver reads the
 * environment when the API starts.
 */
export function JournalReceivingSection() {
  const { t } = useTranslation("installation");
  const query = useJournalReceiver();
  if (query.isPending) {
    return (
      <div className="space-y-4" aria-busy="true">
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }
  if (query.isError) {
    return (
      <ErrorState
        title={t("journal.loadError")}
        error={query.error}
        onRetry={() => void query.refetch()}
        retrying={query.isFetching}
      />
    );
  }
  return <JournalReceivingContent receiver={query.data} />;
}

export function JournalReceivingContent({ receiver }: { receiver: JournalReceiver }) {
  const { t } = useTranslation("installation");
  const { t: ta } = useTranslation("archive");
  const notSetUp = isNotSetUp(receiverStatus(receiver.state));
  const { requirements } = receiver;
  const stateKey =
    receiver.state === "not_configured"
      ? "notConfigured"
      : receiver.state === "listening"
        ? "listening"
        : "down";

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>{t("journal.receiver.title")}</CardTitle>
          <CardDescription>{t("journal.receiver.description")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <StatusBadge
            tone={STATUS_TONE[receiverStatus(receiver.state)]}
            icon
            live={receiver.state === "listening"}
          >
            {t(`journal.state.${stateKey}`)}
          </StatusBadge>

          {notSetUp ? (
            <p className="flex gap-2 text-sm text-muted-foreground">
              <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              <span>{ta("journal.notConfigured")}</span>
            </p>
          ) : receiver.receiver.reason ? (
            <Alert variant="destructive">
              <TriangleAlert aria-hidden="true" />
              <AlertDescription>
                {ta(`journal.reason.${receiver.receiver.reason}`)}
              </AlertDescription>
            </Alert>
          ) : null}

          <dl className="grid gap-x-6 gap-y-4 text-sm sm:grid-cols-2">
            <Fact label={t("journal.port")}>
              {requirements.smtpPort === null ? (
                <span className="text-muted-foreground">{t("journal.notSet")}</span>
              ) : (
                <span className="tabular-nums">{requirements.smtpPort}</span>
              )}
            </Fact>
            <Fact label={t("journal.host")}>
              {receiver.hostname ? (
                <code className="break-all font-mono text-xs">{receiver.hostname}</code>
              ) : (
                <span className="text-muted-foreground">{t("journal.notSet")}</span>
              )}
            </Fact>
            <Fact label={t("journal.tls")}>
              {requirements.tlsConfigured ? t("journal.tlsConfigured") : t("journal.tlsMissing")}
            </Fact>
            <Fact label={t("journal.maxSize")}>
              <span className="tabular-nums">
                {t("journal.maxSizeValue", { size: requirements.maxMessageMegabytes })}
              </span>
            </Fact>
            <Fact label={t("journal.lastReport")}>
              {receiver.lastReportAt ? (
                <RelativeTime value={receiver.lastReportAt} />
              ) : (
                <span className="text-muted-foreground">{t("journal.noReport")}</span>
              )}
            </Fact>
            <Fact label={t("journal.last24Hours")}>
              <span className="tabular-nums">{receiver.last24Hours}</span>
            </Fact>
          </dl>

          {receiver.hostnameIssue && !notSetUp ? (
            <Alert variant="warning">
              <TriangleAlert aria-hidden="true" />
              <AlertDescription>
                {ta(
                  receiver.hostnameIssue === "missing"
                    ? "journal.address.hostMissing"
                    : "journal.address.hostInvalid",
                )}
              </AlertDescription>
            </Alert>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("journal.checklist.title")}</CardTitle>
          <CardDescription>{t("journal.perTenant")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <ul className="space-y-1.5 text-sm">
            {checklistItems({
              requirements,
              status: receiverStatus(receiver.state),
            }).map((item) => {
              const { Icon, className } = CHECKLIST_ICON[item.state];
              return (
                <li key={item.id} className="flex gap-2" data-state={item.state}>
                  <Icon aria-hidden="true" className={`mt-0.5 size-4 shrink-0 ${className}`} />
                  <span>{ta(`journal.checklist.${item.key}`, item.params)}</span>
                </li>
              );
            })}
          </ul>
          {receiver.docsUrl ? (
            <Button variant="link" size="sm" className="-ml-2" asChild>
              <a href={receiver.docsUrl} target="_blank" rel="noreferrer noopener">
                {t("journal.docs")}
                <ExternalLink aria-hidden="true" />
              </a>
            </Button>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 space-y-1">
      <dt className="text-muted-foreground">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
