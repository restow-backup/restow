import { Check } from "lucide-react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import { WIZARD_STEPS, type WizardStep, stepIndex } from "./wizard-state";

interface StepperProps {
  current: WizardStep;
  /** Whether the person may jump to a step (earlier steps, or later ones whose predecessors are complete). */
  canOpen: (step: WizardStep) => boolean;
  onSelect: (step: WizardStep) => void;
}

/** The four steps as a numbered list; done steps are buttons that go back to them. */
export function Stepper({ current, canOpen, onSelect }: StepperProps) {
  const { t } = useTranslation("imports");
  const currentIndex = stepIndex(current);
  return (
    <nav aria-label={t("steps.label")}>
      <ol className="flex flex-wrap items-center gap-x-2 gap-y-2">
        {WIZARD_STEPS.map((step, index) => {
          const done = index < currentIndex;
          const active = step === current;
          const reachable = active || done || canOpen(step);
          return (
            <li key={step} className="flex items-center gap-2">
              <button
                type="button"
                disabled={!reachable}
                aria-current={active ? "step" : undefined}
                onClick={() => onSelect(step)}
                className={cn(
                  "flex items-center gap-2 rounded-full py-1 pr-3 pl-1 text-sm outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50",
                  active ? "bg-primary/10 font-medium text-foreground" : "text-muted-foreground",
                  reachable && !active && "hover:bg-muted hover:text-foreground",
                  !reachable && "cursor-not-allowed opacity-60",
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "flex size-6 items-center justify-center rounded-full border text-xs tabular-nums",
                    active && "border-primary bg-primary text-primary-foreground",
                    done && "border-primary/40 bg-primary/10 text-primary",
                  )}
                >
                  {done ? <Check className="size-3.5" /> : index + 1}
                </span>
                <span className={cn(!active && "hidden sm:inline")}>{t(`steps.${step}`)}</span>
                {done ? <span className="sr-only">{t("steps.done")}</span> : null}
              </button>
              {index < WIZARD_STEPS.length - 1 ? (
                <span aria-hidden="true" className="hidden h-px w-6 bg-border sm:block" />
              ) : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
