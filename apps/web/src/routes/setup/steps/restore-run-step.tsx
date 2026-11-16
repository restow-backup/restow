import { useMutation, useQuery } from "@tanstack/react-query";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import { ApiError } from "@/lib/api";
import {
  abortRestore,
  activateRestore,
  fetchRestoreInfo,
  RESTORE_ACTIVATED_KEY,
  type RestoreOperation,
  type RestoreReport,
} from "@/routes/setup/restore-api";

const PHASE_PROGRESS: Record<RestoreOperation["phase"], number> = {
  restoring: 25,
  preparing: 60,
  awaiting_confirmation: 80,
  activating: 90,
  starting: 95,
};

interface RestoreRunStepProps {
  token: string;
  initial: RestoreOperation | null;
  /** Back to choosing a dump (a refused, failed or aborted restore). */
  onStartAgain: () => void;
  /** The restore was activated: on to waiting for the restored installation. */
  onActivated: () => void;
}

function Report({ report }: { report: RestoreReport }) {
  const { t } = useTranslation("setup");
  return (
    <div className="space-y-3 rounded-md border p-3 text-sm">
      <p className="font-medium">{t("restoreRun.report.title")}</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
        <dt className="text-muted-foreground">{t("restoreRun.report.address")}</dt>
        <dd>{report.installation.publicUrl ?? t("restoreRun.report.noAddress")}</dd>
        <dt className="text-muted-foreground">{t("restoreRun.report.accounts")}</dt>
        <dd>
          {t("restoreRun.report.accountsValue", {
            users: report.counts.users,
            owners: report.counts.providerOwners,
          })}
        </dd>
        <dt className="text-muted-foreground">{t("restoreRun.report.tenants")}</dt>
        <dd>{report.counts.tenants}</dd>
        <dt className="text-muted-foreground">{t("restoreRun.report.migrations")}</dt>
        <dd>
          {t("restoreRun.report.migrationsValue", {
            restored: report.migrations.restored ?? 0,
            shipped: report.migrations.shipped,
          })}
        </dd>
        <dt className="text-muted-foreground">{t("restoreRun.report.keys")}</dt>
        <dd>
          {t("restoreRun.report.keysValue", {
            keys: report.keys.tenantKeys.checked,
            secrets: report.keys.installationSecrets.checked + report.keys.tenantSecrets.checked,
          })}
        </dd>
      </dl>
      {report.storage.checked ? (
        <div className="space-y-1">
          <p className="text-xs font-medium">
            {t("restoreRun.report.storage", {
              count: report.storage.targets.length,
              ahead: report.storage.ahead,
              unreachable: report.storage.unreachable,
            })}
          </p>
          <ul className="space-y-1 text-xs">
            {report.storage.targets.map((target) => (
              <li key={`${target.tenantId}/${target.targetId}`} className="font-mono">
                {target.tenantName ?? target.tenantId} / {target.targetId}:{" "}
                {t(`restoreRun.outcome.${target.outcome}`, { defaultValue: target.outcome })} (
                {t("restoreRun.report.markers", {
                  storage: target.storageMaxSeq ?? "–",
                  database: target.dbSeq,
                })}
                )
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          {t("restoreRun.report.storageNotChecked", { error: report.storage.error ?? "" })}
        </p>
      )}
      {report.counts.clusterNodes > 0 ? (
        <p className="text-xs text-muted-foreground">
          {t("restoreRun.report.nodes", { count: report.counts.clusterNodes })}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The restore runs on the updater: worker and scheduler stopped, the dump in a database of its
 * own, migrated, restore mode on, the master key and the storage checked. Then the report, and
 * the operator activates it (or aborts). A master key that does not open the dump is refused:
 * nothing changed, start again with the right key.
 */
export function RestoreRunStep({ token, initial, onStartAgain, onActivated }: RestoreRunStepProps) {
  const { t } = useTranslation("setup");
  const [confirmed, setConfirmed] = React.useState(false);
  const [acceptUnreachable, setAcceptUnreachable] = React.useState(false);
  const info = useQuery({
    queryKey: ["setup", "restore", "run"],
    queryFn: () => fetchRestoreInfo(token),
    refetchInterval: (query) =>
      query.state.data?.operation?.status === "running" || !query.state.data ? 2000 : false,
    retry: false,
  });
  const operation = info.data?.operation ?? initial;
  const activate = useMutation({
    mutationFn: () => activateRestore(token, acceptUnreachable),
    onSuccess: () => {
      try {
        sessionStorage.setItem(RESTORE_ACTIVATED_KEY, "1");
      } catch {
        // Without storage the next step still waits for the restored installation.
      }
      onActivated();
    },
  });
  const abort = useMutation({
    mutationFn: () => abortRestore(token),
    onSuccess: () => void info.refetch(),
  });

  if (!operation) {
    return <p className="text-sm text-muted-foreground">{t("restoreRun.loading")}</p>;
  }
  const report = operation.report;
  const refusal = report?.refusal ?? null;
  const ended = ["refused", "failed", "aborted", "needs_attention"].includes(operation.status);
  const activateError =
    activate.error instanceof ApiError && typeof activate.error.problem?.detail === "string"
      ? activate.error.problem.detail
      : activate.error
        ? t("restoreRun.activateFailed")
        : null;

  return (
    <div className="space-y-4 text-sm">
      {operation.status === "running" ? (
        <div className="space-y-2">
          <Progress value={PHASE_PROGRESS[operation.phase]} />
          <p className="text-muted-foreground">{t(`restoreRun.phase.${operation.phase}`)}</p>
        </div>
      ) : null}
      {operation.status === "refused" && refusal ? (
        <div role="alert" className="space-y-2 rounded-md border border-destructive p-3">
          <p className="font-medium text-destructive">
            {t(`restoreRun.refused.${refusal.code}.title`)}
          </p>
          <p className="text-muted-foreground">{t(`restoreRun.refused.${refusal.code}.text`)}</p>
          <p className="text-muted-foreground">{t("restoreRun.refused.nothingChanged")}</p>
        </div>
      ) : null}
      {operation.status === "failed" || operation.status === "needs_attention" ? (
        <div role="alert" className="space-y-2 rounded-md border border-destructive p-3">
          <p className="font-medium text-destructive">
            {t(`restoreRun.${operation.status}.title`)}
          </p>
          <p className="text-muted-foreground">{t(`restoreRun.${operation.status}.text`)}</p>
          {operation.message ? <p className="font-mono text-xs">{operation.message}</p> : null}
        </div>
      ) : null}
      {operation.status === "aborted" ? (
        <p className="text-muted-foreground">{t("restoreRun.aborted")}</p>
      ) : null}
      {report && operation.status === "awaiting_confirmation" ? <Report report={report} /> : null}
      {operation.status === "awaiting_confirmation" ? (
        <div className="space-y-3">
          <p className="text-muted-foreground">{t("restoreRun.restoreModeOn")}</p>
          {(report?.storage.unreachable ?? 0) > 0 ? (
            <label className="flex items-start gap-2" htmlFor="restore-accept-unreachable">
              <Checkbox
                id="restore-accept-unreachable"
                checked={acceptUnreachable}
                onCheckedChange={(value) => setAcceptUnreachable(value === true)}
              />
              <span>{t("restoreRun.acceptUnreachable")}</span>
            </label>
          ) : null}
          <label className="flex items-start gap-2" htmlFor="restore-confirm">
            <Checkbox
              id="restore-confirm"
              checked={confirmed}
              onCheckedChange={(value) => setConfirmed(value === true)}
            />
            <span>{t("restoreRun.confirm")}</span>
          </label>
          {activateError ? (
            <p role="alert" className="text-destructive">
              {activateError}
            </p>
          ) : null}
          <div className="flex gap-2">
            <Button
              type="button"
              onClick={() => activate.mutate()}
              disabled={
                !confirmed ||
                ((report?.storage.unreachable ?? 0) > 0 && !acceptUnreachable) ||
                activate.isPending
              }
              loading={activate.isPending}
            >
              {t("restoreRun.activate")}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => abort.mutate()}
              disabled={abort.isPending || activate.isPending}
            >
              {t("restoreRun.abort")}
            </Button>
          </div>
        </div>
      ) : null}
      {ended && operation.status !== "needs_attention" ? (
        <Button type="button" variant="outline" onClick={onStartAgain}>
          {t("restoreRun.startAgain")}
        </Button>
      ) : null}
    </div>
  );
}
