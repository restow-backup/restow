import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  KeyRound,
  ListRestart,
  Plus,
  ShieldAlert,
  ShieldCheck,
  Smartphone,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import * as React from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";

import { Field, messageId } from "@/components/forms/field";
import { DisabledReason } from "@/components/kit";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import { installationSectionTo } from "@/features/installation/paths";
import { errorMessageKey } from "@/lib/api";
import { authClient, browserSupportsPasskeys } from "@/lib/auth-client";
import { zodResolver } from "@/lib/form";
import { formatDateTime } from "@/lib/format";
import { useSession } from "@/lib/session";
import { setupStateQueryOptions } from "@/routes/tree";
import {
  AuthenticatorSetup,
  BackupCodesPanel,
  PasswordConfirmForm,
  authenticatorErrorKey,
} from "../components/authenticator-setup";
import { ConfirmDialog } from "../components/confirm-dialog";
import { ReadinessSummary } from "../components/readiness";
import {
  PASSKEY_NAME_MAX_LENGTH,
  type PasskeyNameValues,
  fieldMessageKey,
  passkeyNameSchema,
} from "../forms";
import {
  AuthRequestError,
  useAddPasskey,
  useDeletePasskey,
  usePasskeys,
  useRegenerateBackupCodes,
  useSignInMethods,
} from "../hooks";
import {
  type PasskeyRemoval,
  type PasskeyRow,
  authStatusKey,
  detectDevice,
  passkeyErrorKey,
  passkeyRemoval,
} from "../presenters";
import { PasswordCard } from "./password-card";
import { SessionsCard } from "./sessions-card";

/**
 * The signed-in person's own sign-in security: passkeys, the authenticator
 * app that protects the emergency password, and other sessions. Every role
 * reaches it from the user menu (`/account`).
 */
export function SecuritySection() {
  const methods = useSignInMethods();
  const hasPassword = methods.data?.hasPassword ?? false;

  return (
    <div className="space-y-6">
      <PasskeysCard hasPassword={hasPassword} />
      {methods.isPending ? (
        <Skeleton className="h-40 w-full rounded-xl" />
      ) : methods.isError ? (
        <SignInMethodsError onRetry={() => void methods.refetch()} retrying={methods.isFetching} />
      ) : hasPassword ? (
        <>
          <PasswordCard />
          <AuthenticatorCard />
        </>
      ) : null}
      <SessionsCard />
    </div>
  );
}

/** i18n key for a failed passkey ceremony or passkey request. */
function passkeyActionErrorKey(error: unknown): string {
  return error instanceof AuthRequestError
    ? passkeyErrorKey(error.detail)
    : "settings:security.passkeys.errors.generic";
}

/** i18n key for a failed plain better-auth request (listing, sessions). */
function requestErrorKey(error: unknown): string {
  return error instanceof AuthRequestError
    ? authStatusKey(error.detail)
    : `common:${errorMessageKey(error)}`;
}

function SignInMethodsError({ onRetry, retrying }: { onRetry: () => void; retrying: boolean }) {
  const { t } = useTranslation("settings");
  const { t: tc } = useTranslation();
  return (
    <Alert variant="destructive">
      <TriangleAlert />
      <AlertTitle>{t("security.authenticator.loadError")}</AlertTitle>
      <AlertDescription className="flex justify-end">
        <Button variant="outline" size="sm" onClick={onRetry} loading={retrying}>
          {tc("actions.retry")}
        </Button>
      </AlertDescription>
    </Alert>
  );
}

// --- Passkeys ---------------------------------------------------------------------

function PasskeysCard({ hasPassword }: { hasPassword: boolean }) {
  const { t } = useTranslation("settings");
  const { isProviderAdmin } = useSession();
  const navigate = useNavigate();
  const setupState = useQuery(setupStateQueryOptions);
  const passkeys = usePasskeys();
  const authSession = authClient.useSession();
  const hasAuthenticator = authSession.data?.user.twoFactorEnabled === true;
  const [adding, setAdding] = React.useState(false);
  const [removing, setRemoving] = React.useState<PasskeyRow | null>(null);

  const readiness = setupState.data?.passkeyReady ?? null;
  const ready = readiness?.ready ?? false;
  const supported = browserSupportsPasskeys();
  const canEnrol = ready && supported;
  const removal = passkeyRemoval({
    passkeyCount: passkeys.data?.length ?? 0,
    hasPassword,
    hasAuthenticator,
    microsoftSignIn: setupState.data?.microsoftSignIn ?? false,
  });
  const emptyKey = !ready
    ? "security.passkeys.emptyNotReady"
    : hasPassword
      ? hasAuthenticator
        ? "security.passkeys.empty"
        : "security.passkeys.emptyNoAuthenticator"
      : "security.passkeys.emptySso";

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
        <div className="space-y-1.5">
          <CardTitle>{t("security.passkeys.title")}</CardTitle>
          <CardDescription>
            {readiness?.rpId
              ? t("security.passkeys.description", { domain: readiness.rpId })
              : t("security.passkeys.descriptionNoDomain")}
          </CardDescription>
        </div>
        <Button className="shrink-0" onClick={() => setAdding(true)} disabled={!canEnrol}>
          <Plus />
          {t("security.passkeys.add")}
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {readiness && !ready ? (
          isProviderAdmin ? (
            <div className="space-y-3">
              <ReadinessSummary readiness={readiness} />
              <Button
                variant="outline"
                size="sm"
                onClick={() => void navigate({ to: installationSectionTo("server") })}
              >
                {t("security.passkeys.openGeneral")}
              </Button>
            </div>
          ) : (
            <Alert variant="info">
              <ShieldAlert />
              <AlertDescription>{t("security.passkeys.notReadyMember")}</AlertDescription>
            </Alert>
          )
        ) : null}
        {ready && !supported ? (
          <Alert variant="warning">
            <TriangleAlert />
            <AlertDescription>{t("security.passkeys.unsupported")}</AlertDescription>
          </Alert>
        ) : null}

        <PasskeyList
          query={passkeys}
          onRemove={setRemoving}
          emptyKey={emptyKey}
          removalBlocked={removal === "blocked"}
        />
      </CardContent>

      <AddPasskeyDialog open={adding} onOpenChange={setAdding} />
      <RemovePasskeyDialog passkey={removing} removal={removal} onClose={() => setRemoving(null)} />
    </Card>
  );
}

function PasskeyList({
  query,
  onRemove,
  emptyKey,
  removalBlocked,
}: {
  query: ReturnType<typeof usePasskeys>;
  onRemove: (passkey: PasskeyRow) => void;
  emptyKey: string;
  /** The only way to sign in: removing it would lock the account out. */
  removalBlocked: boolean;
}) {
  const { t, i18n } = useTranslation("settings");
  const { t: tc } = useTranslation();

  if (query.isPending) {
    return (
      <div className="space-y-2" aria-busy="true">
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
      </div>
    );
  }
  if (query.isError) {
    return (
      <Alert variant="destructive">
        <TriangleAlert />
        <AlertTitle>{t("security.passkeys.loadError")}</AlertTitle>
        <AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <span>{tc(requestErrorKey(query.error))}</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void query.refetch()}
            loading={query.isFetching}
          >
            {tc("actions.retry")}
          </Button>
        </AlertDescription>
      </Alert>
    );
  }
  if (query.data.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
        {t(emptyKey)}
      </p>
    );
  }
  return (
    <ul className="divide-y divide-border rounded-lg border border-border">
      {query.data.map((passkey) => {
        const name = passkey.name ?? t("security.passkeys.unnamed");
        const created = formatDateTime(passkey.createdAt, i18n.language);
        return (
          <li key={passkey.id} className="flex items-center gap-3 px-4 py-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <KeyRound className="size-4" aria-hidden="true" />
            </span>
            <div className="min-w-0 flex-1 space-y-0.5">
              <p className="truncate text-sm font-medium">{name}</p>
              <p className="text-xs text-muted-foreground">
                {created
                  ? t("security.passkeys.createdAt", { date: created })
                  : t("security.passkeys.createdUnknown")}
              </p>
            </div>
            <Badge
              variant={passkey.synced ? "secondary" : "outline"}
              className="hidden sm:inline-flex"
            >
              {passkey.synced ? t("security.passkeys.synced") : t("security.passkeys.deviceBound")}
            </Badge>
            <DisabledReason
              reason={removalBlocked ? t("security.passkeys.removeBlocked") : null}
              side="left"
            >
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => onRemove(passkey)}
                disabled={removalBlocked}
                aria-label={t("security.passkeys.removeLabel", { name })}
                title={removalBlocked ? undefined : t("security.passkeys.remove")}
              >
                <Trash2 />
              </Button>
            </DisabledReason>
          </li>
        );
      })}
    </ul>
  );
}

function suggestedName(t: (key: string, options?: Record<string, unknown>) => string): string {
  const device = typeof navigator === "undefined" ? null : detectDevice(navigator.userAgent);
  return device
    ? t("security.passkeys.addDialog.defaultName", { device })
    : t("security.passkeys.addDialog.defaultNameGeneric");
}

function AddPasskeyDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation("settings");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("security.passkeys.addDialog.title")}</DialogTitle>
          <DialogDescription>{t("security.passkeys.addDialog.description")}</DialogDescription>
        </DialogHeader>
        {/* Mounted only while open: each opening starts with a fresh suggestion. */}
        {open ? <AddPasskeyForm onDone={() => onOpenChange(false)} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function AddPasskeyForm({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation("settings");
  const { t: tc } = useTranslation();
  const add = useAddPasskey();
  const form = useForm<PasskeyNameValues>({
    resolver: zodResolver(passkeyNameSchema),
    defaultValues: { name: suggestedName(t) },
  });

  const onSubmit = form.handleSubmit(async ({ name }) => {
    try {
      await add.mutateAsync(name.trim());
      toast.success(t("toasts.passkeyAdded"));
      onDone();
    } catch {
      // The error stays visible in the dialog (add.error).
    }
  });

  const nameError = form.formState.errors.name;
  const nameMessage = fieldMessageKey(nameError);

  return (
    <>
      <form id="settings-add-passkey" onSubmit={onSubmit} noValidate className="space-y-4">
        <Field
          id="settings-passkey-name"
          label={t("security.passkeys.addDialog.name")}
          hint={t("security.passkeys.addDialog.nameHint")}
          error={nameMessage ? tc(nameMessage) : undefined}
        >
          <Input
            id="settings-passkey-name"
            autoComplete="off"
            maxLength={PASSKEY_NAME_MAX_LENGTH}
            placeholder={t("security.passkeys.addDialog.namePlaceholder")}
            aria-invalid={nameError !== undefined}
            aria-describedby={messageId("settings-passkey-name")}
            {...form.register("name")}
          />
        </Field>
        {add.error ? (
          <Alert variant="destructive">
            <ShieldAlert />
            <AlertDescription>{tc(passkeyActionErrorKey(add.error))}</AlertDescription>
          </Alert>
        ) : null}
      </form>
      <DialogFooter>
        <Button variant="outline" onClick={onDone} disabled={add.isPending}>
          {tc("actions.cancel")}
        </Button>
        <Button type="submit" form="settings-add-passkey" loading={add.isPending}>
          {add.isPending ? null : <KeyRound />}
          {t("security.passkeys.addDialog.confirm")}
        </Button>
      </DialogFooter>
    </>
  );
}

/** The sentence after "no sign-in with it any more", by what the account keeps. */
const REMOVAL_DESCRIPTION: Record<Exclude<PasskeyRemoval, "blocked">, string> = {
  others: "security.passkeys.removeDialog.descriptionOthers",
  authenticator: "security.passkeys.removeDialog.description",
  noAuthenticator: "security.passkeys.removeDialog.descriptionNoAuthenticator",
  sso: "security.passkeys.removeDialog.descriptionSso",
};

function RemovePasskeyDialog({
  passkey,
  removal,
  onClose,
}: {
  passkey: PasskeyRow | null;
  removal: PasskeyRemoval;
  onClose: () => void;
}) {
  const { t } = useTranslation("settings");
  const { t: tc } = useTranslation();
  const remove = useDeletePasskey();
  const name = passkey?.name ?? t("security.passkeys.unnamed");

  const confirm = () => {
    if (!passkey) {
      return;
    }
    remove.mutate(passkey.id, {
      onSuccess: () => {
        toast.success(t("toasts.passkeyRemoved"));
        onClose();
      },
      onError: (error) => {
        toast.error(tc(passkeyActionErrorKey(error)));
        onClose();
      },
    });
  };

  return (
    <ConfirmDialog
      open={passkey !== null}
      onOpenChange={(open) => !open && onClose()}
      title={t("security.passkeys.removeDialog.title")}
      description={
        removal === "blocked"
          ? t("security.passkeys.removeBlocked")
          : t(REMOVAL_DESCRIPTION[removal], { name })
      }
      confirmLabel={t("security.passkeys.removeDialog.confirm")}
      destructive
      pending={remove.isPending}
      onConfirm={confirm}
    />
  );
}

// --- Authenticator app --------------------------------------------------------------

type AuthenticatorDialog = "enroll" | "replace" | "codes" | null;

/**
 * The TOTP second factor of the emergency password. Accounts with a password
 * cannot use Restow without it (the shell sends them to the enrolment), so
 * the card mostly offers what comes later: a new phone and new recovery codes.
 */
function AuthenticatorCard() {
  const { t } = useTranslation("settings");
  const session = authClient.useSession();
  const enabled = session.data?.user.twoFactorEnabled === true;
  const [dialog, setDialog] = React.useState<AuthenticatorDialog>(null);
  // While the one-time recovery codes are on screen the dialog stays open.
  const [codesShown, setCodesShown] = React.useState(false);
  const close = () => {
    setCodesShown(false);
    setDialog(null);
  };
  const requestClose = useGuardedClose(codesShown, close);

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle>{t("security.authenticator.title")}</CardTitle>
            <Badge variant={enabled ? "outline" : "warning"}>
              {enabled
                ? t("security.authenticator.statusOn")
                : t("security.authenticator.statusOff")}
            </Badge>
          </div>
          <CardDescription>{t("security.authenticator.description")}</CardDescription>
        </div>
        <ShieldCheck className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
      </CardHeader>
      <CardContent className="space-y-4">
        {enabled ? (
          <>
            <p className="text-sm text-muted-foreground">
              {t("security.authenticator.enabledDescription")}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => setDialog("replace")}>
                <Smartphone />
                {t("security.authenticator.replace")}
              </Button>
              <Button variant="outline" onClick={() => setDialog("codes")}>
                <ListRestart />
                {t("security.authenticator.newCodes")}
              </Button>
            </div>
          </>
        ) : (
          <>
            <Alert variant="warning">
              <TriangleAlert />
              <AlertDescription>{t("security.authenticator.requiredDescription")}</AlertDescription>
            </Alert>
            <Button onClick={() => setDialog("enroll")}>
              <ShieldCheck />
              {t("security.authenticator.setUp")}
            </Button>
          </>
        )}
      </CardContent>

      <Dialog
        open={dialog === "enroll" || dialog === "replace"}
        onOpenChange={(open) => !open && requestClose()}
      >
        <DialogContent className="sm:max-w-xl" showCloseButton={!codesShown}>
          <DialogHeader>
            <DialogTitle>
              {dialog === "replace"
                ? t("security.authenticator.setup.replaceTitle")
                : t("security.authenticator.setup.title")}
            </DialogTitle>
            <DialogDescription>{t("security.authenticator.setup.description")}</DialogDescription>
          </DialogHeader>
          {dialog === "enroll" || dialog === "replace" ? (
            <AuthenticatorSetup
              key={dialog}
              mode={dialog}
              onCancel={close}
              onEnabled={() => setCodesShown(true)}
              onComplete={close}
            />
          ) : null}
        </DialogContent>
      </Dialog>

      <RegenerateCodesDialog open={dialog === "codes"} onClose={() => setDialog(null)} />
    </Card>
  );
}

/**
 * Closing (X, Escape, a click beside the dialog) while one-time recovery
 * codes are shown would lose them: it is refused with a hint instead, and
 * only "Done" after the acknowledgement closes.
 */
function useGuardedClose(locked: boolean, close: () => void): () => void {
  const { t } = useTranslation("settings");
  return () => {
    if (locked) {
      toast.warning(t("security.authenticator.codes.closeBlocked"));
      return;
    }
    close();
  };
}

function RegenerateCodesDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation("settings");
  const [codesShown, setCodesShown] = React.useState(false);
  const close = () => {
    setCodesShown(false);
    onClose();
  };
  const requestClose = useGuardedClose(codesShown, close);
  return (
    <Dialog open={open} onOpenChange={(next) => !next && requestClose()}>
      <DialogContent className="sm:max-w-lg" showCloseButton={!codesShown}>
        <DialogHeader>
          <DialogTitle>{t("security.authenticator.regenerate.title")}</DialogTitle>
          <DialogDescription>
            {t("security.authenticator.regenerate.description")}
          </DialogDescription>
        </DialogHeader>
        {/* Mounted only while open: the codes are shown once and then forgotten. */}
        {open ? <RegenerateCodes onClose={close} onCodes={() => setCodesShown(true)} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function RegenerateCodes({ onClose, onCodes }: { onClose: () => void; onCodes: () => void }) {
  const { t } = useTranslation("settings");
  const { t: tc } = useTranslation();
  const { user } = useSession();
  const regenerate = useRegenerateBackupCodes();
  const [codes, setCodes] = React.useState<string[] | null>(null);

  if (codes) {
    return (
      <BackupCodesPanel
        codes={codes}
        account={user?.email ?? null}
        issuer={null}
        onDone={onClose}
      />
    );
  }
  return (
    <PasswordConfirmForm
      id="regenerate-codes-password"
      lead={t("security.authenticator.regenerate.passwordLead")}
      warning={null}
      submitLabel={t("security.authenticator.regenerate.confirm")}
      pending={regenerate.isPending}
      errorMessage={regenerate.error ? tc(authenticatorErrorKey(regenerate.error)) : null}
      onCancel={onClose}
      onSubmit={async (password) => {
        try {
          setCodes(await regenerate.mutateAsync(password));
          onCodes();
          toast.success(t("toasts.backupCodesRenewed"));
        } catch {
          // Shown from regenerate.error.
        }
      }}
    />
  );
}
