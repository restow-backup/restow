import { Building, Hourglass, Plus, ShieldAlert } from "lucide-react";
import { useTranslation } from "react-i18next";

import { EmptyState, PageHeader, RefreshButton } from "@/components/kit";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

import type { RetentionPolicy, RetentionPolicyList } from "./api.js";
import { PolicyTable } from "./components/policy-table.js";

export interface RetentionViewProps {
  /** False when no tenant is selected (a provider admin between tenants). */
  hasTenant: boolean;
  /** False for a signed-in tenant user: retention is tenant-administrator only. */
  canManage: boolean;
  list: RetentionPolicyList | undefined;
  loading: boolean;
  fetching: boolean;
  error: unknown;
  onRetry: () => void;
  onCreate: () => void;
  onEdit: (policy: RetentionPolicy) => void;
  onDelete: (policy: RetentionPolicy) => void;
}

/**
 * The retention page without its data wiring: header, then the table
 * (skeleton while loading, error with retry) or, for a tenant without any
 * policy yet, an honest empty state — nothing is pruned until one exists.
 */
export function RetentionView({
  hasTenant,
  canManage,
  list,
  loading,
  fetching,
  error,
  onRetry,
  onCreate,
  onEdit,
  onDelete,
}: RetentionViewProps) {
  const { t } = useTranslation("retention");

  const header = (
    <PageHeader
      icon={Hourglass}
      title={t("page.title")}
      description={t("page.description")}
      actions={
        hasTenant && canManage ? (
          <>
            <RefreshButton label={t("actions.refresh")} fetching={fetching} onRefresh={onRetry} />
            <Button onClick={onCreate}>
              <Plus aria-hidden="true" />
              {t("actions.new")}
            </Button>
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

  if (!canManage) {
    return (
      <div className="space-y-6">
        {header}
        <Alert variant="warning">
          <ShieldAlert aria-hidden="true" />
          <AlertTitle>{t("forbidden.title")}</AlertTitle>
          <AlertDescription>{t("forbidden.description")}</AlertDescription>
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
          icon={Hourglass}
          title={t("empty.title")}
          description={t("empty.description", {
            rule: t(`presetRule.${list?.recommendedPreset ?? "default"}`, {
              defaultValue: t(`presets.${list?.recommendedPreset ?? "default"}`),
            }),
          })}
          actions={
            <Button onClick={onCreate}>
              <Plus aria-hidden="true" />
              {t("empty.cta")}
            </Button>
          }
        />
      ) : (
        <PolicyTable
          items={list?.items}
          loading={loading}
          fetching={fetching}
          error={error}
          onRetry={onRetry}
          onEdit={onEdit}
          onDelete={onDelete}
        />
      )}
    </div>
  );
}
