import {
  CircleCheck,
  CircleMinus,
  CircleX,
  KeyRound,
  Play,
  PlugZap,
  RotateCcw,
  ShieldOff,
  Trash2,
} from "lucide-react";
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
import { useActionFeedback } from "@/features/jobs/components/actions";
import "@/features/jobs/i18n";
import { isLive } from "@/features/jobs/presenters";
import { errorMessageKey } from "@/lib/api";

import { ConfirmDialog } from "./confirm-dialog";
import {
  useBackupObject,
  useConfirmInactive,
  useDeleteAccount,
  useDismissLoginQuestion,
  useSetObjectCredential,
  useSetProtection,
  useTestObjectCredential,
} from "./hooks";
import {
  availableActions,
  canSetCredential,
  canTestCredentialLogin,
  credentialProbeFailureKey,
  loginQuestionOf,
  objectErrorKey,
  objectTitle,
  removalBlock,
  syncResultKey,
} from "./presenters";
import type { ProtectedObject, ProtectionAction, SourceStatus } from "./types";

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
 * Why "Back up now" cannot run for an object, as an i18n key of the `backup` namespace (the same
 * texts as the backup page), or null when it can. Excluded and orphaned objects have no entry at
 * all (see {@link useBackupNowAction}).
 */
export function backupNowBlockKey(
  object: ProtectedObject,
  sourceStatus: SourceStatus | undefined,
): string | null {
  if (sourceStatus === "pending") {
    return "blocked.source_pending";
  }
  if (sourceStatus === "disabled") {
    return "blocked.source_disabled";
  }
  if (object.credential?.authMode === "per_mailbox" && !object.credential.hasPassword) {
    return "noPassword";
  }
  const job = object.latestBackupJob;
  if (job && isLive(job.status)) {
    return job.status === "active" ? "blocked.running" : "blocked.waiting";
  }
  return null;
}

/**
 * "Back up now" in the row menu: backs up exactly this object through the call of the backup
 * page and reports as it does. Null for objects that are not backed up (excluded, not selected,
 * orphaned, except an IMAP account confirmed as shut down); closed with a reason while the source cannot run, an IMAP account has no password or
 * a backup of it is already queued or running. Like the backup page, it has no role or demo gate
 * of its own: the API (technician level, allowed in the demo) refuses what the viewer may not do.
 */
export function useBackupNowAction(
  object: ProtectedObject,
  sourceStatus: SourceStatus | undefined,
): RowAction | null {
  const { t } = useTranslation("directory");
  const { t: tb } = useTranslation("backup");
  const backup = useBackupObject();
  const feedback = useActionFeedback();
  // An IMAP account confirmed as shut down offers it too: the run probes its login first and
  // backs the account up when the login works again.
  const shutDown = object.status === "orphaned" && object.statusReason === "login_refused";
  if ((object.status !== "active" && !shutDown) || object.notSelected) {
    return null;
  }
  const blockKey = backupNowBlockKey(object, sourceStatus);
  const reason =
    blockKey === "noPassword"
      ? t("rowActions.backupNowNoPassword")
      : blockKey
        ? tb(blockKey)
        : undefined;
  const name = objectTitle(object);
  return {
    id: "backupNow",
    label: t("rowActions.backupNow"),
    icon: Play,
    disabled: reason !== undefined || backup.isPending,
    reason,
    onSelect: () =>
      backup.mutate(object.id, {
        onSuccess: (result) => feedback.queued(result, name),
        onError: (error) => feedback.failed(error),
      }),
  };
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
  const confirmInactive = useConfirmInactive();
  const dismissQuestion = useDismissLoginQuestion();
  const [confirm, setConfirm] = React.useState<
    "exclude" | "remove" | "inactive" | "loginShutDown" | null
  >(null);
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

  // "Yes, intended": the object stays not backed up, amber turns grey (audited on the server).
  const confirmIntended = async () => {
    try {
      await confirmInactive.mutateAsync({ objectId: object.id });
      toast.success(t("inactive.done.one", { name }));
      setConfirm(null);
    } catch (error) {
      failed(error);
    }
  };

  // "Yes, shut down": the account turns grey; the login is still checked once a week.
  const confirmShutDown = async () => {
    try {
      await confirmInactive.mutateAsync({ objectId: object.id });
      toast.success(t("inactive.loginQuestion.doneYes", { name }));
      setConfirm(null);
    } catch (error) {
      failed(error);
    }
  };

  // "No, fix the login": the question stays answered; a per-mailbox account gets its password
  // dialog, any other points at the source (its app password or master login).
  const answerNo = async () => {
    try {
      await dismissQuestion.mutateAsync(object.id);
      if (canSetCredential(object)) {
        toast.success(t("inactive.loginQuestion.doneNo", { name }));
        setCredentialDialogOpen(true);
      } else {
        toast.success(t("inactive.loginQuestion.doneNo", { name }), {
          description: t("inactive.loginQuestion.checkSource", { source: object.sourceName }),
        });
      }
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
  const asked = loginQuestionOf(object);
  if (available.answerLoginQuestion && asked) {
    actions.push({
      id: "loginQuestionYes",
      label:
        asked.state === "open"
          ? t("inactive.loginQuestion.yes")
          : t("inactive.loginQuestion.yesAfterNo"),
      icon: ShieldOff,
      onSelect: () => setConfirm("loginShutDown"),
    });
    if (asked.state === "open") {
      actions.push({
        id: "loginQuestionNo",
        label: t("inactive.loginQuestion.no"),
        icon: CircleX,
        onSelect: () => void answerNo(),
      });
    }
  }
  if (available.confirmInactive) {
    actions.push({
      id: "confirmInactive",
      label: t("inactive.confirmAction"),
      icon: ShieldOff,
      onSelect: () => setConfirm("inactive"),
    });
  }
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
      {available.confirmInactive ? (
        <ConfirmDialog
          open={confirm === "inactive"}
          onOpenChange={(open) => setConfirm(open ? "inactive" : null)}
          title={t("inactive.confirm.title", { name })}
          description={t("inactive.confirm.description")}
          confirmLabel={t("inactive.confirmAction")}
          pending={confirmInactive.isPending}
          onConfirm={() => void confirmIntended()}
        />
      ) : null}
      {available.answerLoginQuestion ? (
        <ConfirmDialog
          open={confirm === "loginShutDown"}
          onOpenChange={(open) => setConfirm(open ? "loginShutDown" : null)}
          title={t("inactive.loginConfirm.title", { name })}
          description={t("inactive.loginConfirm.description")}
          confirmLabel={t("inactive.loginQuestion.yes")}
          pending={confirmInactive.isPending}
          onConfirm={() => void confirmShutDown()}
        />
      ) : null}
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
