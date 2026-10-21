import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ShieldQuestion } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { useTenantScope } from "@/features/endpoints/hooks";
import { type GuestReadinessRow, type PveChecks, verifyKeys } from "@/features/verify/api";

import { pveKeys, verifyUnverifiedGuests } from "./api.js";
import "./i18n.js";

/**
 * Proxmox VE in Recovery readiness (docs/PVE.md, "Restore check"): the VMs and containers whose
 * newest restore point no check read back yet, with "Check all unverified" (D2), and how the
 * guests are checked, apart from the Microsoft 365 schedule in the footer (D3).
 */

/**
 * The guests whose newest restore point is unverified and waits for no check: never checked,
 * or its check could not run (the repository stayed locked; servers from 0.4.3).
 */
export function uncheckedGuests(rows: readonly GuestReadinessRow[]): GuestReadinessRow[] {
  return rows.filter(
    (row) =>
      (row.state === "unverified" || (row.state === "yellow" && Boolean(row.verifyNotChecked))) &&
      !row.checkRequested,
  );
}

export function GuestChecksCallout({ guests }: { guests: readonly GuestReadinessRow[] }) {
  const { t } = useTranslation("pve");
  const queryClient = useQueryClient();
  const { tenantId } = useTenantScope();
  const start = useMutation({
    mutationFn: verifyUnverifiedGuests,
    onSuccess: (result) => {
      toast.success(t("readiness.checkAllQueued", { count: result.queued }));
      void queryClient.invalidateQueries({ queryKey: verifyKeys.all(tenantId) });
      void queryClient.invalidateQueries({ queryKey: pveKeys.all(tenantId) });
    },
    onError: (error) => toast.error((error as Error).message),
  });
  const unchecked = uncheckedGuests(guests);
  const waiting = guests.filter((row) => row.checkRequested).length;
  if (unchecked.length === 0 && waiting === 0) {
    return null;
  }
  return (
    <Alert variant="warning" data-slot="pve-readiness-unchecked">
      <ShieldQuestion aria-hidden="true" />
      <AlertTitle>
        {unchecked.length > 0
          ? t("readiness.uncheckedTitle", { count: unchecked.length })
          : t("readiness.waitingTitle", { count: waiting })}
      </AlertTitle>
      <AlertDescription>
        {unchecked.length > 0 ? <p>{t("readiness.uncheckedBody")}</p> : null}
        {waiting > 0 ? <p>{t("readiness.waiting", { count: waiting })}</p> : null}
        {unchecked.length > 0 ? (
          <Button
            size="sm"
            className="mt-2"
            onClick={() => start.mutate()}
            loading={start.isPending}
            disabled={start.isPending}
          >
            {t("readiness.checkAll")}
          </Button>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}

/** The footer line of the guests' checks: after every backup (when on) and weekly. */
export function pveChecksLine(
  t: (key: string, options?: Record<string, unknown>) => string,
  checks: PveChecks,
): string {
  return checks.afterBackup
    ? t("readiness.scheduleAfterBackup", { days: checks.periodicDays })
    : t("readiness.schedulePeriodic", { days: checks.periodicDays });
}

export function PveChecksFooter({ checks }: { checks: PveChecks | null | undefined }) {
  const { t } = useTranslation("pve");
  if (!checks) {
    return null;
  }
  return (
    <p className="text-xs text-muted-foreground" data-slot="pve-readiness-schedule">
      {pveChecksLine(t, checks)}
    </p>
  );
}
