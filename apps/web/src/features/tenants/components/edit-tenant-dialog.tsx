import { TriangleAlert } from "lucide-react";
import * as React from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";

import { Field, messageId } from "@/components/forms/field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/sonner";
import { zodResolver } from "@/lib/form";

import {
  type EditTenantValues,
  NAME_MAX_LENGTH,
  editTenantFormFrom,
  editTenantSchema,
  fieldMessageKey,
  toUpdateTenantInput,
} from "../forms";
import { useUpdateTenant } from "../hooks";
import { type Message, genericError } from "../presenters";
import type { TenantDetail } from "../types";

interface EditTenantDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tenant: TenantDetail;
}

/**
 * Rename a tenant and set its mailbox cap. The slug stays: it names the
 * tenant in exports and integrations and must not change underneath them.
 */
export function EditTenantDialog({ open, onOpenChange, tenant }: EditTenantDialogProps) {
  const { t } = useTranslation("tenants");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("edit.title")}</DialogTitle>
          <DialogDescription>{t("edit.description", { slug: tenant.slug })}</DialogDescription>
        </DialogHeader>
        {/* Mounted only while open: every opening starts from the stored values. */}
        <EditTenantForm tenant={tenant} onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function EditTenantForm({ tenant, onDone }: { tenant: TenantDetail; onDone: () => void }) {
  const { t } = useTranslation("tenants");
  const update = useUpdateTenant(tenant.id);
  const [submitError, setSubmitError] = React.useState<Message | null>(null);

  const form = useForm<EditTenantValues>({
    resolver: zodResolver(editTenantSchema),
    defaultValues: editTenantFormFrom(tenant),
  });
  const { errors, isSubmitting } = form.formState;

  const message = (name: keyof EditTenantValues) => {
    const key = fieldMessageKey(errors[name]);
    return key ? t(key, { max: NAME_MAX_LENGTH }) : undefined;
  };

  const onSubmit = form.handleSubmit(async (values) => {
    setSubmitError(null);
    const patch = toUpdateTenantInput(values, tenant);
    if (Object.keys(patch).length === 0) {
      onDone();
      return;
    }
    try {
      await update.mutateAsync(patch);
      toast.success(t("toasts.updated"));
      onDone();
    } catch (error) {
      setSubmitError(genericError(error));
    }
  });

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4">
      <Field id="tenant-edit-name" label={t("edit.name")} error={message("name")}>
        <Input
          id="tenant-edit-name"
          autoComplete="organization"
          maxLength={NAME_MAX_LENGTH}
          aria-invalid={errors.name !== undefined}
          aria-describedby={messageId("tenant-edit-name")}
          {...form.register("name")}
        />
      </Field>
      <Field
        id="tenant-edit-cap"
        label={t("edit.cap")}
        error={message("mailboxCap")}
        hint={t("edit.capHint")}
      >
        <Input
          id="tenant-edit-cap"
          inputMode="numeric"
          autoComplete="off"
          placeholder={t("edit.capPlaceholder")}
          className="sm:max-w-40"
          aria-invalid={errors.mailboxCap !== undefined}
          aria-describedby={messageId("tenant-edit-cap")}
          {...form.register("mailboxCap")}
        />
      </Field>

      {submitError ? (
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertDescription>{t(submitError.key, submitError.values)}</AlertDescription>
        </Alert>
      ) : null}

      <DialogFooter>
        <Button variant="outline" onClick={onDone} disabled={isSubmitting}>
          {t("common:actions.cancel")}
        </Button>
        <Button type="submit" loading={isSubmitting}>
          {t("edit.submit")}
        </Button>
      </DialogFooter>
    </form>
  );
}
