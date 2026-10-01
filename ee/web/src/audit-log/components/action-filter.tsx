import { Check, ChevronsUpDown } from "lucide-react";
import * as React from "react";

import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { AuditActionCount } from "../api";
import type { AuditFormat } from "../hooks";
import { type ActionChoice, actionChoices, groupActions, matchesActionSearch } from "../presenters";

/** Row value standing for "no filter" (cmdk rows need a non-empty value). */
const ALL = "__all__";

/**
 * The action filter: a searchable list grouped by category. A category row is
 * itself a choice and filters by every action of that category (the URL keeps
 * the dotted prefix, as before); "All actions" stays on top. The list opens
 * below the trigger (above when there is no room), scrolls inside itself and
 * never leaves the viewport (the page does not scroll while it is open). The trigger shows the whole chosen label and
 * wraps instead of cutting it off.
 */
export function ActionFilter({
  id,
  labelId,
  value,
  actions,
  format,
  onChange,
}: {
  id: string;
  /** Id of the visible field label, part of the trigger's accessible name. */
  labelId: string;
  value: string | undefined;
  actions: readonly AuditActionCount[];
  format: AuditFormat;
  onChange: (action: string | undefined) => void;
}) {
  const { t } = format;
  const [open, setOpen] = React.useState(false);
  const valueId = React.useId();

  const groups = React.useMemo(
    () =>
      actionChoices(
        groupActions(actions),
        { category: format.categoryLabel, action: format.actionLabel },
        format.language,
      ),
    [actions, format],
  );
  const allOf = (category: string) => t("filters.allOfCategory", { category });
  const offered = new Set(
    groups.flatMap((group) => [group.category.value, ...group.actions.map((item) => item.value)]),
  );
  // A linked filter with no entries in this scope still shows as selected.
  const unlisted: ActionChoice | null =
    value !== undefined && !offered.has(value) ? unlistedChoice(value, format, allOf) : null;
  const chosenLabel = labelOf(value, groups, unlisted, t("filters.allActions"), allOf);

  const choose = (next: string) => {
    onChange(next === ALL ? undefined : next);
    setOpen(false);
  };

  return (
    // Modal like a select: the page does not scroll while the list is open, so the list
    // cannot be carried out of view with its trigger.
    <Popover modal open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          variant="outline"
          // biome-ignore lint/a11y/useSemanticElements: a native <select> cannot search this list; this is the ARIA combobox pattern (a button opening a listbox)
          role="combobox"
          // Radix sets aria-expanded and aria-controls (the popup holding the list).
          aria-haspopup="listbox"
          aria-labelledby={`${labelId} ${valueId}`}
          className="h-auto min-h-9 w-72 max-w-full justify-between gap-2 py-1.5 text-left font-normal whitespace-normal focus-visible:ring-2 focus-visible:ring-muted-foreground"
        >
          <span id={valueId} className="min-w-0 flex-1 [overflow-wrap:anywhere]">
            {chosenLabel}
          </span>
          <ChevronsUpDown aria-hidden="true" className="opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="bottom"
        collisionPadding={8}
        className="flex max-h-[min(var(--radix-popover-content-available-height),24rem)] w-max max-w-[min(36rem,var(--radix-popover-content-available-width))] min-w-(--radix-popover-trigger-width) flex-col overflow-hidden p-0"
      >
        <Command
          // cmdk names its search field by this label (aria-labelledby), not by aria-label.
          label={t("filters.actionSearch")}
          loop
          defaultValue={value ?? ALL}
          filter={(_value, search, keywords) =>
            matchesActionSearch(keywords ?? [], search) ? 1 : 0
          }
          className="min-h-0 flex-1"
        >
          <CommandInput placeholder={t("filters.actionSearch")} />
          <CommandList
            // cmdk names the listbox by this prop and sets its id itself.
            label={t("filters.action")}
            className="max-h-none min-h-0 flex-1 p-1"
          >
            <CommandEmpty>{t("filters.actionEmpty")}</CommandEmpty>
            <CommandGroup className="p-0">
              <ChoiceRow
                value={ALL}
                label={t("filters.allActions")}
                keywords={[t("filters.allActions")]}
                selected={value === undefined}
                onSelect={choose}
              />
              {unlisted ? (
                <ChoiceRow
                  value={unlisted.value}
                  label={unlisted.label}
                  keywords={unlisted.keywords}
                  selected
                  onSelect={choose}
                />
              ) : null}
            </CommandGroup>
            {groups.map((group) => (
              <CommandGroup key={group.category.value} className="p-0">
                <ChoiceRow
                  value={group.category.value}
                  label={group.category.label}
                  accessibleLabel={
                    group.actions.length > 0 ? allOf(group.category.label) : undefined
                  }
                  keywords={group.category.keywords}
                  selected={value === group.category.value}
                  heading
                  onSelect={choose}
                />
                {group.actions.map((item) => (
                  <ChoiceRow
                    key={item.value}
                    value={item.value}
                    label={item.label}
                    keywords={item.keywords}
                    selected={value === item.value}
                    onSelect={choose}
                  />
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function ChoiceRow({
  value,
  label,
  accessibleLabel,
  keywords,
  selected,
  heading = false,
  onSelect,
}: {
  value: string;
  label: string;
  /** Name for screen readers when the visible label alone is not enough. */
  accessibleLabel?: string;
  keywords: string[];
  selected: boolean;
  /** A category row: set apart from the actions listed under it. */
  heading?: boolean;
  onSelect: (value: string) => void;
}) {
  return (
    <CommandItem
      value={value}
      keywords={keywords}
      aria-label={accessibleLabel}
      aria-checked={selected}
      onSelect={() => onSelect(value)}
      // The highlighted row also gets an inset ring (at least 3:1 in both themes), not only the
      // faint accent background.
      className={cn(
        "items-start data-[selected=true]:ring-1 data-[selected=true]:ring-muted-foreground data-[selected=true]:ring-inset",
        heading ? "mt-1 font-medium first:mt-0" : "pl-7",
      )}
    >
      <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{label}</span>
      <Check
        aria-hidden="true"
        className={cn("mt-0.5 text-foreground", selected ? "opacity-100" : "opacity-0")}
      />
    </CommandItem>
  );
}

/** A linked value this scope has no entries for: a category or a single action. */
function unlistedChoice(
  value: string,
  format: AuditFormat,
  allOf: (category: string) => string,
): ActionChoice {
  const action = format.actionLabel(value);
  const label = action ?? (value.includes(".") ? value : allOf(format.categoryLabel(value)));
  return { value, label, keywords: [label] };
}

/** The whole label of the current choice, for the trigger. */
function labelOf(
  value: string | undefined,
  groups: readonly { category: ActionChoice; actions: ActionChoice[] }[],
  unlisted: ActionChoice | null,
  allActions: string,
  allOf: (category: string) => string,
): string {
  if (value === undefined) {
    return allActions;
  }
  for (const group of groups) {
    if (group.category.value === value) {
      return group.actions.length > 0 ? allOf(group.category.label) : group.category.label;
    }
    const action = group.actions.find((item) => item.value === value);
    if (action) {
      return action.label;
    }
  }
  return unlisted?.label ?? value;
}
