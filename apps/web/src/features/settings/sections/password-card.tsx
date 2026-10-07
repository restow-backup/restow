import { KeyRound, TriangleAlert } from "lucide-react";
import * as React from "react";
import { Controller, useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";

import { Field, messageId } from "@/components/forms/field";
import { PasswordInput } from "@/components/forms/password-input";
import { PasswordStrength } from "@/components/forms/password-strength";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { toast } from "@/components/ui/sonner";
import { errorMessageKey } from "@/lib/api";
import { zodResolver } from "@/lib/form";
import { PASSWORD_MIN_LENGTH } from "@/lib/password";

import { type ChangePasswordValues, changePasswordSchema, fieldMessageKey } from "../forms";
import { AuthRequestError, useChangePassword } from "../hooks";
import { changePasswordErrorKey } from "../presenters";

/**
 * The own password (better-auth `/change-password`), for accounts that have
 * one: the current password is checked, the new one replaces it at once, and
 * the person may sign every other browser out with it (recommended when the
 * old one may be known to someone else). The authenticator app stays.
 */
export function PasswordCard() {
  const { t } = useTranslation("settings");
  const [open, setOpen] = React.useState(false);
  return (
    <Card data-slot="password-card">
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
        <div className="space-y-1.5">
          <CardTitle>{t("security.password.title")}</CardTitle>
          <CardDescription>{t("security.password.description")}</CardDescription>
        </div>
        <KeyRound className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
      </CardHeader>
      <CardContent>
        <Button variant="outline" onClick={() => setOpen(true)}>
          {t("security.password.change")}
        </Button>
      </CardContent>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("security.password.dialog.title")}</DialogTitle>
            <DialogDescription>{t("security.password.dialog.description")}</DialogDescription>
          </DialogHeader>
          {/* Mounted only while open: every opening starts with empty fields. */}
          {open ? <ChangePasswordForm onDone={() => setOpen(false)} /> : null}
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function ChangePasswordForm({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation("settings");
  const { t: tc } = useTranslation();
  const change = useChangePassword();
  const form = useForm<ChangePasswordValues>({
    resolver: zodResolver(changePasswordSchema),
    defaultValues: { current: "", password: "", confirm: "", revokeOtherSessions: true },
  });
  const errors = form.formState.errors;
  const password = form.watch("password");
  const message = (error: (typeof errors)[keyof ChangePasswordValues]) => {
    const key = fieldMessageKey(error);
    return key ? tc(key, { min: PASSWORD_MIN_LENGTH }) : undefined;
  };

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      await change.mutateAsync({
        currentPassword: values.current,
        newPassword: values.password,
        revokeOtherSessions: values.revokeOtherSessions,
      });
      toast.success(
        values.revokeOtherSessions
          ? t("toasts.passwordChangedOthersSignedOut")
          : t("toasts.passwordChanged"),
      );
      onDone();
    } catch {
      // Shown below from change.error.
    }
  });

  const failure = change.error
    ? change.error instanceof AuthRequestError
      ? tc(changePasswordErrorKey(change.error.detail), { min: PASSWORD_MIN_LENGTH })
      : tc(`common:${errorMessageKey(change.error)}`)
    : null;

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4" data-slot="change-password-form">
      <Field
        id="change-password-current"
        label={t("security.password.current")}
        error={message(errors.current)}
      >
        <PasswordInput
          id="change-password-current"
          autoComplete="current-password"
          autoFocus
          aria-invalid={errors.current !== undefined}
          aria-describedby={messageId("change-password-current")}
          {...form.register("current")}
        />
      </Field>
      <Field
        id="change-password-new"
        label={t("security.password.new")}
        error={message(errors.password)}
      >
        <PasswordInput
          id="change-password-new"
          autoComplete="new-password"
          aria-invalid={errors.password !== undefined}
          aria-describedby={messageId("change-password-new")}
          {...form.register("password")}
        />
      </Field>
      <PasswordStrength password={password} />
      <Field
        id="change-password-confirm"
        label={t("security.password.confirm")}
        error={message(errors.confirm)}
      >
        <PasswordInput
          id="change-password-confirm"
          autoComplete="new-password"
          aria-invalid={errors.confirm !== undefined}
          aria-describedby={messageId("change-password-confirm")}
          {...form.register("confirm")}
        />
      </Field>
      <Controller
        control={form.control}
        name="revokeOtherSessions"
        render={({ field }) => (
          <div className="flex items-start gap-2">
            <Checkbox
              id="change-password-revoke"
              checked={field.value}
              onCheckedChange={(checked) => field.onChange(checked === true)}
            />
            <div className="space-y-0.5">
              <Label htmlFor="change-password-revoke">{t("security.password.revokeOthers")}</Label>
              <p className="text-xs text-muted-foreground">
                {t("security.password.revokeOthersHint")}
              </p>
            </div>
          </div>
        )}
      />
      {failure ? (
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertDescription>{failure}</AlertDescription>
        </Alert>
      ) : null}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone} disabled={change.isPending}>
          {tc("actions.cancel")}
        </Button>
        <Button type="submit" loading={change.isPending}>
          {t("security.password.submit")}
        </Button>
      </DialogFooter>
    </form>
  );
}
