import { Check, Minus } from "lucide-react";
import { Checkbox as CheckboxPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";

interface TriStateCheckboxProps {
  state: "none" | "some" | "all";
  onChange: (select: boolean) => void;
  label: string;
}

/**
 * The "select all" checkbox of a list: checked, empty, or a dash when only
 * part of the list is selected. Styled like the shared checkbox, which has no
 * indeterminate look of its own.
 */
export function TriStateCheckbox({ state, onChange, label }: TriStateCheckboxProps) {
  return (
    <CheckboxPrimitive.Root
      checked={state === "all" ? true : state === "some" ? "indeterminate" : false}
      // From "some", a click selects everything; from "all", it clears.
      onCheckedChange={() => onChange(state !== "all")}
      aria-label={label}
      className={cn(
        "peer size-4 shrink-0 rounded-sm border border-primary shadow focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
        "data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground",
        "data-[state=indeterminate]:bg-primary data-[state=indeterminate]:text-primary-foreground",
      )}
    >
      <CheckboxPrimitive.Indicator className="flex items-center justify-center text-current">
        {state === "some" ? (
          <Minus className="size-3.5" aria-hidden="true" />
        ) : (
          <Check className="size-3.5" aria-hidden="true" />
        )}
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}
