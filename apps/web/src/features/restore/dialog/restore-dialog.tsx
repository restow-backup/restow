import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArchiveRestore,
  Copy,
  Download,
  FolderInput,
  type LucideIcon,
  SkipForward,
  UserRound,
} from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { toast } from "@/components/ui/sonner";
import { Textarea } from "@/components/ui/textarea";
import type {
  ObjectKind,
  RestoreMode,
  RestoreTargetType,
  Snapshot,
  SnapshotObject,
} from "@/features/restore/api";
import { objectLabel } from "@/features/restore/explorer/entry-icon";
import { useSnapshotLabel } from "@/features/restore/explorer/restore-point-label";
import { useEntryLabel } from "@/features/restore/explorer/use-entry-label";
import {
  type RestoreErrorDisplay,
  type RestoreFormContext,
  type RestoreFormErrors,
  type RestoreFormField,
  type RestoreFormState,
  type RestoreScope,
  buildRestoreRequest,
  hasErrors,
  initialFormState,
  modeApplies,
  originalTargetDescriptionKey,
  restoreErrorOf,
  restoreModesFor,
  restoreStamp,
  targetAvailable,
  validateRestoreForm,
} from "@/features/restore/lib/request";
import { countSelection } from "@/features/restore/lib/selection";
import { useOpenJob } from "@/features/restore/navigation";
import { useCreateRestore, useRestoreTargets } from "@/features/restore/use-restore-data";
import { setupStateQueryOptions } from "@/lib/api";
import { formatBytes } from "@/lib/format";
import { useSession } from "@/lib/session";
import { cn } from "@/lib/utils";

/** What the dialog restores, from where, and how it opens. */
export interface RestoreDialogRequest {
  object: SnapshotObject;
  snapshot: Snapshot;
  scope: RestoreScope;
  /** Target to preselect when available. */
  target?: RestoreTargetType;
  /** Only this target is possible (OneDrive's own versions can only be downloaded). */
  onlyTarget?: RestoreTargetType;
}

export function RestoreDialog({
  request,
  onClose,
  onStarted,
}: {
  request: RestoreDialogRequest | null;
  onClose: () => void;
  /** Called after the restore was accepted (e.g. to clear the selection). */
  onStarted?: () => void;
}) {
  return (
    <Dialog open={request !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      {request ? (
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl">
          <RestoreForm request={request} onClose={onClose} onStarted={onStarted} />
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

/** Fields in the order the form shows them. */
const FIELD_ORDER: readonly RestoreFormField[] = ["target", "accountId", "reason"];

const ACCOUNT_HINT_KEYS: Record<ObjectKind, string> = {
  mailbox: "dialog.target.accountHint.mailbox",
  onedrive: "dialog.target.accountHint.onedrive",
  imap: "dialog.target.accountHint.imap",
};

function RestoreForm({
  request,
  onClose,
  onStarted,
}: {
  request: RestoreDialogRequest;
  onClose: () => void;
  onStarted?: () => void;
}) {
  const { t, i18n } = useTranslation("restore");
  const { t: tAny } = useTranslation();
  const language = i18n.resolvedLanguage ?? i18n.language;
  const { isProviderAdmin, activeTenant } = useSession();
  const snapshotLabel = useSnapshotLabel();
  const entryLabel = useEntryLabel(request.object.kind);
  const openJob = useOpenJob();
  const create = useCreateRestore();
  const { object, snapshot, scope } = request;
  const label = objectLabel(object);
  const setupState = useQuery(setupStateQueryOptions);
  const demoMode = setupState.data?.demo.enabled === true;

  const context: RestoreFormContext = {
    canRestoreElsewhere:
      request.onlyTarget === undefined &&
      (isProviderAdmin || activeTenant?.role === "tenant_admin"),
    reasonRequired: !object.own,
    originalAvailable: request.onlyTarget === undefined && object.status !== "orphaned",
    downloadOnly: demoMode,
  };
  const [state, setState] = React.useState<RestoreFormState>(() =>
    initialFormState(context, request.onlyTarget ?? request.target),
  );
  const [errors, setErrors] = React.useState<RestoreFormErrors>({});
  // One stamp per opening: the folder name the dialog shows is the one the restore uses.
  const [openedAt] = React.useState(() => new Date());
  const restoreFolderName = t("dialog.restoreFolderName", { stamp: restoreStamp(openedAt) });
  const [failure, setFailure] = React.useState<RestoreErrorDisplay | null>(null);
  const accountRef = React.useRef<HTMLInputElement>(null);
  const reasonRef = React.useRef<HTMLTextAreaElement>(null);
  // Bring the first field with a problem into view, so no message stays below the fold.
  const focusField = (field: RestoreFormField | null | undefined) => {
    if (field === "accountId") accountRef.current?.focus();
    if (field === "reason") reasonRef.current?.focus();
  };
  const targets = useRestoreTargets(
    object.id,
    context.canRestoreElsewhere && state.target === "other",
  );

  const update = (patch: Partial<RestoreFormState>) => {
    setState((current) => ({ ...current, ...patch }));
    setErrors((current) => {
      const next = { ...current };
      for (const key of Object.keys(patch)) {
        delete next[key as keyof RestoreFormErrors];
      }
      return next;
    });
    setFailure(null);
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const found = validateRestoreForm(state, context);
    setErrors(found);
    if (hasErrors(found)) {
      focusField(FIELD_ORDER.find((field) => found[field] !== undefined));
      return;
    }
    const now = new Date();
    const body = buildRestoreRequest({
      snapshotId: snapshot.id,
      objectKind: object.kind,
      objectLabel: label,
      scope,
      state,
      context,
      restoreFolderName,
      now,
    });
    create.mutate(body, {
      onSuccess: (created) => {
        toast.success(
          t(state.target === "download" ? "dialog.started.download" : "dialog.started.restore"),
          { description: t("dialog.started.description") },
        );
        onStarted?.();
        onClose();
        openJob(created.id);
      },
      onError: (error) => {
        const display = restoreErrorOf(error);
        if (display.field) {
          setErrors((current) => ({ ...current, [display.field as string]: display.key }));
          focusField(display.field);
        } else {
          setFailure(display);
        }
      },
    });
  };

  const download = state.target === "download";
  const fieldError = (key: keyof RestoreFormErrors) => {
    const value = errors[key];
    return value ? tAny(value) : undefined;
  };

  const targetChoices: Choice<RestoreTargetType>[] = [
    {
      value: "original",
      label: t("dialog.target.original"),
      description: t(originalTargetDescriptionKey(object.kind, state.mode), {
        object: label,
        folder: restoreFolderName,
      }),
      icon: ArchiveRestore,
      disabled: !targetAvailable("original", context),
      disabledHint: demoMode
        ? t("dialog.target.demoDownloadOnly")
        : object.status === "orphaned"
          ? t("dialog.target.originalGone")
          : undefined,
    },
    {
      value: "other",
      label: t("dialog.target.other"),
      description: t("dialog.target.otherDescription"),
      icon: FolderInput,
      disabled: !targetAvailable("other", context),
      disabledHint: demoMode
        ? t("dialog.target.demoDownloadOnly")
        : request.onlyTarget
          ? undefined
          : t("dialog.target.otherRequiresAdmin"),
    },
    {
      value: "download",
      label: t("dialog.target.download"),
      description: t("dialog.target.downloadDescription"),
      icon: Download,
    },
  ];

  // A restore only ever keeps both or skips existing items, never overwrites
  // one (see restoreModesFor).
  const allModeChoices: Choice<RestoreMode>[] = [
    {
      value: "rename",
      label: t("dialog.mode.rename"),
      description:
        object.kind === "onedrive"
          ? t("dialog.mode.renameDescriptionFiles")
          : t("dialog.mode.renameDescriptionMail", { folder: restoreFolderName }),
      icon: Copy,
    },
    {
      value: "skip",
      label: t("dialog.mode.skip"),
      description: t("dialog.mode.skipDescription"),
      icon: SkipForward,
    },
  ];
  const allowedModes = restoreModesFor(object.kind);
  const modeChoices = allModeChoices.filter((choice) => allowedModes.includes(choice.value));

  return (
    <form onSubmit={submit} className="grid gap-5" noValidate>
      <DialogHeader>
        <DialogTitle>{t(download ? "dialog.titleDownload" : "dialog.title")}</DialogTitle>
        <DialogDescription>
          {t("dialog.source", { object: label, restorePoint: snapshotLabel(snapshot) })}
        </DialogDescription>
      </DialogHeader>

      <ScopeSummary scope={scope} label={entryLabel} language={language} />

      {request.onlyTarget ? (
        <p className="rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
          {t("dialog.target.onlyDownload")}
        </p>
      ) : (
        <RadioCardGroup
          name="restore-target"
          legend={t("dialog.target.label")}
          value={state.target}
          onChange={(target) => update({ target })}
          choices={targetChoices}
          error={fieldError("target")}
        />
      )}

      {state.target === "other" ? (
        <div className="space-y-1.5">
          <Label htmlFor="restore-account">{t("dialog.target.account")}</Label>
          <Input
            id="restore-account"
            ref={accountRef}
            list="restore-account-suggestions"
            value={state.accountId}
            onChange={(event) => update({ accountId: event.target.value })}
            placeholder={t("dialog.target.accountPlaceholder")}
            aria-invalid={errors.accountId ? true : undefined}
            aria-describedby="restore-account-message"
            autoComplete="off"
            spellCheck={false}
          />
          <datalist id="restore-account-suggestions">
            {(targets.data ?? []).map((account) => (
              <option key={account.id} value={account.externalId}>
                {account.displayName ?? account.externalId}
              </option>
            ))}
          </datalist>
          <p
            id="restore-account-message"
            role={errors.accountId ? "alert" : undefined}
            className={cn(
              "text-xs",
              errors.accountId ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {fieldError("accountId") ?? t(ACCOUNT_HINT_KEYS[object.kind])}
          </p>
        </div>
      ) : null}

      {modeApplies(state.target) ? (
        <RadioCardGroup
          name="restore-mode"
          legend={t("dialog.mode.label")}
          value={state.mode}
          onChange={(mode) => update({ mode })}
          choices={modeChoices}
        />
      ) : null}

      {context.reasonRequired ? (
        <div className="space-y-1.5">
          <Alert variant="info">
            <UserRound />
            <AlertTitle>{t("dialog.reason.impersonationTitle")}</AlertTitle>
            <AlertDescription>
              {t("dialog.reason.impersonation", { owner: object.ownerEmail ?? label })}
            </AlertDescription>
          </Alert>
          <Label htmlFor="restore-reason">{t("dialog.reason.label")}</Label>
          <Textarea
            id="restore-reason"
            ref={reasonRef}
            value={state.reason}
            onChange={(event) => update({ reason: event.target.value })}
            placeholder={t("dialog.reason.placeholder")}
            rows={3}
            maxLength={2000}
            aria-invalid={errors.reason ? true : undefined}
            aria-describedby="restore-reason-message"
          />
          <p
            id="restore-reason-message"
            role={errors.reason ? "alert" : undefined}
            className={cn("text-xs", errors.reason ? "text-destructive" : "text-muted-foreground")}
          >
            {fieldError("reason") ?? t("dialog.reason.help")}
          </p>
        </div>
      ) : null}

      {failure ? (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>{t("dialog.errors.title")}</AlertTitle>
          <AlertDescription>{tAny(failure.key)}</AlertDescription>
        </Alert>
      ) : null}

      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onClose} disabled={create.isPending}>
          {tAny("actions.cancel")}
        </Button>
        <Button type="submit" loading={create.isPending}>
          {download ? <Download /> : <ArchiveRestore />}
          {t(download ? "dialog.submitDownload" : "dialog.submit")}
        </Button>
      </DialogFooter>
    </form>
  );
}

const PREVIEW_ENTRIES = 5;

/** What will be restored, in words: everything, or the first few entries and the rest counted. */
function ScopeSummary({
  scope,
  label,
  language,
}: {
  scope: RestoreScope;
  label: ReturnType<typeof useEntryLabel>;
  language: string;
}) {
  const { t } = useTranslation("restore");
  if (scope.kind === "everything") {
    return (
      <p className="rounded-md border border-border px-3 py-2 text-sm">{t("dialog.everything")}</p>
    );
  }
  const counts = countSelection(scope.selection);
  const entries = [...scope.selection.values()];
  const shown = entries.slice(0, PREVIEW_ENTRIES);
  return (
    <div className="space-y-2 rounded-md border border-border px-3 py-2 text-sm">
      <p className="font-medium">
        {[
          counts.folders > 0 ? t("explorer.selection.folders", { count: counts.folders }) : null,
          counts.items > 0 ? t("explorer.selection.items", { count: counts.items }) : null,
        ]
          .filter(Boolean)
          .join(", ")}
        {counts.bytes > 0 ? (
          <span className="font-normal text-muted-foreground">
            {" · "}
            {formatBytes(counts.bytes, language)}
          </span>
        ) : null}
      </p>
      <ul className="space-y-0.5 text-muted-foreground">
        {shown.map((entry) => (
          <li key={entry.path} className="truncate">
            {label({ kind: entry.kind, path: entry.path, subject: entry.subject })}
          </li>
        ))}
        {entries.length > shown.length ? (
          <li>{t("dialog.andMore", { count: entries.length - shown.length })}</li>
        ) : null}
      </ul>
    </div>
  );
}

interface Choice<T extends string> {
  value: T;
  label: string;
  description?: React.ReactNode;
  icon?: LucideIcon;
  disabled?: boolean;
  /** Why the choice is unavailable; shown only while disabled. */
  disabledHint?: string;
}

interface RadioCardGroupProps<T extends string> {
  name: string;
  legend: string;
  value: T;
  onChange: (value: T) => void;
  choices: readonly Choice<T>[];
  /** Translated problem with the current choice. */
  error?: string;
}

/**
 * A `RadioGroup` rendered as self-explaining cards: every option shows its
 * own description (and, disabled, why it cannot be picked) before it is
 * chosen. Built from the shadcn `RadioGroup`/`RadioGroupItem` primitives
 * (this dialog's own replacement for the old, hand-rolled `ChoiceGroup`).
 */
function RadioCardGroup<T extends string>({
  name,
  legend,
  value,
  onChange,
  choices,
  error,
}: RadioCardGroupProps<T>) {
  const errorId = `${name}-error`;
  return (
    <fieldset className="space-y-2" aria-describedby={error ? errorId : undefined}>
      <legend className="mb-2 text-sm font-medium">{legend}</legend>
      <RadioGroup
        value={value}
        onValueChange={(next) => onChange(next as T)}
        aria-invalid={error ? true : undefined}
      >
        {choices.map((choice) => {
          const Icon = choice.icon;
          const checked = value === choice.value;
          const id = `${name}-${choice.value}`;
          return (
            <Label
              key={choice.value}
              htmlFor={id}
              className={cn(
                "flex items-start gap-3 rounded-lg border border-border p-3 font-normal transition-colors",
                "has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
                choice.disabled
                  ? "cursor-not-allowed opacity-60"
                  : "cursor-pointer hover:bg-accent/50",
                checked && !choice.disabled && "border-primary bg-primary/5",
              )}
            >
              <RadioGroupItem
                id={id}
                value={choice.value}
                disabled={choice.disabled}
                className="mt-0.5"
              />
              <span className="min-w-0 space-y-0.5">
                <span className="flex items-center gap-2 text-sm font-medium">
                  {Icon ? (
                    <Icon className="size-4 text-muted-foreground" aria-hidden="true" />
                  ) : null}
                  {choice.label}
                </span>
                {choice.description ? (
                  <span className="block text-xs text-muted-foreground">{choice.description}</span>
                ) : null}
                {choice.disabled && choice.disabledHint ? (
                  <span className="block text-xs text-muted-foreground">{choice.disabledHint}</span>
                ) : null}
              </span>
            </Label>
          );
        })}
      </RadioGroup>
      {error ? (
        <p id={errorId} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}
