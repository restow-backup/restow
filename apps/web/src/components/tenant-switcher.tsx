import { type LinkProps, useNavigate, useRouterState } from "@tanstack/react-router";
import { Building2, Check, ChevronsUpDown } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { toast } from "@/components/ui/sonner";
import { useOpenTenantSetup } from "@/features/tenant-setup/setup-tabs";
import { TENANT_SETUP_NAV_ID } from "@/features/tenant-setup/tabs";
import { pathAfterTenantSwitch } from "@/lib/navigation";
import { type SessionTenant, canAccess, hasFeature, useSession } from "@/lib/session";
import { canEnterTenant } from "@/lib/tenant";
import { useNavItems } from "@/lib/use-nav-items";
import { cn } from "@/lib/utils";

/**
 * Make another tenant the active one: every tenant-scoped query is re-read
 * for it, a detail page of the previous tenant gives way to its list, and a
 * toast confirms the switch. Shared by the switcher and the command palette.
 */
export function useSwitchTenant(): (tenant: Pick<SessionTenant, "id" | "name">) => void {
  const { t } = useTranslation();
  const { activeTenant, setActiveTenant } = useSession();
  const navigate = useNavigate();
  const items = useNavItems();
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  return React.useCallback(
    (tenant) => {
      if (tenant.id === activeTenant?.id) {
        return;
      }
      setActiveTenant(tenant.id);
      toast.success(t("tenant.switched", { name: tenant.name }));
      const next = pathAfterTenantSwitch(pathname, items);
      if (next) {
        void navigate({ to: next as LinkProps["to"] });
      }
    },
    [activeTenant?.id, items, navigate, pathname, setActiveTenant, t],
  );
}

/**
 * Searchable tenant switcher. Tenant names are data from the API, not UI
 * copy, so they are not translated; the surrounding labels are. Provider
 * admins see every tenant, everyone else their memberships, each with the
 * role that applies there; a suspended tenant says so and is open only to
 * provider admins.
 */
export function TenantSwitcher({ className }: { className?: string }) {
  const { t } = useTranslation();
  const session = useSession();
  const { tenants, activeTenant, isProviderAdmin, role } = session;
  const switchTenant = useSwitchTenant();
  const openTenantSetup = useOpenTenantSetup();
  const [open, setOpen] = React.useState(false);
  // Where tenants are managed the setup area has no menu entry ("Setup" is
  // for one-tenant installations): it opens from here, for the active tenant.
  const offersTenantPage =
    activeTenant !== null &&
    hasFeature(session, "tenants.additional") &&
    canAccess(role, ["provider_admin", "tenant_admin"]);

  if (tenants.length === 0) {
    return (
      <div
        className={cn(
          "inline-flex h-9 items-center gap-2 rounded-md border border-dashed border-border px-3 text-sm text-muted-foreground",
          className,
        )}
        title={t("tenant.noneDescription")}
      >
        <Building2 className="size-4 shrink-0" aria-hidden="true" />
        <span className="hidden truncate sm:inline">{t("tenant.none")}</span>
        <span className="sr-only sm:hidden">{t("tenant.noneDescription")}</span>
      </div>
    );
  }

  const roleLabel = (tenant: SessionTenant) =>
    t(`roles.${isProviderAdmin ? "provider_admin" : tenant.role}`);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {/* The trigger announces a dialog (search field plus list); Radix sets
            aria-haspopup, aria-expanded and aria-controls. */}
        <Button
          variant="outline"
          aria-label={t("tenant.switchCurrent", {
            name: activeTenant?.name ?? t("tenant.placeholder"),
          })}
          // The top bar keeps the name to one line; a long one shows in full on hover.
          title={activeTenant?.name}
          className={cn(
            "max-w-full min-w-0 justify-between gap-2 px-2.5 sm:max-w-[16rem]",
            className,
          )}
        >
          <Building2 className="text-muted-foreground" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate text-left">
            {activeTenant?.name ?? t("tenant.placeholder")}
          </span>
          {activeTenant && activeTenant.status !== "active" ? (
            <Badge variant="warning" className="hidden sm:inline-flex">
              {t(`tenant.status.${activeTenant.status}`)}
            </Badge>
          ) : null}
          <ChevronsUpDown className="text-muted-foreground" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(22rem,calc(100vw-2rem))] p-0">
        <Command>
          <CommandInput placeholder={t("tenant.search")} aria-label={t("tenant.search")} />
          <CommandList>
            <CommandEmpty>{t("tenant.empty")}</CommandEmpty>
            <CommandGroup heading={t("tenant.count", { count: tenants.length })}>
              {tenants.map((tenant) => {
                const selected = tenant.id === activeTenant?.id;
                const enterable = canEnterTenant(tenant.status, isProviderAdmin);
                return (
                  <CommandItem
                    key={tenant.id}
                    value={`${tenant.name} ${tenant.slug}`}
                    disabled={!enterable}
                    onSelect={() => {
                      setOpen(false);
                      switchTenant(tenant);
                    }}
                    className="gap-2"
                  >
                    <Check
                      className={cn("size-4", selected ? "opacity-100" : "opacity-0")}
                      aria-hidden="true"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block [overflow-wrap:anywhere]">{tenant.name}</span>
                      <span className="block text-xs text-muted-foreground">
                        {roleLabel(tenant)}
                        {enterable ? null : ` · ${t("tenant.closedHint")}`}
                      </span>
                    </span>
                    {tenant.status === "active" ? null : (
                      <Badge variant="warning" className="shrink-0">
                        {t(`tenant.status.${tenant.status}`)}
                      </Badge>
                    )}
                    {selected ? <span className="sr-only">{t("tenant.current")}</span> : null}
                  </CommandItem>
                );
              })}
            </CommandGroup>
            {offersTenantPage && activeTenant ? (
              <>
                <CommandSeparator />
                <CommandGroup>
                  <CommandItem
                    value={`${TENANT_SETUP_NAV_ID} ${t("nav.setup.openTenantPage")}`}
                    onSelect={() => {
                      setOpen(false);
                      openTenantSetup(activeTenant);
                    }}
                    className="gap-2"
                  >
                    <Building2 className="size-4" aria-hidden="true" />
                    <span className="min-w-0 flex-1">
                      {t("nav.setup.openTenantPageFor", { name: activeTenant.name })}
                    </span>
                  </CommandItem>
                </CommandGroup>
              </>
            ) : null}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
