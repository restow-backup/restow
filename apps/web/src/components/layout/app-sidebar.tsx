import { Link, type LinkProps } from "@tanstack/react-router";
import { cn } from "cn";
import { ArrowUpCircle, Clock, Loader2, Lock } from "lucide-react";
import type * as React from "react";
import { useTranslation } from "react-i18next";

import { CollapsibleNavSection } from "@/components/layout/collapsible-nav-section";
import { useShellEntry } from "@/components/layout/shell-entry";
import { SoonBadge, SoonSuffix } from "@/components/layout/soon-badge";
import { TenantSwitcher } from "@/components/tenant-switcher";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { BrandName, RestowMark } from "@/components/wordmark";
import { CommunityEditionBadge } from "@/features/installation/edition-link";
import { StartEntry } from "@/features/start";
import { ExtensionSlot } from "@/lib/extensions";
import {
  groupNavItems,
  type NavActivity,
  type NavActivityItem,
  type NavBadge,
  navGroupLabelKey,
} from "@/lib/navigation";
import { isTenantOnlyNavItem } from "@/lib/scope";
import { canAccess, type RunningVersion, sessionScope, useSession } from "@/lib/session";
import { useNavItems } from "@/lib/use-nav-items";

const EXACT_MATCH = { exact: true, includeSearch: true } as const;

/** Calls an entry's badge hook: a component of its own, so the hook always has its place. */
function WithBadge({
  useBadge,
  children,
}: {
  useBadge: () => NavBadge | null;
  children: (badge: NavBadge | null) => React.ReactNode;
}) {
  return <>{children(useBadge())}</>;
}

/** The count an entry shows next to its label (`NavItem.useBadge`); nothing while it has none. */
function EntryBadge({ badge }: { badge: NavBadge | null }) {
  if (!badge || badge.count <= 0) {
    return null;
  }
  return (
    <span
      aria-hidden="true"
      data-slot="nav-badge"
      className="ml-auto rounded-md bg-sidebar-accent px-1.5 text-[0.6875rem] leading-5 font-medium tabular-nums text-sidebar-accent-foreground group-data-[collapsible=icon]:hidden"
    >
      {badge.count > 99 ? "99+" : badge.count}
    </span>
  );
}

/**
 * The collapsed rail has no room for a count: a dot on the icon says that something runs (Lapis,
 * pulsing where motion is allowed) or only waits (muted).
 */
function ActivityDot({ activity }: { activity: NavActivity }) {
  const running = activity.running > 0;
  return (
    <span
      aria-hidden="true"
      data-slot="nav-activity-dot"
      data-running={running || undefined}
      className={cn(
        "pointer-events-none absolute top-1 right-1 hidden size-2 rounded-full ring-2 ring-sidebar group-data-[collapsible=icon]:block",
        running ? "bg-info motion-safe:animate-pulse" : "bg-sidebar-foreground/50",
      )}
    />
  );
}

function ActivityItemText({ item }: { item: NavActivityItem }) {
  const { t } = useTranslation();
  return (
    <>
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      {item.percent !== null ? (
        <span className="shrink-0 font-mono tabular-nums opacity-70">
          {t("nav.activity.percent", { percent: item.percent })}
        </span>
      ) : null}
    </>
  );
}

/**
 * The work behind an entry, beside its label: a spinner with the number of backups that run
 * ("⟳ 2"; a still dot with reduced motion), and those that wait, muted ("+1", or a clock alone
 * when nothing runs). The tooltip says it in words and lists what runs; a click opens the running
 * backup, or a menu of them when several run. Lapis, never green: running is not proof of
 * anything. Hidden on the collapsed rail, which shows {@link ActivityDot} instead.
 */
function ActivityControl({
  activity,
  summary,
  onNavigate,
}: {
  activity: NavActivity;
  summary: string;
  onNavigate: () => void;
}) {
  const { t } = useTranslation();
  const running = activity.running > 0;
  const face = (
    <>
      {running ? (
        <>
          <Loader2
            aria-hidden="true"
            className="size-3 motion-safe:animate-spin motion-reduce:hidden"
          />
          <span
            aria-hidden="true"
            className="hidden size-1.5 rounded-full bg-info motion-reduce:inline-block"
          />
          <span>{activity.running}</span>
          {activity.queued > 0 ? (
            <span className="font-normal text-sidebar-foreground/60">{`+${activity.queued}`}</span>
          ) : null}
        </>
      ) : (
        <>
          <Clock aria-hidden="true" className="size-3" />
          <span>{activity.queued}</span>
        </>
      )}
    </>
  );
  const className = cn(
    "absolute top-1.5 right-1 inline-flex h-5 items-center gap-1 rounded-md px-1.5 text-[0.6875rem] font-medium tabular-nums ring-sidebar-ring outline-hidden hover:bg-sidebar-hover focus-visible:ring-2 group-data-[collapsible=icon]:hidden",
    running ? "text-info-text" : "text-sidebar-foreground/60",
  );
  const tooltip = (
    <TooltipContent side="right" className="max-w-72">
      <p className="font-medium">{summary}</p>
      {activity.items.length > 0 ? (
        <ul className="mt-1 space-y-0.5">
          {activity.items.map((item) => (
            <li key={item.id} className="flex gap-2">
              <ActivityItemText item={item} />
            </li>
          ))}
        </ul>
      ) : null}
    </TooltipContent>
  );
  const [single] = activity.items;
  if (activity.items.length === 1 && single) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Link
            to={single.to as LinkProps["to"]}
            search={(single.search ?? {}) as never}
            aria-label={`${summary}. ${t("nav.activity.open", { name: single.label })}`}
            data-slot="nav-activity"
            className={className}
            onClick={onNavigate}
          >
            {face}
          </Link>
        </TooltipTrigger>
        {tooltip}
      </Tooltip>
    );
  }
  if (activity.items.length === 0) {
    // Nothing to open (only waiting): the entry's own label already says it to a screen reader.
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span aria-hidden="true" data-slot="nav-activity" className={className}>
            {face}
          </span>
        </TooltipTrigger>
        {tooltip}
      </Tooltip>
    );
  }
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger
            aria-label={t("nav.activity.show", { summary })}
            data-slot="nav-activity"
            className={className}
          >
            {face}
          </DropdownMenuTrigger>
        </TooltipTrigger>
        {tooltip}
      </Tooltip>
      <DropdownMenuContent side="right" align="start" className="w-72">
        <DropdownMenuLabel>{t("nav.activity.title")}</DropdownMenuLabel>
        {activity.items.map((item) => (
          <DropdownMenuItem key={item.id} asChild>
            <Link
              to={item.to as LinkProps["to"]}
              search={(item.search ?? {}) as never}
              onClick={onNavigate}
              className="flex gap-2"
            >
              <ActivityItemText item={item} />
            </Link>
          </DropdownMenuItem>
        ))}
        {activity.queued > 0 ? (
          <DropdownMenuLabel className="font-normal text-muted-foreground">
            {t("nav.activity.queued", { count: activity.queued })}
          </DropdownMenuLabel>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The application sidebar on the shadcn Sidebar: the product mark, the tenant
 * switcher (which tenant the daily work belongs to, with the way to its
 * settings), the navigation grouped by section (filtered by the role in the
 * active tenant,
 * locked entries greyed out, see `NavLock` in lib/navigation.ts, upcoming
 * ones marked "Soon"; under "All tenants" the entries that only exist per tenant
 * are dimmed, lib/scope.ts), and a footer with "Start" (the setup checklist, until
 * it is done), what extensions add there (`shell.sidebarFooter`) and the running
 * version. The pinned installation section folds away to its header, remembered
 * per browser (collapsible-nav-section.tsx). Account security lives in
 * the user menu. It collapses to an icon rail (labels move into tooltips),
 * becomes a sheet below 768 px and toggles with Ctrl/Cmd+B; the state is
 * remembered per browser by the sidebar primitive.
 */
export function AppSidebar() {
  const { t } = useTranslation();
  const session = useSession();
  const { role, version } = session;
  const { isMobile, setOpenMobile, state } = useSidebar();
  // The icon-only rail shows every entry; a closed section would hide them.
  const iconRail = state === "collapsed" && !isMobile;
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

  // The entries of one section of the navigation.
  const renderEntries = (group: (typeof groups)[number]) => (
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
          const renderEntry = (badge: NavBadge | null) => {
            const activity = badge?.activity ?? null;
            const base = dimmedHint
              ? `${label} — ${dimmedHint}`
              : note
                ? `${label} (${note})`
                : label;
            return (
              <SidebarMenuItem key={item.id}>
                <SidebarMenuButton
                  asChild
                  isActive={active}
                  // The collapsed rail's tooltip says what runs, too.
                  tooltip={activity && badge ? `${base} — ${badge.label}` : base}
                  className={cn(
                    dimmed && "text-sidebar-foreground/50 hover:text-sidebar-foreground/70",
                    // Room for the activity beside the label, which is a control of its own.
                    activity && "pr-14",
                  )}
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
                      {/* "Jobs, 2 backups running": the count is only drawn. */}
                      {badge && (activity || badge.count > 0) ? (
                        <span className="sr-only">{`, ${badge.label}`}</span>
                      ) : null}
                    </span>
                    {item.soon ? (
                      <SoonBadge className="ml-auto group-data-[collapsible=icon]:hidden" />
                    ) : null}
                    {activity ? <ActivityDot activity={activity} /> : <EntryBadge badge={badge} />}
                    {stage ? (
                      <span className="ml-auto rounded border border-sidebar-border px-1 text-[0.625rem] leading-4 font-medium text-sidebar-foreground/70 group-data-[collapsible=icon]:hidden">
                        {stage}
                      </span>
                    ) : null}
                  </Link>
                </SidebarMenuButton>
                {activity && badge ? (
                  <ActivityControl
                    activity={activity}
                    summary={badge.label}
                    onNavigate={closeOnMobile}
                  />
                ) : null}
              </SidebarMenuItem>
            );
          };
          return item.useBadge && !dimmed ? (
            <WithBadge key={item.id} useBadge={item.useBadge}>
              {renderEntry}
            </WithBadge>
          ) : (
            renderEntry(null)
          );
        })}
      </SidebarMenu>
    </SidebarGroupContent>
  );

  const renderGroup = (group: (typeof groups)[number]) => (
    <SidebarGroup key={group.id}>
      <SidebarGroupLabel>{t(navGroupLabelKey(group.id, session))}</SidebarGroupLabel>
      {renderEntries(group)}
    </SidebarGroup>
  );

  // The installation section is rendered apart, pinned below the scrolling sections: what it
  // holds applies to the whole installation, everything above it to the organisation that is
  // active. It folds away to its header (#56) and opens by itself when the current page is in it.
  const renderInstallationGroup = (group: (typeof groups)[number]) => {
    const activeId = group.items.find((item) => item.id === entry?.item.id)?.id ?? null;
    return (
      <CollapsibleNavSection
        key={group.id}
        id={group.id}
        label={t(navGroupLabelKey(group.id, session))}
        activeId={activeId}
        forceOpen={iconRail}
      >
        <p className="px-2 pb-1 text-[0.6875rem] leading-snug text-sidebar-foreground/70 group-data-[collapsible=icon]:hidden">
          {t("nav.installationHint")}
        </p>
        {renderEntries(group)}
      </CollapsibleNavSection>
    );
  };

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
          {installationGroups.map(renderInstallationGroup)}
        </nav>
      ) : null}

      <SidebarFooter>
        {/* The setup checklist, until every step is done (nothing renders then). */}
        <StartEntry />
        <SidebarSeparator className="mx-0 group-data-[collapsible=icon]:sr-only" />
        <div className="flex flex-col gap-2 px-2 pb-1 text-xs text-sidebar-foreground/70 group-data-[collapsible=icon]:hidden">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <ExtensionSlot
              name="shell.sidebarFooter"
              props={{}}
              fallback={<CommunityEditionBadge />}
            />
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
