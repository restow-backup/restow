import type * as React from "react";
import { useTranslation } from "react-i18next";

import "@/features/endpoints/i18n";

/**
 * What a restore point holds, at the top of its file browser (#59): "This restore point contains:
 * /etc, /home, ..." with each path a button that opens it. A machine backs up the folders of its
 * job only, so a folder someone looks for may simply not be in it; `hint` says so (and where to
 * change it). A container holds its whole root file system, so it has no such hint.
 */
export function RestorePointContents({
  paths,
  onOpen,
  labelOf,
  hint,
}: {
  /** Absolute paths, in the order to show. */
  paths: readonly string[];
  /** Opens a folder in the browser. */
  onOpen?: (path: string) => void;
  /** How a path is named (a container names its root as the whole of it). */
  labelOf?: (path: string) => string;
  hint?: React.ReactNode;
}) {
  const { t } = useTranslation("endpoints");
  if (paths.length === 0) {
    return null;
  }
  return (
    <div className="space-y-1 text-xs text-muted-foreground" data-slot="restore-point-contents">
      <p className="flex flex-wrap items-baseline gap-x-1.5 gap-y-1">
        <span>{t("browser.contents.label")}</span>
        {paths.map((path, index) => {
          const label = labelOf?.(path) ?? path;
          const separator = index < paths.length - 1 ? "," : "";
          return (
            <span key={path} className="font-mono text-foreground">
              {onOpen ? (
                <button
                  type="button"
                  onClick={() => onOpen(path)}
                  aria-label={t("browser.contents.open", { path })}
                  className="rounded-sm underline-offset-2 outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
                >
                  {label}
                </button>
              ) : (
                label
              )}
              {separator}
            </span>
          );
        })}
      </p>
      {hint ? <p data-slot="restore-point-contents-hint">{hint}</p> : null}
    </div>
  );
}
