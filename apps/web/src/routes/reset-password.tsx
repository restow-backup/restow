import { useNavigate, useSearch } from "@tanstack/react-router";
import { CheckCircle2, KeyRound, MailQuestion, ShieldCheck } from "lucide-react";
import * as React from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";

import { Field, messageId } from "@/components/forms/field";
import { PasswordInput } from "@/components/forms/password-input";
import { PasswordStrength } from "@/components/forms/password-strength";
import { AuthLayout } from "@/components/layout/auth-layout";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { type SetPasswordFormValues, setPasswordFormSchema } from "@/features/accounts/forms";
import { authClient } from "@/lib/auth-client";
import { LOGIN_PATH } from "@/lib/entry";
import { validationKey, zodResolver } from "@/lib/form";
import { PASSWORD_MIN_LENGTH } from "@/lib/password";

/** What a failed reset says: the link is unusable, too many attempts, or something else. */
export type ResetFailure = "invalidLink" | "tooMany" | "generic";

/** Map better-auth's answer to `/reset-password` onto what the page shows. */
export function resetFailureOf(error: { status: number; code?: string } | null): ResetFailure {
  if (!error) {
    return "generic";
  }
  if (error.code === "INVALID_TOKEN" || error.code === "USER_NOT_FOUND") {
    return "invalidLink";
  }
  return error.status === 429 ? "tooMany" : "generic";
}

/**
 * The page the link of a reset mail opens (`/reset-password?token=…`,
 * apps/api lib/password-reset.ts): choose a new password. better-auth checks
 * the token, ends every session of the account, and the person signs in again
 * with the new password and a code from the authenticator app, which stays.
 */
export function ResetPasswordPage() {
  const { t } = useTranslation("auth");
  const search = useSearch({ strict: false }) as { token?: string };
  const token = search.token?.trim() ?? "";
  const [state, setState] = React.useState<"form" | "done" | "invalid">(
    token === "" ? "invalid" : "form",
  );

  return (
    <AuthLayout width="sm">
      <h1 className="sr-only">{t("passwordReset.page.title")}</h1>
      {state === "done" ? (
        <ResultCard
          icon={CheckCircle2}
          title={t("passwordReset.page.doneTitle")}
          description={t("passwordReset.page.doneDescription")}
        />
      ) : state === "invalid" ? (
        <ResultCard
          icon={MailQuestion}
          title={t("passwordReset.page.invalidTitle")}
          description={t("passwordReset.page.invalidDescription")}
        />
      ) : (
        <ResetForm
          token={token}
          onDone={() => setState("done")}
          onInvalid={() => setState("invalid")}
        />
      )}
    </AuthLayout>
  );
}

function ResetForm({
  token,
  onDone,
  onInvalid,
}: {
  token: string;
  onDone: () => void;
  onInvalid: () => void;
}) {
  const { t } = useTranslation("auth");
  const { t: tc } = useTranslation();
  const [failure, setFailure] = React.useState<ResetFailure | null>(null);
  const form = useForm<SetPasswordFormValues>({
    resolver: zodResolver(setPasswordFormSchema),
    defaultValues: { password: "", confirm: "" },
  });
  const password = form.watch("password");
  const errors = form.formState.errors;
  const message = (error: Parameters<typeof validationKey>[0]) => {
    const key = validationKey(error);
    return key ? tc(key, { min: PASSWORD_MIN_LENGTH }) : undefined;
  };

  const onSubmit = form.handleSubmit(async (values) => {
    setFailure(null);
    const result = await authClient.resetPassword({ newPassword: values.password, token });
    if (result.error) {
      const reason = resetFailureOf(result.error);
      if (reason === "invalidLink") {
        onInvalid();
        return;
      }
      setFailure(reason);
      return;
    }
    onDone();
  });

  return (
    <Card>
      <CardHeader className="flex flex-col items-center text-center">
        <div className="mb-2 flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
          <KeyRound aria-hidden="true" className="size-5" />
        </div>
        <CardTitle className="text-xl">{t("passwordReset.page.title")}</CardTitle>
        <CardDescription>{t("passwordReset.page.lead")}</CardDescription>
      </CardHeader>
      <form onSubmit={onSubmit} noValidate data-slot="reset-password-form">
        <CardContent className="space-y-4">
          {failure ? (
            <Alert variant="destructive">
              <AlertDescription>
                {failure === "tooMany" ? t("passwordReset.page.tooMany") : t("login.error.generic")}
              </AlertDescription>
            </Alert>
          ) : null}
          <Field
            id="reset-password"
            label={t("passwordReset.page.password")}
            error={message(errors.password)}
          >
            <PasswordInput
              id="reset-password"
              autoComplete="new-password"
              autoFocus
              aria-invalid={errors.password !== undefined}
              aria-describedby={messageId("reset-password")}
              {...form.register("password")}
            />
          </Field>
          <PasswordStrength password={password} />
          <Field
            id="reset-password-confirm"
            label={t("passwordReset.page.confirm")}
            error={message(errors.confirm)}
          >
            <PasswordInput
              id="reset-password-confirm"
              autoComplete="new-password"
              aria-invalid={errors.confirm !== undefined}
              aria-describedby={messageId("reset-password-confirm")}
              {...form.register("confirm")}
            />
          </Field>
        </CardContent>
        <CardFooter>
          <Button type="submit" className="w-full" loading={form.formState.isSubmitting}>
            {t("passwordReset.page.submit")}
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}

function ResultCard({
  icon: Icon,
  title,
  description,
}: {
  icon: typeof CheckCircle2;
  title: string;
  description: string;
}) {
  const { t } = useTranslation("auth");
  const navigate = useNavigate();
  return (
    <Card data-slot="reset-password-result">
      <CardHeader className="flex flex-col items-center text-center">
        <div className="mb-2 flex size-12 items-center justify-center rounded-full bg-muted text-foreground">
          <Icon aria-hidden="true" className="size-5" />
        </div>
        <CardTitle className="text-xl">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardFooter>
        <Button className="w-full" onClick={() => void navigate({ to: LOGIN_PATH, replace: true })}>
          <ShieldCheck />
          {t("passwordReset.page.signIn")}
        </Button>
      </CardFooter>
    </Card>
  );
}
