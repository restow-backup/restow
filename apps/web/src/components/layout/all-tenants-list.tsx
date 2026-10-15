import { ArrowRightLeft, Building2, ChevronRight, Shield } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { tenantSublineOf } from "@/components/tenant-switcher-model";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { SessionTenant } from "@/lib/session";
import { cn } from "@/lib/utils";

/**
 * The tenants of a page that works per tenant, as the provider sees them under "All tenants":
 * one row per tenant with what the page knows about it beside the name, opened in place to show
 * more (the disclosure pattern: a button with `aria-expanded` that controls the region below
 * it), and on the right a button that makes the tenant the active one and continues on the page
 * with it. Opening a row never switches the tenant; switching never needs the row open.
 *
 * Built for Jobs (#63); History, Warnings and the Restore explorer can hand it their own summary
 * and detail. On a phone the summary moves to a line of its own under the name.
 */

export type ListTenant = Pick<
  SessionTenant,
  "id" | "name" | "slug" | "kind" | "customerNumber" | "status"
>;

/** The mark, name and second line of a tenant, as the switcher shows them. */
export function TenantIdentity({
  tenant,
  organisationMode,
}: {
  tenant: ListTenant;
  organisationMode: boolean;
}) {
  const { t } = useTranslation();
  const subline = tenantSublineOf(tenant, organisationMode);
  const Mark = tenant.kind === "internal" ? Shield : Building2;
  return (
    <>
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground [&>svg]:size-4">
        <Mark aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{tenant.name}</span>
        <span className="block truncate text-xs text-muted-foreground">
          {subline.kind === "number" ? (
            <>
              <span className="sr-only">{`${t("tenant.customerNumber")} `}</span>
              <span className="font-mono">{subline.number}</span>
            </>
          ) : subline.kind === "internal" ? (
            t("tenant.internal")
          ) : subline.kind === "organisation" ? (
            t("tenant.organisation")
          ) : (
            t("tenant.label")
          )}
        </span>
      </span>
      {tenant.kind === "internal" && !organisationMode ? (
        <Badge variant="info">{t("tenant.internal")}</Badge>
      ) : null}
      {tenant.status === "active" ? null : (
        <Badge variant="warning">{t(`tenant.status.${tenant.status}`)}</Badge>
      )}
    </>
  );
}

export interface AllTenantsListItem {
  tenant: ListTenant;
  /** What the page knows about the tenant, beside its name (no controls: it is read as a description). */
  summary: React.ReactNode;
  /** What an opened row shows; rendered only while it is open, so it may load on demand. */
  detail: () => React.ReactNode;
  /** The tenant cannot be entered (closed to this person): the switch button is off. */
  switchDisabled?: boolean;
}

export interface AllTenantsListProps {
  /** The list's name for a screen reader. */
  label: string;
  items: readonly AllTenantsListItem[];
  organisationMode: boolean;
  onSwitch: (tenant: ListTenant) => void;
}

export function AllTenantsList({ label, items, organisationMode, onSwitch }: AllTenantsListProps) {
  const [open, setOpen] = React.useState<ReadonlySet<string>>(() => new Set());
  const toggle = React.useCallback((id: string) => {
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  return (
    <Card className="gap-0 overflow-hidden py-0">
      <ul aria-label={label} className="divide-y" data-slot="all-tenants-list">
        {items.map((item) => (
          <AllTenantsRow
            key={item.tenant.id}
            item={item}
            expanded={open.has(item.tenant.id)}
            onToggle={toggle}
            organisationMode={organisationMode}
            onSwitch={onSwitch}
          />
        ))}
      </ul>
    </Card>
  );
}

function AllTenantsRow({
  item,
  expanded,
  onToggle,
  organisationMode,
  onSwitch,
}: {
  item: AllTenantsListItem;
  expanded: boolean;
  onToggle: (id: string) => void;
  organisationMode: boolean;
  onSwitch: (tenant: ListTenant) => void;
}) {
  const { t } = useTranslation();
  const id = React.useId();
  const buttonId = `${id}-button`;
  const panelId = `${id}-panel`;
  const summaryId = `${id}-summary`;
  const { tenant } = item;

  return (
    <li data-tenant={tenant.id} data-expanded={expanded || undefined}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
        <button
          type="button"
          id={buttonId}
          aria-expanded={expanded}
          aria-controls={panelId}
          aria-describedby={summaryId}
          onClick={() => onToggle(tenant.id)}
          data-slot="all-tenants-toggle"
          className={cn(
            "-mx-2 -my-1 flex min-w-0 flex-1 basis-48 items-center gap-3 rounded-md px-2 py-1 text-left outline-none transition-colors",
            "hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50",
          )}
        >
          <ChevronRight
            aria-hidden="true"
            className={cn(
              "size-4 shrink-0 text-muted-foreground motion-safe:transition-transform",
              expanded && "rotate-90",
            )}
          />
          <TenantIdentity tenant={tenant} organisationMode={organisationMode} />
        </button>
        <div
          id={summaryId}
          data-slot="all-tenants-summary"
          className="order-last flex min-w-0 basis-full flex-wrap items-center gap-x-3 gap-y-1 text-sm sm:order-none sm:basis-auto sm:justify-end"
        >
          {item.summary}
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={item.switchDisabled}
          onClick={() => onSwitch(tenant)}
          aria-label={t("allTenantsList.switchTo", { name: tenant.name })}
          data-slot="all-tenants-switch"
          className="shrink-0"
        >
          <ArrowRightLeft aria-hidden="true" />
          <span className="hidden md:inline">{t("allTenantsList.switch")}</span>
        </Button>
      </div>
      {/* Always present, so `aria-controls` names an element; its content exists only while open. */}
      <section
        id={panelId}
        aria-labelledby={buttonId}
        hidden={!expanded}
        data-slot="all-tenants-detail"
        className="border-t bg-muted/30 px-4 py-3"
      >
        {expanded ? item.detail() : null}
      </section>
    </li>
  );
}
