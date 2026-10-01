import { ChevronDown } from "lucide-react";
import { useTranslation } from "react-i18next";

import { ActivityOrb, ConfirmDialog, RelativeTime } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Progress } from "@/components/ui/progress";
import { toast } from "@/components/ui/sonner";
import {
  isMigrationRetryable,
  isMigrationRunning,
  migrationEtaParts,
  migrationSummary,
  storageErrorKey,
  targetDisplayName,
} from "../presenters";
import type { StorageTargetDto } from "../types";
import { useCancelMigration, useRetryMigration } from "../use-storage";
import { ToneLine } from "./status";

/**
 * The storage migration a card's target is part of, if any (docs/STORAGE.md,
 * "Replace the primary"): a live progress bar with an orb and an ETA while it
 * moves or verifies, when it is switched or retired instead, and a plain
 * failure or cancellation. Only the destination side may cancel or retry it.
 *
 * A failure's headline is always a translated sentence, never the worker's
 * raw message (which names storage keys and the tenant id, e.g.
 * `tenants/<uuid>/packs/...`): that text is still there, but tucked behind a
 * "technical details" disclosure instead of the visible label.
 */
export function MigrationLine({ target }: { target: StorageTargetDto }) {
  const { t } = useTranslation("storage");
  const { t: tc } = useTranslation();
  const migration = target.migration;
  const cancel = useCancelMigration(target.id);
  const retry = useRetryMigration(target.id);
  if (!migration) {
    return null;
  }

  const active = isMigrationRunning(migration);
  const summary = migrationSummary(migration);
  const isDestination = migration.role === "destination";
  const name = targetDisplayName(target, t);

  const confirmCancel = async () => {
    await cancel.mutateAsync();
    toast.success(t("toasts.migrationCancelled", { name }));
  };

  const runRetry = () => {
    retry.mutate(undefined, {
      onSuccess: () => toast.success(t("toasts.migrationRetried", { name })),
      onError: (error) => toast.error(tc(storageErrorKey(error))),
    });
  };

  return (
    <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-3">
      <div className="flex items-center gap-2">
        {active ? <ActivityOrb kind="storageMigration" size={20} decorative /> : null}
        <ToneLine tone={summary.tone} className="flex-1">
          <span className="inline-flex flex-wrap items-center gap-x-1.5">
            {t(summary.key, summary.values)}
            {migration.status === "completed" ? (
              <RelativeTime value={migration.switchedAt} />
            ) : null}
          </span>
        </ToneLine>
      </div>
      {active && migration.percent !== null ? (
        <div className="space-y-1">
          <Progress value={migration.percent} aria-label={t(summary.key, summary.values)} />
          {migration.etaSeconds !== null ? (
            <p className="text-xs text-muted-foreground tabular-nums">
              {t("migration.etaLabel", {
                duration: t(
                  migrationEtaParts(migration.etaSeconds).key,
                  migrationEtaParts(migration.etaSeconds).values,
                ),
              })}
            </p>
          ) : null}
        </div>
      ) : null}
      {(migration.status === "failed" || migration.stalled) && migration.errorMessage ? (
        <Collapsible>
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="flex items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:underline"
            >
              <ChevronDown aria-hidden="true" className="size-3" />
              {t("migration.showDetails")}
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <pre className="mt-1.5 overflow-x-auto rounded-md bg-muted p-2 font-mono text-xs whitespace-pre-wrap text-muted-foreground">
              {migration.errorMessage}
            </pre>
          </CollapsibleContent>
        </Collapsible>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {isDestination && migration.cancellable ? (
          <ConfirmDialog
            trigger={
              <Button variant="outline" size="sm">
                {t("migration.cancel")}
              </Button>
            }
            title={t("migration.cancelConfirmTitle")}
            description={t("migration.cancelConfirmDescription")}
            confirmLabel={t("migration.cancelConfirm")}
            destructive
            pending={cancel.isPending}
            error={cancel.error ? tc(storageErrorKey(cancel.error)) : undefined}
            onConfirm={confirmCancel}
          />
        ) : null}
        {isDestination && isMigrationRetryable(migration) ? (
          <Button variant="outline" size="sm" onClick={runRetry} loading={retry.isPending}>
            {t("migration.retry")}
          </Button>
        ) : null}
      </div>
      {retry.error ? (
        <p className="text-xs text-destructive">{tc(storageErrorKey(retry.error))}</p>
      ) : null}
    </div>
  );
}
