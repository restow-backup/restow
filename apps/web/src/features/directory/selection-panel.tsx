import type { TFunction } from "i18next";
import {
  CircleCheck,
  CircleMinus,
  Ellipsis,
  ListChecks,
  ListPlus,
  type LucideIcon,
  RotateCcw,
  ShieldOff,
  X,
} from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { ConfirmDialog, type RowAction, RowActionItems } from "@/components/kit";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "@/components/ui/sonner";
import type { JobsAccess } from "@/features/backup-jobs/components/access-note";
import { newJobTo } from "@/features/backup-jobs/paths";
import { cn } from "@/lib/utils";

import {
  type BulkSelectionState,
  bulkTarget,
  clearSelection,
  EMPTY_SELECTION,
  isPageFullySelected,
  selectAllMatching,
  selectionCount,
} from "./bulk-selection";
import { useBulkSetProtection, useConfirmInactive } from "./hooks";
import type { BulkProtectionInput, DirectorySource, ObjectsFilter } from "./types";

type BulkAction = "include" | "exclude" | "reset";
type PanelDialog = BulkAction | "confirm";

/**
 * Clears the selection on Escape pressed inside `event.currentTarget` in DOM terms. React lets
 * key events of portaled content (a confirmation, a menu) bubble through the components that
 * rendered it, so Escape that closes such a layer would clear the selection as well without the
 * containment check. Nothing happens once something else handled the key.
 */
export function clearOnEscape(event: React.KeyboardEvent<HTMLElement>, clear: () => void): void {
  if (event.key !== "Escape" || event.defaultPrevented) {
    return;
  }
  const target = event.target;
  if (!(target instanceof Node) || !event.currentTarget.contains(target)) {
    return;
  }
  event.preventDefault();
  clear();
}

export interface SelectionPanelProps {
  /**
   * `column`: docked at the bottom of the tenant page's section column (wide screens, portaled
   * there); `bar`: a bar that sticks to the bottom of the viewport below the list (narrow screens).
   */
  variant: "column" | "bar";
  jobs: JobsAccess;
  /** The one source protection decisions apply to; absent while only confirming tenant-wide. */
  sourceId: string | undefined;
  /** Reset only makes sense for an M365 source (IMAP accounts have no rules to fall back to). */
  sourceKind: DirectorySource["kind"] | undefined;
  selection: BulkSelectionState;
  onSelectionChange: (next: BulkSelectionState) => void;
  pageIds: readonly string[];
  total: number;
  filter: ObjectsFilter;
  /** Opens "Add to job" for the checked objects (closed jobs are handled by `jobs`). */
  onAddToJob: AddToJob;
  /**
   * While the list shows the open login questions: the sources of the checked accounts and
   * whether the login fails for a whole source, which the confirmation names before a bulk "Yes".
   */
  loginQuestion?: { sourceNames: readonly string[]; sourceWide: boolean } | null;
}

type AddToJob = (objects: { id: string; name: string }[]) => void;

/**
 * A job with several checked objects: a new one, or an existing one. Offered by the selection
 * panel and by the context menu of a checked row; closed with a reason while the viewer may not
 * change jobs. "Add to job" needs a way to open its dialog (absent outside the objects list).
 */
export function selectionJobActions(
  ids: ReadonlySet<string>,
  jobs: JobsAccess,
  addToJob: AddToJob | null,
  t: TFunction<"directory">,
): RowAction[] {
  const actions: RowAction[] = [
    {
      id: "newJobFromSelection",
      label: t("rowActions.newJobFromSelection", { count: ids.size }),
      icon: ListPlus,
      disabled: jobs.closed,
      reason: jobs.reason,
      link: newJobTo("mail", [...ids]),
    },
  ];
  if (addToJob) {
    actions.push({
      id: "addSelectionToJob",
      label: t("rowActions.addSelectionToJob", { count: ids.size }),
      icon: ListChecks,
      disabled: jobs.closed,
      reason: jobs.reason,
      onSelect: () => addToJob([...ids].map((id) => ({ id, name: "" }))),
    });
  }
  return actions;
}

/**
 * The actions for the checked objects, shown while at least one is checked: how many, a way to
 * reach past the page ("select all N matching"), the protection decisions (each behind a
 * confirmation that states the count and the effect, applied through the same per-object logic
 * on the server as the row actions), "Yes, intended" where objects wait for it, and a job with
 * the selection. It is a plain region, never a dialog: the page keeps scrolling, focus stays
 * where it is when the panel appears, and Escape inside it (or in the table) clears the
 * selection. Outside the list's flow, it never pushes the rows away from the pointer.
 */
export const SelectionPanel = React.forwardRef<HTMLDivElement, SelectionPanelProps>(
  function SelectionPanel(
    {
      variant,
      jobs,
      sourceId,
      sourceKind,
      selection,
      onSelectionChange,
      pageIds,
      total,
      filter,
      onAddToJob,
      loginQuestion = null,
    },
    ref,
  ) {
    const { t } = useTranslation("directory");
    const bulk = useBulkSetProtection();
    const confirmInactive = useConfirmInactive();
    const [dialog, setDialog] = React.useState<PanelDialog | null>(null);
    const moreRef = React.useRef<HTMLButtonElement>(null);

    const canReset = sourceKind === "m365";
    // "Yes, intended" only where objects wait for it: the "to confirm" filter, or orphans listed;
    // "Yes, shut down" for the open login questions.
    const answeringLogins = filter.status === "login_question";
    const canConfirm =
      filter.status === "to_confirm" || filter.status === "orphaned" || answeringLogins;
    const canDecide = sourceId !== undefined;
    const count = selectionCount(selection, total);
    const offerAllMatching =
      selection.mode === "ids" && isPageFullySelected(selection, pageIds) && total > pageIds.length;
    const clear = () => onSelectionChange(clearSelection());

    const applyConfirm = () =>
      confirmInactive.mutateAsync({ input: bulkTarget(selection, filter) }).then((result) => {
        toast.success(
          answeringLogins
            ? t("inactive.loginQuestion.doneBulk", { count: result.confirmed })
            : t("inactive.done.bulk", { count: result.confirmed }),
        );
        onSelectionChange(EMPTY_SELECTION);
        return result;
      });

    const applyBulk = (action: BulkAction) => {
      if (sourceId === undefined) {
        return Promise.resolve(null);
      }
      const input: BulkProtectionInput = { action, ...bulkTarget(selection, filter) };
      return bulk.mutateAsync({ sourceId, input }).then((result) => {
        toast.success(t(`bulk.done.${action}`, { count: result.updated }));
        onSelectionChange(EMPTY_SELECTION);
        return result;
      });
    };

    // A job is made of explicit objects: "all matching" has no list of ids to hand over.
    const jobEntries =
      selection.mode === "ids" ? selectionJobActions(selection.ids, jobs, onAddToJob, t) : [];

    const dialogs = {
      include: {
        title: t("bulk.confirm.include.title", { count }),
        description: t("bulk.confirm.include.description", { count }),
        confirmLabel: t("bulk.confirm.include.confirm"),
        onConfirm: () => applyBulk("include"),
      },
      exclude: {
        title: t("bulk.confirm.exclude.title", { count }),
        description: t("bulk.confirm.exclude.description", { count }),
        confirmLabel: t("bulk.confirm.exclude.confirm"),
        destructive: true,
        onConfirm: () => applyBulk("exclude"),
      },
      reset: {
        title: t("bulk.confirm.reset.title", { count }),
        description: t("bulk.confirm.reset.description", { count }),
        confirmLabel: t("bulk.confirm.reset.confirm"),
        onConfirm: () => applyBulk("reset"),
      },
      confirm: answeringLogins
        ? {
            title: t("inactive.loginBulkConfirm.title", { count }),
            description: [
              t("inactive.loginBulkConfirm.description", {
                count,
                sources: (loginQuestion?.sourceNames ?? []).join(", ") || "–",
              }),
              loginQuestion?.sourceWide ? t("inactive.loginQuestion.sourceWide") : null,
            ]
              .filter(Boolean)
              .join(" "),
            confirmLabel: t("inactive.loginQuestion.yes"),
            onConfirm: () => applyConfirm(),
          }
        : {
            title: t("inactive.bulkConfirm.title", { count }),
            description: t("inactive.bulkConfirm.description", { count }),
            confirmLabel: t("inactive.confirmAction"),
            onConfirm: () => applyConfirm(),
          },
    } satisfies Record<PanelDialog, React.ComponentProps<typeof ConfirmDialog>>;

    const actionButton = (id: PanelDialog, icon: LucideIcon, label: string) => {
      const Icon = icon;
      return (
        <ConfirmDialog
          key={id}
          {...dialogs[id]}
          trigger={
            <Button
              variant="outline"
              size="sm"
              data-action={id === "confirm" ? "confirmInactive" : id}
              className={
                variant === "column" ? "w-full min-w-0 justify-start" : "flex-1 sm:flex-none"
              }
            >
              <Icon aria-hidden="true" />
              {label}
            </Button>
          }
        />
      );
    };

    const regionProps = {
      ref,
      role: "region",
      "aria-label": t("bulk.panelLabel"),
      "data-slot": "selection-panel",
      "data-variant": variant,
      onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => clearOnEscape(event, clear),
    } as const;

    const clearButton = (
      <Button
        variant="ghost"
        size="icon-sm"
        className="shrink-0"
        aria-label={t("bulk.clear")}
        title={t("bulk.clear")}
        data-action="clearSelection"
        onClick={clear}
      >
        <X aria-hidden="true" />
      </Button>
    );

    if (variant === "column") {
      return (
        <div
          {...regionProps}
          className="rounded-lg border bg-card p-3 text-card-foreground shadow-md motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-2"
        >
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-medium" data-slot="selection-count">
              {t("bulk.selected", { count })}
            </p>
            {clearButton}
          </div>
          {offerAllMatching ? (
            <Button
              variant="link"
              size="sm"
              className="h-auto p-0 text-left whitespace-normal"
              data-action="selectAllMatching"
              onClick={() => onSelectionChange(selectAllMatching())}
            >
              {t("bulk.selectAllMatching", { count: total })}
            </Button>
          ) : null}
          <div className="mt-2 grid gap-1.5">
            {canDecide ? actionButton("include", CircleCheck, t("bulk.include")) : null}
            {canDecide ? actionButton("exclude", CircleMinus, t("bulk.exclude")) : null}
            {canDecide && canReset ? actionButton("reset", RotateCcw, t("bulk.reset")) : null}
            {canConfirm
              ? actionButton(
                  "confirm",
                  ShieldOff,
                  answeringLogins ? t("inactive.loginQuestion.yes") : t("inactive.confirmAction"),
                )
              : null}
            {jobEntries.length > 0 ? (
              <MoreMenu
                ref={moreRef}
                entries={[]}
                jobEntries={jobEntries}
                label={t("bulk.more")}
                className="w-full justify-start"
              />
            ) : null}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">{t("bulk.escapeHint")}</p>
        </div>
      );
    }

    // The bar keeps the two decisions as buttons; the rest waits in "More actions".
    const barEntries: RowAction[] = [
      ...(offerAllMatching
        ? [
            {
              id: "selectAllMatching",
              label: t("bulk.selectAllMatching", { count: total }),
              icon: ListChecks,
              onSelect: () => onSelectionChange(selectAllMatching()),
            },
          ]
        : []),
      ...(canDecide && canReset
        ? [
            {
              id: "reset",
              label: t("bulk.reset"),
              icon: RotateCcw,
              onSelect: () => setDialog("reset"),
            },
          ]
        : []),
      ...(canConfirm
        ? [
            {
              id: "confirmInactive",
              label: answeringLogins
                ? t("inactive.loginQuestion.yes")
                : t("inactive.confirmAction"),
              icon: ShieldOff,
              onSelect: () => setDialog("confirm"),
            },
          ]
        : []),
    ];
    const opened = dialog ? dialogs[dialog] : null;

    return (
      <div
        {...regionProps}
        // A phone puts the count and its clear button above the actions; from `sm` on one row.
        className="sticky bottom-0 z-10 -mx-4 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1.5 border-t bg-card/95 px-4 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] text-card-foreground shadow-[0_-4px_12px_rgb(0_0_0/0.06)] backdrop-blur sm:flex md:mx-0 md:rounded-t-lg md:border dark:shadow-[0_-4px_12px_rgb(0_0_0/0.3)]"
      >
        <p className="min-w-0 text-sm font-medium sm:mr-auto" data-slot="selection-count">
          {t("bulk.selected", { count })}
          <span className="ml-2 hidden text-xs font-normal text-muted-foreground md:inline">
            {t("bulk.escapeHint")}
          </span>
        </p>
        <div className="col-span-2 row-start-2 flex gap-2 sm:contents">
          {canDecide ? actionButton("include", CircleCheck, t("bulk.include")) : null}
          {canDecide ? actionButton("exclude", CircleMinus, t("bulk.exclude")) : null}
          {barEntries.length > 0 || jobEntries.length > 0 ? (
            <MoreMenu
              ref={moreRef}
              entries={barEntries}
              jobEntries={jobEntries}
              label={t("bulk.more")}
              compact
            />
          ) : null}
        </div>
        {clearButton}
        {opened ? (
          <ConfirmDialog
            {...opened}
            open
            onOpenChange={(open) => {
              if (!open) {
                setDialog(null);
                // The dialog had no trigger to return to: back to the menu that opened it.
                window.setTimeout(() => {
                  const active = document.activeElement;
                  if (!active || active === document.body) {
                    moreRef.current?.focus();
                  }
                }, 0);
              }
            }}
          />
        ) : null}
      </div>
    );
  },
);

/**
 * "More actions": a non-modal menu, so the page keeps scrolling and dialogs opened from it work.
 * The entries render like a row's menu (the kit's `RowActionItems`); a job with the selection
 * comes last, below a separator.
 */
const MoreMenu = React.forwardRef<
  HTMLButtonElement,
  {
    entries: readonly RowAction[];
    jobEntries: readonly RowAction[];
    label: string;
    className?: string;
    compact?: boolean;
  }
>(function MoreMenu({ entries, jobEntries, label, className, compact = false }, ref) {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          ref={ref}
          variant="outline"
          size={compact ? "icon-sm" : "sm"}
          className={cn(compact && "shrink-0", className)}
          aria-label={compact ? label : undefined}
          title={compact ? label : undefined}
          data-action="moreSelectionActions"
        >
          <Ellipsis aria-hidden="true" />
          {compact ? null : label}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side={compact ? "top" : "right"} className="min-w-52">
        <RowActionItems actions={entries} />
        {entries.length > 0 && jobEntries.length > 0 ? <DropdownMenuSeparator /> : null}
        <RowActionItems actions={jobEntries} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
});
