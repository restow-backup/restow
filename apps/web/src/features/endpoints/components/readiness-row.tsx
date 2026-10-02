import { Link } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import { useTranslation } from "react-i18next";

import { RelativeTime, StatusBadge } from "@/components/kit";
import { buttonVariants } from "@/components/ui/button";
import { PIN_FIRST, TableCell, TableRow } from "@/components/ui/table";
import type { EndpointReadinessRow } from "@/features/verify/api";
import { StateBadge } from "@/features/verify/components/status";

import "../i18n.js";
import { endpointDetailTo } from "../paths.js";
import { endpointHostLine, endpointName } from "../presenters.js";
import { ProfileIcon } from "./status.js";

/**
 * A server or client as a row of the recovery readiness table
 * (features/verify), next to the mailboxes, OneDrives and IMAP accounts: the
 * same six columns (object, readiness, last check, result, latest backup,
 * actions), the same rating, with the type of the machine (Server or Client)
 * and its operating system where a mailbox shows its address.
 */

/** The translation key (namespace `endpoints`) of the result line of a machine. */
export function endpointResultKey(row: Pick<EndpointReadinessRow, "state" | "overdue">): string {
  if (row.state === "no_backup") {
    return row.overdue
      ? "readinessSection.result.noBackupOverdue"
      : "readinessSection.result.noBackup";
  }
  return `readinessSection.result.${row.state}`;
}

function MachineCell({ row }: { row: EndpointReadinessRow }) {
  const { t } = useTranslation("endpoints");
  const name = endpointName(row);
  const host = endpointHostLine(row);
  return (
    <div className="flex min-w-0 items-start gap-2" data-slot="endpoint-readiness-object">
      <ProfileIcon profile={row.profile} className="mt-0.5" />
      <div className="min-w-0" title={host ?? undefined}>
        <p className="truncate font-medium" title={name}>
          {name}
        </p>
        <p className="truncate text-xs text-muted-foreground">
          {t(`profile.${row.profile}`)} · {t(`os.${row.os}`)}
        </p>
      </div>
    </div>
  );
}

export function EndpointReadinessRowView({ row }: { row: EndpointReadinessRow }) {
  const { t } = useTranslation("endpoints");
  const result = t(endpointResultKey(row));
  return (
    <TableRow data-slot="endpoint-readiness-row">
      <TableCell pin={PIN_FIRST} className="max-w-md pl-6">
        <MachineCell row={row} />
      </TableCell>
      <TableCell className="whitespace-nowrap">
        <div className="flex flex-wrap items-center gap-1.5">
          <StateBadge state={row.state} overdue={row.overdue} />
          {row.overdue && row.state !== "no_backup" ? (
            <StatusBadge tone="warning">{t("readinessSection.overdue")}</StatusBadge>
          ) : null}
        </div>
      </TableCell>
      <TableCell className="whitespace-nowrap">
        <RelativeTime
          value={row.checkedAt}
          fallback={t("readinessSection.notChecked")}
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
          fallback={t("list.noBackupYet")}
          focusable={false}
        />
      </TableCell>
      <TableCell className="pr-6">
        <div className="flex items-center justify-end gap-2 whitespace-nowrap">
          <Link
            to={endpointDetailTo(row.id)}
            className={buttonVariants({ variant: "ghost", size: "sm" })}
            aria-label={t("readinessSection.openFor", { name: endpointName(row) })}
          >
            {t("readinessSection.open")}
            <ArrowRight aria-hidden="true" />
          </Link>
        </div>
      </TableCell>
    </TableRow>
  );
}
