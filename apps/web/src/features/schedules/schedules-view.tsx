import { Building, CalendarClock, CalendarPlus, Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";

import { EmptyState, PageHeader, RefreshButton } from "@/components/kit";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

import type { ScheduleItem, ScheduleList } from "./api.js";
import { CoverageNotices } from "./components/coverage-notices.js";
import { SchedulesTable } from "./components/schedules-table.js";

export interface SchedulesViewProps {
  /** False when no tenant is selected (a provider admin between tenants). */
  hasTenant: boolean;
  list: ScheduleList | undefined;
  loading: boolean;
  fetching: boolean;
  error: unknown;
  onRetry: () => void;
  /** Tenant administrators and provider admins change schedules; everyone else reads. */
  canManage: boolean;
  onCreate: () => void;
  onEdit: (item: ScheduleItem) => void;
  onDelete: (item: ScheduleItem) => void;
  onToggle: (item: ScheduleItem, enabled: boolean) => void;
  onApplyRecommended: () => void;
  applying: boolean;
  /** Id of the schedule whose switch is being saved. */
  pendingId: string | null;
}

/**
 * The schedules page without its data wiring: header, the honest notices,
 * then the table (skeleton while loading, error with retry) or, for a tenant
 * without any schedule, an empty state that offers the recommended set.
 */
export function SchedulesView({
  hasTenant,
  list,
  loading,
  fetching,
  error,
  onRetry,
  canManage,
  onCreate,
  onEdit,
  onDelete,
  onToggle,
  onApplyRecommended,
  applying,
  pendingId,
}: SchedulesViewProps) {
  const { t } = useTranslation("schedules");

  const header = (
    <PageHeader
      icon={CalendarClock}
      title={t("page.title")}
      description={t("page.description")}
      actions={
        hasTenant ? (
          <>
            <RefreshButton label={t("actions.refresh")} fetching={fetching} onRefresh={onRetry} />
            {canManage ? (
              <Button onClick={onCreate}>
                <CalendarPlus aria-hidden="true" />
                {t("actions.new")}
              </Button>
            ) : null}
          </>
        ) : null
      }
    />
  );

  if (!hasTenant) {
    return (
      <div className="space-y-6">
        {header}
        <Alert variant="info">
          <Building aria-hidden="true" />
          <AlertTitle>{t("noTenant.title")}</AlertTitle>
          <AlertDescription>{t("noTenant.description")}</AlertDescription>
        </Alert>
      </div>
    );
  }

  const empty = list !== undefined && list.items.length === 0;

  return (
    <div className="space-y-6">
      {header}
      {empty ? (
        <EmptyState
          icon={CalendarClock}
          title={t("empty.title")}
          description={t("empty.description")}
          actions={
            canManage ? (
              <Button onClick={onApplyRecommended} loading={applying}>
                <Sparkles aria-hidden="true" />
                {t("actions.applyRecommended")}
              </Button>
            ) : null
          }
        />
      ) : (
        <>
          {list ? (
            <CoverageNotices
              list={list}
              canManage={canManage}
              onApplyRecommended={onApplyRecommended}
              applying={applying}
              onEnable={(item) => onToggle(item, true)}
              pendingId={pendingId}
            />
          ) : null}
          <SchedulesTable
            items={list?.items}
            loading={loading}
            fetching={fetching}
            error={error}
            onRetry={onRetry}
            canManage={canManage}
            empty={null}
            onEdit={onEdit}
            onDelete={onDelete}
            onToggle={onToggle}
            pendingId={pendingId}
          />
        </>
      )}
    </div>
  );
}
