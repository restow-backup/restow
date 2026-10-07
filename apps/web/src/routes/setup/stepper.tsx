import { Check } from "lucide-react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import { STEP_KEYS, type StepKey } from "@/routes/setup/schema";

/**
 * The steps the wizard shows and counts: the ones that apply here (no setup
 * token step where none is asked for, no notice step where it counts as
 * accepted), each with its place in `STEP_KEYS`. The current step is always
 * shown, so the count never jumps.
 */
export function shownSteps(
  applies: (key: StepKey) => boolean,
  activeIndex: number,
): { key: StepKey; index: number }[] {
  return STEP_KEYS.map((key, index) => ({ key, index })).filter(
    (step) => step.index === activeIndex || applies(step.key),
  );
}

interface StepperProps {
  /** The current step's place in `STEP_KEYS`. */
  activeIndex: number;
  /** The steps to show ({@link shownSteps}). */
  steps: readonly { key: StepKey; index: number }[];
  /** Steps the user may jump back to (already completed). */
  onSelect: (index: number) => void;
}

/** Progress indicator for the wizard; completed steps are clickable. */
export function Stepper({ activeIndex, steps, onSelect }: StepperProps) {
  const { t } = useTranslation("setup");

  return (
    <ol className="flex items-center gap-2" aria-label={t("title")}>
      {steps.map(({ key, index }, position) => {
        const state = index < activeIndex ? "done" : index === activeIndex ? "active" : "todo";
        const clickable = state === "done";
        return (
          <li key={key} className="flex flex-1 items-center gap-2">
            <button
              type="button"
              disabled={!clickable}
              onClick={() => onSelect(index)}
              aria-current={state === "active" ? "step" : undefined}
              className={cn(
                "flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default",
                state === "done" &&
                  "border-primary bg-primary text-primary-foreground hover:bg-primary/90",
                state === "active" && "border-primary text-foreground",
                state === "todo" && "border-border text-muted-foreground",
              )}
            >
              {state === "done" ? (
                <Check className="h-3.5 w-3.5" aria-hidden="true" />
              ) : (
                position + 1
              )}
              <span className="sr-only">{t(`step.${key}`)}</span>
            </button>
            {/* Seven steps do not fit with every name written out: the active one is named. */}
            <span
              aria-hidden="true"
              className={cn("hidden text-xs", state === "active" && "text-foreground sm:inline")}
            >
              {t(`step.${key}`)}
            </span>
            {position < steps.length - 1 ? (
              <span aria-hidden="true" className="hidden h-px flex-1 bg-border sm:block" />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
