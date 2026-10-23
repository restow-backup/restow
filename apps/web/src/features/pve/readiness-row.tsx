import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowRight, Box, Monitor } from "lucide-react";
import { useTranslation } from "react-i18next";

import { RelativeTime, StatusBadge } from "@/components/kit";
import { Button, buttonVariants } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { PIN_FIRST, TableCell, TableRow } from "@/components/ui/table";
import { useTenantScope } from "@/features/endpoints/hooks";
import { type GuestReadinessRow, verifyKeys } from "@/features/verify/api";
import { StateBadge } from "@/features/verify/components/status";
import { guestRowName } from "@/features/verify/presenters";

import { pveKeys, verifyGuest } from "./api.js";
import "./i18n.js";
import { guestTo } from "./paths.js";

/**
 * A VM or container of Proxmox VE as a row of the recovery readiness table (features/verify),
 * next to the mailboxes and the machines: the same six columns (object, readiness, last check,
 * result, latest backup, actions), rated by the restore check and the boot test of its newest
 * restore point.
 */

/** The translation key (namespace `pve`) of the result line of a guest. */
export function guestResultKey(
  row: Pick<GuestReadinessRow, "state" | "overdue" | "basis" | "verifyNotChecked">,
): string {
  if (row.state === "no_backup") {
    return row.overdue ? "readiness.result.noBackupOverdue" : "readiness.result.noBackup";
  }
  // The boot test decided: green only when the guest agent answered, yellow when it only started.
  if (row.basis === "boot_test") {
    if (row.state === "green") return "readiness.result.bootGreen";
    if (row.state === "yellow") return "readiness.result.bootYellow";
    if (row.state === "red") return "readiness.result.bootRed";
  }
  // The read-back rates green or red, or yellow when it could not run at all (servers from 0.4.3).
  if (row.state === "yellow" && row.verifyNotChecked) {
    return row.verifyNotChecked.reason === "locked"
      ? "readiness.result.notCheckedLocked"
      : "readiness.result.notCheckedInterrupted";
  }
  return row.state === "yellow" ? "readiness.result.bootYellow" : `readiness.result.${row.state}`;
}

/** "Check now" of a guest's newest restore point (D2): queued for the worker's next pass. */
function useGuestCheck() {
  const { t } = useTranslation("pve");
  const queryClient = useQueryClient();
  const { tenantId } = useTenantScope();
  return useMutation({
    mutationFn: (guestId: string) => verifyGuest(guestId),
    onSuccess: () => {
      toast.success(t("readiness.checkQueued"));
      void queryClient.invalidateQueries({ queryKey: verifyKeys.all(tenantId) });
      void queryClient.invalidateQueries({ queryKey: pveKeys.all(tenantId) });
    },
    onError: (error) => toast.error((error as Error).message),
  });
}

export function GuestReadinessRowView({
  row,
  canCheck = true,
}: {
  row: GuestReadinessRow;
  canCheck?: boolean;
}) {
  const { t } = useTranslation("pve");
  const check = useGuestCheck();
  const name = guestRowName(row);
  // A red row names what failed: the boot test's message when the boot test decided, else
  // what the restore check found.
  const bootMessage =
    row.state === "red" && row.basis === "boot_test" ? (row.bootTest?.message ?? "") : "";
  const errors =
    row.state === "red" ? [...(bootMessage ? [bootMessage] : []), ...(row.verifyErrors ?? [])] : [];
  // A check that could not run says why (who held the repository's lock), muted: no finding.
  const notChecked = row.state === "yellow" ? (row.verifyNotChecked?.detail ?? "") : "";
  const result = t(guestResultKey(row));
  // A red restore check names what it found (the real restic or read error), not only the rule.
  const resultTitle =
    errors.length > 0
      ? `${result}\n${errors.join("\n")}`
      : notChecked
        ? `${result}\n${notChecked}`
        : result;
  const Icon = row.kind === "vm" ? Monitor : Box;
  return (
    <TableRow data-slot="guest-readiness-row">
      <TableCell pin={PIN_FIRST} className="max-w-md pl-6">
        <div className="flex min-w-0 items-start gap-2">
          <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <div className="min-w-0">
            <p className="truncate font-medium" title={name}>
              {name}
            </p>
            <p className="truncate text-xs text-muted-foreground">
              {t(`guests.${row.kind}`)} {row.vmid}
              {row.node ? ` · ${row.node}` : ""}
            </p>
          </div>
        </div>
      </TableCell>
      <TableCell className="whitespace-nowrap">
        <div className="flex flex-wrap items-center gap-1.5">
          <StateBadge state={row.state} overdue={row.overdue} />
          {row.overdue && row.state !== "no_backup" ? (
            <StatusBadge tone="warning">{t("readiness.overdue")}</StatusBadge>
          ) : null}
          {row.inJob ? null : <StatusBadge tone="warning">{t("readiness.noJob")}</StatusBadge>}
        </div>
      </TableCell>
      <TableCell className="whitespace-nowrap">
        <div className="flex flex-col items-start gap-1">
          <RelativeTime
            value={row.checkedAt}
            fallback={t("readiness.notChecked")}
            focusable={false}
          />
          {row.checkRequested ? (
            // Asked for and not done yet: the row says so until the result replaces it.
            <StatusBadge tone="info" live aria-live="polite" data-slot="guest-readiness-waiting">
              {t("readiness.checkWaiting")}
            </StatusBadge>
          ) : null}
        </div>
      </TableCell>
      <TableCell className="max-w-64">
        <span className="line-clamp-2 text-muted-foreground" title={resultTitle}>
          {result}
        </span>
        {errors[0] ? (
          <span
            className="line-clamp-1 text-xs text-destructive-text"
            title={errors.join("\n")}
            data-slot="guest-readiness-error"
          >
            {errors[0]}
          </span>
        ) : notChecked ? (
          <span
            className="line-clamp-1 text-xs text-muted-foreground"
            title={notChecked}
            data-slot="guest-readiness-not-checked"
          >
            {notChecked}
          </span>
        ) : null}
      </TableCell>
      <TableCell className="whitespace-nowrap">
        <RelativeTime
          value={row.latestBackupAt}
          fallback={t("readiness.noBackupYet")}
          focusable={false}
        />
      </TableCell>
      <TableCell className="pr-6">
        <div className="flex items-center justify-end gap-2 whitespace-nowrap">
          {canCheck && row.latestSnapshotId ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={row.checkRequested === true || check.isPending}
              loading={check.isPending}
              aria-label={t("readiness.checkNowFor", { name })}
              onClick={() => check.mutate(row.id)}
              data-slot="guest-readiness-check"
            >
              {row.checkRequested ? t("readiness.checkWaiting") : t("readiness.checkNow")}
            </Button>
          ) : null}
          <Link
            {...guestTo(row.id)}
            className={buttonVariants({ variant: "ghost", size: "sm" })}
            aria-label={t("readiness.openFor", { name })}
          >
            {t("readiness.open")}
            <ArrowRight aria-hidden="true" />
          </Link>
        </div>
      </TableCell>
    </TableRow>
  );
}
