import { useQuery } from "@tanstack/react-query";
import { KeyRound, LogIn, TriangleAlert } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { setupStateQueryOptions } from "@/lib/api";
import { authClient, browserSupportsPasskeys } from "@/lib/auth-client";
import { offersPasskeyConfirmation } from "@/lib/recent-sign-in";
import { useSession } from "@/lib/session";
import { loginReturnPath, signInErrorKey } from "@/lib/sign-in";

/**
 * "Confirm it is you": the step-up before an action the API only accepts from
 * a recent sign-in (lib/recent-sign-in.ts). A passkey confirms right here (it
 * opens a fresh session for the same account, and the action is repeated at
 * once); otherwise the person signs in again on the sign-in page, with the
 * password and the authenticator code or however they usually sign in, and
 * comes back to this page to repeat the action. Nothing here weakens the
 * sign-in: it uses the same better-auth endpoints, user verification and second
 * factor.
 */
export function ConfirmIdentityDialog({
  open,
  onOpenChange,
  onConfirmed,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The fresh session is in place: repeat the action. */
  onConfirmed: () => void;
}) {
  const { t } = useTranslation("auth");
  const session = useSession();
  // Shared with the shell, which has usually loaded it already; asked only while open.
  const setup = useQuery({ ...setupStateQueryOptions, enabled: open });
  const passkeys = useQuery({
    queryKey: ["auth", "passkeys", "count"] as const,
    queryFn: async (): Promise<number> => {
      const { data, error } = await authClient.passkey.listUserPasskeys();
      return error ? 0 : (data ?? []).length;
    },
    enabled: open,
    staleTime: 60_000,
  });
  const [pending, setPending] = React.useState<"passkey" | "signIn" | null>(null);
  const [errorKey, setErrorKey] = React.useState<string | null>(null);

  // Every opening starts without the last attempt's error.
  const [wasOpen, setWasOpen] = React.useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setErrorKey(null);
    }
  }

  const passkey = offersPasskeyConfirmation({
    passkeyReady: setup.data?.passkeyReady?.ready ?? false,
    browserSupportsPasskeys: browserSupportsPasskeys(),
    passkeys: passkeys.data ?? null,
  });

  const confirmWithPasskey = async () => {
    setErrorKey(null);
    setPending("passkey");
    try {
      const result = await authClient.signIn.passkey();
      if (result.error) {
        setErrorKey(signInErrorKey(result.error, "passkey"));
        return;
      }
      const fresh = await authClient.getSession();
      if (fresh.data?.user.id !== session.user?.id) {
        // Someone confirmed with another account's passkey: the browser now holds
        // that account's session, so the page starts over for it.
        window.location.reload();
        return;
      }
      await session.refresh();
      onOpenChange(false);
      onConfirmed();
    } finally {
      setPending(null);
    }
  };

  const signInAgain = async () => {
    setPending("signIn");
    const target = `${window.location.pathname}${window.location.search}`;
    await session.signOut();
    window.location.assign(loginReturnPath(target));
  };

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next && pending !== null) {
          return;
        }
        onOpenChange(next);
      }}
    >
      <AlertDialogContent data-slot="confirm-identity">
        <AlertDialogHeader>
          <AlertDialogTitle>{t("confirmIdentity.title")}</AlertDialogTitle>
          <AlertDialogDescription>{t("confirmIdentity.description")}</AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-4">
          {passkey ? (
            <div className="space-y-2">
              <Button
                type="button"
                className="w-full"
                onClick={confirmWithPasskey}
                loading={pending === "passkey"}
                disabled={pending !== null}
                data-slot="confirm-passkey"
              >
                {pending === "passkey" ? null : <KeyRound />}
                {pending === "passkey"
                  ? t("confirmIdentity.passkeyPending")
                  : t("confirmIdentity.passkey")}
              </Button>
              <p className="text-xs text-muted-foreground">{t("confirmIdentity.passkeyHint")}</p>
            </div>
          ) : null}
          <div className="space-y-2">
            <Button
              type="button"
              variant={passkey ? "outline" : "default"}
              className="w-full"
              onClick={signInAgain}
              loading={pending === "signIn"}
              disabled={pending !== null}
              data-slot="confirm-sign-in-again"
            >
              {pending === "signIn" ? null : <LogIn />}
              {t("confirmIdentity.signInAgain")}
            </Button>
            <p className="text-xs text-muted-foreground">{t("confirmIdentity.signInAgainHint")}</p>
          </div>
          {errorKey ? (
            <Alert variant="destructive" data-slot="confirm-identity-error">
              <TriangleAlert />
              <AlertDescription>{t(errorKey)}</AlertDescription>
            </Alert>
          ) : null}
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending !== null}>
            {t("confirmIdentity.cancel")}
          </AlertDialogCancel>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * Wire the dialog to an action: `ask(retry)` opens it, and a confirmation with
 * the passkey runs `retry` once. Render `dialog` next to the action's controls.
 */
export function useConfirmIdentity(): {
  ask: (retry: () => void) => void;
  dialog: React.ReactNode;
} {
  const retry = React.useRef<(() => void) | null>(null);
  const [open, setOpen] = React.useState(false);
  const ask = React.useCallback((action: () => void) => {
    retry.current = action;
    setOpen(true);
  }, []);
  const dialog = (
    <ConfirmIdentityDialog
      open={open}
      onOpenChange={setOpen}
      onConfirmed={() => {
        // Only a confirmation runs the action; a cancelled dialog's action is replaced by the next ask.
        const action = retry.current;
        retry.current = null;
        action?.();
      }}
    />
  );
  return { ask, dialog };
}
