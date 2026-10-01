import { Link, type LinkProps, useRouterState } from "@tanstack/react-router";
import { Check, ChevronDown, Lock } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { usePageTitle } from "@/components/kit/page-context";
import { buildBreadcrumbTrail } from "@/components/layout/breadcrumb-trail";
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
import { TENANT_SETUP_PATH } from "@/features/tenant-setup/tabs";
import { type PlacedNavItem, groupNavItems } from "@/lib/navigation";
import { canAccess, useSession } from "@/lib/session";
import { useNavItems } from "@/lib/use-nav-items";
import { cn } from "@/lib/utils";

/** The router marks active links itself; exact only, so it never contradicts ours. */
const EXACT_MATCH = { exact: true, includeSearch: true } as const;

/**
 * Breadcrumbs of the current shell page: section (a menu of its entries),
 * menu entry and the title the page published (the entity name on detail
 * pages). Below the md breakpoint only the last crumb stays, so the top bar
 * keeps its height.
 */
export function ShellBreadcrumbs({ className }: { className?: string }) {
  const { t } = useTranslation();
  const entry = useShellEntry();
  const pageTitle = usePageTitle();
  const session = useSession();
  const navItems = useNavItems();
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  const setupTab = entry?.setupTab ?? null;
  // In the setup area the entry crumb names what the area is set up for:
  // the tenant where tenants are managed, else the entry itself ("Setup").
  const entryLabel = entry
    ? setupTab && entry.item.id === "tenants"
      ? (session.activeTenant?.name ?? t(entry.item.labelKey))
      : t(entry.item.labelKey)
    : null;

  const trail = buildBreadcrumbTrail({
    pathname,
    entry:
      entry && entryLabel
        ? {
            id: entry.item.id,
            path: setupTab ? TENANT_SETUP_PATH : entry.item.path,
            label: entryLabel,
          }
        : null,
    groupLabel: entry?.group ? t(`nav.groups.${entry.group}`) : null,
    groupId: entry?.group ?? null,
    setupTab: setupTab
      ? { id: setupTab.id, path: setupTab.path, label: t(setupTab.labelKey) }
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
          // Only the last crumb shows on small screens.
          const hideOnMobile = last ? undefined : "hidden md:inline-flex";
          const groupItems = crumb.group
            ? (groups.find((group) => group.id === crumb.group)?.items ?? [])
            : [];
          return (
            <React.Fragment key={crumb.key}>
              <BreadcrumbItem className={cn("min-w-0", hideOnMobile)}>
                {crumb.current ? (
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
              {last ? null : <BreadcrumbSeparator className="hidden md:block" />}
            </React.Fragment>
          );
        })}
      </BreadcrumbList>
    </Breadcrumb>
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
}: {
  label: string;
  items: readonly PlacedNavItem[];
  activeId: string | null;
}) {
  const { t } = useTranslation();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="inline-flex min-w-0 items-center gap-1 rounded-sm outline-none transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 data-[state=open]:text-foreground"
        aria-label={t("nav.groupMenu", { group: label })}
        data-slot="breadcrumb-group"
      >
        <span className="truncate">{label}</span>
        <ChevronDown aria-hidden="true" className="size-3.5 shrink-0" />
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
