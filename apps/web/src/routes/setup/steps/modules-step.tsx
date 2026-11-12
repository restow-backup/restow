import { useId } from "react";
import { type UseFormReturn, useWatch } from "react-hook-form";
import { useTranslation } from "react-i18next";

import { Checkbox } from "@/components/ui/checkbox";
import { MODULE_IDS, type ModuleId, moduleDescriptionKey, moduleTitleKey } from "@/lib/modules";
import { cn } from "@/lib/utils";
import type { SetupFormValues } from "@/routes/setup/schema";

interface ModulesStepProps {
  form: UseFormReturn<SetupFormValues>;
}

/**
 * "What do you want to protect?": one box per module of the installation (lib/modules.ts), all
 * ticked to begin with, at least one to continue. The answer only decides what the menu, the
 * overview and the offers to create something show; Installation > Modules changes it at any
 * time, and nothing is lost by leaving a module out here.
 */
export function ModulesStep({ form }: ModulesStepProps) {
  const { t } = useTranslation("setup");
  const { t: tc } = useTranslation();
  const id = useId();
  const selected = useWatch({ control: form.control, name: "modules" });
  const invalid = form.formState.errors.modules !== undefined;

  const toggle = (module: ModuleId, checked: boolean) => {
    const next = MODULE_IDS.filter((candidate) =>
      candidate === module ? checked : selected.includes(candidate),
    );
    form.setValue("modules", next, { shouldDirty: true, shouldValidate: true });
  };

  return (
    <fieldset className="space-y-3" aria-describedby={invalid ? `${id}-error` : `${id}-hint`}>
      <legend className="sr-only">{t("modules.title")}</legend>
      <div className="grid gap-3">
        {MODULE_IDS.map((module) => {
          const checked = selected.includes(module);
          const boxId = `${id}-${module}`;
          return (
            <label
              key={module}
              htmlFor={boxId}
              data-module={module}
              className={cn(
                "flex cursor-pointer items-start gap-3 rounded-lg border p-4 text-left transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
                checked ? "border-primary" : "border-border hover:bg-accent",
              )}
            >
              <Checkbox
                id={boxId}
                className="mt-0.5"
                checked={checked}
                aria-invalid={invalid || undefined}
                aria-describedby={`${boxId}-description`}
                onCheckedChange={(state) => toggle(module, state === true)}
              />
              <span className="flex flex-col gap-1">
                <span className="text-sm font-medium">{tc(moduleTitleKey(module))}</span>
                <span id={`${boxId}-description`} className="text-xs text-muted-foreground">
                  {tc(moduleDescriptionKey(module))}
                </span>
              </span>
            </label>
          );
        })}
      </div>
      {invalid ? (
        <p id={`${id}-error`} role="alert" className="text-sm text-destructive">
          {t("modules.required")}
        </p>
      ) : null}
      <p id={`${id}-hint`} className="text-xs text-muted-foreground">
        {t("modules.hint")}
      </p>
    </fieldset>
  );
}
