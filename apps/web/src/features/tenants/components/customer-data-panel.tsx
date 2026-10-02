import { Pencil, TriangleAlert, UsersRound } from "lucide-react";
import * as React from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";

import { Field, messageId } from "@/components/forms/field";
import { EmptyState } from "@/components/kit";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "@/components/ui/sonner";
import { zodResolver } from "@/lib/form";

import {
  type CustomerDataFormValues,
  type TenantWizardValues,
  WIZARD_LENGTH_LIMITS,
  customerDataFormFrom,
  customerDataFormSchema,
  emptyContact,
  emptyTenantWizardForm,
  fieldMessageKey,
  tenantWizardSchema,
  toUpdateTenantCustomerInput,
  undefinedIfBlank,
} from "../forms";
import { useReplaceTenantContacts, useUpdateTenantCustomer } from "../hooks";
import { type Message, genericError, isCustomerNumberConflict } from "../presenters";
import type { TenantDetail } from "../types";
import { ContactsStep } from "./tenant-wizard/step-contacts";

interface CustomerDataPanelProps {
  tenant: TenantDetail;
  /** No changes while the tenant is being deleted (the API refuses them too). */
  readOnly?: boolean;
}

type DialogName = "customer" | "contacts" | null;

/**
 * Customer data of the tenant wizard, in the master data of the tenant page:
 * customer number, address and locale and contact persons — shown, and
 * (unless the tenant is being deleted, or the viewer may not change them)
 * editable.
 */
export function CustomerDataPanel({ tenant, readOnly = false }: CustomerDataPanelProps) {
  const { t } = useTranslation("tenants");
  const [dialog, setDialog] = React.useState<DialogName>(null);
  const address = [
    tenant.customer.addressLine1,
    tenant.customer.addressLine2,
    [tenant.customer.postalCode, tenant.customer.city].filter(Boolean).join(" "),
    tenant.customer.countryCode,
  ]
    .filter((part) => part && part.length > 0)
    .join(", ");

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 space-y-0">
          <div className="min-w-0 flex-1 space-y-1.5">
            <CardTitle>{t("customerPanel.title")}</CardTitle>
            <CardDescription>{t("customerPanel.description")}</CardDescription>
          </div>
          {readOnly ? null : (
            <Button variant="outline" size="sm" onClick={() => setDialog("customer")}>
              <Pencil />
              {t("customerPanel.edit")}
            </Button>
          )}
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-2">
            <InfoRow
              label={t("customerPanel.customerNumber")}
              value={tenant.customer.customerNumber}
            />
            <InfoRow label={t("customerPanel.vatId")} value={tenant.customer.vatId} />
            <InfoRow label={t("customerPanel.address")} value={address || null} />
            <InfoRow
              label={t("customerPanel.language")}
              value={
                tenant.customer.language ? t(`common:language.${tenant.customer.language}`) : null
              }
            />
            <InfoRow label={t("customerPanel.timeZone")} value={tenant.customer.timeZone} />
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 space-y-0">
          <div className="min-w-0 flex-1 space-y-1.5">
            <CardTitle>{t("customerPanel.contactsTitle")}</CardTitle>
            <CardDescription>{t("customerPanel.contactsDescription")}</CardDescription>
          </div>
          {readOnly ? null : (
            <Button variant="outline" size="sm" onClick={() => setDialog("contacts")}>
              <Pencil />
              {t("customerPanel.editContacts")}
            </Button>
          )}
        </CardHeader>
        <CardContent>
          {tenant.contacts.length === 0 ? (
            <EmptyState
              variant="plain"
              icon={UsersRound}
              title={t("customerPanel.noContacts")}
              actions={
                readOnly ? undefined : (
                  <Button size="sm" onClick={() => setDialog("contacts")}>
                    {t("customerPanel.addContact")}
                  </Button>
                )
              }
            />
          ) : (
            <ul className="space-y-2">
              {tenant.contacts.map((contact) => (
                <li key={contact.id} className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium">{contact.name}</span>
                  {contact.isPrimary ? (
                    <Badge variant="secondary">{t("customerPanel.primaryBadge")}</Badge>
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
        </CardContent>
      </Card>

      <EditCustomerDataDialog
        open={dialog === "customer"}
        onOpenChange={(open) => !open && setDialog(null)}
        tenant={tenant}
      />
      <EditContactsDialog
        open={dialog === "contacts"}
        onOpenChange={(open) => !open && setDialog(null)}
        tenant={tenant}
      />
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string | null }) {
  const { t } = useTranslation("tenants");
  return (
    <div className="space-y-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd>
        {value || <span className="text-muted-foreground">{t("customerPanel.noneSet")}</span>}
      </dd>
    </div>
  );
}

// --- Edit customer data ----------------------------------------------------------

function EditCustomerDataDialog({
  open,
  onOpenChange,
  tenant,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tenant: TenantDetail;
}) {
  const { t, i18n } = useTranslation("tenants");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("customerPanel.edit")}</DialogTitle>
          <DialogDescription>{t("wizard.organisation.description")}</DialogDescription>
        </DialogHeader>
        {open ? (
          <CustomerDataForm
            tenant={tenant}
            language={i18n.language.startsWith("de") ? "de" : "en"}
            onDone={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function CustomerDataForm({
  tenant,
  language,
  onDone,
}: {
  tenant: TenantDetail;
  language: "de" | "en";
  onDone: () => void;
}) {
  const { t } = useTranslation("tenants");
  const update = useUpdateTenantCustomer(tenant.id);
  const [submitError, setSubmitError] = React.useState<Message | null>(null);
  const form = useForm<CustomerDataFormValues>({
    resolver: zodResolver(customerDataFormSchema),
    defaultValues: customerDataFormFrom(tenant.customer, language),
  });
  const { errors, isSubmitting } = form.formState;

  const message = (name: keyof CustomerDataFormValues) => {
    const key = fieldMessageKey(errors[name]);
    return key ? t(key, WIZARD_LENGTH_LIMITS[name] ?? {}) : undefined;
  };

  const onSubmit = form.handleSubmit(async (values) => {
    setSubmitError(null);
    const patch = toUpdateTenantCustomerInput(
      values,
      tenant.customer,
      form.formState.dirtyFields.language === true,
    );
    if (Object.keys(patch).length === 0) {
      onDone();
      return;
    }
    try {
      await update.mutateAsync(patch);
      toast.success(t("customerPanel.saved"));
      onDone();
    } catch (error) {
      if (isCustomerNumberConflict(error)) {
        form.setError("customerNumber", { message: "customerNumberTaken" }, { shouldFocus: true });
      } else {
        setSubmitError(genericError(error));
      }
    }
  });

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field
          id="edit-customer-number"
          label={t("wizard.organisation.customerNumber")}
          error={message("customerNumber")}
        >
          <Input
            id="edit-customer-number"
            aria-invalid={errors.customerNumber !== undefined}
            aria-describedby={messageId("edit-customer-number")}
            {...form.register("customerNumber")}
          />
        </Field>
        <Field id="edit-vat-id" label={t("wizard.organisation.vatId")} error={message("vatId")}>
          <Input
            id="edit-vat-id"
            aria-invalid={errors.vatId !== undefined}
            aria-describedby={messageId("edit-vat-id")}
            {...form.register("vatId")}
          />
        </Field>
        <Field
          id="edit-address-1"
          label={t("wizard.organisation.addressLine1")}
          error={message("addressLine1")}
          className="sm:col-span-2"
        >
          <Input
            id="edit-address-1"
            aria-invalid={errors.addressLine1 !== undefined}
            aria-describedby={messageId("edit-address-1")}
            {...form.register("addressLine1")}
          />
        </Field>
        <Field
          id="edit-address-2"
          label={t("wizard.organisation.addressLine2")}
          error={message("addressLine2")}
          className="sm:col-span-2"
        >
          <Input
            id="edit-address-2"
            aria-invalid={errors.addressLine2 !== undefined}
            aria-describedby={messageId("edit-address-2")}
            {...form.register("addressLine2")}
          />
        </Field>
        <Field
          id="edit-postal-code"
          label={t("wizard.organisation.postalCode")}
          error={message("postalCode")}
        >
          <Input
            id="edit-postal-code"
            aria-invalid={errors.postalCode !== undefined}
            aria-describedby={messageId("edit-postal-code")}
            {...form.register("postalCode")}
          />
        </Field>
        <Field id="edit-city" label={t("wizard.organisation.city")} error={message("city")}>
          <Input
            id="edit-city"
            aria-invalid={errors.city !== undefined}
            aria-describedby={messageId("edit-city")}
            {...form.register("city")}
          />
        </Field>
        <Field
          id="edit-country-code"
          label={t("wizard.organisation.countryCode")}
          error={message("countryCode")}
        >
          <Input
            id="edit-country-code"
            maxLength={2}
            className="font-mono uppercase"
            aria-invalid={errors.countryCode !== undefined}
            aria-describedby={messageId("edit-country-code")}
            {...form.register("countryCode")}
          />
        </Field>
        <Field id="edit-language" label={t("wizard.organisation.language")}>
          <Select
            value={form.watch("language")}
            onValueChange={(next) =>
              form.setValue("language", next === "de" ? "de" : "en", { shouldDirty: true })
            }
          >
            <SelectTrigger id="edit-language" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="de">{t("common:language.de")}</SelectItem>
              <SelectItem value="en">{t("common:language.en")}</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field
          id="edit-time-zone"
          label={t("wizard.organisation.timeZone")}
          error={message("timeZone")}
          className="sm:col-span-2"
        >
          <Input
            id="edit-time-zone"
            className="font-mono"
            aria-invalid={errors.timeZone !== undefined}
            aria-describedby={messageId("edit-time-zone")}
            {...form.register("timeZone")}
          />
        </Field>
      </div>

      {submitError ? (
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertDescription>{t(submitError.key, submitError.values)}</AlertDescription>
        </Alert>
      ) : null}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone} disabled={isSubmitting}>
          {t("common:actions.cancel")}
        </Button>
        <Button type="submit" loading={isSubmitting}>
          {t("edit.submit")}
        </Button>
      </DialogFooter>
    </form>
  );
}

// --- Edit contacts / notification recipients --------------------------------------
//
// Both dialogs reuse the wizard's own step components: a full
// `TenantWizardValues` form is created with placeholder values for every
// field but the one being edited, and only that field is validated and read
// back on submit, so this stays a thin wrapper instead of a second copy of
// the repeatable-row UI.

function EditContactsDialog({
  open,
  onOpenChange,
  tenant,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tenant: TenantDetail;
}) {
  const { t } = useTranslation("tenants");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("customerPanel.editContacts")}</DialogTitle>
          <DialogDescription>{t("wizard.contacts.description")}</DialogDescription>
        </DialogHeader>
        {open ? <ContactsForm tenant={tenant} onDone={() => onOpenChange(false)} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function ContactsForm({ tenant, onDone }: { tenant: TenantDetail; onDone: () => void }) {
  const { t } = useTranslation("tenants");
  const replace = useReplaceTenantContacts(tenant.id);
  const [submitError, setSubmitError] = React.useState<Message | null>(null);
  const form = useForm<TenantWizardValues>({
    resolver: zodResolver(tenantWizardSchema),
    defaultValues: {
      ...emptyTenantWizardForm("en"),
      // A tenant with no contacts yet (every tenant created before this
      // release, or through the API without contacts) starts from one blank,
      // already-primary row instead of an empty list: the dialog's "Add a
      // contact" button then adds something to save, and the one contact
      // that exists already satisfies "exactly one primary".
      contacts:
        tenant.contacts.length > 0
          ? tenant.contacts.map((contact) => ({
              name: contact.name,
              role: contact.role ?? "",
              email: contact.email ?? "",
              phone: contact.phone ?? "",
              isPrimary: contact.isPrimary,
            }))
          : [emptyContact(true)],
    },
  });
  const { isSubmitting } = form.formState;

  async function onSubmit() {
    setSubmitError(null);
    const ok = await form.trigger("contacts");
    if (!ok) {
      return;
    }
    try {
      await replace.mutateAsync(
        form.getValues("contacts").map((contact) => ({
          name: contact.name.trim(),
          role: undefinedIfBlank(contact.role),
          email: undefinedIfBlank(contact.email),
          phone: undefinedIfBlank(contact.phone),
          isPrimary: contact.isPrimary,
        })),
      );
      toast.success(t("customerPanel.contactsSaved"));
      onDone();
    } catch (error) {
      setSubmitError(genericError(error));
    }
  }

  return (
    <div className="space-y-4">
      <ContactsStep form={form} />
      {submitError ? (
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertDescription>{t(submitError.key, submitError.values)}</AlertDescription>
        </Alert>
      ) : null}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone} disabled={isSubmitting}>
          {t("common:actions.cancel")}
        </Button>
        <Button
          type="button"
          loading={isSubmitting || replace.isPending}
          onClick={() => void onSubmit()}
        >
          {t("edit.submit")}
        </Button>
      </DialogFooter>
    </div>
  );
}
