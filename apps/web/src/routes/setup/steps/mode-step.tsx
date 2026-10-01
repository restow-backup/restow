import { Globe, HardDrive } from "lucide-react";
import type * as React from "react";
import { type UseFormReturn, useWatch } from "react-hook-form";
import { useTranslation } from "react-i18next";

import { Field, messageId } from "@/components/forms/field";
import { Input } from "@/components/ui/input";
import type { OperatingMode } from "@/lib/api";
import { validationKey } from "@/lib/form";
import { isLocalhostOrigin, previewPasskeyReady } from "@/lib/passkey-ready";
import { cn } from "@/lib/utils";
import { PasskeyReadiness } from "@/routes/setup/passkey-readiness";
import type { SetupFormValues } from "@/routes/setup/schema";

interface ModeStepProps {
  form: UseFormReturn<SetupFormValues>;
}

export function ModeStep({ form }: ModeStepProps) {
  const { t } = useTranslation("setup");
  const { t: tc } = useTranslation();

  const mode = useWatch({ control: form.control, name: "operatingMode" });
  const publicUrl = useWatch({ control: form.control, name: "publicUrl" });
  const urlError = form.formState.errors.publicUrl;

  const observedOrigin = typeof window === "undefined" ? null : window.location.origin;
  const preview = previewPasskeyReady({
    operatingMode: mode,
    publicUrl,
    observedOrigin,
    allowLocalhost: isLocalhostOrigin(observedOrigin),
  });

  const select = (next: OperatingMode) => {
    form.setValue("operatingMode", next, { shouldDirty: true });
    if (next === "local") {
      form.clearErrors("publicUrl");
    } else if (!form.getValues("publicUrl") && observedOrigin) {
      // Pre-fill with the address the browser is using right now.
      form.setValue("publicUrl", observedOrigin, { shouldDirty: true });
    }
  };

  return (
    <div className="space-y-6">
      <div role="radiogroup" aria-label={t("step.mode")} className="grid gap-3 sm:grid-cols-2">
        <ModeOption
          icon={<HardDrive className="h-5 w-5" />}
          title={t("mode.local")}
          description={t("mode.localDescription")}
          selected={mode === "local"}
          onSelect={() => select("local")}
        />
        <ModeOption
          icon={<Globe className="h-5 w-5" />}
          title={t("mode.public")}
          description={t("mode.publicDescription")}
          selected={mode === "public"}
          onSelect={() => select("public")}
        />
      </div>

      {mode === "public" ? (
        <Field
          id="public-url"
          label={t("mode.publicUrl.label")}
          error={urlError ? tc(validationKey(urlError) ?? "validation.required") : undefined}
          hint={t("mode.publicUrl.hint")}
        >
          <Input
            id="public-url"
            type="url"
            inputMode="url"
            autoComplete="url"
            placeholder={t("mode.publicUrl.placeholder")}
            aria-invalid={urlError !== undefined}
            aria-describedby={messageId("public-url")}
            {...form.register("publicUrl")}
          />
        </Field>
      ) : null}

      <PasskeyReadiness readiness={preview} />
    </div>
  );
}

function ModeOption({
  icon,
  title,
  description,
  selected,
  onSelect,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <label
      className={cn(
        "flex cursor-pointer flex-col gap-2 rounded-lg border p-4 text-left transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
        selected ? "border-primary ring-1 ring-ring" : "border-border hover:bg-accent",
      )}
    >
      <input
        type="radio"
        name="operating-mode"
        className="sr-only"
        checked={selected}
        onChange={onSelect}
      />
      <span className="text-primary">{icon}</span>
      <span className="font-medium">{title}</span>
      <span className="text-xs text-muted-foreground">{description}</span>
    </label>
  );
}
