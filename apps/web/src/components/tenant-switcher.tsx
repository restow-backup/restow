import { Link, type LinkProps, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  ArrowRight,
  Building2,
  Check,
  ChevronsUpDown,
  Layers,
  Settings,
  Shield,
} from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import {
  matchTenantSearch,
  orderTenants,
  tenantSearchValue,
  tenantSublineOf,
} from "@/components/tenant-switcher-model";
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
import { useSidebar } from "@/components/ui/sidebar";
import { toast } from "@/components/ui/sonner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  ALL_TENANTS_NAV_ID,
  type PlacedNavItem,
  pathAfterTenantSwitch,
  visibleNavItems,
} from "@/lib/navigation";
import { type SessionTenant, canAccess, hasFeature, sessionScope, useSession } from "@/lib/session";
import { canEnterTenant } from "@/lib/tenant";
import { TENANT_SETTINGS_NAV_IDS } from "@/lib/tenant-nav";
import { parseTenantPagePath, tenantPageAfterSwitch } from "@/lib/tenant-paths";
import { useNavItems } from "@/lib/use-nav-items";
import { cn } from "@/lib/utils";

/**
 * Make another tenant the active one: every tenant-scoped query is re-read
 * for it, a detail page of the previous tenant gives way to its list, a tenant
 * page opens on the same section of the new tenant, and a toast confirms the
 * switch. Shared by the switcher, the command palette and the "choose a tenant"
 * page. Choosing a tenant also leaves "All tenants", even the tenant that stayed
 * active underneath it.
 */
export function useSwitchTenant(): (tenant: Pick<SessionTenant, "id" | "name">) => void {
  const { t } = useTranslation();
  const session = useSession();
  const { activeTenant, setActiveTenant } = session;
  const scope = sessionScope(session);
  const navigate = useNavigate();
  const items = useNavItems();
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  return React.useCallback(
    (tenant) => {
      if (tenant.id === activeTenant?.id && scope !== "all") {
        return;
      }
      setActiveTenant(tenant.id);
      toast.success(t("tenant.switched", { name: tenant.name }));
      // Out of "All tenants" the page stays: a page that needs a tenant continues with the one
      // chosen. On a tenant's page the page follows: the same section of the new tenant.
      const next =
        tenantPageAfterSwitch(pathname, tenant.id) ?? pathAfterTenantSwitch(pathname, items);
      if (next) {
        void navigate({ to: next as LinkProps["to"] });
      }
    },
    [activeTenant?.id, items, navigate, pathname, scope, setActiveTenant, t],
  );
}

/**
 * Work across all tenants (provider admins on an installation that manages tenants): the
 * overview, and Recovery readiness by tenant, look at every tenant. A page that belongs to
 * one tenant (a tenant's page, a detail page of one of its objects) cannot stay open: it gives
 * way to the overview, or to its list; a list page stays and asks for a tenant.
 */
export function useSwitchToAllTenants(): () => void {
  const { t } = useTranslation();
  const session = useSession();
  const { setScopeAll } = session;
  const scope = sessionScope(session);
  const navigate = useNavigate();
  const items = useNavItems();
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  return React.useCallback(() => {
    if (!setScopeAll || scope === "all") {
      return;
    }
    toast.success(t("tenant.all.switched"));
    const next = parseTenantPagePath(pathname) ? "/" : pathAfterTenantSwitch(pathname, items);
    if (!next) {
      setScopeAll();
      return;
    }
    // The page gives way first: a tenant's page that is still open would take "All tenants" away
    // again (it makes its own tenant the active one).
    void navigate({ to: next as LinkProps["to"] }).then(setScopeAll);
  }, [items, navigate, pathname, scope, setScopeAll, t]);
}

/** The tenant's mark: the own organisation a shield, every other tenant a building. */
function TenantMark({
  tenant,
  className,
}: { tenant: Pick<SessionTenant, "kind">; className?: string }) {
  const Icon = tenant.kind === "internal" ? Shield : Building2;
  return (
    <span
      data-slot="tenant-mark"
      className={cn(
        "flex shrink-0 items-center justify-center rounded-md bg-sidebar-accent text-sidebar-accent-foreground [&>svg]:size-4",
        className,
      )}
    >
      <Icon aria-hidden="true" />
    </span>
  );
}

/** The mark of "All tenants": layers, where a tenant has a building and the own organisation a shield. */
function AllTenantsMark({ className }: { className?: string }) {
  return (
    <span
      data-slot="tenant-mark"
      data-scope="all"
      className={cn(
        "flex shrink-0 items-center justify-center rounded-md bg-sidebar-accent text-sidebar-accent-foreground [&>svg]:size-4",
        className,
      )}
    >
      <Layers aria-hidden="true" />
    </span>
  );
}

/** Second line under the name: customer number (mono), "Internal", "Organisation" or "Tenant". */
function TenantSubline({
  tenant,
  organisationMode,
}: {
  tenant: SessionTenant;
  organisationMode: boolean;
}) {
  const { t } = useTranslation();
  const subline = tenantSublineOf(tenant, organisationMode);
  return (
    <span
      data-slot="tenant-subline"
      className="flex min-w-0 items-center gap-1.5 text-xs leading-4"
    >
      {subline.kind === "number" ? (
        <span className="truncate font-mono">
          <span className="sr-only">{`${t("tenant.customerNumber")} `}</span>
          {subline.number}
        </span>
      ) : (
        <span className="truncate">
          {subline.kind === "internal"
            ? t("tenant.internal")
            : subline.kind === "organisation"
              ? t("tenant.organisation")
              : t("tenant.label")}
        </span>
      )}
      {tenant.status === "active" ? null : (
        <Badge variant="warning" className="h-4 px-1.5 py-0 text-[0.6875rem] leading-4">
          {t(`tenant.status.${tenant.status}`)}
        </Badge>
      )}
    </span>
  );
}

/**
 * The tenant switcher at the top of the sidebar, below the wordmark: which
 * tenant the daily work belongs to, and the way to another one. Tenant names
 * are data from the API, not UI copy, so they are not translated; the
 * surrounding labels are.
 *
 * The trigger keeps one height whichever tenant is active: the mark, the name
 * on one line (long names are cut, the full name is the tooltip) and a second
 * line that is the customer number, "Internal" for the operator's own
 * organisation or "Tenant". The gear beside it opens the settings of the
 * active tenant, the same page as the menu entry. The dropdown is wider than
 * the sidebar and may cover the content; it searches name and customer
 * number, shows full names, and offers "Manage all tenants" to those who may.
 * An installation with exactly one tenant has nothing to switch to: it shows
 * the name statically, with the gear. The collapsed sidebar shows the mark
 * only, with the name as its tooltip, and opens the same dropdown; in the
 * mobile sheet the switcher is the first control below the wordmark.
 *
 * Provider admins see every tenant, everyone else their memberships, each
 * with the role that applies there; a suspended tenant says so and is open
 * only to provider admins.
 */
export function TenantSwitcher({ className }: { className?: string }) {
  const { t } = useTranslation();
  const session = useSession();
  const { tenants, activeTenant, role, canViewAllTenants } = session;
  const allTenants = sessionScope(session) === "all";
  const { state, isMobile, setOpenMobile } = useSidebar();
  const navItems = useNavItems();
  const collapsed = state === "collapsed" && !isMobile;
  const organisationMode = !hasFeature(session, "tenants.additional");

  const entries = React.useMemo(
    () => visibleNavItems(navItems, role, canAccess, session),
    [navItems, role, session],
  );
  const settingsEntry = entries.find((item) => TENANT_SETTINGS_NAV_IDS.includes(item.id)) ?? null;
  const manageAllEntry =
    entries.find((item) => item.id === ALL_TENANTS_NAV_ID && !item.locked) ?? null;

  // A tap on a link in the mobile sheet should reveal the page it opens.
  const closeOnMobile = React.useCallback(() => {
    if (isMobile) {
      setOpenMobile(false);
    }
  }, [isMobile, setOpenMobile]);

  if (tenants.length === 0 || !activeTenant) {
    return (
      <div
        className={cn(
          "flex h-12 items-center gap-2 rounded-md border border-dashed border-sidebar-border px-2 text-sm text-sidebar-foreground/70",
          "group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:p-0",
          className,
        )}
        title={t("tenant.noneDescription")}
      >
        <Building2 className="size-4 shrink-0" aria-hidden="true" />
        <span className="truncate group-data-[collapsible=icon]:sr-only">{t("tenant.none")}</span>
        <span className="sr-only">{t("tenant.noneDescription")}</span>
      </div>
    );
  }

  // Under "All tenants" the gear leads where the menu entry does: the list of tenants.
  const gear = settingsEntry ? (
    <SettingsLink
      entry={settingsEntry}
      label={
        allTenants ? t("tenant.manageAll") : t("tenant.settingsOf", { name: activeTenant.name })
      }
      onNavigate={closeOnMobile}
    />
  ) : null;

  return (
    <div data-slot="tenant-switcher" className={cn("flex items-center gap-1.5", className)}>
      {tenants.length === 1 ? (
        <StaticTenant
          tenant={activeTenant}
          organisationMode={organisationMode}
          collapsed={collapsed}
        />
      ) : (
        <TenantPicker
          tenants={tenants}
          activeTenant={activeTenant}
          allTenants={allTenants}
          offerAllTenants={canViewAllTenants === true}
          organisationMode={organisationMode}
          collapsed={collapsed}
          manageAllEntry={manageAllEntry}
          onNavigate={closeOnMobile}
        />
      )}
      {gear}
    </div>
  );
}

/** The gear: opens the settings of the active tenant (the list of tenants under "All tenants"), where the menu entry leads. */
function SettingsLink({
  entry,
  label,
  onNavigate,
}: {
  entry: PlacedNavItem;
  label: string;
  onNavigate: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          asChild
          variant="outline"
          className="h-12 w-9 px-0 has-[>svg]:px-0 group-data-[collapsible=icon]:hidden"
        >
          <Link
            data-slot="tenant-settings-link"
            to={entry.path as LinkProps["to"]}
            search={(entry.search ?? {}) as never}
            aria-label={label}
            onClick={onNavigate}
          >
            <Settings aria-hidden="true" />
          </Link>
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

const TRIGGER_CLASS = [
  // One height for every tenant: the name is cut, never wrapped.
  "h-12 min-w-0 flex-1 justify-start gap-2 px-2 text-left has-[>svg]:px-2",
  // The collapsed sidebar keeps the mark only.
  "group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:flex-none group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:border-0 group-data-[collapsible=icon]:p-0 group-data-[collapsible=icon]:shadow-none group-data-[collapsible=icon]:has-[>svg]:px-0",
].join(" ");

/** The name and the second line, the part of the trigger the collapsed sidebar hides. */
function TenantText({
  tenant,
  organisationMode,
}: {
  tenant: SessionTenant;
  organisationMode: boolean;
}) {
  return (
    <span className="flex min-w-0 flex-1 flex-col text-left group-data-[collapsible=icon]:sr-only">
      <span data-slot="tenant-name" className="truncate text-sm leading-5 font-medium">
        {tenant.name}
      </span>
      <span className="min-w-0 text-muted-foreground">
        <TenantSubline tenant={tenant} organisationMode={organisationMode} />
      </span>
    </span>
  );
}

/** Exactly one tenant: nothing to switch to, so the name stands there as information. */
function StaticTenant({
  tenant,
  organisationMode,
  collapsed,
}: {
  tenant: SessionTenant;
  organisationMode: boolean;
  collapsed: boolean;
}) {
  const body = (
    <div
      data-slot="tenant-switcher-static"
      // The full name for a name that was cut.
      title={collapsed ? undefined : tenant.name}
      tabIndex={collapsed ? 0 : undefined}
      className={cn(
        "flex h-12 min-w-0 flex-1 items-center gap-2 rounded-md border bg-background px-2 text-sm shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:border-input dark:bg-input/30",
        "group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:flex-none group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:border-0 group-data-[collapsible=icon]:p-0",
      )}
    >
      <TenantMark tenant={tenant} className="size-8" />
      <TenantText tenant={tenant} organisationMode={organisationMode} />
    </div>
  );
  return (
    <Tooltip>
      <TooltipTrigger asChild>{body}</TooltipTrigger>
      <TooltipContent side="right" hidden={!collapsed}>
        {tenant.name}
      </TooltipContent>
    </Tooltip>
  );
}

function TenantPicker({
  tenants,
  activeTenant,
  allTenants,
  offerAllTenants,
  organisationMode,
  collapsed,
  manageAllEntry,
  onNavigate,
}: {
  tenants: readonly SessionTenant[];
  activeTenant: SessionTenant;
  /** "All tenants" is the chosen scope: it, not the active tenant, is what the trigger names. */
  allTenants: boolean;
  /** "All tenants" is on offer as the first entry of the list. */
  offerAllTenants: boolean;
  organisationMode: boolean;
  collapsed: boolean;
  manageAllEntry: PlacedNavItem | null;
  onNavigate: () => void;
}) {
  const { t } = useTranslation();
  const { isProviderAdmin } = useSession();
  const switchTenant = useSwitchTenant();
  const switchToAll = useSwitchToAllTenants();
  const navigate = useNavigate();
  // The provider's customers: its own organisation is not counted.
  const customerCount = tenants.filter((tenant) => tenant.kind !== "internal").length;
  const allLabel = t("tenant.all.title");
  const [open, setOpen] = React.useState(false);
  // The row the arrow keys start from: the tenant that is active.
  const [highlighted, setHighlighted] = React.useState("");
  const ordered = React.useMemo(() => orderTenants(tenants), [tenants]);

  const roleLabel = (tenant: SessionTenant) =>
    t(`roles.${isProviderAdmin ? "provider_admin" : tenant.role}`);

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setHighlighted(allTenants ? allLabel : tenantSearchValue(activeTenant));
        }
        setOpen(next);
      }}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            {/* The trigger announces a dialog (search field plus list); Radix sets
                aria-haspopup, aria-expanded and aria-controls. */}
            <Button
              variant="outline"
              data-slot="tenant-switcher-trigger"
              data-scope={allTenants ? "all" : "tenant"}
              aria-label={t("tenant.switchCurrent", {
                name: allTenants ? allLabel : activeTenant.name,
              })}
              // A long name is cut to one line; the full name shows on hover.
              title={collapsed ? undefined : allTenants ? allLabel : activeTenant.name}
              className={TRIGGER_CLASS}
            >
              {allTenants ? (
                <>
                  <AllTenantsMark className="size-8" />
                  <span className="flex min-w-0 flex-1 flex-col text-left group-data-[collapsible=icon]:sr-only">
                    <span
                      data-slot="tenant-name"
                      className="truncate text-sm leading-5 font-medium"
                    >
                      {allLabel}
                    </span>
                    <span
                      data-slot="tenant-subline"
                      className="truncate text-xs leading-4 text-muted-foreground"
                    >
                      {t("tenant.all.count", { count: customerCount })}
                    </span>
                  </span>
                </>
              ) : (
                <>
                  <TenantMark tenant={activeTenant} className="size-8" />
                  <TenantText tenant={activeTenant} organisationMode={organisationMode} />
                </>
              )}
              <ChevronsUpDown
                className="text-muted-foreground group-data-[collapsible=icon]:hidden"
                aria-hidden="true"
              />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="right" hidden={!collapsed || open}>
          {allTenants ? allLabel : activeTenant.name}
        </TooltipContent>
      </Tooltip>
      <PopoverContent
        align="start"
        collisionPadding={8}
        className="w-[min(24rem,calc(100vw-1rem))] p-0"
      >
        <Command filter={matchTenantSearch} value={highlighted} onValueChange={setHighlighted}>
          <CommandInput placeholder={t("tenant.search")} aria-label={t("tenant.search")} />
          <CommandList className="max-h-80">
            <CommandEmpty>{t("tenant.empty")}</CommandEmpty>
            {offerAllTenants ? (
              <>
                <CommandGroup>
                  <CommandItem
                    value={allLabel}
                    data-current={allTenants ? "true" : undefined}
                    data-option="all-tenants"
                    onSelect={() => {
                      setOpen(false);
                      switchToAll();
                      onNavigate();
                    }}
                    className="items-start gap-2.5 py-2"
                  >
                    <AllTenantsMark className="mt-0.5 size-7" />
                    <span className="min-w-0 flex-1">
                      <span
                        className={cn(
                          "block leading-snug [overflow-wrap:anywhere]",
                          allTenants && "font-medium",
                        )}
                      >
                        {allLabel}
                      </span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        {t("tenant.all.description", { count: customerCount })}
                      </span>
                    </span>
                    {allTenants ? (
                      <>
                        <Check className="mt-0.5 size-4 text-primary" aria-hidden="true" />
                        <span className="sr-only">{t("tenant.current")}</span>
                      </>
                    ) : null}
                  </CommandItem>
                </CommandGroup>
                <CommandSeparator />
              </>
            ) : null}
            <CommandGroup heading={t("tenant.count", { count: tenants.length })}>
              {ordered.map((tenant) => {
                const selected = !allTenants && tenant.id === activeTenant.id;
                const enterable = canEnterTenant(tenant.status, isProviderAdmin);
                return (
                  <CommandItem
                    key={tenant.id}
                    value={tenantSearchValue(tenant)}
                    disabled={!enterable}
                    data-current={selected ? "true" : undefined}
                    onSelect={() => {
                      setOpen(false);
                      switchTenant(tenant);
                      onNavigate();
                    }}
                    className="items-start gap-2.5 py-2"
                  >
                    <TenantMark tenant={tenant} className="mt-0.5 size-7" />
                    <span className="min-w-0 flex-1">
                      <span
                        data-slot="tenant-option-name"
                        className={cn(
                          "block leading-snug [overflow-wrap:anywhere]",
                          selected && "font-medium",
                        )}
                      >
                        {tenant.name}
                      </span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        {tenant.customerNumber ? (
                          <>
                            <span className="sr-only">{`${t("tenant.customerNumber")} `}</span>
                            <span data-slot="tenant-option-number" className="font-mono">
                              {tenant.customerNumber}
                            </span>
                            {" · "}
                          </>
                        ) : null}
                        {roleLabel(tenant)}
                        {enterable ? null : ` · ${t("tenant.closedHint")}`}
                      </span>
                    </span>
                    {tenant.kind === "internal" && !organisationMode ? (
                      <Badge variant="info" className="mt-0.5">
                        {t("tenant.internal")}
                      </Badge>
                    ) : null}
                    {tenant.status === "active" ? null : (
                      <Badge variant="warning" className="mt-0.5 shrink-0">
                        {t(`tenant.status.${tenant.status}`)}
                      </Badge>
                    )}
                    {selected ? (
                      <>
                        <Check className="mt-0.5 size-4 text-primary" aria-hidden="true" />
                        <span className="sr-only">{t("tenant.current")}</span>
                      </>
                    ) : null}
                  </CommandItem>
                );
              })}
            </CommandGroup>
            {manageAllEntry ? (
              /* Pinned to the bottom of the list, and kept when the search finds nothing: the way to the full list. */
              <CommandGroup forceMount className="sticky bottom-0 border-t bg-popover">
                <CommandItem
                  forceMount
                  value="manage-all-tenants"
                  onSelect={() => {
                    setOpen(false);
                    void navigate({ to: manageAllEntry.path as LinkProps["to"] });
                    onNavigate();
                  }}
                  className="justify-center gap-2 font-medium text-primary"
                >
                  {t("tenant.manageAll")}
                  <ArrowRight className="text-primary!" aria-hidden="true" />
                </CommandItem>
              </CommandGroup>
            ) : null}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
