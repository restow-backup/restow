import { Link, type LinkProps, useRouterState } from "@tanstack/react-router";
import { Check, ChevronDown, Lock } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { usePageTitle } from "@/components/kit/page-context";
import {
  type Crumb,
  type ScopeKind,
  buildBreadcrumbTrail,
  scopeKindOf,
  scopeOpensGroup,
} from "@/components/layout/breadcrumb-trail";
import { ScopePill } from "@/components/layout/scope-pill";
import { useShellEntry } from "@/components/layout/shell-entry";
import { SoonBadge, SoonSuffix } from "@/components/layout/soon-badge";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { type PlacedNavItem, groupNavItems, navGroupLabelKey } from "@/lib/navigation";
import { canAccess, hasFeature, sessionScope, useSession } from "@/lib/session";
import { TENANT_SETTINGS_NAV_IDS } from "@/lib/tenant-nav";
import { parseTenantPagePath, tenantRootPath } from "@/lib/tenant-paths";
import { useNavItems } from "@/lib/use-nav-items";
import { cn } from "@/lib/utils";

/**
 * A tenant's name can be very long (a municipal utility with its full legal
 * name): the scope pill gives way to it by width, so the crumbs after it (the
 * section, the page) keep their room. The full label is its title.
 */
const SCOPE_PILL_WIDTH = "max-w-40 sm:max-w-52 lg:max-w-60 2xl:max-w-72";

/** The router marks active links itself; exact only, so it never contradicts ours. */
const EXACT_MATCH = { exact: true, includeSearch: true } as const;

/**
 * Breadcrumbs of the current shell page: the scope (the level the page works
 * on: the installation, the own organisation, a tenant, all tenants), section
 * (a menu of its entries), menu entry and the title the page published (the
 * entity name on detail pages). Below the md breakpoint the scope and the
 * last crumb stay, so the top bar keeps its height and the level stays in
 * sight now that the tenant switcher is in the sidebar.
 */
export function ShellBreadcrumbs({ className }: { className?: string }) {
  const { t } = useTranslation();
  const entry = useShellEntry();
  const pageTitle = usePageTitle();
  const session = useSession();
  const navItems = useNavItems();
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  const scopeKind = scopeKindOf({
    groupId: entry?.group ?? null,
    entryId: entry?.item.id ?? null,
    tenantKind: session.activeTenant?.kind ?? null,
    organisationMode: !hasFeature(session, "tenants.additional"),
    allTenants: sessionScope(session) === "all",
    mayManageTenants: session.isProviderAdmin,
  });
  const entryLabel = entry ? t(entry.item.labelKey) : null;
  // The tenant settings entry opens the overview, but the crumb stands for the whole page of the
  // tenant: the section the visitor is on follows it as the current page.
  const tenantPage = parseTenantPagePath(pathname);
  const entryPath =
    entry && TENANT_SETTINGS_NAV_IDS.includes(entry.item.id) && tenantPage
      ? tenantRootPath(tenantPage.tenantId)
      : entry?.item.path;

  const trail = buildBreadcrumbTrail({
    pathname,
    entry:
      entry && entryLabel
        ? {
            id: entry.item.id,
            path: entryPath ?? entry.item.path,
            label: entryLabel,
          }
        : null,
    groupLabel: entry?.group ? t(navGroupLabelKey(entry.group, session)) : null,
    groupId: entry?.group ?? null,
    scope: scopeKind
      ? {
          kind: scopeKind,
          label: t(`nav.scope.${scopeKind}`, { name: session.activeTenant?.name ?? "" }),
          opensGroup: scopeOpensGroup(scopeKind, entry?.group ?? null),
        }
      : null,
    pageTitle,
  });

  const groups = React.useMemo(
    () => groupNavItems(navItems, session.role, canAccess, session),
    [navItems, session],
  );

  if (trail.length === 0) {
    return null;
  }

  return (
    <Breadcrumb className={cn("min-w-0", className)}>
      <BreadcrumbList className="flex-nowrap">
        {trail.map((crumb, index) => {
          const last = index === trail.length - 1;
          // On small screens only the scope and the last crumb show.
          const hideOnMobile = last || crumb.scope ? undefined : "hidden md:inline-flex";
          const groupItems = crumb.group
            ? (groups.find((group) => group.id === crumb.group)?.items ?? [])
            : [];
          return (
            <React.Fragment key={crumb.key}>
              <BreadcrumbItem
                className={cn(
                  "min-w-0",
                  hideOnMobile,
                  // A long tenant name gives way first (and never to nothing), so the section and the
                  // page stay readable. The other crumbs keep their width: a share of a pixel taken
                  // from a text is already an ellipsis. "Installation" and "All tenants" are short
                  // words that name the level: they keep theirs too.
                  crumb.scope === "installation" || crumb.scope === "all"
                    ? "shrink-0"
                    : crumb.scope
                      ? "min-w-12 shrink-[100]"
                      : "shrink-0",
                  last && !crumb.scope && "max-w-[70%]",
                )}
              >
                {crumb.scope ? (
                  <ScopeCrumb
                    crumb={crumb}
                    kind={crumb.scope}
                    groupItems={groupItems}
                    activeId={entry?.item.id ?? null}
                  />
                ) : crumb.current ? (
                  <BreadcrumbPage className="truncate font-medium">{crumb.label}</BreadcrumbPage>
                ) : crumb.to ? (
                  <BreadcrumbLink asChild className="truncate">
                    <Link to={crumb.to as LinkProps["to"]}>{crumb.label}</Link>
                  </BreadcrumbLink>
                ) : groupItems.length > 0 ? (
                  <GroupCrumbMenu
                    label={crumb.label}
                    items={groupItems}
                    activeId={entry?.item.id ?? null}
                  />
                ) : (
                  <span className="truncate">{crumb.label}</span>
                )}
              </BreadcrumbItem>
              {last ? null : (
                <BreadcrumbSeparator className={crumb.scope ? undefined : "hidden md:block"} />
              )}
            </React.Fragment>
          );
        })}
      </BreadcrumbList>
    </Breadcrumb>
  );
}

/**
 * The scope crumb: a pill saying which level the page works on. It is the
 * current page where the scope is the entry itself (all tenants), a link
 * above a detail page of it, the menu of its group where the group is named
 * like the scope (Installation), and plain text otherwise.
 */
function ScopeCrumb({
  crumb,
  kind,
  groupItems,
  activeId,
}: {
  crumb: Crumb;
  kind: ScopeKind;
  groupItems: readonly PlacedNavItem[];
  activeId: string | null;
}) {
  if (crumb.group && groupItems.length > 0) {
    return (
      <GroupCrumbMenu label={crumb.label} items={groupItems} activeId={activeId} scope={kind} />
    );
  }
  if (crumb.current) {
    return (
      <BreadcrumbPage className="min-w-0">
        <ScopePill kind={kind} title={crumb.label} className={SCOPE_PILL_WIDTH}>
          {crumb.label}
        </ScopePill>
      </BreadcrumbPage>
    );
  }
  if (crumb.to) {
    return (
      <BreadcrumbLink asChild className="min-w-0">
        <Link to={crumb.to as LinkProps["to"]}>
          <ScopePill kind={kind} title={crumb.label} className={SCOPE_PILL_WIDTH}>
            {crumb.label}
          </ScopePill>
        </Link>
      </BreadcrumbLink>
    );
  }
  return (
    <ScopePill kind={kind} title={crumb.label} className={SCOPE_PILL_WIDTH}>
      {crumb.label}
    </ScopePill>
  );
}

/**
 * The group crumb as a menu button: Enter, Space or a click opens the list of
 * the group's entries (the sidebar's filter: role, edition locks, "Soon"),
 * the arrow keys move, Enter opens an entry and Escape closes the menu and
 * returns focus to the crumb (Radix menu primitives).
 */
export function GroupCrumbMenu({
  label,
  items,
  activeId,
  scope,
}: {
  label: string;
  items: readonly PlacedNavItem[];
  activeId: string | null;
  /** Show the trigger as the scope pill of this kind (the group is named like the scope). */
  scope?: ScopeKind;
}) {
  const { t } = useTranslation();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          "inline-flex min-w-0 items-center gap-1 rounded-sm outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50",
          scope
            ? "rounded-full"
            : "hover:text-foreground focus-visible:text-foreground data-[state=open]:text-foreground",
        )}
        aria-label={t("nav.groupMenu", { group: label })}
        data-slot="breadcrumb-group"
      >
        {scope ? (
          <ScopePill
            kind={scope}
            title={label}
            className={SCOPE_PILL_WIDTH}
            trailing={<ChevronDown aria-hidden="true" className="size-3.5 shrink-0" />}
          >
            {label}
          </ScopePill>
        ) : (
          <>
            <span className="truncate">{label}</span>
            <ChevronDown aria-hidden="true" className="size-3.5 shrink-0" />
          </>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-56">
        <DropdownMenuLabel className="text-xs text-muted-foreground">{label}</DropdownMenuLabel>
        {items.map((item) => {
          const Icon = item.icon;
          const itemLabel = t(item.labelKey);
          const active = item.id === activeId;
          if (item.locked && item.lock) {
            return (
              <DropdownMenuItem key={item.id} asChild className="text-muted-foreground">
                <Link
                  to={item.lock.to as LinkProps["to"]}
                  search={item.lock.search as never}
                  data-locked="true"
                  title={`${itemLabel} — ${t(item.lock.hintKey)}`}
                >
                  <Icon aria-hidden="true" />
                  <span className="flex-1">{itemLabel}</span>
                  <Lock aria-hidden="true" className="size-3.5" />
                  <span className="sr-only">{`, ${t(item.lock.hintKey)}`}</span>
                </Link>
              </DropdownMenuItem>
            );
          }
          return (
            <DropdownMenuItem key={item.id} asChild>
              <Link
                to={item.path as LinkProps["to"]}
                search={(item.search ?? {}) as never}
                activeOptions={EXACT_MATCH}
                aria-current={active ? "page" : undefined}
              >
                <Icon aria-hidden="true" />
                <span className="flex-1">
                  {itemLabel}
                  {item.soon ? <SoonSuffix /> : null}
                </span>
                {item.soon ? <SoonBadge /> : null}
                {active ? <Check aria-hidden="true" className="size-3.5" /> : null}
              </Link>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
