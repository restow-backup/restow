import { useNavigate } from "@tanstack/react-router";
import { CheckCircle2, KeyRound, MailQuestion, MailX, ShieldCheck } from "lucide-react";
import * as React from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";

import { ErrorState } from "@/components/error-state";
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
import { Skeleton } from "@/components/ui/skeleton";
import { LOGIN_PATH } from "@/lib/entry";
import { validationKey, zodResolver } from "@/lib/form";
import { PASSWORD_MIN_LENGTH } from "@/lib/password";

import { type SetPasswordFormValues, setPasswordFormSchema } from "./forms";
import { useRedeemSetPasswordToken, useSetPasswordTokenStatus } from "./hooks";
import { setPasswordError } from "./presenters";
import type { AccountLinkStatus } from "./types";

/**
 * The public page a provisioned person opens: choose a password for the
 * account a tenant admin just created (or reused) for them. No session
 * exists yet — the link's token is the only credential. Once the password is
 * set they sign in normally, where the existing mandatory authenticator
 * enrolment takes over.
 */
export function SetPasswordPage({ token }: { token: string }) {
  const { t } = useTranslation("accounts");

  return (
    <AuthLayout width="sm">
      <h1 className="sr-only">{t("setPassword.pageTitle")}</h1>
      <SetPasswordCard token={token} />
    </AuthLayout>
  );
}

function SetPasswordCard({ token }: { token: string }) {
  const { t } = useTranslation("accounts");
  const query = useSetPasswordTokenStatus(token);
  const redeem = useRedeemSetPasswordToken();
  const [done, setDone] = React.useState(false);

  if (query.isPending) {
    return <SetPasswordSkeleton />;
  }
  if (query.isError) {
    return (
      <Card aria-live="polite">
        <CardContent className="pt-6">
          <ErrorState
            title={t("setPassword.error")}
            error={query.error}
            onRetry={() => void query.refetch()}
            retrying={query.isFetching}
          />
        </CardContent>
      </Card>
    );
  }
  if (done) {
    return <SetPasswordDone />;
  }
  if (query.data.status !== "valid") {
    return <LinkNotUsable status={query.data.status} emailHint={query.data.emailHint} />;
  }
  return (
    <SetPasswordForm
      token={token}
      emailHint={query.data.emailHint}
      redeem={redeem}
      onDone={() => setDone(true)}
    />
  );
}

interface SetPasswordFormProps {
  token: string;
  emailHint: string | null;
  redeem: ReturnType<typeof useRedeemSetPasswordToken>;
  onDone: () => void;
}

function SetPasswordForm({ token, emailHint, redeem, onDone }: SetPasswordFormProps) {
  const { t } = useTranslation("accounts");
  const { t: tc } = useTranslation();
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
    try {
      await redeem.mutateAsync({ token, password: values.password });
      onDone();
    } catch {
      // Shown below via redeem.error.
    }
  });

  return (
    <Card>
      <CardHeader className="flex flex-col items-center text-center">
        <div className="mb-2 flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
          <KeyRound aria-hidden="true" className="size-5" />
        </div>
        <CardTitle className="text-xl">{t("setPassword.title")}</CardTitle>
        <CardDescription>
          {emailHint ? t("setPassword.leadWithEmail", { email: emailHint }) : t("setPassword.lead")}
        </CardDescription>
      </CardHeader>
      <form onSubmit={onSubmit} noValidate>
        <CardContent className="space-y-4">
          {redeem.isError ? (
            <Alert variant="destructive">
              <AlertDescription>
                {t(setPasswordError(redeem.error).key, setPasswordError(redeem.error).values)}
              </AlertDescription>
            </Alert>
          ) : null}
          <Field
            id="new-password"
            label={t("setPassword.password.label")}
            error={message(errors.password)}
          >
            <PasswordInput
              id="new-password"
              autoComplete="new-password"
              autoFocus
              placeholder={t("setPassword.password.placeholder")}
              aria-invalid={errors.password !== undefined}
              aria-describedby={messageId("new-password")}
              {...form.register("password")}
            />
          </Field>
          <PasswordStrength password={password} />
          <Field
            id="confirm-password"
            label={t("setPassword.confirm.label")}
            error={message(errors.confirm)}
          >
            <PasswordInput
              id="confirm-password"
              autoComplete="new-password"
              placeholder={t("setPassword.confirm.placeholder")}
              aria-invalid={errors.confirm !== undefined}
              aria-describedby={messageId("confirm-password")}
              {...form.register("confirm")}
            />
          </Field>
        </CardContent>
        <CardFooter>
          <Button type="submit" className="w-full" loading={form.formState.isSubmitting}>
            {t("setPassword.submit")}
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}

function SetPasswordDone() {
  const { t } = useTranslation("accounts");
  const navigate = useNavigate();
  return (
    <Card>
      <CardHeader className="flex flex-col items-center text-center">
        <div className="mb-2 flex size-12 items-center justify-center rounded-full bg-muted text-foreground">
          <CheckCircle2 aria-hidden="true" className="size-5" />
        </div>
        <CardTitle className="text-xl">{t("setPassword.done.title")}</CardTitle>
        <CardDescription>{t("setPassword.done.description")}</CardDescription>
      </CardHeader>
      <CardFooter>
        <Button className="w-full" onClick={() => void navigate({ to: LOGIN_PATH, replace: true })}>
          <ShieldCheck />
          {t("setPassword.done.signIn")}
        </Button>
      </CardFooter>
    </Card>
  );
}

interface LinkNotUsableProps {
  status: Exclude<AccountLinkStatus, "valid">;
  emailHint: string | null;
}

/** Reused or expired links say so plainly instead of a generic failure. */
function LinkNotUsable({ status, emailHint }: LinkNotUsableProps) {
  const { t } = useTranslation("accounts");
  const navigate = useNavigate();
  const Icon = status === "used" ? MailX : MailQuestion;
  return (
    <Card>
      <CardHeader className="flex flex-col items-center text-center">
        <div className="mb-2 flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <Icon aria-hidden="true" className="size-5" />
        </div>
        <CardTitle className="text-xl">{t(`setPassword.linkStatus.${status}.title`)}</CardTitle>
        <CardDescription>
          {emailHint
            ? t(`setPassword.linkStatus.${status}.descriptionWithEmail`, { email: emailHint })
            : t(`setPassword.linkStatus.${status}.description`)}
        </CardDescription>
      </CardHeader>
      {status === "used" ? (
        // A password was already set with this link: signing in is the one
        // action that could actually help, so it gets a real call to action
        // instead of leaving the person stranded on a dead-end card.
        <CardFooter>
          <Button
            className="w-full"
            onClick={() => void navigate({ to: LOGIN_PATH, replace: true })}
          >
            <ShieldCheck />
            {t("setPassword.done.signIn")}
          </Button>
        </CardFooter>
      ) : null}
    </Card>
  );
}

function SetPasswordSkeleton() {
  const { t } = useTranslation();
  return (
    <Card aria-busy="true">
      <CardHeader className="flex flex-col items-center gap-3">
        <Skeleton className="size-12 rounded-full" />
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-4 w-64" />
      </CardHeader>
      <CardContent className="space-y-3">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </CardContent>
      <span className="sr-only">{t("common:loading.label")}</span>
    </Card>
  );
}
