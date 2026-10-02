import { Building, CalendarClock, CalendarPlus, Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";

import { EmptyState, PageHeader, RefreshButton } from "@/components/kit";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

import type { ScheduleItem, ScheduleList } from "./api.js";
import { CoverageNotices } from "./components/coverage-notices.js";
import { SchedulesTable } from "./components/schedules-table.js";
import { JOB_REPLACED_KINDS, isShownSchedule } from "./presenters.js";

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
              <Button variant="outline" onClick={onCreate}>
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

  // Backups and restore checks are backup jobs: schedules they took over are not listed here.
  const items = list?.items.filter(isShownSchedule);
  const empty = list !== undefined && (items?.length ?? 0) === 0;
  // An older backup or restore-check schedule no job took over keeps running next to the jobs.
  const legacy = (items ?? []).filter((item) => JOB_REPLACED_KINDS.includes(item.kind)).length;

  return (
    <div className="space-y-6">
      {header}
      {empty ? (
        <>
          {list ? (
            <CoverageNotices
              list={list}
              legacy={0}
              canManage={canManage}
              onApplyRecommended={onApplyRecommended}
              applying={applying}
              showApply={false}
            />
          ) : null}
          <EmptyState
            icon={CalendarClock}
            title={t("empty.title")}
            description={t("empty.description")}
            actions={
              canManage ? (
                <Button variant="outline" onClick={onApplyRecommended} loading={applying}>
                  <Sparkles aria-hidden="true" />
                  {t("actions.applyRecommended")}
                </Button>
              ) : null
            }
          />
        </>
      ) : (
        <>
          {list ? (
            <CoverageNotices
              list={list}
              legacy={legacy}
              canManage={canManage}
              onApplyRecommended={onApplyRecommended}
              applying={applying}
            />
          ) : null}
          <SchedulesTable
            items={items}
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
