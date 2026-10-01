import { Server } from "lucide-react";
import { useTranslation } from "react-i18next";

import { RelativeTime, StatusBadge } from "@/components/kit";
import { Skeleton } from "@/components/ui/skeleton";
import { inventoryTo } from "@/features/endpoints/paths";
import { formatInteger } from "@/lib/format";
import { cn } from "@/lib/utils";

import type { EndpointsWidget as EndpointsData } from "../api.js";
import { LinkButton } from "../components/link-button.js";
import { WidgetCard, type WidgetStateProps } from "../components/widget-frame.js";
import {
  endpointFindings,
  endpointsOverall,
  readinessSegments,
  readinessTone,
} from "../presenters.js";
import { SEGMENT_FILL } from "./readiness-widget.js";

function EndpointsSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-6 w-28 rounded-full" />
      <Skeleton className="h-4 w-64 max-w-full" />
      <Skeleton className="h-2 w-full rounded-full" />
      <Skeleton className="h-4 w-48" />
    </div>
  );
}

function EndpointsBody({ data }: { data: EndpointsData }) {
  const { t, i18n } = useTranslation("dashboard");
  const language = i18n.resolvedLanguage ?? i18n.language;
  const overall = endpointsOverall(data);
  const findings = endpointFindings(data);
  const segments = readinessSegments(data.readiness);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <StatusBadge tone={readinessTone(overall)} icon className="text-sm">
          {t(`readiness.overall.${overall ?? "none"}`)}
        </StatusBadge>
        <span className="text-xs text-muted-foreground">
          {data.lastSuccessAt ? (
            <>
              {t("endpoints.lastBackup")} <RelativeTime value={data.lastSuccessAt} />
            </>
          ) : (
            t("endpoints.neverBacked")
          )}
        </span>
      </div>

      <p className="text-sm" data-line="protected">
        {t("endpoints.summary", {
          count: data.protected,
          servers: data.servers,
          clients: data.clients,
        })}
      </p>

      <div
        className="flex h-2 w-full gap-0.5 overflow-hidden rounded-full bg-muted"
        aria-hidden="true"
      >
        {segments.map((segment) => (
          <div
            key={segment.key}
            className={cn("h-full", SEGMENT_FILL[segment.tone])}
            style={{ width: `${(segment.count / Math.max(1, data.protected)) * 100}%` }}
          />
        ))}
      </div>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-1.5 text-sm sm:grid-cols-2">
        {segments.map((segment) => (
          <div
            key={segment.key}
            data-segment={segment.key}
            className="flex items-center justify-between gap-2"
          >
            <dt className="flex items-center gap-2 text-muted-foreground">
              <span
                aria-hidden="true"
                className={cn("size-2 rounded-full", SEGMENT_FILL[segment.tone])}
              />
              {t(`readiness.segments.${segment.key}`)}
            </dt>
            <dd className="font-medium tabular-nums">{formatInteger(segment.count, language)}</dd>
          </div>
        ))}
      </dl>

      {findings.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-flag="all-good">
          {t("endpoints.allGood")}
        </p>
      ) : (
        <ul className="flex flex-col items-start gap-1.5">
          {findings.map((finding) => (
            <li key={finding.key} data-finding={finding.key}>
              <StatusBadge tone={finding.tone} icon>
                {t(`endpoints.findings.${finding.key}`, { count: finding.count })}
              </StatusBadge>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Servers and clients backed up by the agent: how many are protected, how
 * many are not proven restorable and how many failed their last backup, in
 * plain words, coloured by the rules of the readiness card. They count in
 * that card's totals as well; this one says which machines need an admin. The
 * dashboard shows it only for a tenant that has machines (widget-registry.tsx).
 */
export function EndpointsWidget(props: WidgetStateProps<EndpointsData>) {
  const { t } = useTranslation("dashboard");
  return (
    <WidgetCard
      id="endpoints"
      {...props}
      title={t("endpoints.title")}
      description={t("endpoints.description")}
      icon={Server}
      skeleton={<EndpointsSkeleton />}
      action={
        <LinkButton to={inventoryTo()} variant="ghost">
          {t("actions.details")}
        </LinkButton>
      }
    >
      {(data) => <EndpointsBody data={data} />}
    </WidgetCard>
  );
}
