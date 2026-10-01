import { Check } from "lucide-react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import { STEP_KEYS, type StepKey } from "@/routes/setup/schema";

interface StepperProps {
  activeIndex: number;
  /** Steps the user may jump back to (already completed). */
  onSelect: (index: number) => void;
}

/** Progress indicator for the wizard; completed steps are clickable. */
export function Stepper({ activeIndex, onSelect }: StepperProps) {
  const { t } = useTranslation("setup");

  return (
    <ol className="flex items-center gap-2" aria-label={t("title")}>
      {STEP_KEYS.map((key: StepKey, index) => {
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
              {state === "done" ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : index + 1}
              <span className="sr-only">{t(`step.${key}`)}</span>
            </button>
            <span
              aria-hidden="true"
              className={cn(
                "hidden text-xs sm:inline",
                state === "todo" ? "text-muted-foreground" : "text-foreground",
              )}
            >
              {t(`step.${key}`)}
            </span>
            {index < STEP_KEYS.length - 1 ? (
              <span aria-hidden="true" className="hidden h-px flex-1 bg-border sm:block" />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
