import * as React from "react";
import { useTranslation } from "react-i18next";

import type { RetentionPolicy } from "./api.js";
import { DeletePolicyDialog } from "./components/delete-policy-dialog.js";
import { PolicySheet } from "./components/policy-sheet.js";
import { useDeleteRetentionPolicy, useRetentionPolicies, useTenantScope } from "./hooks.js";
import { RetentionView } from "./retention-view.js";
import { toastChanged } from "./toasts.js";

type SheetState = { mode: "create" } | { mode: "edit"; policy: RetentionPolicy } | null;

/**
 * /retention: how long backup restore points are kept for the active tenant,
 * as a tenant default plus any per-object overrides. Tenant-administrator
 * only (retention shapes what backup data survives at all).
 */
export function RetentionPage() {
  const { t } = useTranslation("retention");
  const { tenantId, canManage } = useTenantScope();
  const query = useRetentionPolicies();
  const remove = useDeleteRetentionPolicy();

  const [sheet, setSheet] = React.useState<SheetState>(null);
  const [deleting, setDeleting] = React.useState<RetentionPolicy | null>(null);

  const onEdit = React.useCallback(
    (policy: RetentionPolicy) => setSheet({ mode: "edit", policy }),
    [],
  );
  const onDelete = React.useCallback((policy: RetentionPolicy) => setDeleting(policy), []);

  return (
    <>
      <RetentionView
        hasTenant={tenantId !== null}
        canManage={canManage}
        list={query.data}
        loading={query.isPending && query.fetchStatus !== "idle"}
        fetching={query.isFetching}
        error={query.error}
        onRetry={() => void query.refetch()}
        onCreate={() => setSheet({ mode: "create" })}
        onEdit={onEdit}
        onDelete={onDelete}
      />

      <PolicySheet
        open={sheet !== null}
        onOpenChange={(open) => {
          if (!open) setSheet(null);
        }}
        policy={sheet?.mode === "edit" ? sheet.policy : null}
        recommendedPreset={query.data?.recommendedPreset ?? "default"}
        onSaved={(change, item) => toastChanged(t, change, item.name)}
      />

      <DeletePolicyDialog
        policy={deleting}
        onCancel={() => setDeleting(null)}
        onConfirm={async (policy) => {
          await remove.mutateAsync(policy.id);
          setDeleting(null);
          toastChanged(t, "deleted", policy.name);
        }}
      />
    </>
  );
}
