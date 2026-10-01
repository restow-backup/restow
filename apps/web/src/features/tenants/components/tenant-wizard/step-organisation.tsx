import type * as React from "react";
import type { UseFormReturn } from "react-hook-form";
import { useTranslation } from "react-i18next";

import { Field, messageId } from "@/components/forms/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import {
  NAME_MAX_LENGTH,
  type TenantWizardValues,
  WIZARD_LENGTH_LIMITS,
  fieldMessageKey,
} from "../../forms";
import { SLUG_MAX_LENGTH, SLUG_MIN_LENGTH, slugify } from "../../slug";

interface StepProps {
  form: UseFormReturn<TenantWizardValues>;
  /** The slug follows the name until the field is edited by hand. */
  slugEdited: boolean;
  onSlugEdited: (edited: boolean) => void;
}

/** The step's own scalar fields (excludes the array fields of later steps). */
type OrganisationField = Exclude<
  keyof TenantWizardValues,
  "contacts" | "notificationRecipients" | "admins" | "language"
>;

/** Step 1: organisation name, slug, customer number, address and locale. */
export function OrganisationStep({ form, slugEdited, onSlugEdited }: StepProps) {
  const { t } = useTranslation("tenants");
  const { errors } = form.formState;

  const message = (name: OrganisationField) => {
    const key = fieldMessageKey(errors[name]);
    return key ? t(key, WIZARD_LENGTH_LIMITS[name] ?? {}) : undefined;
  };

  const nameField = form.register("name", {
    onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
      if (!slugEdited) {
        form.setValue("slug", slugify(event.target.value), {
          shouldValidate: form.formState.isSubmitted,
        });
      }
    },
  });
  const slugField = form.register("slug", {
    onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
      onSlugEdited(event.target.value.length > 0);
    },
  });
  const language = form.watch("language");

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field
          id="wizard-name"
          label={t("wizard.organisation.name")}
          error={message("name")}
          className="sm:col-span-2"
        >
          <Input
            id="wizard-name"
            autoComplete="organization"
            maxLength={NAME_MAX_LENGTH}
            placeholder={t("wizard.organisation.namePlaceholder")}
            aria-invalid={errors.name !== undefined}
            aria-describedby={messageId("wizard-name")}
            {...nameField}
          />
        </Field>
        <Field
          id="wizard-slug"
          label={t("wizard.organisation.slug")}
          error={message("slug")}
          hint={t("wizard.organisation.slugHint")}
          className="sm:col-span-2"
        >
          <Input
            id="wizard-slug"
            autoComplete="off"
            spellCheck={false}
            maxLength={SLUG_MAX_LENGTH}
            className="font-mono"
            placeholder={t("wizard.organisation.slugPlaceholder")}
            aria-invalid={errors.slug !== undefined}
            aria-describedby={messageId("wizard-slug")}
            {...slugField}
          />
        </Field>
        <Field
          id="wizard-customer-number"
          label={t("wizard.organisation.customerNumber")}
          error={message("customerNumber")}
          hint={t("wizard.organisation.customerNumberHint")}
        >
          <Input
            id="wizard-customer-number"
            autoComplete="off"
            placeholder={t("wizard.organisation.customerNumberPlaceholder")}
            aria-invalid={errors.customerNumber !== undefined}
            aria-describedby={messageId("wizard-customer-number")}
            {...form.register("customerNumber")}
          />
        </Field>
        <Field id="wizard-vat-id" label={t("wizard.organisation.vatId")} error={message("vatId")}>
          <Input
            id="wizard-vat-id"
            autoComplete="off"
            placeholder={t("wizard.organisation.vatIdPlaceholder")}
            aria-invalid={errors.vatId !== undefined}
            aria-describedby={messageId("wizard-vat-id")}
            {...form.register("vatId")}
          />
        </Field>
        <Field
          id="wizard-address-1"
          label={t("wizard.organisation.addressLine1")}
          error={message("addressLine1")}
          className="sm:col-span-2"
        >
          <Input
            id="wizard-address-1"
            autoComplete="address-line1"
            placeholder={t("wizard.organisation.addressLine1Placeholder")}
            aria-invalid={errors.addressLine1 !== undefined}
            aria-describedby={messageId("wizard-address-1")}
            {...form.register("addressLine1")}
          />
        </Field>
        <Field
          id="wizard-address-2"
          label={t("wizard.organisation.addressLine2")}
          error={message("addressLine2")}
          className="sm:col-span-2"
        >
          <Input
            id="wizard-address-2"
            autoComplete="address-line2"
            placeholder={t("wizard.organisation.addressLine2Placeholder")}
            aria-invalid={errors.addressLine2 !== undefined}
            aria-describedby={messageId("wizard-address-2")}
            {...form.register("addressLine2")}
          />
        </Field>
        <Field
          id="wizard-postal-code"
          label={t("wizard.organisation.postalCode")}
          error={message("postalCode")}
        >
          <Input
            id="wizard-postal-code"
            autoComplete="postal-code"
            aria-invalid={errors.postalCode !== undefined}
            aria-describedby={messageId("wizard-postal-code")}
            {...form.register("postalCode")}
          />
        </Field>
        <Field id="wizard-city" label={t("wizard.organisation.city")} error={message("city")}>
          <Input
            id="wizard-city"
            autoComplete="address-level2"
            aria-invalid={errors.city !== undefined}
            aria-describedby={messageId("wizard-city")}
            {...form.register("city")}
          />
        </Field>
        <Field
          id="wizard-country-code"
          label={t("wizard.organisation.countryCode")}
          error={message("countryCode")}
        >
          <Input
            id="wizard-country-code"
            autoComplete="country"
            spellCheck={false}
            maxLength={2}
            className="font-mono uppercase"
            placeholder={t("wizard.organisation.countryCodePlaceholder")}
            aria-invalid={errors.countryCode !== undefined}
            aria-describedby={messageId("wizard-country-code")}
            {...form.register("countryCode")}
          />
        </Field>
        <Field id="wizard-language" label={t("wizard.organisation.language")}>
          <Select
            value={language}
            onValueChange={(next) => form.setValue("language", next === "de" ? "de" : "en")}
          >
            <SelectTrigger id="wizard-language" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="de">{t("common:language.de")}</SelectItem>
              <SelectItem value="en">{t("common:language.en")}</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      </div>
    </div>
  );
}
