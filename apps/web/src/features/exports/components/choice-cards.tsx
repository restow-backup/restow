import type { LucideIcon } from "lucide-react";
import type * as React from "react";

import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { cn } from "@/lib/utils";

export interface Choice<T extends string> {
  value: T;
  label: string;
  description?: React.ReactNode;
  icon?: LucideIcon;
  disabled?: boolean;
  /** A short tag next to the label, e.g. "Planned for a later release". */
  badge?: string;
  /** Why the choice is unavailable; shown only while disabled. */
  disabledHint?: string;
}

interface ChoiceCardsProps<T extends string> {
  name: string;
  legend: string;
  value: T | null;
  onChange: (value: T) => void;
  choices: readonly Choice<T>[];
  /** Translated problem with the current choice. */
  error?: string;
}

/**
 * A `RadioGroup` rendered as self-explaining cards: every option shows its
 * own description (and, disabled, why it cannot be picked) before it is
 * chosen. Same look as the restore dialog's target cards.
 */
export function ChoiceCards<T extends string>({
  name,
  legend,
  value,
  onChange,
  choices,
  error,
}: ChoiceCardsProps<T>) {
  const errorId = `${name}-error`;
  return (
    <fieldset className="space-y-2" aria-describedby={error ? errorId : undefined}>
      <legend className="mb-2 text-sm font-medium">{legend}</legend>
      <RadioGroup
        value={value ?? ""}
        onValueChange={(next) => onChange(next as T)}
        aria-invalid={error ? true : undefined}
      >
        {choices.map((choice) => {
          const Icon = choice.icon;
          const checked = value === choice.value;
          const id = `${name}-${choice.value}`;
          return (
            <Label
              key={choice.value}
              htmlFor={id}
              className={cn(
                "flex items-start gap-3 rounded-lg border border-border p-3 font-normal transition-colors",
                "has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
                choice.disabled
                  ? "cursor-not-allowed bg-muted/40"
                  : "cursor-pointer hover:bg-accent/50",
                checked && !choice.disabled && "border-primary bg-primary/5",
              )}
            >
              <RadioGroupItem
                id={id}
                value={choice.value}
                disabled={choice.disabled}
                className="mt-0.5"
              />
              <span className={cn("min-w-0 space-y-0.5", choice.disabled && "opacity-80")}>
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium">
                  {Icon ? (
                    <Icon className="size-4 text-muted-foreground" aria-hidden="true" />
                  ) : null}
                  {choice.label}
                  {choice.badge ? <Badge variant="muted">{choice.badge}</Badge> : null}
                </span>
                {choice.description ? (
                  <span className="block text-xs text-muted-foreground">{choice.description}</span>
                ) : null}
                {choice.disabled && choice.disabledHint ? (
                  <span className="block text-xs text-muted-foreground">{choice.disabledHint}</span>
                ) : null}
              </span>
            </Label>
          );
        })}
      </RadioGroup>
      {error ? (
        <p id={errorId} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}
