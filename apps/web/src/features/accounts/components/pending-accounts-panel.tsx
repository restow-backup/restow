import { useQuery } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { RefreshCw } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { DataTable, DataTableSearch, RelativeTime } from "@/components/kit";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "@/components/ui/sonner";
import { setupStateQueryOptions } from "@/routes/tree";

import { usePendingAccounts, useReissueAccountLink } from "../hooks";
import { linkStatusBadge, provisionError } from "../presenters";
import type { PendingAccount, ProvisionResult } from "../types";
import { CopyLinkDialog } from "./copy-link-dialog";

interface PendingAccountsPanelProps {
  tenantId: string;
  /** No changes while the tenant is being deleted (the API refuses them too). */
  readOnly?: boolean;
}

/**
 * People a tenant admin provisioned who have not set a password yet: shown
 * next to the members list so a sign-in link nobody has redeemed is never
 * quietly forgotten. Invisible while the query is still loading and while
 * there is nothing pending — an empty supplementary panel would just be
 * noise next to the members list above it, and a skeleton that then
 * disappears the moment loading finishes (the common case) is a layout
 * shift the UX bar forbids — but a load failure always shows, with a retry
 * (never hidden, per the honesty rule).
 */
export function PendingAccountsPanel({ tenantId, readOnly = false }: PendingAccountsPanelProps) {
  const { t } = useTranslation(["accounts", "tenants"]);
  const query = usePendingAccounts(tenantId);
  const reissue = useReissueAccountLink(tenantId);
  const setup = useQuery(setupStateQueryOptions);
  const mailConfigured = Boolean(setup.data?.mailTransport);
  const [dialogResult, setDialogResult] = React.useState<ProvisionResult | null>(null);
  // A link already reads "valid" (someone may have it in their inbox
  // already): reissuing it is confirmed first, since it stops working the
  // moment the new one is issued. Any other status has nothing live to lose.
  const [confirmTarget, setConfirmTarget] = React.useState<PendingAccount | null>(null);

  const accounts = query.data ?? [];
  if (query.isPending || (!query.isError && accounts.length === 0)) {
    return null;
  }

  const issueLink = (userId: string) => {
    reissue.mutate(userId, {
      onSuccess: (result) => setDialogResult(result),
      onError: (error) => {
        const message = provisionError(error);
        toast.error(t(message.key, message.values));
      },
    });
  };

  const requestLink = (account: PendingAccount) => {
    if (account.linkStatus === "valid") {
      setConfirmTarget(account);
    } else {
      issueLink(account.userId);
    }
  };

  const busyUserId = reissue.isPending ? (reissue.variables ?? null) : null;
  const columns = pendingAccountColumns(t, {
    mailConfigured,
    readOnly,
    busyUserId,
    onGetLink: requestLink,
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("accounts:pending.title")}</CardTitle>
        <CardDescription>{t("accounts:pending.description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <DataTable
          id="accounts-pending"
          label={t("accounts:pending.title")}
          columns={columns}
          data={query.data}
          getRowId={(row) => row.userId}
          fetching={query.isFetching}
          error={query.isError ? query.error : undefined}
          onRetry={() => void query.refetch()}
          errorTitle={t("accounts:pending.error")}
          columnsMenu={false}
          pagination={{ mode: "client", pageSize: 10 }}
          toolbar={
            accounts.length > 5
              ? (table) => (
                  <DataTableSearch
                    value={(table.getState().globalFilter as string | undefined) ?? ""}
                    onChange={(value) => table.setGlobalFilter(value)}
                    placeholder={t("accounts:pending.search")}
                  />
                )
              : undefined
          }
        />
      </CardContent>
      <CopyLinkDialog
        open={dialogResult !== null}
        onOpenChange={(open) => !open && setDialogResult(null)}
        result={dialogResult}
      />
      <AlertDialog
        open={confirmTarget !== null}
        onOpenChange={(open) => !open && setConfirmTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("accounts:pending.reissueConfirm.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmTarget
                ? t("accounts:pending.reissueConfirm.description", { email: confirmTarget.email })
                : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common:actions.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirmTarget) {
                  issueLink(confirmTarget.userId);
                }
                setConfirmTarget(null);
              }}
            >
              {t("accounts:pending.reissueConfirm.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

interface ColumnOptions {
  mailConfigured: boolean;
  readOnly: boolean;
  busyUserId: string | null;
  onGetLink: (account: PendingAccount) => void;
}

function pendingAccountColumns(
  t: (key: string, values?: Record<string, unknown>) => string,
  { mailConfigured, readOnly, busyUserId, onGetLink }: ColumnOptions,
): ColumnDef<PendingAccount>[] {
  return [
    {
      id: "person",
      accessorFn: (row) => row.name || row.email,
      header: t("tenants:members.columns.person"),
      cell: ({ row }) => (
        <div className="flex min-w-0 flex-col">
          <span className="truncate font-medium">{row.original.name || row.original.email}</span>
          {row.original.name ? (
            <span className="truncate text-xs text-muted-foreground">{row.original.email}</span>
          ) : null}
        </div>
      ),
    },
    {
      id: "role",
      accessorFn: (row) => t(`tenants:members.roles.${row.role}`),
      header: t("tenants:members.columns.role"),
    },
    {
      id: "status",
      accessorFn: (row) => t(linkStatusBadge(row.linkStatus).labelKey),
      header: t("accounts:pending.columns.status"),
      cell: ({ row }) => {
        const badge = linkStatusBadge(row.original.linkStatus);
        return (
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={badge.variant}>{t(badge.labelKey)}</Badge>
            {row.original.linkStatus === "valid" && row.original.linkExpiresAt ? (
              <span className="text-xs text-muted-foreground">
                {t("accounts:pending.linkExpiresAt")}{" "}
                <RelativeTime value={row.original.linkExpiresAt} />
              </span>
            ) : null}
          </div>
        );
      },
    },
    {
      id: "actions",
      enableSorting: false,
      header: () => <span className="sr-only">{t("tenants:members.columns.actions")}</span>,
      meta: { className: "w-44 text-right" },
      cell: ({ row }) => {
        if (readOnly) {
          return null;
        }
        const account = row.original;
        const busy = busyUserId === account.userId;
        return (
          <div className="flex justify-end">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onGetLink(account)}
              loading={busy}
              disabled={busyUserId !== null && !busy}
            >
              {busy ? null : <RefreshCw />}
              {mailConfigured ? t("accounts:pending.resend") : t("accounts:pending.copyNewLink")}
            </Button>
          </div>
        );
      },
    },
  ];
}
