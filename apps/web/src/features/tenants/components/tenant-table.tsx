import { Link } from "@tanstack/react-router";
import { ArrowRightLeft, Building2, Ellipsis, Eye, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  PIN_FIRST,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import type { HealthState } from "../hooks";
import { tenantDetailTo } from "../paths";
import { canEnter, mailboxUsage } from "../presenters";
import type { TenantItem, UsageOverview } from "../types";
import { HealthSummary, LastBackup, MailboxUsageText, TenantStatusBadge } from "./badges";

interface TenantTableProps {
  tenants: TenantItem[];
  health: Map<string, HealthState>;
  /** Protected mailboxes per tenant; undefined while unknown. */
  usage: UsageOverview | undefined;
  activeTenantId: string | null;
  onEnter: (tenant: TenantItem) => void;
  /** "Open tenant page": switch to the tenant and open its setup area. */
  onOpenSetup?: (tenant: TenantItem) => void;
  /** Offers deleting a tenant; left out when the provider role does not allow it. */
  onDelete?: (tenant: TenantItem) => void;
}

/** The provider's tenants with protection state and the actions per tenant. */
export function TenantTable({
  tenants,
  health,
  usage,
  activeTenantId,
  onEnter,
  onOpenSetup,
  onDelete,
}: TenantTableProps) {
  const { t } = useTranslation("tenants");
  return (
    <Table scrollLabel={t("list.title")}>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead pin={PIN_FIRST}>{t("list.columns.tenant")}</TableHead>
          <TableHead className="hidden sm:table-cell">{t("list.columns.mailboxes")}</TableHead>
          <TableHead className="hidden lg:table-cell">{t("list.columns.lastBackup")}</TableHead>
          <TableHead className="hidden md:table-cell">{t("list.columns.readiness")}</TableHead>
          <TableHead className="w-0">
            <span className="sr-only">{t("list.columns.actions")}</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {tenants.map((tenant) => {
          const deleting = !canEnter(tenant);
          const state = health.get(tenant.id);
          const current = tenant.id === activeTenantId;
          return (
            <TableRow key={tenant.id}>
              <TableCell pin={PIN_FIRST} className="min-w-0 max-w-[22rem] py-3">
                <div className="flex min-w-0 flex-col items-start gap-1">
                  <Link
                    to={tenantDetailTo(tenant.id)}
                    className="max-w-full truncate rounded-sm font-medium outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {tenant.name}
                  </Link>
                  <span className="max-w-full truncate font-mono text-xs text-muted-foreground">
                    {tenant.slug}
                  </span>
                  {tenant.status !== "active" || current || tenant.kind === "internal" ? (
                    <span className="flex flex-wrap gap-1">
                      {tenant.status === "active" ? null : (
                        <TenantStatusBadge status={tenant.status} />
                      )}
                      {tenant.kind === "internal" ? (
                        <Badge variant="outline">{t("ownOrganisation.badge")}</Badge>
                      ) : null}
                      {current ? <Badge variant="secondary">{t("list.current")}</Badge> : null}
                    </span>
                  ) : null}
                  {deleting ? null : (
                    // Narrow screens hide the readiness column; the essentials move here.
                    <div className="pt-1 md:hidden">
                      <HealthSummary state={state} />
                    </div>
                  )}
                </div>
              </TableCell>
              <TableCell className="hidden sm:table-cell">
                {deleting ? (
                  <span className="text-sm text-muted-foreground">{t("mailboxes.notTracked")}</span>
                ) : (
                  <MailboxUsageText usage={mailboxUsage(tenant, usage)} />
                )}
              </TableCell>
              <TableCell className="hidden lg:table-cell">
                <LastBackup state={state} deleting={deleting} />
              </TableCell>
              <TableCell className="hidden md:table-cell">
                <HealthSummary state={state} deleting={deleting} />
              </TableCell>
              <TableCell>
                <div className="flex items-center justify-end gap-1">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => onEnter(tenant)}
                    disabled={deleting}
                    className="hidden sm:inline-flex"
                  >
                    <ArrowRightLeft />
                    {t("actions.enter")}
                  </Button>
                  <RowMenu
                    tenant={tenant}
                    deleting={deleting}
                    onEnter={() => onEnter(tenant)}
                    onOpenSetup={onOpenSetup ? () => onOpenSetup(tenant) : undefined}
                    onDelete={onDelete ? () => onDelete(tenant) : undefined}
                  />
                </div>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

interface RowMenuProps {
  tenant: TenantItem;
  deleting: boolean;
  onEnter: () => void;
  onOpenSetup?: () => void;
  onDelete?: () => void;
}

function RowMenu({ tenant, deleting, onEnter, onOpenSetup, onDelete }: RowMenuProps) {
  const { t } = useTranslation("tenants");
  const { t: tc } = useTranslation();
  const label = t("actions.moreFor", { name: tenant.name });
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={label} title={label}>
          <Ellipsis />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuItem asChild>
          <Link to={tenantDetailTo(tenant.id)}>
            <Eye />
            {t("actions.open")}
          </Link>
        </DropdownMenuItem>
        {onOpenSetup ? (
          <DropdownMenuItem onSelect={onOpenSetup} disabled={deleting}>
            <Building2 />
            {tc("nav.setup.openTenantPage")}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem onSelect={onEnter} disabled={deleting}>
          <ArrowRightLeft />
          {t("actions.enter")}
        </DropdownMenuItem>
        {onDelete ? (
          <>
            <DropdownMenuSeparator />
            {/* The own organisation is deleted only after another tenant took its place. */}
            <DropdownMenuItem
              onSelect={onDelete}
              disabled={deleting || tenant.kind === "internal"}
              variant="destructive"
            >
              <Trash2 />
              {t("actions.delete")}
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
