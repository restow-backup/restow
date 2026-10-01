import { Search, Users } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { errorMessageKey } from "@/lib/api";
import { cn } from "@/lib/utils";

import { useDebouncedValue, useGroupSearch } from "./hooks";

export interface PickedGroup {
  id: string;
  name: string | null;
}

interface GroupPickerProps {
  id: string;
  sourceId: string;
  value: PickedGroup | null;
  onChange: (group: PickedGroup | null) => void;
  /** Shows the field as invalid (group mode without a group). */
  invalid?: boolean;
  describedBy?: string;
}

/**
 * Pick the protection group by name (type-ahead against the tenant's groups)
 * or by pasting its object id. The chosen group shows with its name; the id
 * is what the sync uses.
 */
export function GroupPicker({
  id,
  sourceId,
  value,
  onChange,
  invalid,
  describedBy,
}: GroupPickerProps) {
  const { t } = useTranslation("directory");
  const { t: tc } = useTranslation();
  const [text, setText] = React.useState("");
  const search = useDebouncedValue(text.trim(), 300);
  const groups = useGroupSearch(sourceId, search, value === null);

  if (value) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-md border border-border p-3">
        <div className="flex min-w-0 items-center gap-3">
          <Users className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">
              {value.name ?? t("rules.group.unnamed", { id: value.id })}
            </div>
            <div className="truncate font-mono text-xs text-muted-foreground">{value.id}</div>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={() => onChange(null)}>
          {t("rules.group.change")}
        </Button>
      </div>
    );
  }

  const results = groups.data ?? [];
  return (
    <div className="space-y-2">
      <div className="relative">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          id={id}
          type="search"
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder={t("rules.group.search")}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          aria-controls={`${id}-results`}
          className={cn("pl-9", invalid && "border-destructive")}
          autoComplete="off"
        />
      </div>
      <div
        id={`${id}-results`}
        className="max-h-56 overflow-y-auto rounded-md border border-border"
        aria-busy={groups.isFetching || undefined}
      >
        {groups.isError ? (
          <Alert variant="destructive" className="rounded-none border-0">
            <AlertDescription>
              {t("rules.group.error")} {tc(errorMessageKey(groups.error))}
            </AlertDescription>
          </Alert>
        ) : groups.isPending ? (
          <div className="flex justify-center p-4">
            <Spinner />
          </div>
        ) : results.length === 0 ? (
          <p className="p-3 text-sm text-muted-foreground">{t("rules.group.empty")}</p>
        ) : (
          <ul className="divide-y divide-border">
            {results.map((group) => (
              <li key={group.id}>
                <button
                  type="button"
                  className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-none"
                  onClick={() => onChange({ id: group.id, name: group.displayName })}
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">
                      {group.displayName ?? t("rules.group.unnamed", { id: group.id })}
                    </span>
                    {group.mail ? (
                      <span className="block truncate text-xs text-muted-foreground">
                        {group.mail}
                      </span>
                    ) : null}
                  </span>
                  <Badge variant="muted">{t(`rules.group.kind.${group.kind}`)}</Badge>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
