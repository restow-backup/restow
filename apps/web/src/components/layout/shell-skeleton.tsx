import { useTranslation } from "react-i18next";

import {
  DEFAULT_PAGE_WIDTH,
  PAGE_WIDTH_CONTAINER_CLASS,
  PAGE_WIDTH_MAIN_CLASS,
} from "@/components/kit/page-context";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/** The sidebar primitive's stored state (components/ui/sidebar.tsx). */
const SIDEBAR_STORAGE_KEY = "restow.sidebar";

function sidebarCollapsed(): boolean {
  try {
    return globalThis.localStorage?.getItem(SIDEBAR_STORAGE_KEY) === "collapsed";
  } catch {
    return false;
  }
}

/** Placeholder in the shape of a page header: icon tile, title and one line. */
export function PageHeaderSkeleton() {
  return (
    <div className="flex items-start gap-3">
      <Skeleton className="size-10 shrink-0 rounded-lg" />
      <div className="flex-1 space-y-2 pt-0.5">
        <Skeleton className="h-7 w-48 max-w-full" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>
    </div>
  );
}

/**
 * Layout-shaped placeholder while the session and profile load: sidebar (in
 * its remembered width), top bar and a page, so nothing moves when the shell
 * arrives.
 */
export function ShellSkeleton() {
  const { t } = useTranslation();
  const collapsed = sidebarCollapsed();
  return (
    <div className="flex min-h-svh w-full" aria-busy="true" aria-live="polite">
      <span className="sr-only">{t("loading.session")}</span>
      <div
        className={cn(
          "hidden shrink-0 flex-col gap-2 border-r border-sidebar-border bg-sidebar p-2 md:flex",
          collapsed ? "w-12" : "w-64",
        )}
      >
        <div className="flex h-12 items-center gap-2 p-2">
          <Skeleton className="size-8 shrink-0 rounded-lg" />
          {collapsed ? null : <Skeleton className="h-5 w-20" />}
        </div>
        {[0, 1, 2].map((group) => (
          <div key={group} className="flex flex-col gap-1 p-2">
            {collapsed ? null : <Skeleton className="mb-2 h-3 w-16" />}
            {[0, 1, 2].map((row) => (
              <div key={row} className="flex h-8 items-center gap-2">
                <Skeleton className="size-4 shrink-0" />
                {collapsed ? null : <Skeleton className="h-4 flex-1" />}
              </div>
            ))}
          </div>
        ))}
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-(--topbar-height) items-center gap-2 border-b border-border px-4">
          <Skeleton className="size-7" />
          <Skeleton className="h-4 w-40" />
          <div className="ml-auto flex items-center gap-2">
            <Skeleton className="h-9 w-24 sm:w-40" />
            <Skeleton className="size-9 md:w-44" />
            <Skeleton className="size-8 rounded-full" />
          </div>
        </div>
        <div className={PAGE_WIDTH_MAIN_CLASS[DEFAULT_PAGE_WIDTH]}>
          <div className={cn(PAGE_WIDTH_CONTAINER_CLASS[DEFAULT_PAGE_WIDTH], "space-y-6")}>
            <PageHeaderSkeleton />
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {[0, 1, 2, 3].map((tile) => (
                <Skeleton key={tile} className="h-28" />
              ))}
            </div>
            <Skeleton className="h-64" />
          </div>
        </div>
      </div>
    </div>
  );
}
