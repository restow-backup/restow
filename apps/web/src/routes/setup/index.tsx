import { DEFAULT_PRODUCT_NAME } from "@restow/i18n";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import * as React from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";

import { ErrorState } from "@/components/error-state";
import { AuthLayout } from "@/components/layout/auth-layout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "@/components/ui/sonner";
import { SETTINGS_NAMESPACE } from "@/features/settings/i18n";
import { mailTestFailureKey } from "@/features/settings/presenters";
import { activeLanguage, i18n as appI18n, chooseLanguage, setupLanguageSuggestion } from "@/i18n";
import {
  ApiError,
  DISCLAIMER_REQUIRED_PROBLEM,
  DISCLAIMER_VERSION_PROBLEM,
  SETUP_TOKEN_PROBLEM,
  type SetupResult,
  type SetupState,
  type SetupSubmission,
  queryKeys,
  setupStateQueryOptions,
  submitSetup,
  verifySetupToken,
} from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { HOME_PATH, LOGIN_PATH } from "@/lib/entry";
import { zodResolver } from "@/lib/form";
import { holdPasswordForEnrolment } from "@/lib/password-handoff";
import { PasskeyReadiness } from "@/routes/setup/passkey-readiness";
import {
  SETUP_LANGUAGES,
  STEP_FIELDS,
  STEP_KEYS,
  type SetupFormValues,
  type SetupLanguage,
  type StepKey,
  buildSubmission,
  defaultSetupValues,
  setupFormSchema,
} from "@/routes/setup/schema";
import { Stepper, shownSteps } from "@/routes/setup/stepper";
import { AdminStep } from "@/routes/setup/steps/admin-step";
import { DisclaimerStep, type DisclaimerStepError } from "@/routes/setup/steps/disclaimer-step";
import { LanguageStep } from "@/routes/setup/steps/language-step";
import { MailStep } from "@/routes/setup/steps/mail-step";
import { ModeStep } from "@/routes/setup/steps/mode-step";
import { ReviewStep } from "@/routes/setup/steps/review-step";
import { TokenStep, type TokenStepError } from "@/routes/setup/steps/token-step";

type Phase = "editing" | "submitting" | "signingIn";

/** Problem types POST /api/v1/setup answers with that the wizard handles itself. */
const PROBLEM = {
  alreadyConfigured: "urn:restow:problem:already-configured",
  emailInUse: "urn:restow:problem:email-in-use",
  administratorExists: "urn:restow:problem:administrator-exists",
  configurationIncomplete: "urn:restow:problem:configuration-incomplete",
} as const;

function problemType(error: unknown): string | null {
  return error instanceof ApiError ? (error.problem?.type ?? null) : null;
}

/** Names of the missing server settings a `configuration-incomplete` problem lists. */
function missingSettings(error: unknown): string[] {
  const missing = error instanceof ApiError ? error.problem?.missing : undefined;
  return Array.isArray(missing) ? missing.filter((name) => typeof name === "string") : [];
}

/** The wizard's language is the app's current one, when the wizard offers it. */
function setupLanguageOf(language: string | undefined): SetupLanguage {
  return SETUP_LANGUAGES.find((candidate) => candidate === language) ?? "en";
}

/**
 * First-run setup wizard: the language, the setup token, the operator notice,
 * operating mode, first admin account, mail transport (which can be skipped)
 * and a review step (docs/ARCHITECTURE.md, setup and operating modes). On
 * success the new admin is signed in right away and lands on the dashboard.
 */
export function SetupPage() {
  const { t } = useTranslation("setup");
  const { t: tc, i18n } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data: setupState } = useQuery(setupStateQueryOptions);
  const disclaimer = setupState?.disclaimer ?? { version: "", accepted: false };
  const tokenSource = setupState?.setupToken?.source ?? null;
  const tokenRequired = setupState?.setupToken?.required ?? true;

  // The language is the wizard's first step, the demo's included. The steps that
  // do not apply (no setup token to ask for in the demo, a notice that counts as
  // accepted there) are passed over, forwards and backwards.
  const [stepIndex, setStepIndex] = React.useState(0);
  const language = setupLanguageOf(i18n.resolvedLanguage ?? i18n.language);
  const [setupToken, setSetupToken] = React.useState("");
  const [tokenError, setTokenError] = React.useState<TokenStepError | null>(null);
  const [noticeChecked, setNoticeChecked] = React.useState(false);
  const [noticeError, setNoticeError] = React.useState<DisclaimerStepError | null>(null);
  const [phase, setPhase] = React.useState<Phase>("editing");
  const [serverReadiness, setServerReadiness] = React.useState<SetupResult["passkeyReady"] | null>(
    null,
  );

  const form = useForm<SetupFormValues>({
    resolver: zodResolver(setupFormSchema),
    defaultValues: defaultSetupValues,
    mode: "onTouched",
  });

  // The wizard starts in the browser's language (or the one the visitor chose before):
  // the preselected card, and the language of every text from the first one on.
  React.useEffect(() => {
    const suggestion = setupLanguageSuggestion();
    if (suggestion !== activeLanguage()) {
      void appI18n.changeLanguage(suggestion);
    }
  }, []);

  const currentKey = STEP_KEYS[stepIndex] ?? "language";
  const totalSteps = STEP_KEYS.length;
  const stepApplies = (key: StepKey) =>
    key === "token" ? tokenRequired : key === "disclaimer" ? !disclaimer.accepted : true;
  const stepFrom = (from: number, direction: 1 | -1) => {
    let index = from + direction;
    while (index > 0 && index < totalSteps - 1 && !stepApplies(STEP_KEYS[index] ?? "review")) {
      index += direction;
    }
    return Math.min(Math.max(index, 0), totalSteps - 1);
  };
  const next = () => setStepIndex((index) => stepFrom(index, 1));
  // Only the steps that apply are shown and counted ("Step 2 of 5", not "3 of 7").
  const steps = shownSteps(stepApplies, stepIndex);
  const stepPosition = Math.max(
    0,
    steps.findIndex((step) => step.index === stepIndex),
  );

  const leaveConfigured = async () => {
    toast.info(t("result.alreadyConfigured"));
    await queryClient.invalidateQueries({ queryKey: queryKeys.setupState });
    await navigate({ to: HOME_PATH, replace: true });
  };

  const mutation = useMutation({
    mutationFn: (submission: SetupSubmission) => submitSetup(submission, setupToken),
    onMutate: () => setPhase("submitting"),
    onSuccess: async (result, submission) => {
      setServerReadiness(result.passkeyReady);
      queryClient.setQueryData<SetupState>(queryKeys.setupState, (previous) => ({
        productName: previous?.productName ?? DEFAULT_PRODUCT_NAME,
        configured: true,
        operatingMode: submission.operatingMode,
        publicUrl: submission.publicUrl ?? null,
        passkeyReady: result.passkeyReady,
        mailTransport: submission.mail?.transport ?? null,
        disclaimer: { version: previous?.disclaimer.version ?? "", accepted: true },
        setupToken: { required: false, source: null },
        microsoftSignIn: previous?.microsoftSignIn ?? false,
        demo: previous?.demo ?? { enabled: false, email: null, password: null },
      }));

      // The installation is complete without it; the dashboard offers to create it afterwards.
      if (result.ownOrganisation?.created === false) {
        toast.warning(t("result.ownOrganisationFailed"));
      }

      if (result.testSend.attempted) {
        if (result.testSend.ok) {
          toast.success(t("result.testSendOk"));
        } else {
          // The reason in the operator's language, never the transport's raw (English) answer.
          toast.warning(
            t("result.testSendFailed", {
              reason: t(mailTestFailureKey(result.testSend.reason ?? "transport_error"), {
                ns: SETTINGS_NAMESPACE,
              }),
            }),
          );
        }
      }

      setPhase("signingIn");
      const signIn = await authClient.signIn.email({
        email: submission.firstAdmin.email,
        password: submission.firstAdmin.password,
      });
      if (signIn.error) {
        toast.warning(t("result.signInFailed"));
        await navigate({ to: LOGIN_PATH, replace: true });
        return;
      }
      // Next comes the mandatory authenticator app; it starts with the password
      // just chosen instead of asking for it again (lib/password-handoff.ts).
      holdPasswordForEnrolment(submission.firstAdmin.password);
      toast.success(t("result.success"));
      await navigate({ to: HOME_PATH, replace: true });
    },
    onError: async (error) => {
      setPhase("editing");
      const type = problemType(error);
      if (type === PROBLEM.alreadyConfigured) {
        await leaveConfigured();
        return;
      }
      if (type === SETUP_TOKEN_PROBLEM) {
        // The token changed since the first step (the api restarted): ask again.
        setTokenError("changed");
        setStepIndex(STEP_KEYS.indexOf("token"));
        return;
      }
      if (type === DISCLAIMER_REQUIRED_PROBLEM || type === DISCLAIMER_VERSION_PROBLEM) {
        // Back to the notice: read it (again) and accept it.
        setNoticeChecked(false);
        setNoticeError(type === DISCLAIMER_VERSION_PROBLEM ? "versionChanged" : "serverRequired");
        setStepIndex(STEP_KEYS.indexOf("disclaimer"));
        await queryClient.invalidateQueries({ queryKey: queryKeys.setupState });
        return;
      }
      if (type === PROBLEM.emailInUse) {
        setStepIndex(STEP_KEYS.indexOf("admin"));
        form.setError("admin.email", { message: "emailInUse" }, { shouldFocus: true });
      }
    },
  });

  const tokenMutation = useMutation({
    mutationFn: () => verifySetupToken(setupToken),
    onMutate: () => setTokenError(null),
    onSuccess: next,
    onError: async (error) => {
      const type = problemType(error);
      if (type === PROBLEM.alreadyConfigured) {
        await leaveConfigured();
        return;
      }
      setTokenError(type === SETUP_TOKEN_PROBLEM ? "invalid" : "failed");
    },
  });

  const goNext = async () => {
    if (currentKey === "language") {
      // Confirmed, not only preselected: the choice sticks (the language switcher agrees).
      void chooseLanguage(language);
      next();
      return;
    }
    if (currentKey === "token") {
      if (setupToken.trim().length === 0) {
        setTokenError("required");
        return;
      }
      tokenMutation.mutate();
      return;
    }
    if (currentKey === "disclaimer") {
      // The acceptance travels with the setup request; the box must be ticked
      // (in demo mode the notice counts as accepted).
      if (disclaimer.accepted || noticeChecked) {
        setNoticeError(null);
        next();
      }
      return;
    }
    if (currentKey === "mail") {
      // Next on this step means "set it up now", also after an earlier "Skip for now".
      form.setValue("mail.skipped", false);
    }
    if (currentKey !== "review") {
      const valid = await form.trigger(STEP_FIELDS[currentKey], { shouldFocus: true });
      if (!valid) {
        return;
      }
    }
    next();
  };

  const goBack = () => setStepIndex((index) => stepFrom(index, -1));

  // The mail transport can wait: nothing is validated or sent, the settings have it later.
  const skipMail = () => {
    form.setValue("mail.skipped", true, { shouldDirty: true });
    form.clearErrors("mail");
    next();
  };

  const finish = form.handleSubmit((values) => {
    mutation.mutate(buildSubmission(values, disclaimer.version, language));
  });

  const busy = phase !== "editing" || tokenMutation.isPending;
  const failure = problemType(mutation.error);
  // Problems that send the operator back to another step are explained there.
  const handledElsewhere: ReadonlySet<string | null> = new Set([
    PROBLEM.alreadyConfigured,
    PROBLEM.emailInUse,
    SETUP_TOKEN_PROBLEM,
    DISCLAIMER_REQUIRED_PROBLEM,
    DISCLAIMER_VERSION_PROBLEM,
  ]);
  const submitFailed = mutation.isError && !handledElsewhere.has(failure);
  const failureDescription =
    failure === PROBLEM.administratorExists
      ? t("result.administratorExists")
      : failure === PROBLEM.configurationIncomplete
        ? t("result.configurationIncomplete", {
            settings: missingSettings(mutation.error).join(", "),
          })
        : undefined;

  return (
    <AuthLayout width="lg" align="top">
      <div className="flex flex-col gap-6">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
          <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
        </div>

        <div className="flex items-center justify-between gap-4">
          <div className="flex-1">
            <Stepper
              activeIndex={stepIndex}
              steps={steps}
              onSelect={(index) => !busy && setStepIndex(index)}
            />
          </div>
          <span className="shrink-0 text-xs text-muted-foreground">
            {t("stepIndicator", { current: stepPosition + 1, total: steps.length })}
          </span>
        </div>

        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            if (currentKey === "review") {
              void finish();
            } else {
              void goNext();
            }
          }}
          className="space-y-6"
        >
          <Card>
            <CardHeader>
              <CardTitle>{t(`${currentKey}.title`)}</CardTitle>
              <CardDescription>{t(`${currentKey}.description`)}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              {currentKey === "language" ? (
                <LanguageStep
                  value={language}
                  onSelect={(selected) => void chooseLanguage(selected)}
                />
              ) : null}
              {currentKey === "token" ? (
                <TokenStep
                  value={setupToken}
                  onChange={(value) => {
                    setSetupToken(value);
                    setTokenError(null);
                  }}
                  source={tokenSource}
                  checking={tokenMutation.isPending}
                  error={tokenError}
                />
              ) : null}
              {currentKey === "disclaimer" ? (
                <DisclaimerStep
                  version={disclaimer.version}
                  accepted={disclaimer.accepted}
                  checked={noticeChecked}
                  onCheckedChange={setNoticeChecked}
                  error={noticeError}
                  onReload={() => window.location.reload()}
                />
              ) : null}
              {currentKey === "mode" ? <ModeStep form={form} /> : null}
              {currentKey === "admin" ? <AdminStep form={form} /> : null}
              {currentKey === "mail" ? (
                <MailStep
                  form={form}
                  graphAvailable={setupState?.mailOptions?.graphBackupApp === true}
                />
              ) : null}
              {currentKey === "review" ? (
                <>
                  <ReviewStep values={form.getValues()} language={language} />
                  {serverReadiness ? <PasskeyReadiness readiness={serverReadiness} /> : null}
                  {submitFailed ? (
                    <ErrorState
                      title={t("result.failed")}
                      description={failureDescription}
                      error={mutation.error}
                      onRetry={() => void finish()}
                      retrying={busy}
                    />
                  ) : null}
                </>
              ) : null}
            </CardContent>
          </Card>

          <div className="flex items-center justify-between">
            <Button
              variant="ghost"
              type="button"
              onClick={goBack}
              disabled={stepIndex === 0 || busy}
            >
              {tc("actions.back")}
            </Button>

            {currentKey === "review" ? (
              <Button type="submit" loading={busy}>
                {phase === "submitting"
                  ? t("review.submitting")
                  : phase === "signingIn"
                    ? t("review.signingIn")
                    : t("review.finish")}
              </Button>
            ) : currentKey === "token" ? (
              <Button type="submit" loading={tokenMutation.isPending}>
                {tokenMutation.isPending ? t("token.checking") : tc("actions.next")}
              </Button>
            ) : currentKey === "disclaimer" ? (
              <Button type="submit" disabled={!disclaimer.accepted && !noticeChecked}>
                {t("disclaimer.continue")}
              </Button>
            ) : currentKey === "mail" ? (
              <div className="flex items-center gap-2">
                <Button variant="outline" type="button" onClick={skipMail}>
                  {t("mail.skip.action")}
                </Button>
                <Button type="submit">{tc("actions.next")}</Button>
              </div>
            ) : (
              <Button type="submit">{tc("actions.next")}</Button>
            )}
          </div>
        </form>
      </div>
    </AuthLayout>
  );
}
