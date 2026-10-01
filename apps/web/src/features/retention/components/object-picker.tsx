import { Check, ChevronsUpDown, X } from "lucide-react";
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
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { errorMessageKey } from "@/lib/api";
import { cn } from "@/lib/utils";

import type { RetentionScopeObject } from "../api.js";
import { useScopeCandidates } from "../hooks.js";

export interface ObjectPickerProps {
  id: string;
  value: readonly RetentionScopeObject[];
  onChange: (value: RetentionScopeObject[]) => void;
  invalid?: boolean;
  describedBy?: string;
}

/** Search the tenant's active protected objects and pick any number for an override policy. */
export function ObjectPicker({ id, value, onChange, invalid, describedBy }: ObjectPickerProps) {
  const { t } = useTranslation("retention");
  const [open, setOpen] = React.useState(false);
  const [search, setSearch] = React.useState("");
  const candidates = useScopeCandidates(search, open);
  const selectedIds = new Set(value.map((object) => object.id));

  const toggle = (candidate: { id: string; name: string; kind: RetentionScopeObject["kind"] }) => {
    if (selectedIds.has(candidate.id)) {
      onChange(value.filter((object) => object.id !== candidate.id));
    } else {
      onChange([...value, { id: candidate.id, name: candidate.name, kind: candidate.kind }]);
    }
  };

  return (
    <div className="space-y-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            id={id}
            type="button"
            variant="outline"
            aria-invalid={invalid || undefined}
            aria-describedby={describedBy}
            className="h-auto min-h-9 w-full justify-between py-1.5 text-left font-normal whitespace-normal"
          >
            <span
              className={cn(
                "min-w-0 [overflow-wrap:anywhere]",
                value.length === 0 && "text-muted-foreground",
              )}
            >
              {value.length === 0
                ? t("form.objectPlaceholder")
                : t("scope.objects", { count: value.length })}
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
                        onSelect={() => toggle(candidate)}
                      >
                        <Check
                          aria-hidden="true"
                          className={cn(!selectedIds.has(candidate.id) && "opacity-0")}
                        />
                        <span className="min-w-0 [overflow-wrap:anywhere]">{candidate.name}</span>
                        {candidate.detail ? (
                          <span className="ml-auto min-w-0 text-right text-xs text-muted-foreground [overflow-wrap:anywhere]">
                            {candidate.detail}
                          </span>
                        ) : null}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </>
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {value.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5">
          {value.map((object) => (
            <li key={object.id}>
              <Badge variant="secondary" className="gap-1 py-0 pr-1">
                {object.name}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => onChange(value.filter((item) => item.id !== object.id))}
                  aria-label={t("form.removeObject", { name: object.name })}
                  className="size-4 rounded-sm hover:bg-muted-foreground/20"
                >
                  <X aria-hidden="true" className="size-3" />
                </Button>
              </Badge>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
