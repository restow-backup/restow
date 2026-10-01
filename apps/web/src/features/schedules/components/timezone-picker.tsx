import { Check, ChevronsUpDown, Globe } from "lucide-react";
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
import { cn } from "@/lib/utils";

import { browserTimeZone, timeZoneOptions } from "../presenters.js";

export interface TimezonePickerProps {
  id: string;
  value: string;
  onChange: (zone: string) => void;
  disabled?: boolean;
  /** Id of the element describing the field (hint or error). */
  describedBy?: string;
}

/**
 * A searchable list of the IANA time zones the browser knows, the browser's
 * own zone first. Cron schedules run at local times in the chosen zone.
 */
export function TimezonePicker({
  id,
  value,
  onChange,
  disabled,
  describedBy,
}: TimezonePickerProps) {
  const { t } = useTranslation("schedules");
  const [open, setOpen] = React.useState(false);
  const browserZone = React.useMemo(() => browserTimeZone(), []);
  const zones = React.useMemo(() => timeZoneOptions([browserZone, value]), [browserZone, value]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          variant="outline"
          aria-describedby={describedBy}
          disabled={disabled}
          className="h-auto min-h-9 w-full justify-between py-1.5 text-left font-normal whitespace-normal"
        >
          <span className="flex min-w-0 items-center gap-2">
            <Globe aria-hidden="true" className="text-muted-foreground" />
            <span className="min-w-0 [overflow-wrap:anywhere]">{value}</span>
          </span>
          <ChevronsUpDown aria-hidden="true" className="opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-(--radix-popover-trigger-width) p-0" align="start">
        <Command>
          <CommandInput placeholder={t("form.timezoneSearch")} />
          <CommandList>
            <CommandEmpty>{t("form.timezoneEmpty")}</CommandEmpty>
            <CommandGroup>
              {zones.map((zone) => (
                <CommandItem
                  key={zone}
                  value={zone}
                  onSelect={() => {
                    onChange(zone);
                    setOpen(false);
                  }}
                >
                  <Check
                    aria-hidden="true"
                    className={cn(zone === value ? "opacity-100" : "opacity-0")}
                  />
                  <span className="min-w-0 [overflow-wrap:anywhere]">{zone}</span>
                  {zone === browserZone ? (
                    <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                      {t("form.timezoneBrowser")}
                    </span>
                  ) : null}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
