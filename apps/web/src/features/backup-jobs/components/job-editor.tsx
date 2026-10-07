import { Link } from "@tanstack/react-router";
import type { TFunction } from "i18next";
import { ChevronRight, Info, TriangleAlert } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { useConfirmIdentity } from "@/components/confirm-identity-dialog";
import { Field, messageId } from "@/components/forms/field";
import { ConfirmDialog, ErrorState } from "@/components/kit";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
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
import { CadenceFields } from "@/features/schedules/components/cadence-fields";
import { ExtensionSlot } from "@/lib/extensions";
import { isRecentSignInRequired } from "@/lib/recent-sign-in";
import { activeTenantPageTo } from "@/lib/tenant-paths";
import { cn } from "@/lib/utils";

import {
  type BackupJob,
  type JobDefaults,
  type JobKind,
  type JobMember,
  type JobRetention,
  type JobScopeMode,
  LIMITS,
} from "../api.js";
import {
  type JobDraft,
  type JobProblems,
  type SelectedMember,
  type SettingsDraft,
  checkJobDraft,
  createInputOf,
  draftOfJob,
  jobHasProblems,
  memberInputsOf,
  newJobDraft,
  retentionReduction,
  scopeChanged,
  updateInputOf,
} from "../form.js";
import {
  useBackupJobs,
  useCreateBackupJob,
  useJobCandidates,
  useJobDefaults,
  useJobMembers,
  useReplaceJobMembers,
  useUpdateBackupJob,
} from "../hooks.js";
import { repositoryLabel } from "../presenters.js";
import {
  type MemberConflict,
  type ProblemTarget,
  cadenceProblemOf,
  conflictsOf,
  jobErrorKey,
  jobProblemOf,
  problemTarget,
} from "../problems.js";
import { type JobsAccess, JobsAccessNote } from "./access-note.js";
import { BandwidthWindowsField, windowCheckOf } from "./bandwidth-windows-field.js";
import { EditorSection } from "./editor-section.js";
import { ExclusionsField } from "./exclusions-field.js";
import { type BrowsableMachine, FoldersField } from "./folders-field.js";
import { MemberPicker } from "./member-picker.js";
import {
  BandwidthField,
  EndpointScheduleFields,
  HooksField,
  RetentionField,
  useProblemText,
} from "./settings-fields.js";

export interface JobEditorProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kind: JobKind;
  /** The job to change; null creates a new one. */
  job: BackupJob | null;
  /** Ids of objects or machines a new job starts with (the address's `select`). */
  preselect?: readonly string[];
  /** Whether and why changes are closed (the public demo, a provider role that may only look). */
  access: JobsAccess;
  /** A job was created or changed (the page shows the toast and goes where it should). */
  onSaved: (change: "created" | "updated", job: BackupJob) => void;
}

/**
 * The job editor, a wide sheet from the right (new job and change). It holds
 * what the job covers, when it runs and, for a machine job, which folders it
 * backs up and what it leaves out. Everything is reachable with the keyboard,
 * errors are announced where they belong, and closing with unsaved changes asks
 * first. Saving is closed (with the reason said at the button) in the public
 * demo and for a role that may only look.
 */
export function JobEditor({
  open,
  onOpenChange,
  kind,
  job,
  preselect = [],
  access,
  onSaved,
}: JobEditorProps) {
  const { t } = useTranslation("backupjobs");
  const dirty = React.useRef(false);
  const [confirmingDiscard, setConfirmingDiscard] = React.useState(false);
  // The page behind the sheet says the same sentence with its own id: two elements never share one.
  const noteId = React.useId();
  const sheetAccess = React.useMemo<JobsAccess>(() => ({ ...access, noteId }), [access, noteId]);
  const title = job ? t("editor.editTitle", { name: job.name }) : t(`editor.createTitle.${kind}`);

  const requestClose = () => {
    if (dirty.current) {
      setConfirmingDiscard(true);
    } else {
      onOpenChange(false);
    }
  };

  return (
    <>
      <Sheet
        open={open}
        onOpenChange={(next) => {
          if (next) {
            onOpenChange(true);
          } else {
            requestClose();
          }
        }}
      >
        <SheetContent
          side="right"
          className="flex w-full flex-col gap-0 p-0 sm:max-w-3xl"
          data-slot="job-editor"
        >
          <SheetHeader className="border-b border-border p-6 pr-12">
            <SheetTitle className="text-lg">{title}</SheetTitle>
            <SheetDescription>{t(`editor.description.${kind}`)}</SheetDescription>
          </SheetHeader>
          {open ? (
            <EditorLoader
              key={job?.id ?? "new"}
              kind={kind}
              job={job}
              preselect={preselect}
              access={sheetAccess}
              onClose={() => {
                dirty.current = false;
                onOpenChange(false);
              }}
              onCancel={requestClose}
              onDirtyChange={(value) => {
                dirty.current = value;
              }}
              onSaved={onSaved}
            />
          ) : null}
        </SheetContent>
      </Sheet>
      <ConfirmDialog
        open={confirmingDiscard}
        onOpenChange={setConfirmingDiscard}
        title={t("editor.discard.title")}
        description={<p>{t("editor.discard.description")}</p>}
        confirmLabel={t("editor.discard.confirm")}
        cancelLabel={t("editor.discard.keep")}
        destructive
        onConfirm={() => {
          setConfirmingDiscard(false);
          dirty.current = false;
          onOpenChange(false);
        }}
      />
    </>
  );
}

interface LoaderProps {
  kind: JobKind;
  job: BackupJob | null;
  preselect: readonly string[];
  access: JobsAccess;
  onClose: () => void;
  onCancel: () => void;
  onDirtyChange: (dirty: boolean) => void;
  onSaved: JobEditorProps["onSaved"];
}

/** Waits for what the form starts from (the recommended values, and the objects of the job being changed). */
function EditorLoader(props: LoaderProps) {
  const { t } = useTranslation("backupjobs");
  // A new machine job started from chosen machines takes the folders and schedule of their systems.
  const defaults = useJobDefaults(
    props.kind,
    true,
    props.kind === "endpoint" && props.job === null ? props.preselect : [],
  );
  const members = useJobMembers(props.job?.id ?? "", props.job !== null);
  const jobs = useBackupJobs(props.kind);
  // The list of jobs says whether another one already covers all objects: the form waits for it (not for its failure).
  const waitingForJobs = jobs.isPending && jobs.fetchStatus !== "idle";
  const pending = defaults.isPending || waitingForJobs || (props.job !== null && members.isPending);
  const failed = defaults.isError
    ? defaults
    : props.job !== null && members.isError
      ? members
      : null;

  if (failed) {
    return (
      <div className="p-6">
        <ErrorState
          title={t("editor.loadError")}
          error={failed.error}
          onRetry={() => void failed.refetch()}
          retrying={failed.isFetching}
        />
      </div>
    );
  }
  if (pending || !defaults.data) {
    return (
      <div aria-busy="true" className="space-y-4 p-6">
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
        <span className="sr-only">{t("editor.loading")}</span>
      </div>
    );
  }
  // Only one job may cover "all objects not in another job": offered when no other one does.
  const otherAllJob = (jobs.data?.items ?? []).some(
    (candidate) => candidate.scopeMode === "all" && candidate.id !== props.job?.id,
  );
  return (
    <EditorForm
      {...props}
      defaults={defaults.data}
      members={members.data?.items ?? []}
      otherAllJob={otherAllJob}
    />
  );
}

/** The draft as far as the person changed it: the names the picker fills in later are not a change. */
function dirtyKey(draft: JobDraft): string {
  return JSON.stringify({ ...draft, selected: draft.selected.map((member) => member.id) });
}

/** A preselected id whose name is not known yet: the picker fills it in once its list loads. */
function placeholderMember(id: string): SelectedMember {
  return { id, kind: null, name: null, detail: null, job: null };
}

function useServerText() {
  const { t, i18n } = useTranslation("backupjobs");
  return (problem: { code: string; message: string }) =>
    i18n.exists(`backupjobs:problems.server.${problem.code}`)
      ? t(`problems.server.${problem.code}`)
      : problem.message;
}

interface FormProps extends LoaderProps {
  defaults: JobDefaults;
  members: readonly JobMember[];
  otherAllJob: boolean;
}

function EditorForm({
  kind,
  job,
  preselect,
  access,
  defaults,
  members,
  otherAllJob,
  onClose,
  onCancel,
  onDirtyChange,
  onSaved,
}: FormProps) {
  const { t } = useTranslation("backupjobs");
  const { t: tEndpoints } = useTranslation("endpoints");
  const problemText = useProblemText();
  const serverText = useServerText();
  const identity = useConfirmIdentity();
  const formId = React.useId();
  const ids = (name: string) => `${formId}-${name}`;
  const summaryRef = React.useRef<HTMLDivElement>(null);
  const nameRef = React.useRef<HTMLInputElement>(null);

  // The editor starts from this once; later changes of the lists must not overwrite the person's edits.
  const [initial] = React.useState<JobDraft>(() => {
    const base = job ? draftOfJob(job, members, defaults) : newJobDraft(kind, defaults);
    if (job) {
      return base;
    }
    if (preselect.length > 0) {
      return { ...base, selected: preselect.map(placeholderMember) };
    }
    // The natural first mail job covers everything; once another one does, new ones pick their objects.
    return kind === "mail" && !otherAllJob ? { ...base, scopeMode: "all" } : base;
  });
  const [draft, setDraft] = React.useState<JobDraft>(initial);
  const [attempted, setAttempted] = React.useState(false);
  const [attempts, setAttempts] = React.useState(0);
  const [conflicts, setConflicts] = React.useState<MemberConflict[] | null>(null);
  const [stricter, setStricter] = React.useState<{
    less: JobRetention;
    options: { moveMembers?: boolean };
  } | null>(null);
  const [saveError, setSaveError] = React.useState<unknown>(null);
  const [saving, setSaving] = React.useState(false);
  const create = useCreateBackupJob();
  const update = useUpdateBackupJob(job?.id ?? "");
  const replace = useReplaceJobMembers(job?.id ?? "");
  const closed = access.block !== null;

  // The form opens on its first field, so a person can start typing (the sheet holds the focus until it is there).
  React.useEffect(() => {
    nameRef.current?.focus();
  }, []);

  const dirty = dirtyKey(draft) !== dirtyKey(initial);
  React.useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  /** Every edit also clears what the last save said: the person is already on it. */
  const edit = (patch: Partial<JobDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setSaveError(null);
  };
  const editSettings = (patch: Partial<SettingsDraft>) => {
    setDraft((current) => ({ ...current, settings: { ...current.settings, ...patch } }));
    setSaveError(null);
  };

  const problems: JobProblems = checkJobDraft(draft);
  const shown = attempted ? problems : {};
  const serverProblem = jobProblemOf(saveError);
  const target: ProblemTarget | null = serverProblem ? problemTarget(serverProblem.path) : null;
  const serverMessage = serverProblem ? serverText(serverProblem) : undefined;
  const at = (field: ProblemTarget) => (target === field ? serverMessage : undefined);

  const save = async (
    options: { moveMembers?: boolean; stricterConfirmed?: boolean } = {},
  ): Promise<void> => {
    setAttempted(true);
    setSaveError(null);
    const found = checkJobDraft(draft);
    if (jobHasProblems(found) || closed) {
      setAttempts((count) => count + 1);
      return;
    }
    // A stricter machine retention removes restore points for good: say how many, ask first.
    if (job && kind === "endpoint" && !options.stricterConfirmed) {
      const less = retentionReduction(
        job.retention.keep ?? defaults.endpointRetention,
        draft.settings,
      );
      if (less) {
        setStricter({ less, options });
        return;
      }
    }
    setSaving(true);
    try {
      if (job) {
        const patch = updateInputOf(job, draft);
        let saved: BackupJob = job;
        if (patch) {
          saved = await update.mutateAsync(patch);
        }
        if (scopeChanged(job, members, draft)) {
          const keep = members
            .filter((member) => member.explicit && Object.keys(member.overrides).length > 0)
            .map((member) => ({ id: member.targetId, overrides: member.overrides }));
          await replace.mutateAsync({
            mode: draft.scopeMode,
            members: draft.scopeMode === "all" ? keep : memberInputsOf(draft.selected),
            ...(options.moveMembers || draft.moves.length > 0 ? { move: true } : {}),
          });
        }
        onSaved("updated", saved);
      } else {
        onSaved("created", await create.mutateAsync(createInputOf(draft, options)));
      }
      onClose();
    } catch (error) {
      const taken = conflictsOf(error);
      if (taken && taken.length > 0) {
        setConflicts(taken);
      } else if (isRecentSignInRequired(error)) {
        identity.ask(() => void save(options));
      } else {
        setSaveError(error);
        setAttempts((count) => count + 1);
      }
    } finally {
      setSaving(false);
    }
  };

  // After a refused save the summary takes the focus, so the screen reader says what to fix.
  React.useEffect(() => {
    if (attempts > 0) {
      summaryRef.current?.focus();
    }
  }, [attempts]);

  const fieldsProblem = attempted && jobHasProblems(problems);
  const nameError = problemText(shown.name) ?? at("name");

  // Machines whose backups the folder tree can read: the ones in the scope, else any machine.
  const candidates = useJobCandidates("endpoint", "", kind === "endpoint");
  const scopeMachines: BrowsableMachine[] = draft.selected
    .filter(
      (member) => member.kind !== "mailbox" && member.kind !== "onedrive" && member.kind !== "imap",
    )
    .map((member) => ({ id: member.id, name: member.name }));
  const machines: BrowsableMachine[] =
    scopeMachines.length > 0
      ? scopeMachines
      : (candidates.data?.items ?? [])
          .slice(0, 100)
          .map((item) => ({ id: item.targetId, name: item.name }));

  const settingsProblems = shown.settings ?? {};
  const settingsText = (field: keyof typeof settingsProblems) =>
    problemText(settingsProblems[field]);
  const scheduleProblems = shown.endpointSchedule ?? {};
  const endpointScheduleText = {
    intervalMinutes: problemText(scheduleProblems.intervalMinutes),
    timeOfDay: problemText(scheduleProblems.timeOfDay),
    timeZone: problemText(scheduleProblems.timeZone),
  };
  if (kind === "endpoint" && serverProblem && target === "schedule") {
    const part = serverProblem.path[1];
    if (part === "intervalMinutes") endpointScheduleText.intervalMinutes = serverMessage;
    else if (part === "timeOfDay") endpointScheduleText.timeOfDay = serverMessage;
    else if (part === "timeZone") endpointScheduleText.timeZone = serverMessage;
  }

  const overrideCount = draft.selected.filter(
    (member) => member.overrides && Object.keys(member.overrides).length > 0,
  ).length;
  // What the server said about a field the form shows it at; the rest, and every other failure, stands on top.
  const generalError =
    saveError && (!serverProblem || target === "general" || target === "scope")
      ? serverProblem
        ? serverMessage
        : t(jobErrorKey(saveError))
      : undefined;

  return (
    <>
      <form
        className="flex min-h-0 flex-1 flex-col"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <div className="flex-1 space-y-4 overflow-y-auto p-6">
          <JobsAccessNote access={access} />

          <div
            ref={summaryRef}
            tabIndex={-1}
            className="space-y-3 outline-none empty:hidden"
            data-slot="editor-summary"
          >
            {fieldsProblem ? (
              <Alert variant="destructive">
                <TriangleAlert aria-hidden="true" />
                <AlertTitle>{t("editor.fix.title")}</AlertTitle>
                <AlertDescription>{t("editor.fix.description")}</AlertDescription>
              </Alert>
            ) : null}
            {generalError ? (
              <Alert variant="destructive">
                <TriangleAlert aria-hidden="true" />
                <AlertDescription>{generalError}</AlertDescription>
              </Alert>
            ) : null}
          </div>

          <fieldset disabled={closed} className="mx-0 block min-w-0 space-y-4 border-0 p-0">
            <EditorSection id={ids("general")} title={t("editor.general.title")}>
              <Field
                id={ids("name")}
                label={t("editor.general.name")}
                hint={t(`editor.general.nameHint.${kind}`)}
                error={nameError}
              >
                <Input
                  id={ids("name")}
                  ref={nameRef}
                  value={draft.name}
                  onChange={(event) => edit({ name: event.target.value })}
                  maxLength={LIMITS.name + 40}
                  autoComplete="off"
                  placeholder={t(`editor.general.namePlaceholder.${kind}`)}
                  aria-invalid={Boolean(nameError) || undefined}
                  aria-describedby={messageId(ids("name"))}
                />
              </Field>
              {kind === "mail" ? (
                <div className="flex items-start justify-between gap-4 rounded-md border p-3">
                  <div className="space-y-0.5">
                    <Label htmlFor={ids("enabled")}>{t("editor.general.enabled")}</Label>
                    <p id={messageId(ids("enabled"))} className="text-xs text-muted-foreground">
                      {t("editor.general.enabledHint")}
                    </p>
                  </div>
                  <Switch
                    id={ids("enabled")}
                    checked={draft.enabled}
                    onCheckedChange={(checked) => edit({ enabled: checked })}
                    aria-describedby={messageId(ids("enabled"))}
                  />
                </div>
              ) : null}
            </EditorSection>

            <EditorSection
              id={ids("scope")}
              title={t(`editor.scope.title.${kind}`)}
              description={t(`editor.scope.description.${kind}`)}
            >
              {kind === "mail" ? (
                <RadioGroup
                  aria-label={t("editor.scope.mode")}
                  value={draft.scopeMode}
                  onValueChange={(value) => edit({ scopeMode: value as JobScopeMode })}
                >
                  <div className="flex items-start gap-2">
                    <RadioGroupItem
                      id={ids("scope-all")}
                      value="all"
                      disabled={otherAllJob && draft.scopeMode !== "all"}
                      className="mt-0.5"
                    />
                    <div className="space-y-0.5">
                      <Label htmlFor={ids("scope-all")} className="font-normal">
                        {t("editor.scope.all")}
                      </Label>
                      <p className="text-xs text-muted-foreground">
                        {otherAllJob && draft.scopeMode !== "all"
                          ? t("editor.scope.allTaken")
                          : t("editor.scope.allHint")}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <RadioGroupItem id={ids("scope-selected")} value="selected" />
                    <Label htmlFor={ids("scope-selected")} className="font-normal">
                      {t("editor.scope.selected")}
                    </Label>
                  </div>
                </RadioGroup>
              ) : null}
              {draft.scopeMode === "selected" ? (
                <>
                  <MemberPicker
                    idPrefix={ids("picker")}
                    kind={kind}
                    jobId={job?.id}
                    value={{ selected: draft.selected, moves: draft.moves }}
                    onChange={(value) => edit({ selected: value.selected, moves: value.moves })}
                  />
                  {overrideCount > 0 ? (
                    <p className="text-xs text-muted-foreground">
                      {t("editor.scope.overridesKept", { count: overrideCount })}
                    </p>
                  ) : null}
                  {shown.scope ? (
                    <p role="alert" className="text-xs text-destructive">
                      {problemText(shown.scope)}
                    </p>
                  ) : null}
                </>
              ) : (
                <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
                  {t("editor.scope.allBody")}
                </p>
              )}
            </EditorSection>

            {kind === "mail" ? (
              <>
                <EditorSection
                  id={ids("schedule")}
                  title={t("editor.schedule.title")}
                  description={t("editor.schedule.description.mail")}
                >
                  <div className="flex items-start justify-between gap-4 rounded-md border p-3">
                    <Label htmlFor={ids("schedule-on")}>{t("editor.schedule.automatic")}</Label>
                    <Switch
                      id={ids("schedule-on")}
                      checked={draft.scheduleOn}
                      onCheckedChange={(checked) => edit({ scheduleOn: checked })}
                    />
                  </div>
                  {draft.scheduleOn ? (
                    <CadenceFields
                      idPrefix={ids("cadence")}
                      draft={draft.cadence}
                      onChange={(cadence) => edit({ cadence })}
                      attempted={attempted}
                      saveProblem={cadenceProblemOf(serverProblem, "schedule")}
                    />
                  ) : (
                    <Alert variant="warning" data-slot="schedule-off">
                      <TriangleAlert aria-hidden="true" />
                      <AlertDescription>{t("editor.schedule.manualOnly")}</AlertDescription>
                    </Alert>
                  )}
                </EditorSection>

                <EditorSection
                  id={ids("verify")}
                  title={t("editor.verify.title")}
                  description={t("editor.verify.description")}
                >
                  <div className="flex items-start justify-between gap-4 rounded-md border p-3">
                    <Label htmlFor={ids("verify-on")}>{t("editor.verify.automatic")}</Label>
                    <Switch
                      id={ids("verify-on")}
                      checked={draft.verifyOn}
                      onCheckedChange={(checked) => edit({ verifyOn: checked })}
                    />
                  </div>
                  {draft.verifyOn ? (
                    <CadenceFields
                      idPrefix={ids("verify-cadence")}
                      draft={draft.verifyCadence}
                      onChange={(verifyCadence) => edit({ verifyCadence })}
                      attempted={attempted}
                      saveProblem={cadenceProblemOf(serverProblem, "verifySchedule")}
                    />
                  ) : (
                    <Alert variant="warning">
                      <TriangleAlert aria-hidden="true" />
                      <AlertDescription>{t("editor.verify.off")}</AlertDescription>
                    </Alert>
                  )}
                </EditorSection>

                <EditorSection
                  id={ids("retention")}
                  title={t("editor.retention.title")}
                  description={t("editor.retention.description.mail")}
                >
                  <Field
                    id={ids("policy")}
                    label={t("editor.retention.policy")}
                    error={at("retentionPolicy")}
                  >
                    <Select
                      value={draft.retentionPolicyId ?? DEFAULT_POLICY}
                      onValueChange={(value) =>
                        edit({ retentionPolicyId: value === DEFAULT_POLICY ? null : value })
                      }
                    >
                      <SelectTrigger id={ids("policy")} className="w-full sm:w-96">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={DEFAULT_POLICY}>
                          {tenantDefaultLabel(defaults, t)}
                        </SelectItem>
                        {defaults.retentionPolicies
                          .filter((policy) => !policy.isDefault)
                          .map((policy) => (
                            <SelectItem key={policy.id} value={policy.id}>
                              {policy.name}
                            </SelectItem>
                          ))}
                      </SelectContent>
                    </Select>
                  </Field>
                </EditorSection>

                <EditorSection
                  id={ids("archive")}
                  title={t("editor.archive.title")}
                  description={t("editor.archive.description")}
                >
                  <div className="flex items-start justify-between gap-4 rounded-md border p-3">
                    <div className="space-y-0.5">
                      <Label htmlFor={ids("archive-on")}>{t("editor.archive.switch")}</Label>
                      <p
                        id={messageId(ids("archive-on"))}
                        className="text-xs text-muted-foreground"
                      >
                        {t("editor.archive.hint")}
                      </p>
                    </div>
                    <Switch
                      id={ids("archive-on")}
                      checked={draft.archive}
                      onCheckedChange={(checked) => edit({ archive: checked })}
                      aria-describedby={messageId(ids("archive-on"))}
                    />
                  </div>
                  {draft.archive ? (
                    <>
                      {defaults.repository.objectLock === false ? (
                        <Alert variant="warning" data-slot="archive-object-lock">
                          <TriangleAlert aria-hidden="true" />
                          <AlertDescription>{t("editor.archive.noObjectLock")}</AlertDescription>
                        </Alert>
                      ) : defaults.repository.objectLock === null ? (
                        <p
                          className="text-xs text-muted-foreground"
                          data-slot="archive-object-lock"
                        >
                          {t("editor.archive.objectLockUnknown")}
                        </p>
                      ) : null}
                      <ExtensionSlot
                        name="jobs.archiveSetup"
                        props={{ archive: draft.archive }}
                        fallback={
                          <Alert data-slot="archive-edition">
                            <Info aria-hidden="true" />
                            <AlertDescription>{t("editor.archive.edition")}</AlertDescription>
                          </Alert>
                        }
                      />
                    </>
                  ) : null}
                </EditorSection>
              </>
            ) : (
              <>
                <EditorSection
                  id={ids("schedule")}
                  title={t("editor.schedule.title")}
                  description={t("editor.schedule.description.endpoint")}
                >
                  <EndpointScheduleFields
                    idPrefix={ids("schedule-fields")}
                    draft={draft.endpointSchedule}
                    onChange={(endpointSchedule) => edit({ endpointSchedule })}
                    problems={endpointScheduleText}
                  />
                  {target === "schedule" &&
                  serverMessage &&
                  !shownScheduleFields(draft.endpointSchedule.kind).includes(
                    serverProblem?.path[1] ?? "",
                  ) ? (
                    <p role="alert" className="text-xs text-destructive">
                      {serverMessage}
                    </p>
                  ) : null}
                </EditorSection>

                <EditorSection
                  id={ids("folders")}
                  title={t("editor.folders.title")}
                  description={t("editor.folders.description")}
                >
                  {job === null && defaults.basis ? (
                    <p
                      className="flex items-start gap-2 text-xs text-muted-foreground"
                      data-slot="defaults-basis"
                    >
                      <Info aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
                      {defaults.basis.mixed
                        ? t("editor.folders.basisMixed", {
                            systems: defaults.basis.os
                              .map((os) => tEndpoints(`os.${os}`))
                              .join(", "),
                          })
                        : t("editor.folders.basis", {
                            systems: defaults.basis.os
                              .map((os) => tEndpoints(`os.${os}`))
                              .join(", "),
                          })}
                    </p>
                  ) : null}
                  <FoldersField
                    idPrefix={ids("folders-field")}
                    paths={draft.settings.paths}
                    onChange={(paths) => editSettings({ paths })}
                    machines={machines}
                    error={settingsText("paths") ?? at("paths")}
                  />
                </EditorSection>

                <EditorSection
                  id={ids("exclusions")}
                  title={t("editor.exclusions.title")}
                  description={t("editor.exclusions.description")}
                >
                  <ExclusionsField
                    idPrefix={ids("exclusions-field")}
                    value={{
                      excludes: draft.settings.excludes,
                      largerEnabled: draft.settings.largerEnabled,
                      largerGib: draft.settings.largerGib,
                    }}
                    onChange={(value) => editSettings(value)}
                    excludesError={settingsText("excludes") ?? at("excludes")}
                    largerError={settingsText("larger") ?? at("larger")}
                  />
                </EditorSection>

                <EditorSection
                  id={ids("bandwidth")}
                  title={t("editor.bandwidth.title")}
                  description={t("editor.bandwidth.description")}
                >
                  <BandwidthField
                    id={ids("bandwidth-field")}
                    value={draft.settings.bandwidth}
                    onChange={(bandwidth) => editSettings({ bandwidth })}
                    error={settingsText("bandwidth") ?? at("bandwidth")}
                  />
                  <BandwidthWindowsField
                    idPrefix={ids("windows")}
                    rows={draft.settings.bandwidthWindows}
                    onChange={(bandwidthWindows) => editSettings({ bandwidthWindows })}
                    zone={draft.endpointSchedule.timeZone}
                    check={windowCheckOf(draft.settings.bandwidthWindows, attempted)}
                    serverError={at("bandwidthWindows")}
                  />
                </EditorSection>

                <EditorSection
                  id={ids("retention")}
                  title={t("editor.retention.title")}
                  description={t("editor.retention.description.endpoint")}
                >
                  <RetentionField
                    idPrefix={ids("retention-field")}
                    settings={draft.settings}
                    onChange={editSettings}
                    problems={{
                      keepDaily: settingsText("keepDaily") ?? at("retention"),
                      keepWeekly: settingsText("keepWeekly"),
                      keepMonthly: settingsText("keepMonthly"),
                    }}
                  />
                </EditorSection>

                <AdvancedSection
                  id={ids("advanced")}
                  defaultOpen={Boolean(
                    draft.settings.preHook || draft.settings.postHook || draft.settings.hooksHidden,
                  )}
                  title={t("editor.advanced.title")}
                  description={t("editor.advanced.description")}
                >
                  <EditorSection
                    id={ids("hooks")}
                    title={t("editor.hooks.title")}
                    description={t("editor.hooks.description")}
                  >
                    <HooksField
                      idPrefix={ids("hooks-field")}
                      settings={draft.settings}
                      onChange={editSettings}
                      error={settingsText("hooks") ?? at("hooks")}
                    />
                  </EditorSection>
                </AdvancedSection>
              </>
            )}

            <EditorSection
              id={ids("repository")}
              title={t("editor.repository.title")}
              description={t("editor.repository.description")}
            >
              <p className="flex items-center gap-2 text-sm">
                <span className="font-medium">{repositoryLabel(defaults.repository, t)}</span>
                <span className="text-muted-foreground">{t("editor.repository.primary")}</span>
              </p>
              <p className="flex items-start gap-2 text-xs text-muted-foreground">
                <Info aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
                {t("editor.repository.sentence")}
              </p>
              {defaults.repository.status === "error" ? (
                <Alert variant="destructive" data-slot="repository-error">
                  <TriangleAlert aria-hidden="true" />
                  <AlertTitle>{t("editor.repository.errorTitle")}</AlertTitle>
                  <AlertDescription>
                    <p>{t("editor.repository.errorBody")}</p>
                    <Link
                      to={activeTenantPageTo("storage")}
                      className="font-medium underline underline-offset-4"
                    >
                      {t("editor.repository.errorLink")}
                    </Link>
                  </AlertDescription>
                </Alert>
              ) : null}
            </EditorSection>
          </fieldset>
        </div>

        <SheetFooter className="flex-row justify-end gap-2 border-t border-border p-4">
          <Button type="button" variant="outline" onClick={onCancel} disabled={saving}>
            {t("common:actions.cancel")}
          </Button>
          <Button
            type="submit"
            loading={saving}
            disabled={closed}
            aria-describedby={closed ? access.noteId : undefined}
            title={closed ? access.reason : undefined}
          >
            {job ? t("editor.save") : t("editor.create")}
          </Button>
        </SheetFooter>
      </form>

      <ConfirmDialog
        open={conflicts !== null}
        onOpenChange={(next) => {
          if (!next) setConflicts(null);
        }}
        title={t("editor.conflicts.title", { count: conflicts?.length ?? 0 })}
        description={<p>{t("editor.conflicts.description")}</p>}
        confirmLabel={t("editor.conflicts.confirm")}
        cancelLabel={t("editor.conflicts.cancel")}
        onConfirm={() => {
          const taken = new Set((conflicts ?? []).map((conflict) => conflict.targetId));
          setConflicts(null);
          setDraft((current) => ({
            ...current,
            moves: [...new Set([...current.moves, ...taken])],
          }));
          void save({ moveMembers: true });
        }}
      >
        <ul className="max-h-48 space-y-1 overflow-auto text-sm" data-slot="conflict-list">
          {(conflicts ?? []).map((conflict) => {
            const member = draft.selected.find((candidate) => candidate.id === conflict.targetId);
            return (
              <li key={conflict.targetId}>
                {t("editor.conflicts.item", {
                  name: member?.name ?? t("scope.unresolved"),
                  job: conflict.jobName,
                })}
              </li>
            );
          })}
        </ul>
      </ConfirmDialog>
      <ConfirmDialog
        open={stricter !== null}
        onOpenChange={(next) => {
          if (!next) setStricter(null);
        }}
        title={t("editor.stricter.title")}
        description={
          <>
            <p>{t("editor.stricter.description", { count: job?.scope.count ?? 0 })}</p>
            <ul className="list-disc pl-5" data-slot="stricter-list">
              {stricter && stricter.less.keepDaily > 0 ? (
                <li>{t("editor.stricter.daily", { count: stricter.less.keepDaily })}</li>
              ) : null}
              {stricter && stricter.less.keepWeekly > 0 ? (
                <li>{t("editor.stricter.weekly", { count: stricter.less.keepWeekly })}</li>
              ) : null}
              {stricter && stricter.less.keepMonthly > 0 ? (
                <li>{t("editor.stricter.monthly", { count: stricter.less.keepMonthly })}</li>
              ) : null}
            </ul>
          </>
        }
        confirmLabel={t("editor.stricter.confirm")}
        destructive
        onConfirm={() => {
          const pending = stricter;
          setStricter(null);
          void save({ ...(pending?.options ?? {}), stricterConfirmed: true });
        }}
      />
      {identity.dialog}
    </>
  );
}

/** The parts of a machine schedule the form has a field for, by the kind it is on; the rest is said under the fields. */
function shownScheduleFields(kind: "daily" | "interval" | "on_connect"): string[] {
  return kind === "daily" ? ["timeOfDay", "timeZone"] : ["intervalMinutes", "timeZone"];
}

/** The sentinel of the "tenant default" choice in the retention select (a policy id never looks like it). */
const DEFAULT_POLICY = "__tenant_default__";

function tenantDefaultLabel(defaults: JobDefaults, t: TFunction): string {
  const named = defaults.retentionPolicies.find((policy) => policy.isDefault);
  return named
    ? t("retention.tenantDefaultNamed", { name: named.name })
    : t("retention.tenantDefault");
}

/** A disclosure for the settings most people never touch; opens by itself when something in it is set. */
function AdvancedSection({
  id,
  title,
  description,
  defaultOpen,
  children,
}: {
  id: string;
  title: string;
  description: string;
  defaultOpen: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(defaultOpen);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="space-y-3">
      <CollapsibleTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          className="-ml-3 h-auto justify-start gap-2 px-3 py-1.5"
          aria-controls={id}
        >
          <ChevronRight
            aria-hidden="true"
            className={cn(
              "size-4 transition-transform motion-reduce:transition-none",
              open && "rotate-90",
            )}
          />
          <span className="font-semibold">{title}</span>
          <span className="text-xs font-normal text-muted-foreground">{description}</span>
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent id={id}>{children}</CollapsibleContent>
    </Collapsible>
  );
}
