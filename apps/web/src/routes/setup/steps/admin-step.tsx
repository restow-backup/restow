import { type UseFormReturn, useWatch } from "react-hook-form";
import { useTranslation } from "react-i18next";

import { Field, messageId } from "@/components/forms/field";
import { PasswordInput } from "@/components/forms/password-input";
import { PasswordStrength } from "@/components/forms/password-strength";
import { Input } from "@/components/ui/input";
import { validationKey } from "@/lib/form";
import { PASSWORD_MIN_LENGTH } from "@/lib/password";
import type { SetupFormValues } from "@/routes/setup/schema";

interface AdminStepProps {
  form: UseFormReturn<SetupFormValues>;
}

export function AdminStep({ form }: AdminStepProps) {
  const { t } = useTranslation("setup");
  const { t: tc } = useTranslation();

  const errors = form.formState.errors.admin;
  const password = useWatch({ control: form.control, name: "admin.password" });

  const message = (error: Parameters<typeof validationKey>[0]) => {
    const key = validationKey(error);
    return key ? tc(key, { min: PASSWORD_MIN_LENGTH }) : undefined;
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="admin-name" label={t("admin.name.label")} error={message(errors?.name)}>
          <Input
            id="admin-name"
            autoComplete="name"
            placeholder={t("admin.name.placeholder")}
            aria-invalid={errors?.name !== undefined}
            aria-describedby={messageId("admin-name")}
            {...form.register("admin.name")}
          />
        </Field>
        <Field id="admin-email" label={t("admin.email.label")} error={message(errors?.email)}>
          <Input
            id="admin-email"
            type="email"
            autoComplete="username"
            placeholder={t("admin.email.placeholder")}
            aria-invalid={errors?.email !== undefined}
            aria-describedby={messageId("admin-email")}
            {...form.register("admin.email")}
          />
        </Field>
      </div>

      <Field
        id="admin-password"
        label={t("admin.password.label")}
        error={message(errors?.password)}
        hint={t("admin.password.hint")}
      >
        <PasswordInput
          id="admin-password"
          autoComplete="new-password"
          placeholder={t("admin.password.placeholder")}
          aria-invalid={errors?.password !== undefined}
          aria-describedby={messageId("admin-password")}
          {...form.register("admin.password")}
        />
      </Field>
      <PasswordStrength password={password} />

      <Field id="admin-confirm" label={t("admin.confirm.label")} error={message(errors?.confirm)}>
        <PasswordInput
          id="admin-confirm"
          autoComplete="new-password"
          placeholder={t("admin.confirm.placeholder")}
          aria-invalid={errors?.confirm !== undefined}
          aria-describedby={messageId("admin-confirm")}
          {...form.register("admin.confirm")}
        />
      </Field>

      <p className="text-xs text-muted-foreground">{t("admin.passkeyHint")}</p>
    </div>
  );
}
