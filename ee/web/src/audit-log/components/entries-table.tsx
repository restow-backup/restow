import { ShieldAlert } from "lucide-react";
import type * as React from "react";

import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { AuditEntry } from "../api";
import type { AuditFormat } from "../hooks";
import { isOpaqueId } from "../presenters";
import { actorText } from "./actor";

/** The audit entries, newest first; a row opens the entry's details. */
export function AuditEntriesTable({
  entries,
  showTenant,
  selectedId,
  format,
  onOpen,
}: {
  entries: readonly AuditEntry[];
  showTenant: boolean;
  selectedId: string | undefined;
  format: AuditFormat;
  onOpen: (entryId: string) => void;
}) {
  const { t } = format;
  return (
    <Table>
      <TableCaption className="sr-only">{t("table.caption")}</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead className="pl-4">{t("table.time")}</TableHead>
          <TableHead>{t("table.action")}</TableHead>
          <TableHead>{t("table.actor")}</TableHead>
          <TableHead>{t("table.target")}</TableHead>
          {showTenant ? <TableHead>{t("table.tenant")}</TableHead> : null}
          <TableHead className="pr-4">{t("table.ip")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {entries.map((entry) => (
          <EntryRow
            key={entry.id}
            entry={entry}
            showTenant={showTenant}
            selected={entry.id === selectedId}
            format={format}
            onOpen={onOpen}
          />
        ))}
      </TableBody>
    </Table>
  );
}

/**
 * What an entry points at: the name the server resolved (a mailbox, an import,
 * an uploaded file, a machine), with the stored id one hover away. Without a
 * name an opaque id is shown whole in the small monospace face, wrapped rather
 * than cut off, as the id it is.
 */
export function TargetName({ target, label }: { target: string; label: string | null }) {
  if (label) {
    return (
      <span className="block truncate" title={target}>
        {label}
      </span>
    );
  }
  if (isOpaqueId(target)) {
    return (
      <code className="block break-all text-xs text-muted-foreground" title={target}>
        {target}
      </code>
    );
  }
  return (
    <span className="block truncate" title={target}>
      {target}
    </span>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return <span className="text-muted-foreground">{children}</span>;
}

function EntryRow({
  entry,
  showTenant,
  selected,
  format,
  onOpen,
}: {
  entry: AuditEntry;
  showTenant: boolean;
  selected: boolean;
  format: AuditFormat;
  onOpen: (entryId: string) => void;
}) {
  const { t } = format;
  const label = format.actionLabel(entry.action);
  return (
    <TableRow
      data-state={selected ? "selected" : undefined}
      className="cursor-pointer"
      onClick={() => onOpen(entry.id)}
    >
      <TableCell className="pl-4 align-top whitespace-nowrap">
        <time dateTime={entry.createdAt} className="block tabular-nums">
          {format.dateTime(entry.createdAt)}
        </time>
        <span className="text-xs text-muted-foreground">{format.relative(entry.createdAt)}</span>
      </TableCell>
      <TableCell className="max-w-72 align-top">
        <div className="flex items-start gap-1.5">
          {entry.hashValid ? null : (
            <ShieldAlert
              className="mt-0.5 size-4 shrink-0 text-destructive"
              aria-label={t("table.hashMismatch")}
              role="img"
            />
          )}
          <div className="min-w-0">
            {/* The row is clickable for the mouse; this button is the keyboard path. */}
            <button
              type="button"
              className="text-left font-medium underline-offset-4 hover:underline focus-visible:underline focus-visible:outline-none"
              onClick={(event) => {
                event.stopPropagation();
                onOpen(entry.id);
              }}
            >
              {label ?? entry.action}
            </button>
            {label ? (
              <code className="block truncate text-xs text-muted-foreground">{entry.action}</code>
            ) : null}
          </div>
        </div>
      </TableCell>
      <TableCell className="max-w-64 align-top">
        <span className="block truncate">{actorText(entry.actor, format)}</span>
        {entry.onBehalfOf ? (
          <span className="block truncate text-xs text-muted-foreground">
            {t("table.onBehalfOf", { subject: entry.onBehalfOf })}
          </span>
        ) : null}
      </TableCell>
      <TableCell className="max-w-64 align-top">
        {entry.target ? (
          <>
            <TargetName target={entry.target} label={entry.targetLabel ?? null} />
            {entry.targetType ? (
              <span className="block truncate text-xs text-muted-foreground">
                {format.targetTypeLabel(entry.targetType)}
              </span>
            ) : null}
          </>
        ) : (
          <Muted>–</Muted>
        )}
      </TableCell>
      {showTenant ? (
        <TableCell className="max-w-48 align-top">
          <span className="block truncate">{entry.tenantName ?? t("chain.installation")}</span>
        </TableCell>
      ) : null}
      <TableCell className="pr-4 align-top">
        {entry.ip ? <code className="text-xs">{entry.ip}</code> : <Muted>–</Muted>}
      </TableCell>
    </TableRow>
  );
}
