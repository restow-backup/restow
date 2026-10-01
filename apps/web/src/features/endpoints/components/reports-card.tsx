import { ChevronDown, Database, ScanSearch, ShieldCheck } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";

import { RelativeTime, StatusBadge } from "@/components/kit";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { StateBadge } from "@/features/verify/components/status";

import type { EndpointReport, ReportKind } from "../api.js";
import { useEndpointFormat } from "../hooks.js";
import { reportKindKey, reportView } from "../presenters.js";

const KIND_ICON: Record<ReportKind, LucideIcon> = {
  restore_test: ShieldCheck,
  repository_check: ScanSearch,
  retention: Database,
};

function Mismatches({ report }: { report: EndpointReport }) {
  const { t } = useTranslation("endpoints");
  const mismatched = report.summary.mismatched ?? [];
  if (mismatched.length === 0) {
    return null;
  }
  return (
    <Collapsible className="mt-2 rounded-md border">
      <CollapsibleTrigger className="group flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm font-medium outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
        {t("reports.mismatches.show", { count: mismatched.length })}
        <ChevronDown
          aria-hidden="true"
          className="size-4 shrink-0 transition-transform group-data-[state=open]:rotate-180"
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="border-t">
        <ul className="divide-y text-sm" data-slot="report-mismatches">
          {mismatched.map((item) => (
            <li key={item.path} className="space-y-1 p-3">
              <p className="font-mono text-xs break-all">{item.path}</p>
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-xs">
                <dt className="text-muted-foreground">{t("reports.mismatches.expected")}</dt>
                <dd className="font-mono break-all">{item.expected}</dd>
                <dt className="text-muted-foreground">{t("reports.mismatches.actual")}</dt>
                <dd className="font-mono break-all">
                  {item.actual ?? t("reports.mismatches.missing")}
                </dd>
                {item.reason ? (
                  <>
                    <dt className="text-muted-foreground">{t("reports.mismatches.reason")}</dt>
                    <dd className="break-words">{item.reason}</dd>
                  </>
                ) : null}
              </dl>
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * What the server found out about the repository: restore tests (matched x of
 * y files, and every difference), repository checks and retention runs.
 */
export function ReportsCard({ reports }: { reports: readonly EndpointReport[] }) {
  const format = useEndpointFormat();
  const { t } = format;
  return (
    <Card data-slot="reports-card">
      <CardHeader>
        <CardTitle className="text-base">{t("reports.title")}</CardTitle>
        <CardDescription>{t("reports.description")}</CardDescription>
      </CardHeader>
      <CardContent>
        {reports.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("reports.empty")}</p>
        ) : (
          <ul className="divide-y">
            {reports.map((report) => {
              const view = reportView(report, format);
              const Icon = KIND_ICON[report.kind];
              return (
                <li key={report.id} className="py-3 first:pt-0 last:pb-0">
                  <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
                    <div className="flex min-w-0 items-start gap-2">
                      <Icon
                        aria-hidden="true"
                        className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                      />
                      <div className="min-w-0 space-y-0.5">
                        <p className="text-sm font-medium">{t(reportKindKey(report.kind))}</p>
                        <p className="text-sm">{t(view.headline.key, view.headline.values)}</p>
                        {view.details.map((detail) => (
                          <p
                            key={detail.key + JSON.stringify(detail.values ?? {})}
                            className="text-xs text-muted-foreground"
                          >
                            {t(detail.key, detail.values)}
                          </p>
                        ))}
                        <p className="text-xs text-muted-foreground">
                          {t(`reports.origin.${report.origin}`)}
                          {report.snapshotId
                            ? ` · ${t("reports.snapshot", { id: report.snapshotId.slice(0, 8) })}`
                            : ""}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      {report.readiness ? (
                        <StateBadge state={report.readiness} />
                      ) : (
                        <StatusBadge tone="muted">{t("reports.noRating")}</StatusBadge>
                      )}
                      <RelativeTime value={report.checkedAt} focusable={false} />
                    </div>
                  </div>
                  <Mismatches report={report} />
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
