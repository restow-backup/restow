import { type LinkProps, useNavigate } from "@tanstack/react-router";
import * as React from "react";

/**
 * Paths of the exports feature and typed helpers to reach them. Feature
 * routes join the router at integration time (features/registry.ts) and are
 * not part of the statically typed route tree, so the conversion to the
 * router's path type happens here, once, instead of at every link.
 */

export const EXPORT_PATHS = {
  list: "/exports",
  detail: "/exports/$exportId",
} as const;

/** A path of this feature as the router's `to` type. */
export function exportsTo(path: string): LinkProps["to"] {
  return path as LinkProps["to"];
}

export function exportHref(exportId: string): LinkProps["to"] {
  return exportsTo(`${EXPORT_PATHS.list}/${encodeURIComponent(exportId)}`);
}

/** Navigate to an export's page. */
export function useOpenExport(): (exportId: string) => void {
  const navigate = useNavigate();
  return React.useCallback(
    (exportId: string) => {
      void navigate({ to: exportHref(exportId) });
    },
    [navigate],
  );
}
