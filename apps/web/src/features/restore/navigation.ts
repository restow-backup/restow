import { type LinkProps, useMatch, useNavigate } from "@tanstack/react-router";
import * as React from "react";

import {
  type ExplorerSearch,
  compactSearch,
  parseExplorerSearch,
} from "@/features/restore/lib/explorer-search";

/**
 * Paths of the restore feature and typed helpers to reach them. Feature
 * routes join the router at integration time (features/registry.ts) and are
 * not part of the statically typed route tree, so the conversion to the
 * router's path type happens here, once, instead of at every link.
 */

export const RESTORE_PATHS = {
  explorer: "/restore",
  /** The old list of restores; it leads to the tab "Recent restores" (features/redirects). */
  jobs: "/restore/jobs",
  job: "/restore/jobs/$restoreId",
} as const;

/** The explorer's tabs: browse restore points, or follow the recent restores. */
export type RestoreTab = "browse" | "recent";

/** The tab named in the URL (`?tab=recent`); anything else is browsing. */
export function restoreTabOf(search: Readonly<Record<string, unknown>> | undefined): RestoreTab {
  return search?.tab === "recent" ? "recent" : "browse";
}

/** Search of the tab "Recent restores". */
export const RECENT_RESTORES_SEARCH = { tab: "recent" } as const;

/** A path of this feature as the router's `to` type. */
export function restoreTo(path: string): LinkProps["to"] {
  return path as LinkProps["to"];
}

/**
 * The explorer opened at one account and, if given, one of its restore
 * points, as `<Link {...target}>` takes it (file restore links here for a
 * mailbox).
 */
export function explorerAt(
  objectId: string,
  snapshotId?: string,
): { to: LinkProps["to"]; search: ExplorerSearch } {
  return {
    to: restoreTo(RESTORE_PATHS.explorer),
    search: compactSearch({ object: objectId, snapshot: snapshotId }),
  };
}

export function jobHref(restoreId: string): LinkProps["to"] {
  return restoreTo(`${RESTORE_PATHS.jobs}/${encodeURIComponent(restoreId)}`);
}

/**
 * The explorer's URL state and a setter that writes it back (see
 * lib/explorer-search). It reads the search of the route match the explorer
 * renders in, not the global location: while the router moves on to another
 * page, the explorer keeps seeing its own state instead of the next page's
 * (empty) search and never pulls the user back.
 */
export function useExplorerSearch(): readonly [
  ExplorerSearch,
  (next: ExplorerSearch, options?: { replace?: boolean }) => void,
] {
  const raw = useMatch({ strict: false, select: (match) => match.search });
  const search = React.useMemo(() => parseExplorerSearch(raw), [raw]);
  const navigate = useNavigate();
  const setSearch = React.useCallback(
    (next: ExplorerSearch, options: { replace?: boolean } = {}) => {
      void navigate({
        to: restoreTo(RESTORE_PATHS.explorer),
        search: compactSearch(next) as never,
        replace: options.replace,
      });
    },
    [navigate],
  );
  return [search, setSearch] as const;
}

/** Navigate to a restore job's page. */
export function useOpenJob(): (restoreId: string) => void {
  const navigate = useNavigate();
  return React.useCallback(
    (restoreId: string) => {
      void navigate({ to: jobHref(restoreId) });
    },
    [navigate],
  );
}
