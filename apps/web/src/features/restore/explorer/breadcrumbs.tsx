import { ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { ObjectKind } from "@/features/restore/api";
import { useEntryLabel } from "@/features/restore/explorer/use-entry-label";
import { ROOT_PATH, breadcrumbOf } from "@/features/restore/lib/paths";

const crumbClass =
  "max-w-[14rem] truncate rounded px-1 py-0.5 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** Where the list is in the snapshot; every segment leads back up. */
export function Breadcrumbs({
  path,
  rootLabel,
  objectKind,
  onOpen,
}: {
  path: string;
  rootLabel: string;
  objectKind: ObjectKind;
  onOpen: (path: string) => void;
}) {
  const { t } = useTranslation("restore");
  const label = useEntryLabel(objectKind);
  const crumbs = breadcrumbOf(path);

  return (
    <nav aria-label={t("explorer.breadcrumb.label")} className="min-w-0">
      <ol className="flex min-w-0 flex-wrap items-center gap-0.5 text-sm">
        <li className="flex min-w-0 items-center">
          {crumbs.length === 0 ? (
            <span aria-current="location" className="truncate px-1 font-medium">
              {rootLabel}
            </span>
          ) : (
            <button type="button" className={crumbClass} onClick={() => onOpen(ROOT_PATH)}>
              {rootLabel}
            </button>
          )}
        </li>
        {crumbs.map((crumb, index) => {
          const last = index === crumbs.length - 1;
          const text = label({ kind: "folder", path: crumb.path });
          return (
            <li key={crumb.path} className="flex min-w-0 items-center gap-0.5">
              <ChevronRight
                className="size-3.5 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              {last ? (
                <span aria-current="location" className="truncate px-1 font-medium">
                  {text}
                </span>
              ) : (
                <button type="button" className={crumbClass} onClick={() => onOpen(crumb.path)}>
                  {text}
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
