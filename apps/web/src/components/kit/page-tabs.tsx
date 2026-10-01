import { Link, type LinkProps } from "@tanstack/react-router";
import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

const EXACT = { exact: true, includeSearch: true } as const;

export interface PageTab {
  id: string;
  label: string;
  /** Absolute app path the tab opens. */
  to: string;
  /** Search params of that link; `{}` clears the current ones. */
  search?: Readonly<Record<string, unknown>>;
  icon?: LucideIcon;
}

export interface PageTabsProps {
  /** Accessible name of the tab bar, e.g. "Overview views". */
  label: string;
  tabs: readonly PageTab[];
  /** Id of the tab of the current page. */
  current: string;
  className?: string;
}

/**
 * A row of tabs that are links: each tab is its own address (bookmarkable,
 * back and forward work, a deep link opens the right tab). Rendered above
 * the page header of the tab it shows, as a navigation landmark whose current
 * tab carries `aria-current="page"`; the keyboard moves through it with Tab
 * like through any links. For tabs inside one page that keep no address, use
 * the `Tabs` primitive instead.
 */
export function PageTabs({ label, tabs, current, className }: PageTabsProps) {
  return (
    <nav aria-label={label} data-slot="page-tabs" className={className}>
      <ul className="flex flex-wrap gap-x-1 border-b border-border">
        {tabs.map((tab) => {
          const active = tab.id === current;
          const Icon = tab.icon;
          return (
            <li key={tab.id} className="-mb-px">
              <Link
                to={tab.to as LinkProps["to"]}
                search={(tab.search ?? {}) as never}
                // The router marks a link it deems active with aria-current
                // itself; held to exact matches it never contradicts `current`
                // (tabs on one path differ only in their search).
                activeOptions={EXACT}
                aria-current={active ? "page" : undefined}
                data-active={active || undefined}
                className={cn(
                  "inline-flex min-h-10 items-center gap-2 rounded-t-md border-b-2 px-3 py-2 text-sm font-medium outline-none transition-colors",
                  "focus-visible:ring-[3px] focus-visible:ring-ring/50",
                  active
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:border-border hover:text-foreground",
                )}
              >
                {Icon ? <Icon aria-hidden="true" className="size-4 shrink-0" /> : null}
                {tab.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
