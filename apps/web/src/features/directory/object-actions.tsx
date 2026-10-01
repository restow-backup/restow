import {
  CircleCheck,
  CircleMinus,
  KeyRound,
  MoreHorizontal,
  PlugZap,
  RotateCcw,
  Trash2,
} from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { PasswordInput } from "@/components/forms/password-input";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";
import { toast } from "@/components/ui/sonner";
import { errorMessageKey } from "@/lib/api";

import { ConfirmDialog } from "./confirm-dialog";
import {
  useDeleteAccount,
  useSetObjectCredential,
  useSetProtection,
  useTestObjectCredential,
} from "./hooks";
import {
  availableActions,
  canSetCredential,
  canTestCredentialLogin,
  credentialProbeFailureKey,
  objectErrorKey,
  objectTitle,
  syncResultKey,
} from "./presenters";
import type { ProtectedObject, ProtectionAction } from "./types";

/**
 * Set or replace one IMAP account's own password (per_mailbox auth,
 * docs/IMAP.md). Exported (only) so object-actions.test.tsx can mount it
 * directly with a real DOM, without also driving the dropdown menu that
 * normally opens it.
 */
export function SetCredentialDialog({
  object,
  open,
  onOpenChange,
}: {
  object: ProtectedObject;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation("directory");
  const { t: tc } = useTranslation();
  const [password, setPassword] = React.useState("");
  const setCredential = useSetObjectCredential();
  const { reset: resetCredential } = setCredential;
  const name = objectTitle(object);

  React.useEffect(() => {
    if (open) {
      setPassword("");
      resetCredential();
    }
    // `resetCredential` is the mutation observer's stable reset function (bound once),
    // unlike `setCredential` itself which is a new object on every render.
  }, [open, resetCredential]);

  const submit = async () => {
    try {
      await setCredential.mutateAsync({ objectId: object.id, password });
      toast.success(t("credential.setDone", { name }));
      onOpenChange(false);
    } catch (error) {
      toast.error(t("actions.failed"), { description: tc(errorMessageKey(error)) });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t("credential.setTitle", { name })}</DialogTitle>
          <DialogDescription>{t("credential.setDescription")}</DialogDescription>
        </DialogHeader>
        <form
          id="set-credential-form"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
          className="space-y-1.5"
        >
          <Label htmlFor="credential-password">{t("credential.passwordLabel")}</Label>
          <PasswordInput
            id="credential-password"
            autoComplete="new-password"
            autoFocus
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </form>
        {setCredential.isError ? (
          <Alert variant="destructive">
            <AlertDescription>{tc(errorMessageKey(setCredential.error))}</AlertDescription>
          </Alert>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {tc("actions.cancel")}
          </Button>
          <Button
            type="submit"
            form="set-credential-form"
            loading={setCredential.isPending}
            disabled={password.length === 0}
          >
            {t("credential.setConfirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Per-object decisions: always include, exclude (confirmed, because backups
 * stop), return to the rules, and remove an IMAP account that has no backups.
 */
export function ObjectActions({ object }: { object: ProtectedObject }) {
  const { t } = useTranslation("directory");
  const { t: tc } = useTranslation();
  const setProtection = useSetProtection();
  const removeAccount = useDeleteAccount();
  const testCredential = useTestObjectCredential();
  const [confirm, setConfirm] = React.useState<"exclude" | "remove" | null>(null);
  const [credentialDialogOpen, setCredentialDialogOpen] = React.useState(false);

  const actions = availableActions(object);
  const name = objectTitle(object);
  const isImap = object.kind === "imap";
  const failed = (error: unknown) =>
    toast.error(t("actions.failed"), { description: tc(errorMessageKey(error)) });

  const testLogin = async () => {
    // A loading toast, updated in place once the probe settles (sonner's
    // manual promise pattern): the probe can take up to its own timeout, and
    // the menu closes as soon as the action is chosen, so without this
    // nothing tells the admin anything is happening until it is done.
    const toastId = toast.loading(t("credential.testing", { name }));
    try {
      const { probe } = await testCredential.mutateAsync(object.id);
      if (probe.ok) {
        toast.success(t("credential.testOk", { name }), { id: toastId });
      } else {
        toast.error(t("credential.testFailed", { name }), {
          id: toastId,
          description: t(credentialProbeFailureKey(probe)),
        });
      }
    } catch (error) {
      toast.error(t("actions.failed"), { id: toastId, description: tc(objectErrorKey(error)) });
    }
  };

  const apply = async (action: ProtectionAction) => {
    try {
      const result = await setProtection.mutateAsync({ objectId: object.id, action });
      toast.success(
        t(`actions.done.${action}`, { name }),
        result.sync ? { description: t(syncResultKey(result.sync)) } : undefined,
      );
      setConfirm(null);
    } catch (error) {
      failed(error);
    }
  };

  const remove = async () => {
    try {
      await removeAccount.mutateAsync(object.id);
      toast.success(t("actions.done.remove", { name }));
      setConfirm(null);
    } catch (error) {
      failed(error);
    }
  };

  if (!actions.include && !actions.exclude && !actions.reset && !actions.remove && !isImap) {
    return null;
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={t("actions.menu", { name })}>
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60">
          {actions.include ? (
            <DropdownMenuItem onSelect={() => void apply("include")}>
              <CircleCheck />
              {t("actions.include")}
            </DropdownMenuItem>
          ) : null}
          {actions.exclude ? (
            <DropdownMenuItem onSelect={() => setConfirm("exclude")}>
              <CircleMinus />
              {t("actions.exclude")}
            </DropdownMenuItem>
          ) : null}
          {actions.reset ? (
            <DropdownMenuItem onSelect={() => void apply("reset")}>
              <RotateCcw />
              {t("actions.reset")}
            </DropdownMenuItem>
          ) : null}
          {isImap ? (
            <>
              <DropdownMenuSeparator />
              {canSetCredential(object) ? (
                <DropdownMenuItem onSelect={() => setCredentialDialogOpen(true)}>
                  <KeyRound />
                  {t("credential.setAction")}
                </DropdownMenuItem>
              ) : null}
              {canTestCredentialLogin(object) ? (
                <DropdownMenuItem onSelect={() => void testLogin()}>
                  <PlugZap />
                  {t("credential.testAction")}
                </DropdownMenuItem>
              ) : null}
            </>
          ) : null}
          {actions.remove ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={() => setConfirm("remove")}>
                <Trash2 />
                {t("actions.remove")}
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      <ConfirmDialog
        open={confirm === "exclude"}
        onOpenChange={(open) => setConfirm(open ? "exclude" : null)}
        title={t("actions.excludeConfirm.title", { name })}
        description={t("actions.excludeConfirm.description")}
        confirmLabel={t("actions.excludeConfirm.confirm")}
        pending={setProtection.isPending}
        onConfirm={() => void apply("exclude")}
      />
      <ConfirmDialog
        open={confirm === "remove"}
        onOpenChange={(open) => setConfirm(open ? "remove" : null)}
        title={t("actions.removeConfirm.title", { name })}
        description={t("actions.removeConfirm.description")}
        confirmLabel={t("actions.removeConfirm.confirm")}
        destructive
        pending={removeAccount.isPending}
        onConfirm={() => void remove()}
      />
      {isImap ? (
        <SetCredentialDialog
          object={object}
          open={credentialDialogOpen}
          onOpenChange={setCredentialDialogOpen}
        />
      ) : null}
    </>
  );
}
