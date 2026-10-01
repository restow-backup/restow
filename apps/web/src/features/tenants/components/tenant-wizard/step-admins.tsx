import { Plus, Trash2 } from "lucide-react";
import { type FieldError, type UseFormReturn, useFieldArray } from "react-hook-form";
import { useTranslation } from "react-i18next";

import { Field, messageId } from "@/components/forms/field";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

import { type TenantWizardValues, emptyAdmin, fieldMessageKey } from "../../forms";
import { RoleSelect } from "../role-select";

interface StepProps {
  form: UseFormReturn<TenantWizardValues>;
}

/** Step 4: administrators to invite once the tenant exists (the existing invitation API). */
export function AdminsStep({ form }: StepProps) {
  const { t } = useTranslation("tenants");
  const { fields, append, remove } = useFieldArray({ control: form.control, name: "admins" });
  const { errors } = form.formState;
  const admins = form.watch("admins");
  const listError = fieldMessageKey(errors.admins as FieldError | undefined);

  return (
    <div className="space-y-4">
      {listError ? (
        <p className="text-sm text-destructive" role="alert">
          {t(listError)}
        </p>
      ) : fields.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("wizard.admins.empty")}</p>
      ) : null}

      {fields.map((field, index) => {
        const rowErrors = errors.admins?.[index];
        const emailKey = fieldMessageKey(rowErrors?.email);
        const email = admins[index]?.email.trim();
        return (
          <Card key={field.id} className="py-0">
            <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-end">
              <Field
                id={`wizard-admin-${index}-email`}
                label={t("wizard.admins.email")}
                error={emailKey ? t(emailKey, { max: 320 }) : undefined}
                className="flex-1"
              >
                <Input
                  id={`wizard-admin-${index}-email`}
                  type="email"
                  autoComplete="email"
                  aria-invalid={rowErrors?.email !== undefined}
                  aria-describedby={messageId(`wizard-admin-${index}-email`)}
                  {...form.register(`admins.${index}.email`)}
                />
              </Field>
              <Field id={`wizard-admin-${index}-role`} label={t("wizard.admins.role")}>
                <RoleSelect
                  id={`wizard-admin-${index}-role`}
                  value={admins[index]?.role ?? "tenant_user"}
                  onChange={(role) => form.setValue(`admins.${index}.role`, role)}
                />
              </Field>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => remove(index)}
                aria-label={
                  email ? t("wizard.admins.remove", { email }) : t("wizard.admins.removeUnnamed")
                }
              >
                <Trash2 />
              </Button>
            </CardContent>
          </Card>
        );
      })}
      <Button type="button" variant="outline" onClick={() => append(emptyAdmin("tenant_admin"))}>
        <Plus />
        {t("wizard.admins.add")}
      </Button>
    </div>
  );
}
