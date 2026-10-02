import { Check, ChevronRight, Folder, FolderOpen, Loader2, Minus, RotateCw } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { useBrowse } from "@/features/endpoints/hooks";
import { endpointErrorKey } from "@/features/endpoints/presenters";
import { cn } from "@/lib/utils";

import { baseName, isChosen, isCovered, isInside } from "../folders.js";

/**
 * The folders of a machine as a tree to tick, a real `role="tree"` with one tab
 * stop (roving tabindex): the arrow keys move between the rows, expand and
 * collapse folders, Space ticks the folder, Enter opens or closes it. The
 * folders come from the machine's newest backup (the browse API), a folder at a
 * time, and "Load more" fetches the next page of a big folder. Without a backup
 * the machine's configured folders are the roots and nothing opens below them.
 * Only folders are shown: restic backs up folders, and a single file is typed in.
 */

interface TreeContextValue {
  machineId: string;
  snapshotId: string | null;
  selected: readonly string[];
  onToggle: (path: string) => void;
  activeKey: string | null;
  setActiveKey: (key: string) => void;
  treeRef: React.RefObject<HTMLUListElement | null>;
}

const TreeContext = React.createContext<TreeContextValue | null>(null);

function useTree(): TreeContextValue {
  const value = React.useContext(TreeContext);
  if (!value) {
    throw new Error("a tree row needs its tree");
  }
  return value;
}

/** The rows that are on screen, in the order they are shown. */
function visibleRows(tree: HTMLElement | null): HTMLElement[] {
  return tree ? [...tree.querySelectorAll<HTMLElement>('[role="treeitem"]')] : [];
}

const INDENT_PX = 18;

const ROW_CLASS =
  "flex min-h-8 items-center gap-1.5 rounded-md pr-2 text-sm transition-colors hover:bg-muted";
const FOCUS_CLASS =
  "outline-none [&:focus-visible>[data-slot=tree-row]]:ring-[3px] [&:focus-visible>[data-slot=tree-row]]:ring-ring/50";

interface TreeItemProps {
  path: string;
  level: number;
  position: number;
  size: number;
  /** A folder that can be opened (there is a backup to read below it). */
  expandable: boolean;
  /** The first row of the tree: the tab stop until the person moves. */
  first: boolean;
}

function TreeItem({ path, level, position, size, expandable, first }: TreeItemProps) {
  const { t } = useTranslation("backupjobs");
  const tree = useTree();
  const [expanded, setExpanded] = React.useState(false);
  const ref = React.useRef<HTMLLIElement>(null);
  const labelId = React.useId();
  const chosen = isChosen(tree.selected, path);
  const covered = !chosen && isCovered(tree.selected, path);
  const checked = chosen || covered;
  // A folder that is not chosen itself but has chosen folders below it shows it as a mixed box.
  const mixed = !checked && tree.selected.some((candidate) => isInside(path, candidate));
  const name = baseName(path);
  const tabbable = tree.activeKey === path || (tree.activeKey === null && first);

  const collapse = () => {
    // A row that is focused below a folder that closes would vanish: the folder takes the focus.
    if (tree.activeKey !== null && tree.activeKey !== path && isCovered([path], tree.activeKey)) {
      tree.setActiveKey(path);
      ref.current?.focus();
    }
    setExpanded(false);
  };

  const toggleExpanded = () => {
    if (!expandable) {
      return;
    }
    if (expanded) {
      collapse();
    } else {
      setExpanded(true);
    }
  };

  const toggleChecked = () => {
    if (!covered) {
      tree.onToggle(path);
    }
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLLIElement>) => {
    if (event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey) {
      return;
    }
    const rows = visibleRows(tree.treeRef.current);
    const index = rows.indexOf(event.currentTarget);
    const focusRow = (row: HTMLElement | undefined) => {
      if (row) {
        event.preventDefault();
        row.focus();
      }
    };
    switch (event.key) {
      case "ArrowDown":
        focusRow(rows[index + 1]);
        break;
      case "ArrowUp":
        focusRow(rows[index - 1]);
        break;
      case "Home":
        focusRow(rows[0]);
        break;
      case "End":
        focusRow(rows[rows.length - 1]);
        break;
      case "ArrowRight":
        if (expandable && !expanded) {
          event.preventDefault();
          setExpanded(true);
        } else if (expanded) {
          focusRow(
            event.currentTarget.querySelector<HTMLElement>('[role="group"] [role="treeitem"]') ??
              undefined,
          );
        }
        break;
      case "ArrowLeft":
        if (expanded) {
          event.preventDefault();
          collapse();
        } else {
          focusRow(
            event.currentTarget.parentElement?.closest<HTMLElement>('[role="treeitem"]') ??
              undefined,
          );
        }
        break;
      case " ":
        event.preventDefault();
        toggleChecked();
        break;
      case "Enter":
        if (expandable) {
          event.preventDefault();
          toggleExpanded();
        }
        break;
      default:
        break;
    }
  };

  return (
    <li
      ref={ref}
      role="treeitem"
      aria-level={level}
      aria-posinset={position}
      aria-setsize={size}
      aria-labelledby={labelId}
      aria-checked={mixed ? "mixed" : checked}
      aria-expanded={expandable ? expanded : undefined}
      tabIndex={tabbable ? 0 : -1}
      data-path={path}
      data-covered={covered ? "true" : undefined}
      onKeyDown={onKeyDown}
      onFocus={(event) => {
        if (event.target === event.currentTarget) {
          tree.setActiveKey(path);
        }
      }}
      className={FOCUS_CLASS}
    >
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: the tree item handles the keyboard (arrows, Space, Enter); the pointer only mirrors it */}
      <div
        data-slot="tree-row"
        className={ROW_CLASS}
        style={{ paddingLeft: (level - 1) * INDENT_PX + 4 }}
        onClick={(event) => {
          ref.current?.focus();
          // The box ticks the folder; everywhere else on the row opens or closes it.
          if ((event.target as HTMLElement).closest('[data-slot="tree-check"]')) {
            toggleChecked();
          } else {
            toggleExpanded();
          }
        }}
      >
        {expandable ? (
          <span
            aria-hidden="true"
            className="flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground"
          >
            <ChevronRight
              className={cn(
                "size-4 transition-transform motion-reduce:transition-none",
                expanded && "rotate-90",
              )}
            />
          </span>
        ) : (
          <span aria-hidden="true" className="size-6 shrink-0" />
        )}
        <span
          aria-hidden="true"
          data-slot="tree-check"
          data-checked={mixed ? "mixed" : checked ? "true" : "false"}
          className={cn(
            "flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-[4px] border border-input bg-background text-primary-foreground",
            checked && "border-primary bg-primary",
            mixed && "border-primary text-primary",
            covered && "opacity-50",
          )}
        >
          {checked ? <Check className="size-3" /> : mixed ? <Minus className="size-3" /> : null}
        </span>
        {expanded ? (
          <FolderOpen aria-hidden="true" className="size-4 shrink-0 text-primary" />
        ) : (
          <Folder aria-hidden="true" className="size-4 shrink-0 text-primary" />
        )}
        <span id={labelId} title={path} className="min-w-0 flex-1 truncate font-mono text-xs">
          {name}
        </span>
        {covered ? (
          <span className="shrink-0 text-xs text-muted-foreground">
            {t("folders.tree.covered")}
          </span>
        ) : null}
      </div>
      {expanded && expandable ? (
        // biome-ignore lint/a11y/useSemanticElements: the subfolders of a tree item are a group of tree items, not a fieldset
        <ul role="group">
          <BrowseLevel parent={path} level={level + 1} />
        </ul>
      ) : null}
    </li>
  );
}

/** One folder of the backup: its subfolders, a page at a time. */
function BrowseLevel({
  parent,
  level,
  root = false,
}: { parent: string; level: number; root?: boolean }) {
  const { t } = useTranslation("backupjobs");
  const tree = useTree();
  const browse = useBrowse(tree.machineId, tree.snapshotId, parent);
  const loadMoreLabel = t("folders.tree.loadMoreIn", { folder: parent });

  if (browse.isPending) {
    return (
      <li
        role="presentation"
        aria-busy="true"
        className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground"
        style={{ paddingLeft: (level - 1) * INDENT_PX + 8 }}
      >
        <Loader2 aria-hidden="true" className="size-3.5 animate-spin motion-reduce:animate-none" />
        {t("folders.tree.loading")}
      </li>
    );
  }
  if (browse.isError) {
    return (
      <li
        role="presentation"
        className="flex flex-wrap items-center gap-2 px-2 py-1.5 text-xs text-destructive-text"
        style={{ paddingLeft: (level - 1) * INDENT_PX + 8 }}
      >
        <span role="alert">{t(endpointErrorKey(browse.error))}</span>
        <Button type="button" variant="outline" size="xs" onClick={() => void browse.refetch()}>
          <RotateCw aria-hidden="true" />
          {t("folders.tree.retry")}
        </Button>
      </li>
    );
  }

  const folders = browse.data.pages
    .flatMap((page) => page.entries)
    .filter((entry) => entry.type === "dir");
  return (
    <>
      {folders.length === 0 && !browse.hasNextPage ? (
        <li
          role="presentation"
          className="px-2 py-1.5 text-xs text-muted-foreground"
          style={{ paddingLeft: (level - 1) * INDENT_PX + 8 }}
        >
          {root ? t("folders.tree.rootEmpty") : t("folders.tree.noSubfolders")}
        </li>
      ) : null}
      {folders.map((entry, index) => (
        <TreeItem
          key={entry.path}
          path={entry.path}
          level={level}
          position={index + 1}
          size={folders.length}
          expandable
          first={root && index === 0}
        />
      ))}
      {browse.hasNextPage ? (
        <li
          role="treeitem"
          aria-level={level}
          aria-label={loadMoreLabel}
          tabIndex={-1}
          data-load-more="true"
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget) return;
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              void browse.fetchNextPage();
            } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              const rows = visibleRows(tree.treeRef.current);
              const next =
                rows[rows.indexOf(event.currentTarget) + (event.key === "ArrowDown" ? 1 : -1)];
              if (next) {
                event.preventDefault();
                next.focus();
              }
            } else if (event.key === "ArrowLeft") {
              const parentRow =
                event.currentTarget.parentElement?.closest<HTMLElement>('[role="treeitem"]');
              if (parentRow) {
                event.preventDefault();
                parentRow.focus();
              }
            }
          }}
          className={FOCUS_CLASS}
        >
          <div
            data-slot="tree-row"
            className={ROW_CLASS}
            style={{ paddingLeft: (level - 1) * INDENT_PX + 4 }}
          >
            <span aria-hidden="true" className="size-6 shrink-0" />
            <Button
              type="button"
              variant="ghost"
              size="xs"
              tabIndex={-1}
              loading={browse.isFetchingNextPage}
              onClick={() => void browse.fetchNextPage()}
            >
              {t("folders.tree.loadMore")}
            </Button>
          </div>
        </li>
      ) : null}
    </>
  );
}

export interface FolderTreeProps {
  machineId: string;
  /** The backup to read the folders from; null: there is none yet and `roots` are shown. */
  snapshotId: string | null;
  /** The machine's configured folders, shown when there is no backup. */
  roots: readonly string[];
  /** The folders chosen. */
  selected: readonly string[];
  onToggle: (path: string) => void;
  /** Accessible name of the tree. */
  label: string;
}

export function FolderTree({
  machineId,
  snapshotId,
  roots,
  selected,
  onToggle,
  label,
}: FolderTreeProps) {
  const treeRef = React.useRef<HTMLUListElement>(null);
  const [activeKey, setActiveKey] = React.useState<string | null>(null);
  const value = React.useMemo<TreeContextValue>(
    () => ({ machineId, snapshotId, selected, onToggle, activeKey, setActiveKey, treeRef }),
    [machineId, snapshotId, selected, onToggle, activeKey],
  );
  return (
    <TreeContext.Provider value={value}>
      <ul
        ref={treeRef}
        role="tree"
        aria-label={label}
        data-slot="folder-tree"
        className="max-h-80 space-y-0.5 overflow-auto rounded-md border bg-background p-1"
      >
        {snapshotId !== null ? (
          <BrowseLevel parent="/" level={1} root />
        ) : (
          roots.map((path, index) => (
            <TreeItem
              key={path}
              path={path}
              level={1}
              position={index + 1}
              size={roots.length}
              expandable={false}
              first={index === 0}
            />
          ))
        )}
      </ul>
    </TreeContext.Provider>
  );
}
