import { Info, TriangleAlert } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { Field, messageId } from "@/components/forms/field";
import { ErrorState, StatusBadge } from "@/components/kit";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { FolderPicker } from "@/features/file-shares/components/folder-picker";
import { useRestoreTargets, useShares } from "@/features/file-shares/hooks";
import "@/features/file-shares/i18n";
import { ApiError } from "@/lib/api";

import {
  type BackupJob,
  COPY_CONFIRM_PROBLEM,
  COPY_UNSAFE_TARGET_PROBLEM,
  type JobDefaults,
  RESTORE_NOT_ALLOWED_PROBLEM,
} from "../api.js";
import type { FormProblem } from "../form.js";
import { useCreateBackupJob, useJobDefaults, useUpdateBackupJob } from "../hooks.js";
import { jobErrorKey } from "../problems.js";
import {
  type CopyJobDraft,
  checkCopyJobDraft,
  cleanFolder,
  copyCreateInputOf,
  copyUpdateInputOf,
  draftOfCopyJob,
  mirrorConfirmationMatches,
  newCopyJobDraft,
} from "../share-form.js";
import type { JobsAccess } from "./access-note.js";
import { EditorSection } from "./editor-section.js";
import { ShareScheduleFields } from "./share-schedule-fields.js";

export interface CopyPrefill {
  source?: string | null;
  target?: string | null;
  folder?: string | null;
}

export interface CopyJobEditorProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The job to change; null creates one. */
  job: BackupJob | null;
  /** Source, target and folder a new job starts with (from the address). */
  prefill?: CopyPrefill;
  access: JobsAccess;
  onSaved: (change: "created" | "updated", job: BackupJob) => void;
}

/** A mirror the server wants confirmed (409, 4.10 rule 4). */
interface MirrorConfirm {
  folder: string;
  entries: number | null;
  targetName: string;
}

export function mirrorConfirmOf(error: unknown): MirrorConfirm | null {
  if (
    !(error instanceof ApiError) ||
    error.status !== 409 ||
    error.problem?.type !== COPY_CONFIRM_PROBLEM
  ) {
    return null;
  }
  const problem = error.problem as Record<string, unknown>;
  return {
    folder: typeof problem.folder === "string" ? problem.folder : "",
    entries: typeof problem.entries === "number" ? problem.entries : null,
    targetName: typeof problem.targetName === "string" ? problem.targetName : "",
  };
}

/** The words of a refused copy job: the copy rules of 4.10 by name, else the jobs' own. */
export function copyErrorKey(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.problem?.type === COPY_UNSAFE_TARGET_PROBLEM) {
      const rule = (error.problem as Record<string, unknown>).rule;
      if (rule === "same_share" || rule === "share_root" || rule === "retired") {
        return `backupjobs:copyEditor.rules.${rule}`;
      }
      return "backupjobs:copyEditor.rules.unsafe";
    }
    if (error.problem?.type === RESTORE_NOT_ALLOWED_PROBLEM) {
      return "backupjobs:copyEditor.rules.restore_not_allowed";
    }
  }
  return jobErrorKey(error);
}

/**
 * The editor of a copy job (docs/FILESHARES.md 12.6): the share it copies from, the share and
 * folder it copies into (only shares that allow restores into them), overwrite or mirror, the
 * permissions and the check, and when it runs. A copy is not a backup: the target holds the
 * latest state only. A mirror into a folder that is not empty is confirmed by typing the folder.
 */
export function CopyJobEditor({
  open,
  onOpenChange,
  job,
  prefill = {},
  access,
  onSaved,
}: CopyJobEditorProps) {
  const { t } = useTranslation("backupjobs");
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 p-0 sm:max-w-2xl"
        data-slot="copy-job-editor"
      >
        <SheetHeader className="border-b border-border p-6 pr-12">
          <SheetTitle className="text-lg">
            {job ? t("editor.editTitle", { name: job.name }) : t("editor.createTitle.copy")}
          </SheetTitle>
          <SheetDescription>{t("editor.description.copy")}</SheetDescription>
          <div>
            <StatusBadge tone="warning" icon data-slot="not-a-backup">
              {t("copyEditor.notBackup")}
            </StatusBadge>
          </div>
        </SheetHeader>
        {open ? (
          <Loader
            key={job?.id ?? "new"}
            job={job}
            prefill={prefill}
            access={access}
            onSaved={onSaved}
            onClose={() => onOpenChange(false)}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function Loader({
  job,
  prefill,
  access,
  onSaved,
  onClose,
}: {
  job: BackupJob | null;
  prefill: CopyPrefill;
  access: JobsAccess;
  onSaved: CopyJobEditorProps["onSaved"];
  onClose: () => void;
}) {
  const { t } = useTranslation("backupjobs");
  const defaults = useJobDefaults("copy", job === null);
  if (job === null && defaults.isError) {
    return (
      <div className="p-6">
        <ErrorState
          title={t("editor.loadError")}
          error={defaults.error}
          onRetry={() => void defaults.refetch()}
          retrying={defaults.isFetching}
        />
      </div>
    );
  }
  if (job === null && !defaults.data) {
    return (
      <div aria-busy="true" className="space-y-4 p-6">
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  return (
    <Form
      job={job}
      defaults={defaults.data}
      prefill={prefill}
      access={access}
      onSaved={onSaved}
      onClose={onClose}
    />
  );
}

function Form({
  job,
  defaults,
  prefill,
  access,
  onSaved,
  onClose,
}: {
  job: BackupJob | null;
  defaults: JobDefaults | undefined;
  prefill: CopyPrefill;
  access: JobsAccess;
  onSaved: CopyJobEditorProps["onSaved"];
  onClose: () => void;
}) {
  const { t } = useTranslation("backupjobs");
  const [draft, setDraft] = React.useState<CopyJobDraft>(() =>
    job ? draftOfCopyJob(job) : newCopyJobDraft(defaults, prefill),
  );
  const [attempted, setAttempted] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<unknown>(null);
  const [confirm, setConfirm] = React.useState<MirrorConfirm | null>(null);
  const [typed, setTyped] = React.useState("");
  const [picking, setPicking] = React.useState(false);
  const shares = useShares();
  const targets = useRestoreTargets();
  const create = useCreateBackupJob();
  const update = useUpdateBackupJob(job?.id ?? "");
  const closed = access.block !== null;
  const formId = React.useId();
  const id = (name: string) => `${formId}-${name}`;
  const problems = checkCopyJobDraft(draft);
  const shown = attempted ? problems : {};
  const text = (problem: FormProblem | undefined) =>
    problem ? t(`problems.form.${problem.code}`, problem.values ?? {}) : undefined;
  const edit = (patch: Partial<CopyJobDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setError(null);
    setConfirm(null);
    setTyped("");
  };

  const sources = (shares.data?.items ?? []).filter((share) => share.retiredAt === null);
  const targetShares = (targets.data?.items ?? []).filter((share) => share.id !== draft.sourceId);
  const target = targetShares.find((share) => share.id === draft.targetId);

  const save = async (confirmMirror: boolean) => {
    setAttempted(true);
    if (Object.keys(problems).length > 0 || closed) return;
    setSaving(true);
    setError(null);
    try {
      if (job) {
        const patch = copyUpdateInputOf(job, draft, confirmMirror);
        onSaved("updated", patch ? await update.mutateAsync(patch) : job);
      } else {
        onSaved("created", await create.mutateAsync(copyCreateInputOf(draft, confirmMirror)));
      }
      onClose();
    } catch (cause) {
      const wanted = mirrorConfirmOf(cause);
      if (wanted) {
        setConfirm(wanted);
        setTyped("");
      } else {
        setError(cause);
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void save(false);
      }}
    >
      <div className="flex-1 space-y-4 overflow-y-auto p-6">
        {attempted && Object.keys(problems).length > 0 ? (
          <Alert variant="destructive">
            <TriangleAlert aria-hidden="true" />
            <AlertTitle>{t("editor.fix.title")}</AlertTitle>
            <AlertDescription>{t("editor.fix.description")}</AlertDescription>
          </Alert>
        ) : null}
        {error ? (
          <Alert variant="destructive" data-slot="save-error">
            <TriangleAlert aria-hidden="true" />
            <AlertDescription>{t(copyErrorKey(error))}</AlertDescription>
          </Alert>
        ) : null}
        {confirm ? (
          <Alert variant="destructive" data-slot="mirror-confirm">
            <TriangleAlert aria-hidden="true" />
            <AlertTitle>{t("copyEditor.confirm.title")}</AlertTitle>
            <AlertDescription className="space-y-3">
              <p>
                {confirm.entries === null
                  ? t("copyEditor.confirm.unreadable", {
                      folder: confirm.folder,
                      share: confirm.targetName,
                    })
                  : t("copyEditor.confirm.notEmpty", {
                      folder: confirm.folder,
                      share: confirm.targetName,
                      count: confirm.entries,
                    })}
              </p>
              <Field
                id={id("confirm")}
                label={t("copyEditor.confirm.type", { folder: confirm.folder })}
              >
                <Input
                  id={id("confirm")}
                  value={typed}
                  onChange={(event) => setTyped(event.target.value)}
                  autoComplete="off"
                  aria-describedby={messageId(id("confirm"))}
                />
              </Field>
              <Button
                type="button"
                variant="destructive"
                disabled={!mirrorConfirmationMatches(typed, confirm.folder)}
                loading={saving}
                onClick={() => void save(true)}
                data-action="confirm-mirror"
              >
                {t("copyEditor.confirm.action")}
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}
        <fieldset disabled={closed} className="mx-0 block min-w-0 space-y-4 border-0 p-0">
          <EditorSection id={id("general")} title={t("editor.general.title")}>
            <Field
              id={id("name")}
              label={t("editor.general.name")}
              hint={t("editor.general.nameHint.copy")}
              error={text(shown.name)}
            >
              <Input
                id={id("name")}
                value={draft.name}
                onChange={(event) => edit({ name: event.target.value })}
                aria-describedby={messageId(id("name"))}
              />
            </Field>
            <div className="flex items-center gap-3">
              <Switch
                id={id("enabled")}
                checked={draft.enabled}
                onCheckedChange={(checked) => edit({ enabled: checked === true })}
              />
              <Label htmlFor={id("enabled")}>{t("shareEditor.enabled")}</Label>
            </div>
          </EditorSection>

          <EditorSection
            id={id("where")}
            title={t("copyEditor.where.title")}
            description={t("copyEditor.where.description")}
          >
            <Field
              id={id("source")}
              label={t("copyEditor.where.source")}
              error={text(shown.source)}
            >
              <Select
                value={draft.sourceId}
                onValueChange={(value) =>
                  edit({ sourceId: value, ...(value === draft.targetId ? { targetId: "" } : {}) })
                }
              >
                <SelectTrigger
                  id={id("source")}
                  aria-describedby={messageId(id("source"))}
                  data-field="source"
                >
                  <SelectValue placeholder={t("copyEditor.where.pick")} />
                </SelectTrigger>
                <SelectContent>
                  {sources.map((share) => (
                    <SelectItem key={share.id} value={share.id}>
                      {share.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field
              id={id("target")}
              label={t("copyEditor.where.target")}
              hint={t("copyEditor.where.targetHint")}
              error={text(shown.target)}
            >
              <Select
                value={draft.targetId}
                onValueChange={(value) => edit({ targetId: value, targetFolder: "" })}
              >
                <SelectTrigger
                  id={id("target")}
                  aria-describedby={messageId(id("target"))}
                  data-field="target"
                >
                  <SelectValue placeholder={t("copyEditor.where.pick")} />
                </SelectTrigger>
                <SelectContent>
                  {targetShares.map((share) => (
                    <SelectItem key={share.id} value={share.id}>
                      {share.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            {targets.data && targetShares.length === 0 ? (
              <p className="text-sm text-muted-foreground" data-slot="no-targets">
                {t("copyEditor.where.noTargets")}
              </p>
            ) : null}
            <Field
              id={id("folder")}
              label={t("copyEditor.where.folder")}
              hint={t("copyEditor.where.folderHint")}
              error={text(shown.targetFolder)}
            >
              <div className="flex gap-2">
                <Input
                  id={id("folder")}
                  value={draft.targetFolder}
                  onChange={(event) => edit({ targetFolder: event.target.value })}
                  className="font-mono"
                  aria-describedby={messageId(id("folder"))}
                />
                <Button
                  type="button"
                  variant="outline"
                  disabled={!target}
                  onClick={() => setPicking((current) => !current)}
                  data-action="pick-target-folder"
                >
                  {t("copyEditor.where.browse")}
                </Button>
              </div>
            </Field>
            {picking && target ? (
              <FolderPicker
                shareId={target.id}
                mode="one"
                value={cleanFolder(draft.targetFolder) ? [cleanFolder(draft.targetFolder)] : []}
                onChange={(next) => {
                  edit({ targetFolder: next[0] ?? "" });
                  setPicking(false);
                }}
              />
            ) : null}
          </EditorSection>

          <EditorSection id={id("mode")} title={t("copyEditor.mode.title")}>
            <RadioGroup
              value={draft.mode}
              onValueChange={(value) => edit({ mode: value as CopyJobDraft["mode"] })}
              aria-label={t("copyEditor.mode.title")}
              className="grid gap-3"
            >
              {(["overwrite", "mirror"] as const).map((mode) => (
                <Label
                  key={mode}
                  htmlFor={id(`mode-${mode}`)}
                  className="flex items-start gap-3 rounded-md border p-3 font-normal"
                >
                  <RadioGroupItem id={id(`mode-${mode}`)} value={mode} className="mt-0.5" />
                  <span className="grid gap-0.5">
                    <span className="font-medium">{t(`copyEditor.mode.${mode}.label`)}</span>
                    <span className="text-xs text-muted-foreground">
                      {t(`copyEditor.mode.${mode}.description`)}
                    </span>
                  </span>
                </Label>
              ))}
            </RadioGroup>
            {draft.mode === "mirror" ? (
              <Alert data-slot="mirror-warning">
                <Info aria-hidden="true" />
                <AlertDescription>{t("copyEditor.mode.mirrorWarning")}</AlertDescription>
              </Alert>
            ) : null}
            <div className="flex items-start gap-3">
              <Switch
                id={id("permissions")}
                checked={draft.restorePermissions}
                onCheckedChange={(checked) => edit({ restorePermissions: checked === true })}
              />
              <div className="grid gap-0.5">
                <Label htmlFor={id("permissions")}>{t("copyEditor.permissions")}</Label>
                <p className="text-xs text-muted-foreground">{t("copyEditor.permissionsHint")}</p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <Switch
                id={id("verify")}
                checked={draft.verify ?? target?.protocol === "nfs"}
                onCheckedChange={(checked) => edit({ verify: checked === true })}
              />
              <div className="grid gap-0.5">
                <Label htmlFor={id("verify")}>{t("copyEditor.verify")}</Label>
                <p className="text-xs text-muted-foreground">{t("copyEditor.verifyHint")}</p>
              </div>
            </div>
          </EditorSection>

          <EditorSection id={id("schedule")} title={t("shareEditor.schedule.title")}>
            <div className="flex items-center gap-3">
              <Switch
                id={id("scheduleOn")}
                checked={draft.scheduleOn}
                onCheckedChange={(checked) => edit({ scheduleOn: checked === true })}
              />
              <Label htmlFor={id("scheduleOn")}>{t("shareEditor.schedule.on")}</Label>
            </div>
            {draft.scheduleOn ? (
              <ShareScheduleFields
                idPrefix={id("schedule")}
                draft={draft.schedule}
                onChange={(schedule) => edit({ schedule })}
                problems={shown.schedule ?? {}}
              />
            ) : (
              <p className="text-sm text-muted-foreground">{t("shareEditor.schedule.manual")}</p>
            )}
            <p className="text-xs text-muted-foreground">{t("copyEditor.latestOnly")}</p>
          </EditorSection>
        </fieldset>
      </div>
      <SheetFooter className="border-t border-border p-4 sm:flex-row sm:justify-end">
        <Button type="button" variant="outline" onClick={onClose}>
          {t("common:actions.cancel")}
        </Button>
        <Button
          type="submit"
          loading={saving}
          disabled={closed || confirm !== null}
          data-action="save-copy-job"
        >
          {job ? t("editor.save") : t("editor.create")}
        </Button>
      </SheetFooter>
    </form>
  );
}
