import { ChartColumn, LayoutDashboard } from "lucide-react";
import { useTranslation } from "react-i18next";

import { PageTabs } from "@/components/kit/page-tabs";
import { STATS_ROLES, STATS_VIEW } from "@/features/stats";
import { canAccess, useSession } from "@/lib/session";

import { DASHBOARD_NAMESPACE } from "../i18n.js";

export type OverviewView = "status" | "statistics";

/**
 * The tabs of Overview: Status (the dashboard) and Statistics. Statistics is
 * for administrators, so everyone else sees no tab bar at all.
 */
export function OverviewTabs({ current }: { current: OverviewView }) {
  const { t } = useTranslation(DASHBOARD_NAMESPACE);
  const { role } = useSession();
  if (!canAccess(role, STATS_ROLES)) {
    return null;
  }
  return (
    <PageTabs
      label={t("views.label")}
      current={current}
      tabs={[
        { id: "status", label: t("views.status"), to: "/", search: {}, icon: LayoutDashboard },
        {
          id: "statistics",
          label: t("views.statistics"),
          to: "/",
          search: { view: STATS_VIEW },
          icon: ChartColumn,
        },
      ]}
    />
  );
}
