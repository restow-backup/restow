import { Check, ChevronsUpDown } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

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
import { Skeleton } from "@/components/ui/skeleton";
import { errorMessageKey } from "@/lib/api";
import { cn } from "@/lib/utils";

import { useScopeCandidates } from "../hooks.js";

export interface ScopeObjectValue {
  id: string;
  name: string;
}

export interface ScopePickerProps {
  id: string;
  value: ScopeObjectValue | null;
  onChange: (value: ScopeObjectValue) => void;
  invalid?: boolean;
  describedBy?: string;
}

/** Search the tenant's active protected objects and pick the one a schedule is narrowed to. */
export function ScopePicker({ id, value, onChange, invalid, describedBy }: ScopePickerProps) {
  const { t } = useTranslation("schedules");
  const [open, setOpen] = React.useState(false);
  const [search, setSearch] = React.useState("");
  const candidates = useScopeCandidates(search, open);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          variant="outline"
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          className="h-auto min-h-9 w-full justify-between py-1.5 text-left font-normal whitespace-normal"
        >
          <span
            className={cn("min-w-0 [overflow-wrap:anywhere]", !value && "text-muted-foreground")}
          >
            {value?.name ?? t("form.objectPlaceholder")}
          </span>
          <ChevronsUpDown aria-hidden="true" className="opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-(--radix-popover-trigger-width) p-0" align="start">
        {/* The server searches; the list shows its answer as it is. */}
        <Command shouldFilter={false}>
          <CommandInput
            placeholder={t("form.objectSearch")}
            value={search}
            onValueChange={setSearch}
          />
          <CommandList>
            {candidates.isPending ? (
              <div className="space-y-2 p-2" aria-hidden="true">
                <Skeleton className="h-7 w-full" />
                <Skeleton className="h-7 w-3/4" />
              </div>
            ) : candidates.isError ? (
              <p className="p-3 text-sm text-destructive-text" role="alert">
                {t(`common:${errorMessageKey(candidates.error)}`)}
              </p>
            ) : (
              <>
                <CommandEmpty>{t("form.objectEmpty")}</CommandEmpty>
                <CommandGroup>
                  {(candidates.data ?? []).map((candidate) => (
                    <CommandItem
                      key={candidate.id}
                      value={candidate.id}
                      onSelect={() => {
                        onChange({ id: candidate.id, name: candidate.name });
                        setOpen(false);
                      }}
                    >
                      <Check
                        aria-hidden="true"
                        className={cn(candidate.id === value?.id ? "opacity-100" : "opacity-0")}
                      />
                      <span className="min-w-0 [overflow-wrap:anywhere]">
                        <span className="block">{candidate.name}</span>
                        {candidate.detail ? (
                          <span className="block text-xs text-muted-foreground">
                            {candidate.detail}
                          </span>
                        ) : null}
                      </span>
                      <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                        {t(`objectKinds.${candidate.kind}`)}
                      </span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
