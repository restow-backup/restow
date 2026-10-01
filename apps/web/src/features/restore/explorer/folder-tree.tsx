import { ChevronRight, Folder, FolderOpen } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { Skeleton } from "@/components/ui/skeleton";
import type { ObjectKind, SnapshotObject, TreeEntry } from "@/features/restore/api";
import { ObjectIcon, objectLabel } from "@/features/restore/explorer/entry-icon";
import { useEntryLabel } from "@/features/restore/explorer/use-entry-label";
import { toNamedEntry } from "@/features/restore/lib/entries";
import { ROOT_PATH, isWithin } from "@/features/restore/lib/paths";
import { useFolders } from "@/features/restore/use-restore-data";
import { cn } from "@/lib/utils";

interface TreeContext {
  snapshotId: string;
  objectKind: ObjectKind;
  currentPath: string;
  isExpanded: (path: string) => boolean;
  setExpanded: (path: string, expanded: boolean) => void;
  open: (path: string) => void;
}

const INDENT_REM = 0.75;

/**
 * The folder tree of one snapshot, loaded level by level as folders are
 * expanded. The folders above the one being browsed are always open, so the
 * tree follows navigation from the list and the breadcrumb.
 */
export function FolderTree({
  snapshotId,
  object,
  currentPath,
  onOpen,
}: {
  snapshotId: string;
  object: Pick<SnapshotObject, "kind" | "displayName" | "externalId">;
  currentPath: string;
  onOpen: (path: string) => void;
}) {
  const { t } = useTranslation("restore");
  // Explicit choices of the user; everything else follows the current path.
  const [choices, setChoices] = React.useState<ReadonlyMap<string, boolean>>(new Map());

  const context: TreeContext = {
    snapshotId,
    objectKind: object.kind,
    currentPath,
    isExpanded: (path) => choices.get(path) ?? isWithin(currentPath, path),
    setExpanded: (path, expanded) =>
      setChoices((previous) => new Map(previous).set(path, expanded)),
    open: onOpen,
  };
  const rootActive = currentPath === ROOT_PATH;

  return (
    <nav aria-label={t("explorer.tree.label")} className="text-sm">
      <button
        type="button"
        onClick={() => onOpen(ROOT_PATH)}
        aria-current={rootActive ? "location" : undefined}
        className={cn(
          "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left font-medium",
          "hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          rootActive && "bg-accent text-accent-foreground",
        )}
      >
        <ObjectIcon kind={object.kind} />
        <span className="truncate">{objectLabel(object)}</span>
      </button>
      <FolderLevel path={ROOT_PATH} depth={1} context={context} />
    </nav>
  );
}

function FolderLevel({
  path,
  depth,
  context,
}: {
  path: string;
  depth: number;
  context: TreeContext;
}) {
  const { t } = useTranslation("restore");
  const folders = useFolders(context.snapshotId, path);
  const indent = { paddingLeft: `${depth * INDENT_REM}rem` };

  if (folders.isPending) {
    return (
      <div className="space-y-1 py-1" style={indent}>
        <Skeleton className="h-5 w-3/4" />
        <Skeleton className="h-5 w-1/2" />
      </div>
    );
  }
  if (folders.isError) {
    return (
      <p className="py-1 text-xs text-destructive" style={indent}>
        {t("explorer.tree.loadError")}
      </p>
    );
  }
  const { entries, total } = folders.data;
  if (entries.length === 0) {
    // An expanded folder without subfolders says so, instead of opening onto
    // nothing (which looks broken); the object's top level likewise.
    return (
      <p className="py-1 text-xs text-muted-foreground italic" style={indent}>
        {t(depth === 1 ? "explorer.tree.noFolders" : "explorer.tree.noSubfolders")}
      </p>
    );
  }
  return (
    <ul>
      {entries.map((entry) => (
        <FolderNode key={entry.path} entry={entry} depth={depth} context={context} />
      ))}
      {total > entries.length ? (
        <li className="py-1 text-xs text-muted-foreground" style={indent}>
          {t("explorer.tree.more", { count: total - entries.length })}
        </li>
      ) : null}
    </ul>
  );
}

function FolderNode({
  entry,
  depth,
  context,
}: {
  entry: TreeEntry;
  depth: number;
  context: TreeContext;
}) {
  const { t } = useTranslation("restore");
  const label = useEntryLabel(context.objectKind)(toNamedEntry(entry));
  const expanded = context.isExpanded(entry.path);
  const active = context.currentPath === entry.path;
  const Icon = expanded ? FolderOpen : Folder;

  return (
    <li>
      <div
        className={cn(
          "flex min-w-0 items-center gap-0.5 rounded-md pr-2",
          active ? "bg-accent text-accent-foreground" : "hover:bg-accent/60",
        )}
        style={{ paddingLeft: `${(depth - 1) * INDENT_REM}rem` }}
      >
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={t(expanded ? "explorer.tree.collapse" : "explorer.tree.expand", {
            name: label,
          })}
          onClick={() => context.setExpanded(entry.path, !expanded)}
          className="rounded p-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronRight
            className={cn("size-3.5 transition-transform", expanded && "rotate-90")}
            aria-hidden="true"
          />
        </button>
        <button
          type="button"
          onClick={() => context.open(entry.path)}
          aria-current={active ? "location" : undefined}
          title={entry.deleted ? t("explorer.deleted") : label}
          className={cn(
            "flex min-w-0 flex-1 items-center gap-2 rounded py-1 text-left",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            entry.deleted && "text-muted-foreground line-through decoration-muted-foreground/50",
          )}
        >
          <Icon className="size-4 shrink-0 text-primary" aria-hidden="true" />
          <span className="truncate">{label}</span>
        </button>
      </div>
      {expanded ? <FolderLevel path={entry.path} depth={depth + 1} context={context} /> : null}
    </li>
  );
}
