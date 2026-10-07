import { Link } from "@tanstack/react-router";
import { ArrowRight, Box, Monitor } from "lucide-react";
import { useTranslation } from "react-i18next";

import { RelativeTime, StatusBadge } from "@/components/kit";
import { buttonVariants } from "@/components/ui/button";
import { PIN_FIRST, TableCell, TableRow } from "@/components/ui/table";
import type { GuestReadinessRow } from "@/features/verify/api";
import { StateBadge } from "@/features/verify/components/status";
import { guestRowName } from "@/features/verify/presenters";

import "./i18n.js";
import { guestTo } from "./paths.js";

/**
 * A VM or container of Proxmox VE as a row of the recovery readiness table (features/verify),
 * next to the mailboxes and the machines: the same six columns (object, readiness, last check,
 * result, latest backup, actions), rated by the restore check of its newest restore point.
 */

/** The translation key (namespace `pve`) of the result line of a guest. */
export function guestResultKey(row: Pick<GuestReadinessRow, "state" | "overdue">): string {
  if (row.state === "no_backup") {
    return row.overdue ? "readiness.result.noBackupOverdue" : "readiness.result.noBackup";
  }
  // A restore point is rated green or red by its check; yellow does not occur for guests.
  return row.state === "yellow" ? "readiness.result.green" : `readiness.result.${row.state}`;
}

export function GuestReadinessRowView({ row }: { row: GuestReadinessRow }) {
  const { t } = useTranslation("pve");
  const name = guestRowName(row);
  const result = t(guestResultKey(row));
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
        <RelativeTime
          value={row.checkedAt}
          fallback={t("readiness.notChecked")}
          focusable={false}
        />
      </TableCell>
      <TableCell className="max-w-64">
        <span className="line-clamp-2 text-muted-foreground" title={result}>
          {result}
        </span>
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
