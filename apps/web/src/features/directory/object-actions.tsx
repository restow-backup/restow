import { CircleCheck, CircleMinus, KeyRound, PlugZap, RotateCcw, Trash2 } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { PasswordInput } from "@/components/forms/password-input";
import type { RowAction } from "@/components/kit";
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
  removalBlock,
  syncResultKey,
} from "./presenters";
import type { ProtectedObject, ProtectionAction } from "./types";

/**
 * What to show instead of the plain "Remove" confirmation when the account
 * has backups or a legal hold: Restow never deletes backups as a side effect,
 * so the account is excluded from protection and its backups expire with
 * retention. Exported (only) for object-actions.test.tsx.
 */
export function RemoveBlockedDialog({
  object,
  block,
  canExclude,
  pending,
  open,
  onOpenChange,
  onExclude,
}: {
  object: ProtectedObject;
  block: "legal_hold" | "has_backups";
  canExclude: boolean;
  pending: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onExclude: () => void;
}) {
  const { t } = useTranslation("directory");
  const { t: tc } = useTranslation();
  const name = objectTitle(object);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("actions.removeBlocked.title", { name })}</DialogTitle>
          <DialogDescription>
            {block === "legal_hold"
              ? t("actions.removeBlocked.legalHold")
              : t("actions.removeBlocked.hasBackups", { count: object.snapshotCount })}
          </DialogDescription>
        </DialogHeader>
        {block === "has_backups" && !canExclude ? (
          <p className="text-sm text-muted-foreground">
            {t("actions.removeBlocked.alreadyExcluded")}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            {tc("actions.cancel")}
          </Button>
          {block === "has_backups" && canExclude ? (
            <Button onClick={onExclude} loading={pending}>
              {t("actions.removeBlocked.exclude")}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

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
 * stop), return to the rules, and remove an IMAP account that has no backups;
 * for an IMAP account also its own password and a login test. Returned as row
 * actions (the "…" menu and the context menu of the object's row show the same
 * entries, see components/kit row-actions) with the dialogs they open, which the
 * row renders once.
 */
export function useObjectActions(object: ProtectedObject): {
  actions: RowAction[];
  dialogs: React.ReactNode;
} {
  const { t } = useTranslation("directory");
  const { t: tc } = useTranslation();
  const setProtection = useSetProtection();
  const removeAccount = useDeleteAccount();
  const testCredential = useTestObjectCredential();
  const [confirm, setConfirm] = React.useState<"exclude" | "remove" | null>(null);
  const [credentialDialogOpen, setCredentialDialogOpen] = React.useState(false);

  const available = availableActions(object);
  const block = removalBlock(object);
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

  const actions: RowAction[] = [];
  if (available.include) {
    actions.push({
      id: "include",
      label: t("actions.include"),
      icon: CircleCheck,
      onSelect: () => void apply("include"),
    });
  }
  if (available.exclude) {
    actions.push({
      id: "exclude",
      label: t("actions.exclude"),
      icon: CircleMinus,
      onSelect: () => setConfirm("exclude"),
    });
  }
  if (available.reset) {
    actions.push({
      id: "reset",
      label: t("actions.reset"),
      icon: RotateCcw,
      onSelect: () => void apply("reset"),
    });
  }
  if (isImap && canSetCredential(object)) {
    actions.push({
      id: "setCredential",
      label: t("credential.setAction"),
      icon: KeyRound,
      onSelect: () => setCredentialDialogOpen(true),
    });
  }
  if (isImap && canTestCredentialLogin(object)) {
    actions.push({
      id: "testCredential",
      label: t("credential.testAction"),
      icon: PlugZap,
      onSelect: () => void testLogin(),
    });
  }
  if (available.remove) {
    actions.push({
      id: "remove",
      label: t("actions.remove"),
      icon: Trash2,
      destructive: true,
      onSelect: () => setConfirm("remove"),
    });
  }

  const dialogs = (
    <>
      <ConfirmDialog
        open={confirm === "exclude"}
        onOpenChange={(open) => setConfirm(open ? "exclude" : null)}
        title={t("actions.excludeConfirm.title", { name })}
        description={t("actions.excludeConfirm.description")}
        confirmLabel={t("actions.excludeConfirm.confirm")}
        pending={setProtection.isPending}
        onConfirm={() => void apply("exclude")}
      />
      {available.remove && block ? (
        <RemoveBlockedDialog
          object={object}
          block={block}
          canExclude={available.exclude}
          pending={setProtection.isPending}
          open={confirm === "remove"}
          onOpenChange={(open) => setConfirm(open ? "remove" : null)}
          onExclude={() => void apply("exclude")}
        />
      ) : available.remove ? (
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
      ) : null}
      {isImap ? (
        <SetCredentialDialog
          object={object}
          open={credentialDialogOpen}
          onOpenChange={setCredentialDialogOpen}
        />
      ) : null}
    </>
  );

  return { actions, dialogs };
}
