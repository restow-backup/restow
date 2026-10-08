import { ArrowLeft, LifeBuoy, MailCheck } from "lucide-react";
import * as React from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { z } from "zod";

import { Field, messageId } from "@/components/forms/field";
import { CopyButton } from "@/components/kit";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { authClient } from "@/lib/auth-client";
import { zodResolver } from "@/lib/form";

/** The command an owner runs on the server when nobody else can reset their access (README). */
export function adminRecoverCommand(email: string): string {
  return `docker compose exec api restow admin recover --email ${email}`;
}

const emailSchema = z.object({ email: z.string().trim().email() });

/**
 * "Forgot your password or lost access?" on the login page. Where the
 * installation can mail (`passwordReset` of the setup state, apps/api
 * lib/password-reset.ts) it asks for the address and sends a link to choose a
 * new password; the answer is the same whether the address has an account.
 * Below it, always, the ways back in when the authenticator app or passkey is
 * gone too: an owner resets the access under Members, a tenant's
 * administrator helps a tenant's user, and an owner without another owner
 * recovers on the server's command line.
 */
export function ForgotAccess({
  mailReset,
  onBack,
}: {
  /** The installation offers the reset by mail. */
  mailReset: boolean;
  onBack: () => void;
}) {
  const { t } = useTranslation("auth");
  const { t: tc } = useTranslation();
  const [sent, setSent] = React.useState(false);
  const [errorKey, setErrorKey] = React.useState<string | null>(null);
  const command = adminRecoverCommand(t("login.forgot.commandEmail"));
  const form = useForm<{ email: string }>({
    resolver: zodResolver(emailSchema),
    defaultValues: { email: "" },
  });

  const submit = form.handleSubmit(async ({ email }) => {
    setErrorKey(null);
    const result = await authClient.requestPasswordReset({ email });
    if (result.error) {
      // Rate limits and outages only; an unknown address is answered like a known one.
      setErrorKey(result.error.status === 429 ? "login.error.locked" : "login.error.generic");
      return;
    }
    setSent(true);
  });

  return (
    <div className="space-y-5" data-slot="forgot-access">
      <div className="space-y-1">
        <h2 className="text-sm font-medium">{t("login.forgot.title")}</h2>
      </div>

      {mailReset ? (
        sent ? (
          <Alert variant="info" data-slot="forgot-sent">
            <MailCheck />
            <AlertDescription className="space-y-2">
              <p>{t("login.forgot.sent")}</p>
              <p>{t("login.forgot.authenticatorStays")}</p>
            </AlertDescription>
          </Alert>
        ) : (
          <form onSubmit={submit} className="space-y-3" noValidate data-slot="forgot-form">
            <p className="text-xs text-muted-foreground">{t("login.forgot.mailLead")}</p>
            {errorKey ? (
              <Alert variant="destructive">
                <AlertDescription>{t(errorKey)}</AlertDescription>
              </Alert>
            ) : null}
            <Field
              id="forgot-email"
              label={t("login.emergency.email.label")}
              error={form.formState.errors.email ? tc("validation.email") : undefined}
            >
              <Input
                id="forgot-email"
                type="email"
                autoComplete="username"
                autoFocus
                aria-invalid={form.formState.errors.email !== undefined}
                aria-describedby={messageId("forgot-email")}
                {...form.register("email")}
              />
            </Field>
            <Button type="submit" className="w-full" loading={form.formState.isSubmitting}>
              {form.formState.isSubmitting
                ? t("login.forgot.submitting")
                : t("login.forgot.submit")}
            </Button>
          </form>
        )
      ) : (
        <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
          {t("login.forgot.noMail")}
        </p>
      )}

      <div className="space-y-2 text-xs text-muted-foreground" data-slot="forgot-lost">
        <p className="flex items-center gap-1.5 text-sm font-medium text-foreground">
          <LifeBuoy className="size-4" aria-hidden="true" />
          {t("login.forgot.lostTitle")}
        </p>
        <p>{t("login.forgot.lostOwner")}</p>
        <p>{t("login.forgot.lostTenant")}</p>
        <p>{t("login.forgot.lostCli")}</p>
        <div className="flex items-center gap-2 rounded-md bg-muted px-2 py-1.5">
          <code className="min-w-0 flex-1 overflow-x-auto font-mono text-[11px] whitespace-nowrap">
            {command}
          </code>
          <CopyButton value={command} />
        </div>
      </div>

      <Button type="button" variant="ghost" size="sm" onClick={onBack}>
        <ArrowLeft />
        {t("login.forgot.back")}
      </Button>
    </div>
  );
}
