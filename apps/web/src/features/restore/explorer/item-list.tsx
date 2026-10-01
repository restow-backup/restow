import type { TFunction } from "i18next";
import { Flag, Lock, Paperclip } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { MailSummary, ObjectKind, TreeEntry } from "@/features/restore/api";
import { TriStateCheckbox } from "@/features/restore/components/tri-state-checkbox";
import { EntryIcon } from "@/features/restore/explorer/entry-icon";
import { useEntryLabel, useLocationLabel } from "@/features/restore/explorer/use-entry-label";
import { entryDate, toNamedEntry } from "@/features/restore/lib/entries";
import { type ListDirection, moveActivePath } from "@/features/restore/lib/list-nav";
import { parentPathOf } from "@/features/restore/lib/paths";
import {
  type Selection,
  coveringFolder,
  isSelected,
  listSelectionState,
} from "@/features/restore/lib/selection";
import { formatBytes, formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * The To column's content: the capped, comma-separated addresses the backup
 * recorded, plus how many more recipients exist beyond that cap. `toCount`
 * is the true total; counting the shown addresses by splitting on "," is an
 * approximation (a display name that itself contains a comma undercounts by
 * one, which only ever makes the "+N" hint a little low, never wrong in the
 * other direction). `addresses` and `more` render as two separate elements —
 * `addresses` truncates, `more` never does — so a long recipient list never
 * pushes the "+N more" hint itself off the edge of the cell.
 */
function toCellParts(
  mail: MailSummary | null,
  t: TFunction<"restore">,
): { addresses: string; more: string | null } {
  if (!mail?.to) {
    return { addresses: "–", more: null };
  }
  const shown = mail.to.split(",").length;
  const extra = mail.toCount !== null && mail.toCount > shown ? mail.toCount - shown : 0;
  return {
    addresses: mail.to,
    more: extra > 0 ? t("explorer.columns.toMore", { count: extra }) : null,
  };
}

/**
 * Returns keyboard focus to the grid (the `<table>` itself — see the roving
 * tab stop comment below) after a mouse click on a row or its name button,
 * so Up/Down keeps working immediately without an extra Tab.
 */
function focusGrid(event: React.SyntheticEvent<HTMLElement>): void {
  event.currentTarget.closest("table")?.focus();
}

interface ItemListProps {
  entries: readonly TreeEntry[];
  objectKind: ObjectKind;
  selection: Selection;
  /** Path of the entry shown in the reading pane. */
  activePath: string | null;
  /** Search results: show where each entry lives instead of its sender. */
  showLocation?: boolean;
  onToggle: (entry: TreeEntry) => void;
  onToggleAll: (select: boolean) => void;
  /** A click (or Enter) opens an entry: folders navigate, items push a new history entry. */
  onOpen: (entry: TreeEntry) => void;
  /**
   * Up/Down moved the reading pane to this item: same effect as `onOpen`, but
   * the caller should *replace* the current history entry instead of pushing
   * one, so holding an arrow key does not flood Back with every message it
   * passed over. Falls back to `onOpen` when the caller does not care.
   */
  onNavigate?: (entry: TreeEntry) => void;
}

/**
 * The contents of a folder (or search results), with multi-select and
 * Up/Down keyboard navigation into the reading pane. Columns are
 * Subject/Name, From, To, Date and Size; folders come first and, by default,
 * items newest first (explorer.sort, server side).
 */
export function ItemList({
  entries,
  objectKind,
  selection,
  activePath,
  showLocation = false,
  onToggle,
  onToggleAll,
  onOpen,
  onNavigate = onOpen,
}: ItemListProps) {
  const { t, i18n } = useTranslation("restore");
  const language = i18n.resolvedLanguage ?? i18n.language;
  const label = useEntryLabel(objectKind);
  const location = useLocationLabel(objectKind);
  const headerState = listSelectionState(selection, entries);
  // OneDrive lists files by name; a mailbox or IMAP account lists mail by subject.
  const nameColumnKey =
    objectKind === "onedrive" ? "explorer.columns.name" : "explorer.columns.subject";
  const activeRowRef = React.useRef<HTMLTableRowElement>(null);

  // Up/Down move the reading pane through the *items* of this folder, never
  // into a folder (that would silently change what the list itself shows,
  // one keystroke after the previous one just moved the highlight).
  // Folders are still reachable by clicking or pressing Enter on them.
  const navigableEntries = React.useMemo(
    () => entries.filter((entry) => entry.kind !== "folder"),
    [entries],
  );

  const navigate = (direction: ListDirection) => {
    const nextPath = moveActivePath(navigableEntries, activePath, direction);
    const next =
      nextPath === null ? null : navigableEntries.find((entry) => entry.path === nextPath);
    if (next) {
      onNavigate(next);
    }
  };

  // The entry `aria-activedescendant` currently points at — the one a
  // composite-widget Space or Enter must act on, since DOM focus itself
  // never leaves the grid container (see the roving tab stop comment below).
  const activeEntry = activePath
    ? (entries.find((entry) => entry.path === activePath) ?? null)
    : null;

  const onKeyDown = (event: React.KeyboardEvent<HTMLTableElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      navigate("down");
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      navigate("up");
    } else if (event.key === " " || event.key === "Spacebar") {
      // Toggle the active row's own selection, mirroring a click on its
      // checkbox; a row already covered by a selected ancestor folder has no
      // checkbox of its own to toggle (see the `cover` branch below).
      if (!activeEntry || coveringFolder(selection, activeEntry.path)) {
        return;
      }
      event.preventDefault();
      onToggle(activeEntry);
    } else if (event.key === "Enter") {
      // Mirrors a click on the row: opens an item in the reading pane or
      // navigates into a folder (`onOpen` already tells the two apart).
      if (!activeEntry) {
        return;
      }
      event.preventDefault();
      onOpen(activeEntry);
    }
  };

  // The list can hold hundreds of rows; keep the highlighted one in view as
  // Up/Down moves past the edge of the scroll area (aria-activedescendant
  // alone does not scroll).
  // biome-ignore lint/correctness/useExhaustiveDependencies: activePath is the scroll trigger, read via the ref instead.
  React.useEffect(() => {
    // Optional chaining on the method itself, not just the ref: the test DOM
    // (happy-dom) does not implement `scrollIntoView`, every real browser does.
    activeRowRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [activePath]);

  // A single roving tab stop over the whole list, as a real grid rather
  // than a listbox wrapped around a table: `role="grid"`, `tabIndex` and
  // `aria-activedescendant` live on the `<table>` itself (forwarded through
  // `Table`'s own props), so each `<tr>`/`<td>` keeps its ordinary implicit
  // "row"/"gridcell" role instead of the mismatched
  // listbox-div > table > option-row nesting a separate wrapper produced.
  // Up/Down move the active row via lib/list-nav.ts, which also drives the
  // pure keyboard-navigation test. For this composite-widget pattern to work,
  // DOM focus must never leave the `<table>`: every interactive element
  // inside a row (the selection `Checkbox`, the name `<button>`) therefore
  // carries `tabIndex={-1}` below, and Space/Enter on the grid itself act on
  // whichever row `aria-activedescendant` currently names, instead of
  // relying on Tab to reach them one row at a time.
  //
  // `@container` (on the plain, role-less wrapper below): column visibility
  // follows the *pane*'s own rendered width (via `@lg:`/`@xl:`/`@3xl:`
  // container-query variants), not the viewport. The pane can be much
  // narrower than the viewport (a resizable side pane at 1280px can be
  // under 400px wide), and a `lg:`/`xl:` viewport breakpoint would show
  // columns the pane has no room for.
  return (
    <div className="@container">
      <Table
        // biome-ignore lint/a11y/useSemanticElements: intentional — a data
        // grid with per-row keyboard navigation and selection is exactly
        // what `role="grid"` is for; a plain <table> would tell assistive
        // tech this is a static, read-only listing.
        role="grid"
        aria-label={t(nameColumnKey)}
        aria-activedescendant={
          activePath ? `restore-item-${encodeURIComponent(activePath)}` : undefined
        }
        tabIndex={0}
        onKeyDown={onKeyDown}
        className="table-fixed outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      >
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="w-10">
              <TriStateCheckbox
                state={headerState}
                onChange={onToggleAll}
                label={t(
                  headerState === "all"
                    ? "explorer.actions.deselectAll"
                    : "explorer.actions.selectAll",
                )}
              />
            </TableHead>
            {/* Subject/Name is the only column without an explicit width: with
                `table-fixed`, it alone absorbs whatever space the other,
                explicitly-sized columns leave — which is also why every
                other column below needs a real width instead of `max-w-0`
                (that collapsed a column to its header's own intrinsic
                width, e.g. 32px for "To", making its text unreadable). */}
            <TableHead>{t(nameColumnKey)}</TableHead>
            {/* w-48: a "medium" `Intl.DateTimeFormat` date and time with a
                two-digit hour (e.g. "Sep 24, 2026, 10:23 PM" in English) is
                about 160px wide in the table's 14px type, more than the 160px
                of content width the former w-44 left after the cell padding,
                so the end of the time was cut off. w-36 was narrower still
                and overlapped the From column. The cell still truncates (see
                below) as a safety net for locales even longer than this,
                with the full value in a tooltip. */}
            <TableHead className="hidden w-48 @lg:table-cell">
              {t("explorer.columns.date")}
            </TableHead>
            <TableHead className="hidden w-44 @xl:table-cell">
              {t("explorer.columns.from")}
            </TableHead>
            <TableHead className="hidden w-44 @3xl:table-cell">
              {t("explorer.columns.to")}
            </TableHead>
            <TableHead className="w-20 text-right">{t("explorer.columns.size")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {entries.map((entry) => {
            const name = label(toNamedEntry(entry));
            const selected = isSelected(selection, entry.path);
            const cover = coveringFolder(selection, entry.path);
            const date = entryDate(entry);
            const active = activePath === entry.path;
            return (
              <TableRow
                key={entry.path}
                ref={active ? activeRowRef : undefined}
                id={`restore-item-${encodeURIComponent(entry.path)}`}
                aria-selected={active}
                data-state={selected || cover ? "selected" : undefined}
                className={cn("cursor-pointer", active && "bg-accent/70 hover:bg-accent/70")}
                onClick={(event) => {
                  focusGrid(event);
                  onOpen(entry);
                }}
              >
                <TableCell className="w-10" onClick={(event) => event.stopPropagation()}>
                  {cover ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="inline-flex">
                          <Checkbox
                            checked
                            disabled
                            aria-label={t("explorer.selection.covered", { name })}
                          />
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>{t("explorer.selection.covered", { name })}</TooltipContent>
                    </Tooltip>
                  ) : (
                    <Checkbox
                      checked={selected}
                      onCheckedChange={() => onToggle(entry)}
                      aria-label={t("explorer.actions.select", { name })}
                      // Taken out of the tab order: this is a composite grid
                      // with a single tab stop on the `<table>` (see the
                      // comment above); Space on the grid toggles the active
                      // row's selection instead.
                      tabIndex={-1}
                    />
                  )}
                </TableCell>
                <TableCell>
                  <div className="flex min-w-0 items-center gap-2">
                    <EntryIcon kind={entry.kind} />
                    <div className="min-w-0 flex-1">
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          focusGrid(event);
                          onOpen(entry);
                        }}
                        // Same reason as the checkbox above: Enter on the
                        // grid opens the active row instead.
                        tabIndex={-1}
                        className={cn(
                          "block max-w-full truncate rounded-sm text-left",
                          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                          entry.kind === "folder" ? "font-medium" : undefined,
                          entry.kind === "mail" && entry.mail?.isRead === false && "font-semibold",
                          entry.deleted && "text-muted-foreground",
                        )}
                      >
                        {name}
                      </button>
                      {showLocation ? (
                        <p className="truncate text-xs text-muted-foreground">
                          {location(parentPathOf(entry.path))}
                        </p>
                      ) : null}
                      {/* A narrow pane (a laptop-width window splits the
                          explorer into four panes) hides the Date and From
                          columns below their `@lg`/`@xl` container-query
                          breakpoints — see the header comment above. Without
                          this line, a common laptop width shows a mail list
                          with no sender or date at all. It mirrors exactly
                          the columns it stands in for: the date half hides
                          again once the real Date column reappears at `@lg`,
                          and the whole line hides once the real From column
                          also reappears at `@xl`, so nothing is ever shown
                          twice. */}
                      {entry.kind !== "folder" ? (
                        <p className="mt-0.5 flex min-w-0 items-center gap-1 text-xs text-muted-foreground @xl:hidden">
                          {entry.kind === "mail" && entry.mail?.from ? (
                            <span className="min-w-0 truncate">{entry.mail.from}</span>
                          ) : null}
                          {date ? (
                            <>
                              {entry.kind === "mail" && entry.mail?.from ? (
                                <span className="shrink-0 @lg:hidden" aria-hidden="true">
                                  ·
                                </span>
                              ) : null}
                              <span className="shrink-0 tabular-nums @lg:hidden">
                                {formatDateTime(date, language)}
                              </span>
                            </>
                          ) : null}
                        </p>
                      ) : null}
                    </div>
                    {entry.mail?.protection ? (
                      <Lock
                        className="size-3.5 shrink-0 text-muted-foreground"
                        aria-label={t("explorer.flags.protected")}
                        role="img"
                      />
                    ) : null}
                    {entry.mail?.flagged ? (
                      <Flag
                        className="size-3.5 shrink-0 text-destructive"
                        aria-label={t("explorer.flags.flagged")}
                        role="img"
                      />
                    ) : null}
                    {entry.mail?.hasAttachments ? (
                      <Paperclip
                        className="size-3.5 shrink-0 text-muted-foreground"
                        aria-label={t("explorer.flags.attachments")}
                        role="img"
                      />
                    ) : null}
                    {entry.deleted ? (
                      <Badge variant="muted" className="shrink-0" title={t("explorer.deleted")}>
                        {t("explorer.deletedShort")}
                      </Badge>
                    ) : null}
                  </div>
                </TableCell>
                <TableCell
                  className="hidden w-48 truncate text-muted-foreground tabular-nums @lg:table-cell"
                  // A native title, not a Tooltip: this cell renders once per
                  // row (there can be hundreds), and the browser's own
                  // tooltip is enough to recover the full value on the rare
                  // locale where the date truncates despite the column's
                  // width — no need for a Radix tooltip root per row.
                  title={date ? (formatDateTime(date, language) ?? undefined) : undefined}
                >
                  {formatDateTime(date, language) ?? "–"}
                </TableCell>
                <TableCell className="hidden w-44 truncate text-muted-foreground @xl:table-cell">
                  {entry.kind === "mail" ? (entry.mail?.from ?? "–") : "–"}
                </TableCell>
                <TableCell className="hidden w-44 text-muted-foreground @3xl:table-cell">
                  {(() => {
                    const to = entry.kind === "mail" ? toCellParts(entry.mail, t) : null;
                    return to ? (
                      <div className="flex min-w-0 items-center gap-1">
                        <span className="min-w-0 flex-1 truncate">{to.addresses}</span>
                        {to.more ? <span className="shrink-0">{to.more}</span> : null}
                      </div>
                    ) : (
                      "–"
                    );
                  })()}
                </TableCell>
                <TableCell className="w-20 whitespace-nowrap text-right text-muted-foreground tabular-nums">
                  {entry.kind === "folder" ? "–" : formatBytes(entry.size, language)}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
