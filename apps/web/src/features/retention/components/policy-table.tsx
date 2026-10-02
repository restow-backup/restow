import type { ColumnDef } from "@tanstack/react-table";
import { Pencil, Trash2 } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import {
  DataTable,
  DataTableSearch,
  RelativeTime,
  StatusBadge,
  rowActionsColumn,
} from "@/components/kit";

import type { RetentionPolicy } from "../api.js";
import { cutoffLabel, scopeLabel } from "../presenters.js";

export interface PolicyTableProps {
  items: readonly RetentionPolicy[] | undefined;
  loading: boolean;
  fetching: boolean;
  error: unknown;
  onRetry: () => void;
  onEdit: (policy: RetentionPolicy) => void;
  onDelete: (policy: RetentionPolicy) => void;
}

/** The policy stays in view while the other columns scroll. */
const PINNED = ["name"] as const;

/** Every retention policy of the tenant: name, what it applies to, how long it keeps restore points. */
export function PolicyTable({
  items,
  loading,
  fetching,
  error,
  onRetry,
  onEdit,
  onDelete,
}: PolicyTableProps) {
  const { t, i18n } = useTranslation("retention");
  const language = i18n.resolvedLanguage ?? i18n.language;

  const columns = React.useMemo<ColumnDef<RetentionPolicy>[]>(
    () => [
      {
        id: "name",
        accessorKey: "name",
        size: 240,
        header: t("table.name"),
        meta: { label: t("table.name") },
        enableHiding: false,
        cell: ({ row }) => (
          <div className="flex items-center gap-2">
            <span className="font-medium">{row.original.name}</span>
            {row.original.isDefault ? (
              <StatusBadge tone="info">{t("scope.tenantWide")}</StatusBadge>
            ) : null}
          </div>
        ),
      },
      {
        id: "scope",
        size: 180,
        accessorFn: (policy) => scopeLabel(policy.isDefault, policy.protectedObjects, t),
        header: t("table.scope"),
        meta: { label: t("table.scope"), cellClassName: "max-w-56 truncate" },
        cell: ({ getValue }) => <span title={String(getValue())}>{String(getValue())}</span>,
      },
      {
        id: "preset",
        size: 180,
        accessorFn: (policy) => t(`presets.${policy.preset}`),
        header: t("table.preset"),
        meta: { label: t("table.preset"), cellClassName: "max-w-64 truncate" },
        cell: ({ getValue }) => <span title={String(getValue())}>{String(getValue())}</span>,
      },
      {
        id: "cutoff",
        size: 130,
        accessorFn: (policy) => policy.cutoffDays ?? Number.POSITIVE_INFINITY,
        header: t("table.cutoff"),
        meta: { label: t("table.cutoff") },
        cell: ({ row }) => cutoffLabel(row.original.cutoffDays, t, language),
      },
      {
        id: "updated",
        size: 130,
        accessorKey: "updatedAt",
        header: t("table.updated"),
        meta: { label: t("table.updated"), className: "hidden md:table-cell" },
        cell: ({ row }) => <RelativeTime value={row.original.updatedAt} focusable={false} />,
      },
      rowActionsColumn<RetentionPolicy>({
        name: (policy) => policy.name,
        actions: (policy) => [
          { id: "edit", label: t("actions.edit"), icon: Pencil, onSelect: () => onEdit(policy) },
          {
            id: "delete",
            label: t("actions.delete"),
            icon: Trash2,
            destructive: true,
            onSelect: () => onDelete(policy),
          },
        ],
      }) as ColumnDef<RetentionPolicy>,
    ],
    [t, language, onEdit, onDelete],
  );

  return (
    <DataTable
      id="retention-policies"
      label={t("table.label")}
      columns={columns}
      data={items}
      getRowId={(policy) => policy.id}
      loading={loading}
      fetching={fetching}
      error={error}
      onRetry={onRetry}
      errorTitle={t("errors.load")}
      empty={null}
      pinnedColumns={PINNED}
      sorting={{ mode: "client", initial: [{ id: "name", desc: false }] }}
      pagination={{ mode: "client", pageSize: 25 }}
      toolbar={
        (items?.length ?? 0) > 5
          ? (table) => (
              <DataTableSearch
                value={(table.getState().globalFilter as string | undefined) ?? ""}
                onChange={(value) => table.setGlobalFilter(value)}
                placeholder={t("table.search")}
              />
            )
          : undefined
      }
    />
  );
}
