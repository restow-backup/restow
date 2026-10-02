import * as React from "react";
import { useTranslation } from "react-i18next";

import type { ScheduleItem } from "./api.js";
import { DeleteScheduleDialog, DisableScheduleDialog } from "./components/schedule-dialogs.js";
import { ScheduleSheet } from "./components/schedule-sheet.js";
import {
  useApplyRecommended,
  useDeleteSchedule,
  useSchedules,
  useTenantScope,
  useUpdateSchedule,
} from "./hooks.js";
import { browserTimeZone, needsDisableConfirmation } from "./presenters.js";
import { SchedulesView } from "./schedules-view.js";
import { toastApplied, toastChanged, toastFailed } from "./toasts.js";

type SheetState = { mode: "create" } | { mode: "edit"; schedule: ScheduleItem } | null;

/**
 * /schedules: what runs unattended for the active tenant. Administrators
 * create, change, switch and delete schedules; tenant users see them
 * read-only. Switching off backups or verification and every deletion are
 * confirmed first; every change ends in a toast.
 */
export function SchedulesPage() {
  const { t } = useTranslation("schedules");
  const { tenantId, canManage } = useTenantScope();
  const query = useSchedules();
  const update = useUpdateSchedule();
  const remove = useDeleteSchedule();
  const apply = useApplyRecommended();

  const [sheet, setSheet] = React.useState<SheetState>(null);
  const [deleting, setDeleting] = React.useState<ScheduleItem | null>(null);
  const [disabling, setDisabling] = React.useState<ScheduleItem | null>(null);
  const [pendingId, setPendingId] = React.useState<string | null>(null);

  /**
   * Switch a schedule on or off. A failure is toasted, unless a confirmation
   * dialog asked (it shows the cause itself and stays open).
   */
  const setEnabled = React.useCallback(
    async (item: ScheduleItem, enabled: boolean, fromDialog = false) => {
      setPendingId(item.id);
      try {
        await update.mutateAsync({ id: item.id, patch: { enabled } });
        toastChanged(t, enabled ? "enabled" : "disabled", item.kind);
      } catch (error) {
        if (!fromDialog) {
          toastFailed(t, error);
        }
        throw error;
      } finally {
        setPendingId(null);
      }
    },
    [t, update],
  );

  const onToggle = React.useCallback(
    (item: ScheduleItem, enabled: boolean) => {
      if (!enabled && needsDisableConfirmation(item)) {
        setDisabling(item);
        return;
      }
      void setEnabled(item, enabled).catch(() => undefined);
    },
    [setEnabled],
  );

  const onApplyRecommended = () => {
    apply.mutate(browserTimeZone(), {
      onSuccess: (result) => toastApplied(t, result.created.length + (result.jobCreated ? 1 : 0)),
      onError: (error) => toastFailed(t, error),
    });
  };

  const onEdit = React.useCallback(
    (item: ScheduleItem) => setSheet({ mode: "edit", schedule: item }),
    [],
  );
  const onDelete = React.useCallback((item: ScheduleItem) => setDeleting(item), []);

  return (
    <>
      <SchedulesView
        hasTenant={tenantId !== null}
        list={query.data}
        loading={query.isPending && query.fetchStatus !== "idle"}
        fetching={query.isFetching}
        error={query.error}
        onRetry={() => void query.refetch()}
        canManage={canManage}
        onCreate={() => setSheet({ mode: "create" })}
        onEdit={onEdit}
        onDelete={onDelete}
        onToggle={onToggle}
        onApplyRecommended={onApplyRecommended}
        applying={apply.isPending}
        pendingId={pendingId}
      />

      {canManage ? (
        <ScheduleSheet
          open={sheet !== null}
          onOpenChange={(open) => {
            if (!open) setSheet(null);
          }}
          schedule={sheet?.mode === "edit" ? sheet.schedule : null}
          onSaved={(change, item) => toastChanged(t, change, item.kind)}
        />
      ) : null}

      <DeleteScheduleDialog
        schedule={deleting}
        onCancel={() => setDeleting(null)}
        onConfirm={async (item) => {
          await remove.mutateAsync(item.id);
          setDeleting(null);
          toastChanged(t, "deleted", item.kind);
        }}
      />

      <DisableScheduleDialog
        schedule={disabling}
        onCancel={() => setDisabling(null)}
        onConfirm={async (item) => {
          await setEnabled(item, false, true);
          setDisabling(null);
        }}
      />
    </>
  );
}
