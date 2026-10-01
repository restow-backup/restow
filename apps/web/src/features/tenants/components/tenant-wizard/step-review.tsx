import type * as React from "react";
import type { UseFormReturn } from "react-hook-form";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

import { OFFERED_NOTIFICATION_CATEGORIES, type TenantWizardValues } from "../../forms";

interface StepProps {
  form: UseFormReturn<TenantWizardValues>;
}

/** Step 6: everything entered so far, once more before it is written. */
export function ReviewStep({ form }: StepProps) {
  const { t } = useTranslation("tenants");
  const values = form.watch();
  const address = [
    values.addressLine1,
    values.addressLine2,
    [values.postalCode, values.city].filter((part) => part.trim()).join(" "),
    values.countryCode,
  ]
    .map((part) => part.trim())
    .filter(Boolean)
    .join(", ");

  return (
    <div className="space-y-4">
      <ReviewSection title={t("wizard.review.organisation")}>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          <ReviewRow label={t("wizard.organisation.name")} value={values.name} />
          <ReviewRow label={t("wizard.organisation.slug")} value={values.slug} mono />
          <ReviewRow
            label={t("wizard.organisation.customerNumber")}
            value={values.customerNumber || t("wizard.review.noCustomerNumber")}
          />
          <ReviewRow
            label={t("wizard.organisation.vatId")}
            value={values.vatId || t("wizard.review.noVatId")}
          />
          <ReviewRow
            label={t("wizard.organisation.address")}
            value={address || t("wizard.review.noAddress")}
          />
          <ReviewRow
            label={t("wizard.organisation.language")}
            value={t(`common:language.${values.language}`)}
          />
        </dl>
      </ReviewSection>

      <ReviewSection title={t("wizard.review.contacts")}>
        {values.contacts.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("wizard.review.noneYet")}</p>
        ) : (
          <ul className="space-y-2">
            {values.contacts.map((contact, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: rows have no stable id before creation.
              <li key={index} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-medium">{contact.name || t("wizard.contacts.name")}</span>
                {contact.isPrimary ? (
                  <Badge variant="secondary">{t("wizard.contacts.primary")}</Badge>
                ) : null}
                {contact.role ? (
                  <span className="text-muted-foreground">{contact.role}</span>
                ) : null}
                {contact.email ? (
                  <span className="text-muted-foreground">{contact.email}</span>
                ) : null}
                {contact.phone ? (
                  <span className="text-muted-foreground">{contact.phone}</span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </ReviewSection>

      <ReviewSection title={t("wizard.review.notifications")}>
        {values.notificationRecipients.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("wizard.review.noneYet")}</p>
        ) : (
          <ul className="space-y-2">
            {values.notificationRecipients.map((recipient, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: rows have no stable id before creation.
              <li key={index} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-medium">{recipient.email}</span>
                {recipient.categories.length === 0 ? (
                  <span className="text-muted-foreground">
                    {t("wizard.notifications.noCategories")}
                  </span>
                ) : (
                  OFFERED_NOTIFICATION_CATEGORIES.filter((category) =>
                    recipient.categories.includes(category),
                  ).map((category) => (
                    <Badge key={category} variant="outline">
                      {t(`wizard.notifications.categories.${category}`)}
                    </Badge>
                  ))
                )}
              </li>
            ))}
          </ul>
        )}
      </ReviewSection>

      <ReviewSection title={t("wizard.review.admins")}>
        {values.admins.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("wizard.admins.empty")}</p>
        ) : (
          <ul className="space-y-2">
            {values.admins.map((admin, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: rows have no stable id before creation.
              <li key={index} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-medium">{admin.email}</span>
                <Badge variant="outline">{t(`members.roles.${admin.role}`)}</Badge>
              </li>
            ))}
          </ul>
        )}
      </ReviewSection>
    </div>
  );
}

function ReviewSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card className="gap-3 py-0">
      <CardHeader className="pt-4">
        <CardTitle className="text-sm">{title}</CardTitle>
      </CardHeader>
      <CardContent className="pb-4">{children}</CardContent>
    </Card>
  );
}

function ReviewRow({
  label,
  value,
  mono = false,
}: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="space-y-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={mono ? "font-mono" : undefined}>{value}</dd>
    </div>
  );
}
