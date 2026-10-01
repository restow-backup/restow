import type { Column, Table } from "@tanstack/react-table";
import { Check, CirclePlus, type LucideIcon, Search, Settings2 } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

import { UI_NAMESPACE } from "../i18n.js";
import { columnLabel } from "./columns.js";

/** Options longer than this get a search field inside the filter. */
const SEARCHABLE_FROM = 8;

export interface DataTableSearchProps {
  /** The applied search text (from the URL, the query or `table.getState().globalFilter`). */
  value: string;
  /** Receives the settled, trimmed text. */
  onChange: (value: string) => void;
  placeholder?: string;
  /** Accessible name; defaults to the placeholder. */
  label?: string;
  /** Wait this long after the last keystroke (default 250 ms). */
  debounceMs?: number;
  className?: string;
}

/**
 * Search field for the table toolbar. Typing stays instant; only the settled
 * text is passed on, and outside changes (reset, back button) flow back in.
 */
export function DataTableSearch({
  value,
  onChange,
  placeholder,
  label,
  debounceMs = 250,
  className,
}: DataTableSearchProps) {
  const { t } = useTranslation(UI_NAMESPACE);
  const [text, setText] = React.useState(value);
  // What this field last passed on, to tell its own updates from outside ones.
  const pushed = React.useRef(value);
  const latest = React.useRef(onChange);

  React.useEffect(() => {
    latest.current = onChange;
  }, [onChange]);

  React.useEffect(() => {
    if (value !== pushed.current) {
      pushed.current = value;
      setText(value);
    }
  }, [value]);

  React.useEffect(() => {
    const next = text.trim();
    if (next === pushed.current) {
      return;
    }
    const timer = window.setTimeout(() => {
      pushed.current = next;
      latest.current(next);
    }, debounceMs);
    return () => window.clearTimeout(timer);
  }, [text, debounceMs]);

  const hint = placeholder ?? t("table.search");
  return (
    <div className={cn("relative w-full sm:w-64", className)}>
      <Search
        className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden="true"
      />
      <Input
        type="search"
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder={hint}
        aria-label={label ?? hint}
        className="h-8 pl-8"
      />
    </div>
  );
}

/** One value of a faceted filter. */
export interface FacetOption {
  value: string;
  label: string;
  icon?: LucideIcon;
  /** Rows with this value; client tables count on their own. */
  count?: number;
}

export interface DataTableFacetedFilterProps<TData, TValue> {
  title: string;
  options: readonly FacetOption[];
  /**
   * Client tables: the column to filter. Selection and counts come from the
   * table; give the column `filterFn: matchesAnyOf`.
   */
  column?: Column<TData, TValue>;
  /** Server tables: the selected values. */
  selected?: readonly string[];
  /** Server tables: receives the new selection. */
  onChange?: (selected: string[]) => void;
}

/** Multi-select filter button ("Status: Failed, Running") for the table toolbar. */
export function DataTableFacetedFilter<TData, TValue>({
  title,
  options,
  column,
  selected: selectedProp,
  onChange,
}: DataTableFacetedFilterProps<TData, TValue>) {
  const { t } = useTranslation(UI_NAMESPACE);
  const filterValue = column?.getFilterValue();
  const selected = new Set<string>(
    column ? (Array.isArray(filterValue) ? (filterValue as string[]) : []) : (selectedProp ?? []),
  );
  const facets = column?.getFacetedUniqueValues();

  const apply = (next: Set<string>) => {
    const values = options.map((option) => option.value).filter((value) => next.has(value));
    if (column) {
      column.setFilterValue(values.length > 0 ? values : undefined);
    }
    onChange?.(values);
  };

  const toggle = (value: string) => {
    const next = new Set(selected);
    if (next.has(value)) {
      next.delete(value);
    } else {
      next.add(value);
    }
    apply(next);
  };

  const chosen = options.filter((option) => selected.has(option.value));

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 border-dashed">
          <CirclePlus aria-hidden="true" />
          {title}
          {chosen.length > 0 ? (
            <>
              <Separator
                orientation="vertical"
                className="mx-0.5 data-[orientation=vertical]:h-4"
              />
              <Badge variant="secondary" className="rounded-sm px-1 font-normal lg:hidden">
                {chosen.length}
              </Badge>
              <span className="hidden gap-1 lg:flex">
                {chosen.length > 2 ? (
                  <Badge variant="secondary" className="rounded-sm px-1 font-normal">
                    {t("table.filter.selected", { count: chosen.length })}
                  </Badge>
                ) : (
                  chosen.map((option) => (
                    <Badge
                      key={option.value}
                      variant="secondary"
                      className="rounded-sm px-1 font-normal"
                    >
                      {option.label}
                    </Badge>
                  ))
                )}
              </span>
            </>
          ) : null}
        </Button>
      </PopoverTrigger>
      {/* As wide as the longest option (an option is never cut off), within the viewport. */}
      <PopoverContent
        className="w-max max-w-[min(24rem,var(--radix-popover-content-available-width))] min-w-60 p-0"
        align="start"
      >
        <Command>
          {options.length >= SEARCHABLE_FROM ? <CommandInput placeholder={title} /> : null}
          <CommandList>
            <CommandEmpty>{t("table.filter.noOptions")}</CommandEmpty>
            <CommandGroup>
              {options.map((option) => {
                const isSelected = selected.has(option.value);
                const count = facets ? (facets.get(option.value) ?? 0) : option.count;
                const Icon = option.icon;
                return (
                  <CommandItem
                    key={option.value}
                    value={option.value}
                    keywords={[option.label]}
                    aria-checked={isSelected}
                    onSelect={() => toggle(option.value)}
                  >
                    <span
                      aria-hidden="true"
                      className={cn(
                        "flex size-4 items-center justify-center rounded-sm border border-primary",
                        isSelected ? "bg-primary text-primary-foreground" : "opacity-50",
                      )}
                    >
                      {isSelected ? <Check className="size-3.5 text-primary-foreground" /> : null}
                    </span>
                    {Icon ? <Icon aria-hidden="true" /> : null}
                    <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{option.label}</span>
                    {count !== undefined ? (
                      <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                        {count}
                      </span>
                    ) : null}
                  </CommandItem>
                );
              })}
            </CommandGroup>
            {chosen.length > 0 ? (
              <>
                <CommandSeparator />
                <CommandGroup>
                  <CommandItem onSelect={() => apply(new Set())} className="justify-center">
                    {t("table.filter.clear")}
                  </CommandItem>
                </CommandGroup>
              </>
            ) : null}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/**
 * "Columns" menu: show or hide every column that has a label and may hide.
 * The last visible column cannot be switched off.
 */
export function DataTableViewOptions<TData>({ table }: { table: Table<TData> }) {
  const { t } = useTranslation(UI_NAMESPACE);
  const columns = table
    .getAllLeafColumns()
    .filter((column) => column.getCanHide() && columnLabel(column) !== null);
  if (columns.length === 0) {
    return null;
  }
  const visibleCount = columns.filter((column) => column.getIsVisible()).length;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="h-8">
          <Settings2 aria-hidden="true" />
          {t("table.columns.button")}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-48">
        <DropdownMenuLabel>{t("table.columns.label")}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {columns.map((column) => {
          const visible = column.getIsVisible();
          return (
            <DropdownMenuCheckboxItem
              key={column.id}
              checked={visible}
              disabled={visible && visibleCount === 1}
              // Keep the menu open to toggle several columns in a row.
              onSelect={(event) => event.preventDefault()}
              onCheckedChange={(checked) => column.toggleVisibility(checked === true)}
            >
              {columnLabel(column)}
            </DropdownMenuCheckboxItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
