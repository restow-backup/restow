import { Plus, Trash2 } from "lucide-react";
import { type FieldError, type UseFormReturn, useFieldArray } from "react-hook-form";
import { useTranslation } from "react-i18next";

import { Field, messageId } from "@/components/forms/field";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";

import {
  CONTACT_EMAIL_MAX,
  CONTACT_ROLE_MAX,
  NAME_MAX_LENGTH,
  PHONE_MAX,
  type TenantWizardValues,
  emptyContact,
  fieldMessageKey,
} from "../../forms";

/** Per-field character limits, for the "at most N characters" message. */
const FIELD_MAX: Record<"name" | "role" | "email" | "phone", number> = {
  name: NAME_MAX_LENGTH,
  role: CONTACT_ROLE_MAX,
  email: CONTACT_EMAIL_MAX,
  phone: PHONE_MAX,
};

interface StepProps {
  form: UseFormReturn<TenantWizardValues>;
}

/** Step 2: repeatable contact persons, exactly one of them primary. */
export function ContactsStep({ form }: StepProps) {
  const { t } = useTranslation("tenants");
  const { fields, append, remove } = useFieldArray({ control: form.control, name: "contacts" });
  const { errors } = form.formState;
  const contacts = form.watch("contacts");
  const primaryIndex = contacts.findIndex((contact) => contact.isPrimary);
  const listError = fieldMessageKey(errors.contacts as FieldError | undefined);

  function setPrimary(index: number) {
    contacts.forEach((_, i) => {
      form.setValue(`contacts.${i}.isPrimary`, i === index, {
        shouldValidate: true,
        shouldDirty: true,
      });
    });
  }

  /**
   * Removing a row never leaves the list without a primary contact: when the
   * removed row was the primary one, the new first row (what "exactly one
   * primary" requires anyway) takes it over instead of leaving the choice to
   * a validation error the user has to notice and fix by hand.
   */
  function removeContact(index: number) {
    const removedPrimary = contacts[index]?.isPrimary === true;
    remove(index);
    if (removedPrimary) {
      form.setValue("contacts.0.isPrimary", true, { shouldValidate: true, shouldDirty: true });
    }
  }

  return (
    <div className="space-y-4">
      {listError ? (
        <p className="text-sm text-destructive" role="alert">
          {t(listError)}
        </p>
      ) : null}
      <RadioGroup
        value={primaryIndex >= 0 ? String(primaryIndex) : undefined}
        onValueChange={(value) => setPrimary(Number(value))}
        className="contents"
      >
        {fields.map((field, index) => {
          const rowErrors = errors.contacts?.[index];
          const message = (name: "name" | "role" | "email" | "phone") => {
            const key = fieldMessageKey(rowErrors?.[name]);
            return key ? t(key, { max: FIELD_MAX[name] }) : undefined;
          };
          const label = contacts[index]?.name.trim();
          return (
            <Card key={field.id} className="py-0">
              <CardContent className="space-y-3 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <RadioGroupItem
                      value={String(index)}
                      id={`wizard-contact-${index}-primary`}
                      aria-describedby={`wizard-contact-${index}-primary-label`}
                    />
                    <Label
                      id={`wizard-contact-${index}-primary-label`}
                      htmlFor={`wizard-contact-${index}-primary`}
                      className="font-normal text-muted-foreground"
                    >
                      {t("wizard.contacts.primary")}
                    </Label>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    disabled={fields.length <= 1}
                    onClick={() => removeContact(index)}
                    aria-label={
                      label
                        ? t("wizard.contacts.remove", { name: label })
                        : t("wizard.contacts.removeUnnamed")
                    }
                  >
                    <Trash2 />
                  </Button>
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field
                    id={`wizard-contact-${index}-name`}
                    label={t("wizard.contacts.name")}
                    error={message("name")}
                  >
                    <Input
                      id={`wizard-contact-${index}-name`}
                      autoComplete="name"
                      placeholder={t("wizard.contacts.namePlaceholder")}
                      aria-invalid={rowErrors?.name !== undefined}
                      aria-describedby={messageId(`wizard-contact-${index}-name`)}
                      {...form.register(`contacts.${index}.name`)}
                    />
                  </Field>
                  <Field
                    id={`wizard-contact-${index}-role`}
                    label={t("wizard.contacts.role")}
                    error={message("role")}
                  >
                    <Input
                      id={`wizard-contact-${index}-role`}
                      autoComplete="organization-title"
                      placeholder={t("wizard.contacts.rolePlaceholder")}
                      aria-invalid={rowErrors?.role !== undefined}
                      aria-describedby={messageId(`wizard-contact-${index}-role`)}
                      {...form.register(`contacts.${index}.role`)}
                    />
                  </Field>
                  <Field
                    id={`wizard-contact-${index}-email`}
                    label={t("wizard.contacts.email")}
                    error={message("email")}
                  >
                    <Input
                      id={`wizard-contact-${index}-email`}
                      type="email"
                      autoComplete="email"
                      aria-invalid={rowErrors?.email !== undefined}
                      aria-describedby={messageId(`wizard-contact-${index}-email`)}
                      {...form.register(`contacts.${index}.email`)}
                    />
                  </Field>
                  <Field
                    id={`wizard-contact-${index}-phone`}
                    label={t("wizard.contacts.phone")}
                    error={message("phone")}
                  >
                    <Input
                      id={`wizard-contact-${index}-phone`}
                      type="tel"
                      autoComplete="tel"
                      aria-invalid={rowErrors?.phone !== undefined}
                      aria-describedby={messageId(`wizard-contact-${index}-phone`)}
                      {...form.register(`contacts.${index}.phone`)}
                    />
                  </Field>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </RadioGroup>
      <Button
        type="button"
        variant="outline"
        onClick={() => append(emptyContact(fields.length === 0))}
      >
        <Plus />
        {t("wizard.contacts.add")}
      </Button>
    </div>
  );
}
