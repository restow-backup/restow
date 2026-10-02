import { Search } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useCommandPalette } from "@/components/command-palette/command-palette";
import { ShortcutHint, ariaShortcut } from "@/components/command-palette/shortcut";
import { NotificationBell } from "@/components/layout/notification-bell";
import { ShellBreadcrumbs } from "@/components/layout/shell-breadcrumbs";
import { UserMenu } from "@/components/layout/user-menu";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger, useSidebar } from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { LiveIndicator } from "@/features/history/live/indicator";

/**
 * Sticky top bar: sidebar toggle, breadcrumbs (which start with the scope the
 * page works in; the tenant switcher is in the sidebar), the search button
 * that opens the command palette, the bell and the user menu.
 */
export function TopBar() {
  return (
    <header className="sticky top-0 z-20 flex h-(--topbar-height) shrink-0 items-center gap-2 border-b border-border bg-background/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/80">
      <SidebarToggle />
      <Separator orientation="vertical" className="mr-1 data-[orientation=vertical]:h-4" />
      {/* Clipped, so a long crumb gives way to the indicator beside it; the padding keeps focus rings whole. */}
      <ShellBreadcrumbs className="-m-1 flex-1 overflow-hidden p-1" />
      <div className="ml-auto flex shrink-0 items-center gap-1 sm:gap-2">
        <LiveIndicator />
        <SearchButton />
        <NotificationBell />
        <UserMenu />
      </div>
    </header>
  );
}

function SidebarToggle() {
  const { t } = useTranslation();
  const { open, openMobile, isMobile } = useSidebar();
  const expanded = isMobile ? openMobile : open;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <SidebarTrigger
          className="-ml-1 size-8"
          aria-expanded={expanded}
          aria-keyshortcuts={ariaShortcut("b")}
        />
      </TooltipTrigger>
      <TooltipContent side="bottom" className="flex items-center gap-2">
        {expanded ? t("actions.collapseSidebar") : t("actions.expandSidebar")}
        <ShortcutHint shortcutKey="b" />
      </TooltipContent>
    </Tooltip>
  );
}

/** Opens the command palette; wide screens show the shortcut, narrow ones an icon. */
function SearchButton() {
  const { t } = useTranslation();
  const { setOpen } = useCommandPalette();
  return (
    <Button
      variant="outline"
      className="size-9 gap-2 px-0 text-muted-foreground md:w-44 md:justify-start md:px-3"
      aria-label={t("search.open")}
      aria-keyshortcuts={ariaShortcut("k")}
      aria-haspopup="dialog"
      onClick={() => setOpen(true)}
    >
      <Search aria-hidden="true" />
      <span className="hidden flex-1 text-left font-normal md:inline">{t("search.button")}</span>
      <ShortcutHint shortcutKey="k" className="hidden md:inline-flex" />
    </Button>
  );
}
