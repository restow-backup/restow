import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { KeyRound, LifeBuoy, ShieldCheck, Sparkles } from "lucide-react";
import * as React from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { z } from "zod";

import { Field, messageId } from "@/components/forms/field";
import { PasswordInput } from "@/components/forms/password-input";
import { AuthLayout } from "@/components/layout/auth-layout";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { queryKeys } from "@/lib/api";
import { authClient, browserSupportsPasskeys, needsSecondFactor } from "@/lib/auth-client";
import { HOME_PATH, safeRedirectTarget } from "@/lib/entry";
import { zodResolver } from "@/lib/form";
import { holdPasswordForEnrolment } from "@/lib/password-handoff";
import {
  type DemoCredentials,
  MICROSOFT_PROVIDER,
  type SignInPhase,
  demoCredentialsOf,
  loginReturnPath,
  microsoftErrorKey,
  signInErrorKey,
} from "@/lib/sign-in";
import { ForgotAccess } from "@/routes/forgot-access";
import { setupStateQueryOptions } from "@/routes/tree";

const credentialsSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1),
});

const totpSchema = z.object({
  code: z
    .string()
    .transform((value) => value.replace(/\s+/g, ""))
    .pipe(z.string().regex(/^\d{6}$/)),
});

/** Recovery codes look like `abcde-12345`; case and spacing are forgiven. */
const backupCodeSchema = z.object({
  code: z
    .string()
    .transform((value) => value.trim().replace(/\s+/g, ""))
    .pipe(z.string().regex(/^[A-Za-z0-9]{5}-?[A-Za-z0-9]{5}$/)),
});

type CredentialsValues = z.infer<typeof credentialsSchema>;
type CodeValues = { code: string };

/**
 * The public demo's account, shown and offered as a one-click sign-in
 * (deploy/demo/README.md). Credentials are intentionally visible: a public
 * demo has no secret to keep, only a public URL and synthetic data.
 */
function DemoSignIn({
  demo,
  busy,
  onSignedIn,
}: {
  demo: DemoCredentials;
  busy: boolean;
  onSignedIn: () => Promise<void>;
}) {
  const { t } = useTranslation("auth");
  const [pending, setPending] = React.useState(false);
  const [errorKey, setErrorKey] = React.useState<string | null>(null);

  const handleClick = async () => {
    setErrorKey(null);
    setPending(true);
    try {
      const result = await authClient.signIn.email(demo);
      if (result.error) {
        setErrorKey(signInErrorKey(result.error, "password"));
        return;
      }
      await onSignedIn();
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="space-y-3 rounded-lg border border-dashed border-primary/40 bg-primary/5 p-4">
      <div className="flex items-start gap-2">
        <Sparkles className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
        <div className="space-y-1">
          <p className="text-sm font-semibold">{t("demo.panel.title")}</p>
          <p className="text-xs text-muted-foreground">{t("demo.panel.description")}</p>
        </div>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-xs">
        <dt className="text-muted-foreground">{t("demo.panel.emailLabel")}</dt>
        <dd className="font-mono">{demo.email}</dd>
        <dt className="text-muted-foreground">{t("demo.panel.passwordLabel")}</dt>
        <dd className="font-mono">{demo.password}</dd>
      </dl>
      {errorKey ? (
        <Alert variant="destructive">
          <AlertDescription>{t(errorKey)}</AlertDescription>
        </Alert>
      ) : null}
      <Button
        type="button"
        className="w-full"
        onClick={() => void handleClick()}
        loading={pending}
        disabled={busy && !pending}
      >
        {pending ? t("demo.panel.submitting") : t("demo.panel.submit")}
      </Button>
    </div>
  );
}

/**
 * Login: passkey is the primary path for operators, offered only when the
 * deployment reports `passkeyReady` and the browser supports WebAuthn. The
 * Microsoft button appears only when the installation reports `microsoftSignIn`,
 * which the API does only with the experimental switch on
 * (RESTOW_EXPERIMENTAL_MICROSOFT_SIGN_IN): nothing in this release links an
 * account to a Microsoft identity yet, so by default there is no button. The
 * emergency email + password form is always available (docs/ARCHITECTURE.md,
 * security section); accounts with an enrolled authenticator get the TOTP step
 * afterwards (or a recovery code), accounts without one are sent to enrol it
 * right after signing in.
 */
export function LoginPage() {
  const { t } = useTranslation("auth");
  const { t: tc } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const search = useSearch({ strict: false }) as { redirect?: string; error?: string };
  const target = safeRedirectTarget(search.redirect);

  const { data: setupState } = useQuery(setupStateQueryOptions);
  const passkeyReady = setupState?.passkeyReady.ready ?? false;
  const microsoftSignIn = setupState?.microsoftSignIn ?? false;
  const passkeySupported = browserSupportsPasskeys();
  const demoCredentials = demoCredentialsOf(setupState?.demo);

  const [phase, setPhase] = React.useState<SignInPhase>("password");
  const [errorKey, setErrorKey] = React.useState<string | null>(() =>
    search.error ? microsoftErrorKey(search.error) : null,
  );
  const [passkeyPending, setPasskeyPending] = React.useState(false);
  const [forgot, setForgot] = React.useState(false);
  const [microsoftPending, setMicrosoftPending] = React.useState(false);

  const credentials = useForm<CredentialsValues>({
    resolver: zodResolver(credentialsSchema),
    defaultValues: { email: "", password: "" },
  });
  const totp = useForm<CodeValues>({
    resolver: zodResolver(totpSchema),
    defaultValues: { code: "" },
  });
  const backupCode = useForm<CodeValues>({
    resolver: zodResolver(backupCodeSchema),
    defaultValues: { code: "" },
  });

  const finishSignIn = React.useCallback(async () => {
    // The guard re-reads the session; drop whatever the cache held before.
    queryClient.removeQueries({ queryKey: queryKeys.authSession });
    queryClient.removeQueries({ queryKey: queryKeys.me });
    await navigate({ to: target ?? HOME_PATH, replace: true });
  }, [navigate, queryClient, target]);

  const handlePasskey = async () => {
    setErrorKey(null);
    setPasskeyPending(true);
    try {
      const result = await authClient.signIn.passkey();
      if (result.error) {
        setErrorKey(signInErrorKey(result.error, "passkey"));
        return;
      }
      await finishSignIn();
    } finally {
      setPasskeyPending(false);
    }
  };

  const handleMicrosoft = async () => {
    setErrorKey(null);
    setMicrosoftPending(true);
    const result = await authClient.signIn.social({
      provider: MICROSOFT_PROVIDER,
      callbackURL: target ?? HOME_PATH,
      errorCallbackURL: loginReturnPath(target),
    });
    // On success the browser is already on its way to Microsoft.
    if (result.error) {
      setErrorKey(signInErrorKey(result.error, "microsoft"));
      setMicrosoftPending(false);
    }
  };

  const submitCredentials = credentials.handleSubmit(async (values) => {
    setErrorKey(null);
    const result = await authClient.signIn.email({
      email: values.email,
      password: values.password,
    });
    if (result.error) {
      setErrorKey(signInErrorKey(result.error, "password"));
      return;
    }
    if (needsSecondFactor(result.data)) {
      setPhase("totp");
      return;
    }
    // No authenticator app yet: the enrolment right after starts with this
    // password instead of asking for it again (lib/password-handoff.ts).
    if (!setupState?.demo.enabled) {
      holdPasswordForEnrolment(values.password);
    }
    await finishSignIn();
  });

  const submitTotp = totp.handleSubmit(async (values) => {
    setErrorKey(null);
    const result = await authClient.twoFactor.verifyTotp({ code: values.code });
    if (result.error) {
      setErrorKey(signInErrorKey(result.error, "totp"));
      return;
    }
    await finishSignIn();
  });

  const submitBackupCode = backupCode.handleSubmit(async (values) => {
    setErrorKey(null);
    const result = await authClient.twoFactor.verifyBackupCode({ code: values.code });
    if (result.error) {
      setErrorKey(signInErrorKey(result.error, "backupCode"));
      return;
    }
    await finishSignIn();
  });

  const switchPhase = (next: SignInPhase) => {
    setPhase(next);
    setErrorKey(null);
    totp.reset();
    backupCode.reset();
  };

  const credentialErrors = credentials.formState.errors;
  const submittingCredentials = credentials.formState.isSubmitting;
  const submittingCode = totp.formState.isSubmitting || backupCode.formState.isSubmitting;
  const busy = submittingCredentials || submittingCode || passkeyPending || microsoftPending;

  return (
    <AuthLayout width="sm">
      <Card>
        <CardHeader className="gap-1">
          <h1 className="text-lg font-semibold tracking-tight">{t("login.title")}</h1>
          <p className="text-sm text-muted-foreground">{t("login.subtitle")}</p>
        </CardHeader>

        <CardContent className="space-y-5">
          {errorKey ? (
            <Alert variant="destructive">
              <AlertDescription>{t(errorKey)}</AlertDescription>
            </Alert>
          ) : null}

          {phase === "password" && forgot ? (
            <ForgotAccess
              mailReset={setupState?.passwordReset === true}
              onBack={() => setForgot(false)}
            />
          ) : phase === "password" ? (
            <>
              {demoCredentials ? (
                <DemoSignIn demo={demoCredentials} busy={busy} onSignedIn={finishSignIn} />
              ) : null}

              {passkeyReady ? (
                <div className="space-y-2">
                  <Button
                    className="w-full"
                    onClick={() => void handlePasskey()}
                    loading={passkeyPending}
                    disabled={!passkeySupported || busy}
                  >
                    {passkeyPending ? null : <KeyRound />}
                    {passkeyPending ? t("login.passkeyPending") : t("login.passkey")}
                  </Button>
                  <p className="text-center text-xs text-muted-foreground">
                    {passkeySupported
                      ? t("login.passkeyHint")
                      : t("login.error.passkeyUnsupported")}
                  </p>
                </div>
              ) : null}

              {microsoftSignIn ? (
                <div className="space-y-2">
                  <Button
                    variant={passkeyReady ? "outline" : "default"}
                    className="w-full"
                    onClick={() => void handleMicrosoft()}
                    loading={microsoftPending}
                    disabled={busy && !microsoftPending}
                  >
                    {microsoftPending ? t("login.microsoftPending") : t("login.microsoft")}
                  </Button>
                  <p className="text-center text-xs text-muted-foreground">
                    {t("login.microsoftHint")}
                  </p>
                </div>
              ) : null}

              {passkeyReady || microsoftSignIn ? (
                <div className="relative flex items-center">
                  <span className="flex-1 border-t border-border" />
                  <span className="px-3 text-xs text-muted-foreground">{t("login.divider")}</span>
                  <span className="flex-1 border-t border-border" />
                </div>
              ) : null}

              {/* With passkeys the password is the emergency path; without them it is the normal one. */}
              <div className="space-y-1">
                <h2 className="text-sm font-medium">
                  {passkeyReady ? t("login.emergency.title") : t("login.password.title")}
                </h2>
                <p className="text-xs text-muted-foreground">
                  {passkeyReady
                    ? t("login.emergency.description")
                    : t("login.password.description")}
                </p>
              </div>
              {passkeyReady ? null : (
                <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
                  {t("login.passkeyUnavailable")}
                </p>
              )}

              <form onSubmit={submitCredentials} className="space-y-3" noValidate>
                <Field
                  id="email"
                  label={t("login.emergency.email.label")}
                  error={credentialErrors.email ? tc("validation.email") : undefined}
                >
                  <Input
                    id="email"
                    type="email"
                    autoComplete="username"
                    placeholder={t("login.emergency.email.placeholder")}
                    aria-invalid={credentialErrors.email !== undefined}
                    aria-describedby={messageId("email")}
                    {...credentials.register("email")}
                  />
                </Field>

                <Field
                  id="password"
                  label={t("login.emergency.password.label")}
                  error={credentialErrors.password ? tc("validation.required") : undefined}
                >
                  <PasswordInput
                    id="password"
                    autoComplete="current-password"
                    placeholder={
                      passkeyReady
                        ? t("login.emergency.password.placeholder")
                        : t("login.password.placeholder")
                    }
                    aria-invalid={credentialErrors.password !== undefined}
                    aria-describedby={messageId("password")}
                    {...credentials.register("password")}
                  />
                </Field>

                <Button
                  type="submit"
                  variant={passkeyReady || microsoftSignIn ? "secondary" : "default"}
                  className="w-full"
                  loading={submittingCredentials}
                  disabled={passkeyPending || microsoftPending}
                >
                  {submittingCredentials
                    ? t("login.emergency.submitting")
                    : t("login.emergency.submit")}
                </Button>
              </form>
              {demoCredentials ? null : (
                <button
                  type="button"
                  className="w-full text-center text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline disabled:pointer-events-none disabled:opacity-50"
                  disabled={busy}
                  onClick={() => {
                    setErrorKey(null);
                    setForgot(true);
                  }}
                >
                  {t("login.forgot.link")}
                </button>
              )}
            </>
          ) : (
            <form
              onSubmit={phase === "totp" ? submitTotp : submitBackupCode}
              className="space-y-4"
              noValidate
            >
              <div className="flex items-start gap-3 rounded-md bg-muted px-3 py-2">
                {phase === "totp" ? (
                  <ShieldCheck
                    className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                ) : (
                  <LifeBuoy
                    className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                )}
                <div className="space-y-0.5">
                  <p className="text-sm font-medium">
                    {phase === "totp"
                      ? t("login.twoFactor.title")
                      : t("login.twoFactor.backupTitle")}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {phase === "totp"
                      ? t("login.twoFactor.description")
                      : t("login.twoFactor.backupDescription")}
                  </p>
                </div>
              </div>

              {phase === "totp" ? (
                <Field
                  id="totp"
                  label={t("login.emergency.totp.label")}
                  error={totp.formState.errors.code ? tc("validation.totp") : undefined}
                  hint={t("login.emergency.totp.hint")}
                >
                  <Input
                    id="totp"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    autoFocus
                    maxLength={7}
                    placeholder={t("login.emergency.totp.placeholder")}
                    aria-invalid={totp.formState.errors.code !== undefined}
                    aria-describedby={messageId("totp")}
                    {...totp.register("code")}
                  />
                </Field>
              ) : (
                <Field
                  id="backup-code"
                  label={t("login.emergency.backupCode.label")}
                  error={
                    backupCode.formState.errors.code
                      ? t("login.emergency.backupCode.invalidFormat")
                      : undefined
                  }
                  hint={t("login.emergency.backupCode.hint")}
                >
                  <Input
                    id="backup-code"
                    autoComplete="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    autoFocus
                    maxLength={16}
                    placeholder={t("login.emergency.backupCode.placeholder")}
                    className="font-mono"
                    aria-invalid={backupCode.formState.errors.code !== undefined}
                    aria-describedby={messageId("backup-code")}
                    {...backupCode.register("code")}
                  />
                </Field>
              )}

              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    switchPhase("password");
                  }}
                >
                  {tc("actions.back")}
                </Button>
                <Button type="submit" className="flex-1" loading={submittingCode}>
                  {t("login.emergency.verify")}
                </Button>
              </div>

              <button
                type="button"
                className="w-full text-center text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline disabled:pointer-events-none disabled:opacity-50"
                disabled={busy}
                onClick={() => switchPhase(phase === "totp" ? "backupCode" : "totp")}
              >
                {phase === "totp" ? t("login.twoFactor.useBackup") : t("login.twoFactor.useApp")}
              </button>
            </form>
          )}
        </CardContent>
      </Card>
    </AuthLayout>
  );
}
