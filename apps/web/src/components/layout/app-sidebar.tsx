import { Link, type LinkProps } from "@tanstack/react-router";
import { ArrowUpCircle, Lock } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useShellEntry } from "@/components/layout/shell-entry";
import { SoonBadge, SoonSuffix } from "@/components/layout/soon-badge";
import { TenantSwitcher } from "@/components/tenant-switcher";
import { Badge } from "@/components/ui/badge";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarSeparator,
  useSidebar,
} from "@/components/ui/sidebar";
import { BrandName, RestowMark } from "@/components/wordmark";
import { StartEntry } from "@/features/start";
import { ExtensionSlot } from "@/lib/extensions";
import { groupNavItems, navGroupLabelKey } from "@/lib/navigation";
import { isTenantOnlyNavItem } from "@/lib/scope";
import { type RunningVersion, canAccess, sessionScope, useSession } from "@/lib/session";
import { useNavItems } from "@/lib/use-nav-items";

const EXACT_MATCH = { exact: true, includeSearch: true } as const;

/**
 * The application sidebar on the shadcn Sidebar: the product mark, the tenant
 * switcher (which tenant the daily work belongs to, with the way to its
 * settings), the navigation grouped by section (filtered by the role in the
 * active tenant,
 * locked entries greyed out, see `NavLock` in lib/navigation.ts, upcoming
 * ones marked "Soon"; under "All tenants" the entries that only exist per tenant
 * are dimmed, lib/scope.ts), and a footer with "Start" (the setup checklist, until
 * it is done), what extensions add there (`shell.sidebarFooter`) and the running
 * version. Account security lives in
 * the user menu. It collapses to an icon rail (labels move into tooltips),
 * becomes a sheet below 768 px and toggles with Ctrl/Cmd+B; the state is
 * remembered per browser by the sidebar primitive.
 */
export function AppSidebar() {
  const { t } = useTranslation();
  const session = useSession();
  const { role, version } = session;
  const { isMobile, setOpenMobile } = useSidebar();
  const items = useNavItems();
  const entry = useShellEntry();
  const allTenants = sessionScope(session) === "all";

  const groups = groupNavItems(items, role, canAccess, session);
  const installationGroups = groups.filter((group) => group.id === "installation");
  const mainGroups = groups.filter((group) => group.id !== "installation");
  // A tap on a link in the mobile sheet should reveal the page it opens.
  const closeOnMobile = () => {
    if (isMobile) {
      setOpenMobile(false);
    }
  };

  // One section of the navigation. The installation section is rendered apart, pinned below
  // the scrolling sections: what it holds applies to the whole installation, everything above
  // it to the organisation that is active.
  const renderGroup = (group: (typeof groups)[number]) => (
    <SidebarGroup key={group.id}>
      <SidebarGroupLabel>{t(navGroupLabelKey(group.id, session))}</SidebarGroupLabel>
      {group.id === "installation" ? (
        <p className="px-2 pb-1 text-[0.6875rem] leading-snug text-sidebar-foreground/70 group-data-[collapsible=icon]:hidden">
          {t("nav.installationHint")}
        </p>
      ) : null}
      <SidebarGroupContent>
        <SidebarMenu>
          {group.items.map((item) => {
            const Icon = item.icon;
            const label = t(item.labelKey);
            const active = entry?.item.id === item.id;
            if (item.locked && item.lock) {
              // A locked entry leads where its lock says (never a
              // placeholder page, never a popup) and names the reason.
              const tooltip = `${label} — ${t(item.lock.hintKey)}`;
              return (
                <SidebarMenuItem key={item.id}>
                  <SidebarMenuButton
                    asChild
                    tooltip={tooltip}
                    className="text-sidebar-foreground/50 hover:text-sidebar-foreground/50"
                  >
                    <Link
                      to={item.lock.to as LinkProps["to"]}
                      search={item.lock.search as never}
                      aria-disabled="true"
                      data-locked="true"
                      onClick={closeOnMobile}
                    >
                      <Icon aria-hidden="true" />
                      <span>{label}</span>
                      <Lock aria-hidden="true" className="ml-auto size-3.5 shrink-0" />
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              );
            }
            const stage = item.stage ? t(`nav.stage.${item.stage}`) : null;
            const soon = item.soon ? t("nav.soon.badge") : null;
            // Under "All tenants" an entry that needs a tenant stays reachable (it asks for
            // one), but is dimmed and says why.
            const dimmed = allTenants && isTenantOnlyNavItem(item.id);
            const dimmedHint = dimmed ? t("nav.scope.dimmedHint") : null;
            const note = stage ?? soon;
            return (
              <SidebarMenuItem key={item.id}>
                <SidebarMenuButton
                  asChild
                  isActive={active}
                  tooltip={
                    dimmedHint ? `${label} — ${dimmedHint}` : note ? `${label} (${note})` : label
                  }
                  className={
                    dimmed
                      ? "text-sidebar-foreground/50 hover:text-sidebar-foreground/70"
                      : undefined
                  }
                >
                  <Link
                    // Feature paths are registered at runtime, so the
                    // static route typing cannot know them.
                    to={item.path as LinkProps["to"]}
                    search={(item.search ?? {}) as never}
                    // Our own notion of "active" (shell-entry.ts) decides; the router's,
                    // which also sets aria-current, is held to exact matches so that
                    // Settings stays unmarked on Settings › About (License).
                    activeOptions={EXACT_MATCH}
                    aria-current={active ? "page" : undefined}
                    data-soon={item.soon ? "true" : undefined}
                    data-scope-dimmed={dimmed ? "true" : undefined}
                    title={dimmedHint ?? undefined}
                    onClick={closeOnMobile}
                  >
                    <Icon aria-hidden="true" />
                    <span>
                      {label}
                      {/* "Jobs, coming soon" for assistive technology. */}
                      {item.soon ? <SoonSuffix /> : null}
                      {dimmedHint ? <span className="sr-only">{`, ${dimmedHint}`}</span> : null}
                    </span>
                    {item.soon ? (
                      <SoonBadge className="ml-auto group-data-[collapsible=icon]:hidden" />
                    ) : null}
                    {stage ? (
                      <span className="ml-auto rounded border border-sidebar-border px-1 text-[0.625rem] leading-4 font-medium text-sidebar-foreground/70 group-data-[collapsible=icon]:hidden">
                        {stage}
                      </span>
                    ) : null}
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild tooltip={t("app.name")}>
              <Link to="/" onClick={closeOnMobile}>
                {/* The menu button sizes its icons to 16px; the mark is a brand element and keeps its own size until the sidebar collapses to icons. */}
                <RestowMark className="size-7! group-data-[collapsible=icon]:size-4!" />
                <BrandName className="text-base font-semibold tracking-tight group-data-[collapsible=icon]:sr-only" />
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        {/* Below the wordmark, above the first section; in the mobile sheet too. */}
        <TenantSwitcher />
      </SidebarHeader>

      <SidebarContent>
        <nav aria-label={t("nav.label")}>{mainGroups.map(renderGroup)}</nav>
      </SidebarContent>

      {installationGroups.length > 0 ? (
        <nav
          aria-label={t("nav.installationLabel")}
          data-slot="installation-nav"
          className="shrink-0 border-t border-sidebar-border bg-sidebar-accent/40"
        >
          {installationGroups.map(renderGroup)}
        </nav>
      ) : null}

      <SidebarFooter>
        {/* The setup checklist, until every step is done (nothing renders then). */}
        <StartEntry />
        <SidebarSeparator className="mx-0 group-data-[collapsible=icon]:sr-only" />
        <div className="flex flex-col gap-2 px-2 pb-1 text-xs text-sidebar-foreground/70 group-data-[collapsible=icon]:hidden">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <ExtensionSlot name="shell.sidebarFooter" props={{}} />
            <VersionLabel version={version} />
          </div>
          <UpdateNotice version={version} />
        </div>
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  );
}

function VersionLabel({ version }: { version: RunningVersion | null }) {
  const { t } = useTranslation();
  if (!version) {
    return null;
  }
  return (
    <span className="tabular-nums">
      {version.running
        ? t("shell.version", { version: version.running })
        : t("shell.versionUntagged")}
    </span>
  );
}

/** Shown only when the operator enabled the update check and it found a newer release. */
function UpdateNotice({ version }: { version: RunningVersion | null }) {
  const { t } = useTranslation();
  if (!version?.updateAvailable || !version.latest) {
    return null;
  }
  const label = t("shell.updateAvailable", { version: version.latest });
  const content = (
    <>
      <ArrowUpCircle aria-hidden="true" />
      {label}
    </>
  );
  return version.releaseUrl ? (
    <Badge variant="info" asChild className="self-start">
      <a href={version.releaseUrl} target="_blank" rel="noreferrer noopener">
        {content}
      </a>
    </Badge>
  ) : (
    <Badge variant="info" className="self-start">
      {content}
    </Badge>
  );
}
