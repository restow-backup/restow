import { Server } from "lucide-react";
import { useTranslation } from "react-i18next";

import { overallMeta, RelativeTime, StatusBadge, toneOf } from "@/components/kit";
import { Skeleton } from "@/components/ui/skeleton";
import { inventoryTo } from "@/features/endpoints/paths";

import type { EndpointsWidget as EndpointsData } from "../api.js";
import { LinkButton } from "../components/link-button.js";
import { ReadinessBar, ReadinessLegend } from "../components/readiness-legend.js";
import { WidgetCard, type WidgetStateProps } from "../components/widget-frame.js";
import { endpointFindings, endpointsOverall } from "../presenters.js";

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
  const { t } = useTranslation("dashboard");
  const overall = overallMeta(endpointsOverall(data));
  const findings = endpointFindings(data);
  const counts = { ...data.readiness, total: data.machines };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <StatusBadge
          tone={toneOf(overall)}
          icon={overall.icon}
          className="text-sm"
          data-slot="readiness-overall"
          data-category={overall.id}
        >
          {t(overall.labelKey)}
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

      {/* The same bar and legend as the readiness card: all five categories, the empty ones dimmed. */}
      <ReadinessBar counts={counts} />
      <ReadinessLegend
        counts={counts}
        scope="tenant"
        linkable={false}
        label={t("endpoints.legend")}
      />

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
