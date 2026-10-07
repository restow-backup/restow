import { Check, Copy, Download, KeyRound, ShieldCheck, TriangleAlert } from "lucide-react";
import * as React from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";

import { Field, messageId } from "@/components/forms/field";
import { PasswordInput } from "@/components/forms/password-input";
import { QrCode } from "@/components/qr-code";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "@/components/ui/sonner";
import { zodResolver } from "@/lib/form";
import {
  type PasswordConfirmValues,
  TOTP_CODE_LENGTH,
  type TotpCodeValues,
  fieldMessageKey,
  passwordConfirmSchema,
  totpCodeSchema,
} from "../forms";
import {
  AuthRequestError,
  type AuthenticatorEnrollment,
  useConfirmAuthenticator,
  useStartAuthenticatorEnrollment,
} from "../hooks";
import {
  type TotpSetupKey,
  backupCodesDocument,
  parseTotpUri,
  twoFactorErrorKey,
} from "../presenters";

/**
 * Enrolment of the TOTP authenticator that protects the emergency password:
 * confirm the password, scan the key (or type it), prove it with a first
 * code, then keep the recovery codes. Used by the account page and by the
 * mandatory enrolment right after a password sign-in.
 */

/** i18n key (with namespace) for a failed authenticator request. */
export function authenticatorErrorKey(error: unknown): string {
  return error instanceof AuthRequestError
    ? twoFactorErrorKey(error.detail)
    : "common:errors.generic";
}

/** How long a copy button shows its check mark. */
const COPIED_FEEDBACK_MS = 2_000;

function useClipboard() {
  const [copied, setCopied] = React.useState(false);
  React.useEffect(() => {
    if (!copied) {
      return;
    }
    const timer = window.setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const copy = React.useCallback(async (value: string): Promise<boolean> => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      return true;
    } catch {
      return false;
    }
  }, []);
  return { copied, copy };
}

type SetupStep =
  | { step: "password" }
  | { step: "scan"; enrollment: AuthenticatorEnrollment; key: TotpSetupKey }
  | { step: "codes"; enrollment: AuthenticatorEnrollment; key: TotpSetupKey };

interface AuthenticatorSetupProps {
  /**
   * `replace` moves to a new phone: the current authenticator keeps working
   * until the new one's first code is confirmed.
   */
  mode: "enroll" | "replace";
  /** The authenticator is on and the recovery codes were acknowledged. */
  onComplete: () => void;
  /** Leave before the first step is done; omitted where enrolment is mandatory. */
  onCancel?: () => void;
  /**
   * Called once the authenticator is switched on, when the recovery codes
   * appear: a dialog around this must not close until they are acknowledged.
   */
  onEnabled?: () => void;
}

export function AuthenticatorSetup({
  mode,
  onComplete,
  onCancel,
  onEnabled,
}: AuthenticatorSetupProps) {
  const { t } = useTranslation("settings");
  const [state, setState] = React.useState<SetupStep>({ step: "password" });

  if (state.step === "password") {
    return (
      <PasswordStep
        mode={mode}
        onCancel={onCancel}
        onStarted={(enrollment, key) => setState({ step: "scan", enrollment, key })}
      />
    );
  }
  if (state.step === "scan") {
    return (
      <ScanStep
        replace={mode === "replace"}
        enrollment={state.enrollment}
        setupKey={state.key}
        onConfirmed={() => {
          setState({ step: "codes", enrollment: state.enrollment, key: state.key });
          onEnabled?.();
        }}
      />
    );
  }
  return (
    <div className="space-y-4">
      <Alert variant="info">
        <ShieldCheck />
        <AlertDescription>{t("security.authenticator.codes.enabled")}</AlertDescription>
      </Alert>
      <BackupCodesPanel
        codes={state.enrollment.backupCodes}
        account={state.key.account}
        issuer={state.key.issuer}
        onDone={onComplete}
      />
    </div>
  );
}

// --- Step 1: password -------------------------------------------------------------

function PasswordStep({
  mode,
  onCancel,
  onStarted,
}: {
  mode: "enroll" | "replace";
  onCancel?: () => void;
  onStarted: (enrollment: AuthenticatorEnrollment, key: TotpSetupKey) => void;
}) {
  const { t } = useTranslation("settings");
  const { t: tc } = useTranslation();
  const start = useStartAuthenticatorEnrollment();
  const [invalidKey, setInvalidKey] = React.useState(false);

  return (
    <PasswordConfirmForm
      id="authenticator-password"
      lead={t("security.authenticator.setup.passwordLead")}
      warning={mode === "replace" ? t("security.authenticator.setup.replaceWarning") : null}
      submitLabel={t("security.authenticator.setup.continue")}
      pending={start.isPending}
      errorMessage={
        invalidKey
          ? t("security.authenticator.errors.generic")
          : start.error
            ? tc(authenticatorErrorKey(start.error))
            : null
      }
      onCancel={onCancel}
      onSubmit={async (password) => {
        setInvalidKey(false);
        try {
          const enrollment = await start.mutateAsync({ password, replace: mode === "replace" });
          const key = parseTotpUri(enrollment.totpUri);
          if (!key) {
            setInvalidKey(true);
            return;
          }
          onStarted(enrollment, key);
        } catch {
          // Shown from start.error.
        }
      }}
    />
  );
}

interface PasswordConfirmFormProps {
  id: string;
  lead: string;
  warning: string | null;
  submitLabel: string;
  pending: boolean;
  errorMessage: string | null;
  onSubmit: (password: string) => Promise<void>;
  onCancel?: () => void;
}

/** Ask for the account password before a change to the second factor. */
export function PasswordConfirmForm({
  id,
  lead,
  warning,
  submitLabel,
  pending,
  errorMessage,
  onSubmit,
  onCancel,
}: PasswordConfirmFormProps) {
  const { t } = useTranslation("settings");
  const { t: tc } = useTranslation();
  const form = useForm<PasswordConfirmValues>({
    resolver: zodResolver(passwordConfirmSchema),
    defaultValues: { password: "" },
  });
  const fieldId = `${id}-field`;
  const passwordError = form.formState.errors.password;
  const passwordMessage = fieldMessageKey(passwordError);

  return (
    <form
      onSubmit={form.handleSubmit(({ password }) => onSubmit(password))}
      noValidate
      className="space-y-4"
    >
      <p className="text-sm text-muted-foreground">{lead}</p>
      {warning ? (
        <Alert variant="warning">
          <TriangleAlert />
          <AlertDescription>{warning}</AlertDescription>
        </Alert>
      ) : null}
      <Field
        id={fieldId}
        label={t("security.authenticator.setup.password")}
        error={passwordMessage ? tc(passwordMessage) : undefined}
      >
        <PasswordInput
          id={fieldId}
          autoComplete="current-password"
          autoFocus
          aria-invalid={passwordError !== undefined}
          aria-describedby={messageId(fieldId)}
          {...form.register("password")}
        />
      </Field>
      {errorMessage ? (
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertDescription>{errorMessage}</AlertDescription>
        </Alert>
      ) : null}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        {onCancel ? (
          <Button type="button" variant="outline" onClick={onCancel} disabled={pending}>
            {tc("actions.cancel")}
          </Button>
        ) : null}
        <Button type="submit" loading={pending}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

// --- Step 2: scan and confirm -----------------------------------------------------

function ScanStep({
  replace,
  enrollment,
  setupKey,
  onConfirmed,
}: {
  replace: boolean;
  enrollment: AuthenticatorEnrollment;
  setupKey: TotpSetupKey;
  onConfirmed: () => void;
}) {
  const { t } = useTranslation("settings");
  const { t: tc } = useTranslation();
  const confirm = useConfirmAuthenticator();
  const { copied, copy } = useClipboard();
  const form = useForm<TotpCodeValues>({
    resolver: zodResolver(totpCodeSchema),
    defaultValues: { code: "" },
  });
  const codeError = form.formState.errors.code;
  const codeMessage = fieldMessageKey(codeError);

  const onSubmit = form.handleSubmit(async ({ code }) => {
    try {
      await confirm.mutateAsync({ code, replace });
      toast.success(t("toasts.authenticatorEnabled"));
      onConfirmed();
    } catch {
      form.setValue("code", "");
      form.setFocus("code");
    }
  });

  const copyKey = async () => {
    if (await copy(setupKey.secret)) {
      toast.success(t("security.authenticator.setup.keyCopied"));
    } else {
      toast.error(t("security.authenticator.setup.keyCopyFailed"));
    }
  };

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-5">
      <ol className="list-decimal space-y-1.5 pl-5 text-sm text-muted-foreground marker:text-foreground">
        <li>{t("security.authenticator.setup.steps.open")}</li>
        <li>{t("security.authenticator.setup.steps.scan")}</li>
        <li>{t("security.authenticator.setup.steps.enter")}</li>
      </ol>

      <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
        <QrCode
          value={enrollment.totpUri}
          label={t("security.authenticator.setup.qrLabel")}
          className="size-44 shrink-0 border border-border"
        />
        <div className="w-full min-w-0 space-y-2 text-sm">
          <p className="font-medium">{t("security.authenticator.setup.manualTitle")}</p>
          <p className="text-xs text-muted-foreground">
            {t("security.authenticator.setup.manualHint")}
          </p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
            {setupKey.account ? (
              <>
                <dt className="text-muted-foreground">
                  {t("security.authenticator.setup.account")}
                </dt>
                <dd className="break-all">{setupKey.account}</dd>
              </>
            ) : null}
            <dt className="text-muted-foreground">{t("security.authenticator.setup.key")}</dt>
            <dd className="break-all font-mono tracking-wider">{setupKey.groupedSecret}</dd>
          </dl>
          <Button type="button" variant="outline" size="sm" onClick={() => void copyKey()}>
            {copied ? <Check /> : <Copy />}
            {t("security.authenticator.setup.copyKey")}
          </Button>
        </div>
      </div>

      <Field
        id="authenticator-code"
        label={t("security.authenticator.setup.code")}
        hint={t("security.authenticator.setup.codeHint")}
        error={codeMessage ? tc(codeMessage) : undefined}
      >
        <Input
          id="authenticator-code"
          inputMode="numeric"
          autoComplete="one-time-code"
          autoFocus
          maxLength={TOTP_CODE_LENGTH + 1}
          placeholder={t("security.authenticator.setup.codePlaceholder")}
          className="max-w-40 font-mono tracking-widest"
          aria-invalid={codeError !== undefined}
          aria-describedby={messageId("authenticator-code")}
          {...form.register("code")}
        />
      </Field>
      {confirm.error ? (
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertDescription>{tc(authenticatorErrorKey(confirm.error))}</AlertDescription>
        </Alert>
      ) : null}
      <div className="flex justify-end">
        <Button type="submit" loading={confirm.isPending}>
          {confirm.isPending ? null : <KeyRound />}
          {t("security.authenticator.setup.confirm")}
        </Button>
      </div>
    </form>
  );
}

// --- Step 3: recovery codes --------------------------------------------------------

interface BackupCodesPanelProps {
  codes: readonly string[];
  account: string | null;
  issuer: string | null;
  onDone: () => void;
}

/** Show recovery codes once, with copy and download, until their safekeeping is confirmed. */
export function BackupCodesPanel({ codes, account, issuer, onDone }: BackupCodesPanelProps) {
  const { t } = useTranslation("settings");
  const { copied, copy } = useClipboard();
  const [stored, setStored] = React.useState(false);
  const checkboxId = React.useId();

  const text = backupCodesDocument(codes, {
    title: t("security.authenticator.codes.fileTitle"),
    account,
    issuer,
    note: t("security.authenticator.codes.fileNote"),
  });

  const copyCodes = async () => {
    if (await copy(codes.join("\n"))) {
      toast.success(t("security.authenticator.codes.copied"));
    } else {
      toast.error(t("security.authenticator.codes.copyFailed"));
    }
  };

  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = t("security.authenticator.codes.fileName");
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <p className="text-sm font-medium">{t("security.authenticator.codes.title")}</p>
        <p className="text-sm text-muted-foreground">{t("security.authenticator.codes.lead")}</p>
      </div>
      <ul
        aria-label={t("security.authenticator.codes.listLabel")}
        className="grid grid-cols-2 gap-x-6 gap-y-1.5 rounded-lg border border-border bg-muted/40 px-4 py-3 font-mono text-sm tracking-wider"
      >
        {codes.map((code) => (
          <li key={code} className="select-all">
            {code}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => void copyCodes()}>
          {copied ? <Check /> : <Copy />}
          {t("security.authenticator.codes.copy")}
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={download}>
          <Download />
          {t("security.authenticator.codes.download")}
        </Button>
      </div>
      <div className="flex items-start gap-2">
        <Checkbox
          id={checkboxId}
          checked={stored}
          onCheckedChange={(value) => setStored(value === true)}
          className="mt-0.5"
        />
        <Label htmlFor={checkboxId} className="text-sm font-normal leading-snug">
          {t("security.authenticator.codes.acknowledge")}
        </Label>
      </div>
      <div className="flex justify-end">
        <Button type="button" onClick={onDone} disabled={!stored}>
          {t("security.authenticator.codes.done")}
        </Button>
      </div>
    </div>
  );
}
