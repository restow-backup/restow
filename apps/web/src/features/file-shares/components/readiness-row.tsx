import { Link } from "@tanstack/react-router";
import { ArrowRight, Network } from "lucide-react";
import { useTranslation } from "react-i18next";

import { RelativeTime, StatusBadge } from "@/components/kit";
import { buttonVariants } from "@/components/ui/button";
import { PIN_FIRST, TableCell, TableRow } from "@/components/ui/table";
import type { ShareReadinessRow } from "@/features/verify/api";
import { StateBadge } from "@/features/verify/components/status";

import "../i18n.js";
import { fileShareTo, linkTo } from "../paths.js";

/**
 * A file share as a row of the recovery readiness table (features/verify), next to the
 * mailboxes, the machines and the guests (docs/FILESHARES.md 13): the same six columns, rated by
 * the restore check of its newest restore point.
 */

/** The translation key (namespace `fileshares`) of the result line of a share. */
export function shareResultKey(row: Pick<ShareReadinessRow, "state" | "overdue">): string {
  if (row.state === "no_backup") {
    return row.overdue ? "readinessRow.result.noBackupOverdue" : "readinessRow.result.noBackup";
  }
  return `readinessRow.result.${row.state}`;
}

export function ShareReadinessRowView({ row }: { row: ShareReadinessRow }) {
  const { t } = useTranslation("fileshares");
  const result = t(shareResultKey(row));
  return (
    <TableRow data-slot="share-readiness-row">
      <TableCell pin={PIN_FIRST} className="max-w-md pl-6">
        <div className="flex min-w-0 items-start gap-2">
          <Network className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <div className="min-w-0">
            <p className="truncate font-medium" title={row.name}>
              {row.name}
            </p>
            <p className="truncate text-xs text-muted-foreground">
              {t(`protocol.${row.protocol}`)} · {row.server}
            </p>
          </div>
        </div>
      </TableCell>
      <TableCell className="whitespace-nowrap">
        <div className="flex flex-wrap items-center gap-1.5">
          <StateBadge state={row.state} overdue={row.overdue} />
          {row.overdue && row.state !== "no_backup" ? (
            <StatusBadge tone="warning">{t("readinessRow.overdue")}</StatusBadge>
          ) : null}
          {row.inJob ? null : <StatusBadge tone="warning">{t("readinessRow.noJob")}</StatusBadge>}
        </div>
      </TableCell>
      <TableCell className="whitespace-nowrap">
        <RelativeTime
          value={row.checkedAt}
          fallback={t("readinessRow.notChecked")}
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
          fallback={t("readinessRow.noBackupYet")}
          focusable={false}
        />
      </TableCell>
      <TableCell className="pr-6">
        <div className="flex items-center justify-end gap-2 whitespace-nowrap">
          <Link
            {...linkTo(fileShareTo(row.id))}
            className={buttonVariants({ variant: "ghost", size: "sm" })}
            aria-label={t("readinessRow.openFor", { name: row.name })}
          >
            {t("readinessRow.open")}
            <ArrowRight aria-hidden="true" />
          </Link>
        </div>
      </TableCell>
    </TableRow>
  );
}
