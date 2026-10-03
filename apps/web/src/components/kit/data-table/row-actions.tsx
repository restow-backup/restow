import { Link, type LinkProps } from "@tanstack/react-router";
import type { ColumnDef } from "@tanstack/react-table";
import { Ellipsis, type LucideIcon } from "lucide-react";
import { ContextMenu as ContextMenuPrimitive } from "radix-ui";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

import { UI_NAMESPACE } from "../i18n.js";

/**
 * The actions of a table row, defined once and offered twice: as the "…" menu at the end of the
 * row and as the context menu of the row itself (right click, the context menu key or Shift+F10
 * anywhere in the row, a long press on touch screens). A table built on `DataTable` gets both from
 * `rowActionsColumn`; a table of its own wraps each row in `RowContextMenu`.
 */

/** One entry of a row's action menu. */
export interface RowAction {
  id: string;
  label: string;
  icon?: LucideIcon;
  /** What the entry does; an entry with `link` navigates instead. */
  onSelect?: () => void;
  /**
   * The entry is a link to another page (open the machine, restore its files): it navigates like
   * any link and opens in a new tab with the usual keys.
   */
  link?: { to: LinkProps["to"]; search?: unknown };
  /** Deletes, revokes or stops something; listed last, separated and in red. */
  destructive?: boolean;
  disabled?: boolean;
  /** Id of the element that says why the action is disabled (`aria-describedby` of the entry). */
  describedBy?: string;
  /** Why the action is disabled, in one short sentence shown under its label. */
  reason?: string;
}

/** The actions of a row, and of several selected rows at once. */
export interface RowActionsDefinition<TData> {
  /** The actions of one row; an empty list renders no menu. */
  actions: (row: TData) => readonly RowAction[];
  /**
   * The actions of several selected rows (a new job from the selection): the context menu of a
   * selected row offers them while more than one row is selected, and the selection bar of a
   * `selectable` table shows them as buttons. Without it a selected row offers its own actions.
   */
  selectionActions?: (rows: readonly TData[]) => readonly RowAction[];
  /** Name of the row for the menus' accessible labels, "Actions for <name>". */
  name?: (row: TData) => string;
  /** Id of the element that says why entries are closed, named by the "…" button (`aria-describedby`). */
  describedBy?: string;
}

type MenuKind = "dropdown" | "context";

function splitActions(actions: readonly RowAction[]) {
  return {
    regular: actions.filter((action) => !action.destructive),
    destructive: actions.filter((action) => action.destructive),
  };
}

/** The entries of a row's menu, for the "…" menu or the context menu. */
function ActionItems({ actions, kind }: { actions: readonly RowAction[]; kind: MenuKind }) {
  const reasonPrefix = React.useId();
  const { regular, destructive } = splitActions(actions);
  const Item = kind === "dropdown" ? DropdownMenuItem : ContextMenuItem;
  const Separator = kind === "dropdown" ? DropdownMenuSeparator : ContextMenuSeparator;

  const item = (action: RowAction) => {
    const Icon = action.icon;
    const reasonId = action.disabled && action.reason ? `${reasonPrefix}-${action.id}` : undefined;
    const describedBy = [action.describedBy, reasonId].filter(Boolean).join(" ") || undefined;
    const content = (
      <>
        {Icon ? <Icon aria-hidden="true" /> : null}
        {reasonId ? (
          <span className="min-w-0">
            <span className="block">{action.label}</span>
            <span id={reasonId} className="block text-xs text-muted-foreground">
              {action.reason}
            </span>
          </span>
        ) : (
          action.label
        )}
      </>
    );
    const common = {
      variant: action.destructive ? ("destructive" as const) : ("default" as const),
      disabled: action.disabled,
      "aria-describedby": describedBy,
      "data-action": action.id,
    };
    if (action.link && !action.disabled) {
      return (
        <Item key={action.id} asChild {...common} onSelect={action.onSelect}>
          <Link to={action.link.to} search={action.link.search as never}>
            {content}
          </Link>
        </Item>
      );
    }
    return (
      <Item key={action.id} {...common} onSelect={action.onSelect}>
        {content}
      </Item>
    );
  };

  return (
    <>
      {regular.map(item)}
      {regular.length > 0 && destructive.length > 0 ? <Separator /> : null}
      {destructive.map(item)}
    </>
  );
}

export interface RowActionsMenuProps {
  actions: readonly RowAction[];
  /** Name of the row for the trigger's label, "Actions for <name>". */
  name?: string;
  /** Id of the element that says why the entries are closed, named by the trigger (`aria-describedby`). */
  describedBy?: string;
}

/**
 * The "…" menu of a row. Destructive actions come last, after a separator;
 * they should open a ConfirmDialog rather than act at once.
 */
export function RowActionsMenu({ actions, name, describedBy }: RowActionsMenuProps) {
  const { t } = useTranslation(UI_NAMESPACE);
  if (actions.length === 0) {
    return null;
  }
  const label = name ? t("table.actions.openFor", { name }) : t("table.actions.open");

  return (
    // Not modal: a dialog opened from an item must not inherit the menu's pointer lock.
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          aria-describedby={describedBy}
          data-slot="row-actions-trigger"
        >
          <Ellipsis aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        <ActionItems actions={actions} kind="dropdown" />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Elements whose own context menu the browser keeps: a link (open in a new tab) and fields. */
const NATIVE_MENU_TARGETS =
  "a[href],input,textarea,select,[contenteditable=''],[contenteditable=true]";

/** Context menu events this module raised itself (from the keyboard). */
const raisedByKeyboard = new WeakSet<Event>();

/** A keyboard-raised menu also makes the browser raise one; that one is dropped for this long. */
const KEYBOARD_ECHO_MS = 600;

/** Whether a key press asks for the context menu: the context menu key or Shift+F10. */
export function isContextMenuKey(event: Pick<KeyboardEvent, "key" | "shiftKey">): boolean {
  return event.key === "ContextMenu" || (event.shiftKey && event.key === "F10");
}

/**
 * Whether a right click inside a row should get the browser's own menu instead of the row's: on
 * a link or a field (open in a new tab, paste), with Shift held, or while text in the row is
 * selected (copy). A context menu from the keyboard always gets the row's.
 */
export function wantsNativeMenu(
  event: Pick<MouseEvent, "button" | "shiftKey" | "target">,
  row: Element,
  selection: Pick<Selection, "isCollapsed" | "rangeCount" | "getRangeAt"> | null,
): boolean {
  if (event.button !== 2) {
    return false;
  }
  if (event.shiftKey) {
    return true;
  }
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest(NATIVE_MENU_TARGETS)) {
    return true;
  }
  if (selection && !selection.isCollapsed && selection.rangeCount > 0) {
    return row.contains(selection.getRangeAt(0).commonAncestorContainer);
  }
  return false;
}

export interface RowContextMenuProps {
  /**
   * The entries, asked for when the menu opens (the selection may have changed since the row
   * rendered). An empty list leaves the browser its own menu.
   */
  actions: () => readonly RowAction[];
  /** The menu's accessible name, "Actions for <name>". */
  label?: string;
  /** The row element (`TableRow`); it becomes the trigger. */
  children: React.ReactElement;
  /** False renders the row alone (a placeholder row, a table without actions). */
  enabled?: boolean;
}

/**
 * The context menu of a table row: a right click on the row, the context menu key or Shift+F10
 * while anything in the row has focus, or a long press opens the row's actions where they were
 * asked for. Links, fields, selected text and Shift with a right click keep the browser's menu,
 * so "open in a new tab" and "copy" still work. Focus returns to where it was when the menu closes
 * without opening something else.
 */
export function RowContextMenu({ actions, label, children, enabled = true }: RowContextMenuProps) {
  const [entries, setEntries] = React.useState<readonly RowAction[]>([]);
  const returnFocus = React.useRef<HTMLElement | null>(null);
  const lastKeyboardOpen = React.useRef(0);

  if (!enabled) {
    return children;
  }

  // The trigger merges these handlers with the row's own (the row's run first).
  const onContextMenuCapture = (event: React.MouseEvent<HTMLElement>) => {
    const native = event.nativeEvent;
    if (raisedByKeyboard.has(native)) {
      return;
    }
    // The browser's own menu event after one raised from the keyboard: already open.
    if (event.button !== 2 && Date.now() - lastKeyboardOpen.current < KEYBOARD_ECHO_MS) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const pending = actions();
    if (
      pending.length === 0 ||
      wantsNativeMenu(event, event.currentTarget, window.getSelection?.() ?? null)
    ) {
      // Stopping here keeps the menu closed; the browser shows its own.
      event.stopPropagation();
      return;
    }
    setEntries(pending);
    const active = document.activeElement;
    returnFocus.current =
      active instanceof HTMLElement && event.currentTarget.contains(active) ? active : null;
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.defaultPrevented || !isContextMenuKey(event)) {
      return;
    }
    const pending = actions();
    if (pending.length === 0) {
      return;
    }
    event.preventDefault();
    const rowElement = event.currentTarget;
    const focused = event.target instanceof HTMLElement ? event.target : rowElement;
    const rect = focused.getBoundingClientRect();
    setEntries(pending);
    returnFocus.current = focused;
    lastKeyboardOpen.current = Date.now();
    const raised = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: rect.left + Math.min(16, rect.width / 2),
      clientY: rect.bottom,
    });
    raisedByKeyboard.add(raised);
    rowElement.dispatchEvent(raised);
  };

  return (
    <ContextMenu
      modal={false}
      onOpenChange={(open) => {
        // A long press on a touch screen opens the menu without a context menu event.
        if (open) {
          setEntries(actions());
        }
      }}
    >
      {/* The bare trigger: the row keeps its own `data-slot`. */}
      <ContextMenuPrimitive.Trigger
        asChild
        onContextMenuCapture={onContextMenuCapture}
        onKeyDown={onKeyDown}
      >
        {children}
      </ContextMenuPrimitive.Trigger>
      <ContextMenuContent
        className="min-w-48"
        aria-label={label}
        data-slot="row-context-menu"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          const target = returnFocus.current;
          returnFocus.current = null;
          // Only when nothing else took the focus (a dialog an entry opened keeps it).
          const active = document.activeElement;
          if (target?.isConnected && (active === null || active === document.body)) {
            target.focus();
          }
        }}
      >
        {label ? <ContextMenuLabel className="sr-only">{label}</ContextMenuLabel> : null}
        <ActionItems actions={entries} kind="context" />
      </ContextMenuContent>
    </ContextMenu>
  );
}

function ActionsHeader() {
  const { t } = useTranslation(UI_NAMESPACE);
  return <span className="sr-only">{t("table.actions.column")}</span>;
}

export type RowActionsColumnOptions<TData> = RowActionsDefinition<TData>;

/**
 * A trailing column with each row's "…" menu (never sortable or hideable). `DataTable` reads the
 * same definition for the context menu of its rows, so both always offer the same actions.
 */
export function rowActionsColumn<TData>(
  options: RowActionsColumnOptions<TData>,
): ColumnDef<TData, unknown> {
  const { actions, name, describedBy } = options;
  return {
    id: "actions",
    header: () => <ActionsHeader />,
    cell: ({ row }) => (
      <RowActionsMenu
        actions={actions(row.original)}
        name={name?.(row.original)}
        describedBy={describedBy}
      />
    ),
    enableSorting: false,
    enableHiding: false,
    enableGlobalFilter: false,
    size: 48,
    meta: {
      className: "w-12 text-right",
      rowActions: options as RowActionsDefinition<unknown>,
    },
  };
}

/** The row actions a column list carries (see `rowActionsColumn`), if any. */
export function rowActionsOf<TData>(
  columns: readonly ColumnDef<TData, unknown>[],
): RowActionsDefinition<TData> | undefined {
  for (const column of columns) {
    const found = column.meta?.rowActions;
    if (found) {
      return found as RowActionsDefinition<TData>;
    }
  }
  return undefined;
}
