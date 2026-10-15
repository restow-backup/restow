import { FolderTree, TriangleAlert, X } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { Field, messageId } from "@/components/forms/field";
import { ErrorState } from "@/components/kit";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { Textarea } from "@/components/ui/textarea";
import { FolderPicker } from "@/features/file-shares/components/folder-picker";
import "@/features/file-shares/i18n";

import type { BackupJob, JobDefaults, JobMember } from "../api.js";
import type { FormProblem } from "../form.js";
import {
  useCreateBackupJob,
  useJobCandidates,
  useJobDefaults,
  useJobMembers,
  useReplaceJobMembers,
  useUpdateBackupJob,
} from "../hooks.js";
import { jobErrorKey } from "../problems.js";
import {
  SHARE_SYSTEM_FILE_PATTERNS,
  type ShareJobDraft,
  type ShareMemberDraft,
  checkShareJobDraft,
  cleanExtension,
  draftOfShareJob,
  memberDraftOfCandidate,
  newShareJobDraft,
  shareCreateInputOf,
  shareMemberInputs,
  shareMembersChanged,
  shareUpdateInputOf,
} from "../share-form.js";
import type { JobsAccess } from "./access-note.js";
import { BandwidthWindowsField, windowCheckOf } from "./bandwidth-windows-field.js";
import { EditorSection } from "./editor-section.js";
import { ShareScheduleFields } from "./share-schedule-fields.js";

export interface ShareJobEditorProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The job to change; null creates one. */
  job: BackupJob | null;
  /** File shares a new job starts with (the address's `select`). */
  preselect?: readonly string[];
  access: JobsAccess;
  onSaved: (change: "created" | "updated", job: BackupJob) => void;
}

/**
 * The editor of a file share job (docs/FILESHARES.md 12.5): its shares with the folders of each
 * (everything, or folders picked from a live browser of the share), when it runs, how long
 * restore points are kept, what is left out (own patterns, "Skip temporary and system files"
 * with its list, file types, files larger than), the bandwidth limit and its windows, the read
 * concurrency and whether offline (tiered) files are recalled. Every new restore point is
 * checked; there is no restore-check schedule to set.
 */
export function ShareJobEditor({
  open,
  onOpenChange,
  job,
  preselect = [],
  access,
  onSaved,
}: ShareJobEditorProps) {
  const { t } = useTranslation("backupjobs");
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 p-0 sm:max-w-3xl"
        data-slot="share-job-editor"
      >
        <SheetHeader className="border-b border-border p-6 pr-12">
          <SheetTitle className="text-lg">
            {job ? t("editor.editTitle", { name: job.name }) : t("editor.createTitle.share")}
          </SheetTitle>
          <SheetDescription>{t("editor.description.share")}</SheetDescription>
        </SheetHeader>
        {open ? (
          <Loader
            key={job?.id ?? "new"}
            job={job}
            preselect={preselect}
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
  preselect,
  access,
  onSaved,
  onClose,
}: {
  job: BackupJob | null;
  preselect: readonly string[];
  access: JobsAccess;
  onSaved: ShareJobEditorProps["onSaved"];
  onClose: () => void;
}) {
  const { t } = useTranslation("backupjobs");
  const defaults = useJobDefaults("share", job === null);
  const members = useJobMembers(job?.id ?? "", job !== null);
  const failed =
    job === null ? (defaults.isError ? defaults : null) : members.isError ? members : null;
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
  if ((job === null && !defaults.data) || (job !== null && !members.data)) {
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
      members={members.data?.items ?? []}
      preselect={preselect}
      access={access}
      onSaved={onSaved}
      onClose={onClose}
    />
  );
}

function Form({
  job,
  defaults,
  members,
  preselect,
  access,
  onSaved,
  onClose,
}: {
  job: BackupJob | null;
  defaults: JobDefaults | undefined;
  members: readonly JobMember[];
  preselect: readonly string[];
  access: JobsAccess;
  onSaved: ShareJobEditorProps["onSaved"];
  onClose: () => void;
}) {
  const { t } = useTranslation("backupjobs");
  const [draft, setDraft] = React.useState<ShareJobDraft>(() =>
    job ? draftOfShareJob(job, members) : newShareJobDraft(defaults),
  );
  const [attempted, setAttempted] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<unknown>(null);
  const [typedExtension, setTypedExtension] = React.useState("");
  const [picking, setPicking] = React.useState<string | null>(null);
  const candidates = useJobCandidates("share", "", true);
  const create = useCreateBackupJob();
  const update = useUpdateBackupJob(job?.id ?? "");
  const replace = useReplaceJobMembers(job?.id ?? "");
  const closed = access.block !== null;
  const formId = React.useId();
  const id = (name: string) => `${formId}-${name}`;
  const problems = checkShareJobDraft(draft);
  const shown = attempted ? problems : {};
  const text = (problem: FormProblem | undefined) =>
    problem ? t(`problems.form.${problem.code}`, problem.values ?? {}) : undefined;
  const edit = (patch: Partial<ShareJobDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setError(null);
  };

  // Shares named in the address are ticked once the list that knows them has loaded.
  const preselected = React.useRef(false);
  React.useEffect(() => {
    if (preselected.current || job || preselect.length === 0 || !candidates.data) return;
    preselected.current = true;
    const chosen = candidates.data.items.filter((item) => preselect.includes(item.targetId));
    if (chosen.length > 0) {
      setDraft((current) => ({ ...current, members: chosen.map(memberDraftOfCandidate) }));
    }
  }, [candidates.data, job, preselect]);

  const toggleMember = (candidate: ShareMemberDraft) =>
    edit({
      members: draft.members.some((member) => member.id === candidate.id)
        ? draft.members.filter((member) => member.id !== candidate.id)
        : [...draft.members, candidate],
    });
  const setIncludes = (shareId: string, includes: string[]) =>
    edit({
      members: draft.members.map((member) =>
        member.id === shareId ? { ...member, includes } : member,
      ),
    });

  const save = async () => {
    setAttempted(true);
    if (Object.keys(problems).length > 0 || closed) return;
    setSaving(true);
    setError(null);
    try {
      if (job) {
        const patch = shareUpdateInputOf(job, draft);
        let saved = job;
        if (patch) saved = await update.mutateAsync(patch);
        if (shareMembersChanged(members, draft)) {
          saved = await replace.mutateAsync({
            members: shareMemberInputs(draft),
            ...(draft.members.some((member) => member.job !== null) ? { move: true } : {}),
          });
        }
        onSaved("updated", saved);
      } else {
        onSaved("created", await create.mutateAsync(shareCreateInputOf(draft)));
      }
      onClose();
    } catch (cause) {
      setError(cause);
    } finally {
      setSaving(false);
    }
  };

  const shares = candidates.data?.items ?? [];
  const windowCheck = windowCheckOf(draft.windows, attempted);

  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void save();
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
            <AlertDescription>{t(jobErrorKey(error))}</AlertDescription>
          </Alert>
        ) : null}
        <fieldset disabled={closed} className="mx-0 block min-w-0 space-y-4 border-0 p-0">
          <EditorSection id={id("general")} title={t("editor.general.title")}>
            <Field
              id={id("name")}
              label={t("editor.general.name")}
              hint={t("editor.general.nameHint.share")}
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
            id={id("shares")}
            title={t("shareEditor.shares.title")}
            description={t("shareEditor.shares.description")}
          >
            {candidates.isPending ? (
              <Skeleton className="h-24 w-full" />
            ) : shares.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("shareEditor.shares.none")}</p>
            ) : (
              <ul className="divide-y rounded-md border" data-slot="share-members">
                {shares.map((candidate) => {
                  const member = draft.members.find((item) => item.id === candidate.targetId);
                  const otherJob =
                    candidate.job && candidate.job.id !== job?.id ? candidate.job : null;
                  return (
                    <li key={candidate.targetId} className="space-y-2 px-3 py-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <Checkbox
                          id={id(`share-${candidate.targetId}`)}
                          checked={member !== undefined}
                          onCheckedChange={() => toggleMember(memberDraftOfCandidate(candidate))}
                          aria-label={t("shareEditor.shares.pick", { name: candidate.name })}
                        />
                        <Label htmlFor={id(`share-${candidate.targetId}`)} className="font-medium">
                          {candidate.name}
                        </Label>
                        <span className="truncate font-mono text-xs text-muted-foreground">
                          {candidate.detail}
                        </span>
                        {otherJob ? (
                          <Badge variant="outline">
                            {t("shareEditor.shares.inJob", { job: otherJob.name })}
                          </Badge>
                        ) : null}
                      </div>
                      {member ? (
                        <div className="space-y-2 pl-6">
                          <p className="text-xs text-muted-foreground">
                            {t("shareEditor.shares.folders")}:{" "}
                            {member.includes.length > 0
                              ? member.includes.join(", ")
                              : t("shareEditor.shares.everything")}
                          </p>
                          {picking === member.id ? (
                            <div className="space-y-2">
                              <FolderPicker
                                shareId={member.id}
                                mode="many"
                                value={member.includes}
                                onChange={(next) => setIncludes(member.id, next)}
                              />
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                onClick={() => setPicking(null)}
                              >
                                {t("shareEditor.shares.donePicking")}
                              </Button>
                            </div>
                          ) : (
                            <div className="flex gap-2">
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                onClick={() => setPicking(member.id)}
                                data-action="pick-folders"
                              >
                                <FolderTree aria-hidden="true" />
                                {t("shareEditor.shares.pickFolders")}
                              </Button>
                              {member.includes.length > 0 ? (
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => setIncludes(member.id, [])}
                                >
                                  {t("shareEditor.shares.everythingAction")}
                                </Button>
                              ) : null}
                            </div>
                          )}
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
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
            <p className="text-xs text-muted-foreground">{t("shareEditor.schedule.check")}</p>
          </EditorSection>

          <EditorSection
            id={id("retention")}
            title={t("shareEditor.retention.title")}
            description={t("shareEditor.retention.description")}
          >
            <div className="grid gap-3 sm:grid-cols-3">
              {(["keepDaily", "keepWeekly", "keepMonthly"] as const).map((key) => (
                <Field
                  key={key}
                  id={id(key)}
                  label={t(`shareEditor.retention.${key}`)}
                  error={text(shown[key])}
                >
                  <Input
                    id={id(key)}
                    inputMode="numeric"
                    value={draft[key]}
                    onChange={(event) =>
                      edit({ [key]: event.target.value } as Partial<ShareJobDraft>)
                    }
                    aria-describedby={messageId(id(key))}
                  />
                </Field>
              ))}
            </div>
          </EditorSection>

          <EditorSection id={id("exclusions")} title={t("shareEditor.exclusions.title")}>
            <div className="flex items-start gap-3">
              <Switch
                id={id("systemFiles")}
                checked={draft.systemFiles}
                onCheckedChange={(checked) => edit({ systemFiles: checked === true })}
              />
              <div className="grid gap-1">
                <Label htmlFor={id("systemFiles")}>{t("shareEditor.exclusions.preset")}</Label>
                <p className="font-mono text-xs text-muted-foreground" data-slot="preset-list">
                  {SHARE_SYSTEM_FILE_PATTERNS.join("  ")}
                </p>
              </div>
            </div>
            <Field
              id={id("excludes")}
              label={t("shareEditor.exclusions.patterns")}
              hint={t("shareEditor.exclusions.patternsHint")}
              error={text(shown.excludes)}
            >
              <Textarea
                id={id("excludes")}
                rows={4}
                value={draft.excludes}
                onChange={(event) => edit({ excludes: event.target.value })}
                className="font-mono text-sm"
                aria-describedby={messageId(id("excludes"))}
              />
            </Field>
            <div className="grid gap-1.5">
              <Label htmlFor={id("fileType")}>{t("shareEditor.exclusions.fileTypes")}</Label>
              <div className="flex flex-wrap items-center gap-2" data-slot="file-types">
                {draft.fileTypes.map((ext) => (
                  <Badge key={ext} variant="secondary" className="gap-1">
                    .{ext}
                    <button
                      type="button"
                      aria-label={t("shareEditor.exclusions.removeType", { ext })}
                      onClick={() =>
                        edit({ fileTypes: draft.fileTypes.filter((item) => item !== ext) })
                      }
                    >
                      <X className="size-3" aria-hidden="true" />
                    </button>
                  </Badge>
                ))}
                <Input
                  id={id("fileType")}
                  className="h-8 w-32"
                  value={typedExtension}
                  placeholder="iso"
                  onChange={(event) => setTypedExtension(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === ",") {
                      event.preventDefault();
                      const clean = cleanExtension(typedExtension);
                      if (clean && !draft.fileTypes.includes(clean)) {
                        edit({ fileTypes: [...draft.fileTypes, clean] });
                      }
                      setTypedExtension("");
                    }
                  }}
                />
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    const clean = cleanExtension(typedExtension);
                    if (clean && !draft.fileTypes.includes(clean))
                      edit({ fileTypes: [...draft.fileTypes, clean] });
                    setTypedExtension("");
                  }}
                  data-action="add-file-type"
                >
                  {t("shareEditor.exclusions.addType")}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                {t("shareEditor.exclusions.fileTypesHint")}
              </p>
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <div className="flex items-center gap-2">
                <Switch
                  id={id("largerOn")}
                  checked={draft.largerOn}
                  onCheckedChange={(checked) => edit({ largerOn: checked === true })}
                />
                <Label htmlFor={id("largerOn")}>{t("shareEditor.exclusions.larger")}</Label>
              </div>
              {draft.largerOn ? (
                <Field
                  id={id("largerGib")}
                  label={t("shareEditor.exclusions.largerGb")}
                  error={text(shown.larger)}
                >
                  <Input
                    id={id("largerGib")}
                    className="w-28"
                    inputMode="decimal"
                    value={draft.largerGib}
                    onChange={(event) => edit({ largerGib: event.target.value })}
                    aria-describedby={messageId(id("largerGib"))}
                  />
                </Field>
              ) : null}
            </div>
            <div className="flex items-start gap-3">
              <Switch
                id={id("recall")}
                checked={!draft.skipOffline}
                onCheckedChange={(checked) => edit({ skipOffline: checked !== true })}
              />
              <div className="grid gap-0.5">
                <Label htmlFor={id("recall")}>{t("shareEditor.exclusions.offline")}</Label>
                <p className="text-xs text-muted-foreground">
                  {t("shareEditor.exclusions.offlineHint")}
                </p>
              </div>
            </div>
          </EditorSection>

          <EditorSection
            id={id("transfer")}
            title={t("shareEditor.transfer.title")}
            description={t("shareEditor.transfer.description")}
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <Field
                id={id("bandwidth")}
                label={t("shareEditor.transfer.bandwidth")}
                hint={t("shareEditor.transfer.bandwidthHint")}
                error={text(shown.bandwidth)}
              >
                <Input
                  id={id("bandwidth")}
                  inputMode="numeric"
                  value={draft.bandwidth}
                  onChange={(event) => edit({ bandwidth: event.target.value })}
                  aria-describedby={messageId(id("bandwidth"))}
                />
              </Field>
              <Field
                id={id("concurrency")}
                label={t("shareEditor.transfer.concurrency")}
                hint={t("shareEditor.transfer.concurrencyHint")}
                error={text(shown.readConcurrency)}
              >
                <Input
                  id={id("concurrency")}
                  inputMode="numeric"
                  value={draft.readConcurrency}
                  onChange={(event) => edit({ readConcurrency: event.target.value })}
                  aria-describedby={messageId(id("concurrency"))}
                />
              </Field>
            </div>
            <BandwidthWindowsField
              idPrefix={id("windows")}
              rows={draft.windows}
              onChange={(windows) => edit({ windows })}
              zone={draft.schedule.timeZone}
              check={windowCheck}
            />
          </EditorSection>
        </fieldset>
      </div>
      <SheetFooter className="border-t border-border p-4 sm:flex-row sm:justify-end">
        <Button type="button" variant="outline" onClick={onClose}>
          {t("common:actions.cancel")}
        </Button>
        <Button type="submit" loading={saving} disabled={closed} data-action="save-share-job">
          {job ? t("editor.save") : t("editor.create")}
        </Button>
      </SheetFooter>
    </form>
  );
}
