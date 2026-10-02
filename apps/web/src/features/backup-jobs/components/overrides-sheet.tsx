import { TriangleAlert } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { useConfirmIdentity } from "@/components/confirm-identity-dialog";
import { ConfirmDialog, ErrorState } from "@/components/kit";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
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
import { CadenceFields } from "@/features/schedules/components/cadence-fields";
import { isRecentSignInRequired } from "@/lib/recent-sign-in";

import type { BackupJob, JobDefaults, JobMember } from "../api.js";
import {
  type OverrideGroup,
  type OverridesDraft,
  type SettingsDraft,
  checkOverrides,
  hasProblems,
  overrideGroupsOf,
  overridesDraftOf,
  overridesOfDraft,
} from "../form.js";
import { useJobDefaults, useSetMemberOverrides } from "../hooks.js";
import { jobErrorKey, jobProblemOf } from "../problems.js";
import { type JobsAccess, JobsAccessNote } from "./access-note.js";
import { BandwidthWindowsField, windowCheckOf } from "./bandwidth-windows-field.js";
import { EditorSection } from "./editor-section.js";
import { ExclusionsField } from "./exclusions-field.js";
import { FoldersField } from "./folders-field.js";
import {
  BandwidthField,
  EndpointScheduleFields,
  HooksField,
  RetentionField,
  useProblemText,
} from "./settings-fields.js";

export interface OverridesSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  job: BackupJob;
  /** The object or machine whose overrides are edited; null while the sheet is closed. */
  member: JobMember | null;
  access: JobsAccess;
  /** The overrides were saved (the page shows the toast). */
  onSaved: (member: JobMember) => void;
}

/**
 * What one object or machine of a job does differently: a switch per setting
 * (own schedule, own folders, own exclusions, own bandwidth, own hooks, own
 * retention for machines; own schedule and own restore check for mail) and,
 * switched on, the same fields as the job's own. Everything left off follows the
 * job. Saving with every switch off clears the overrides.
 */
export function OverridesSheet({
  open,
  onOpenChange,
  job,
  member,
  access,
  onSaved,
}: OverridesSheetProps) {
  const { t } = useTranslation("backupjobs");
  const dirty = React.useRef(false);
  const [confirming, setConfirming] = React.useState(false);
  const noteId = React.useId();
  const sheetAccess = React.useMemo<JobsAccess>(() => ({ ...access, noteId }), [access, noteId]);

  const requestClose = () => {
    if (dirty.current) {
      setConfirming(true);
    } else {
      onOpenChange(false);
    }
  };

  return (
    <>
      <Sheet
        open={open}
        onOpenChange={(next) => {
          if (next) onOpenChange(true);
          else requestClose();
        }}
      >
        <SheetContent
          side="right"
          className="flex w-full flex-col gap-0 p-0 sm:max-w-2xl"
          data-slot="overrides-sheet"
        >
          <SheetHeader className="border-b border-border p-6 pr-12">
            <SheetTitle className="text-lg">
              {t("overrides.title", { name: member?.name ?? "" })}
            </SheetTitle>
            <SheetDescription>
              {t(`overrides.description.${job.kind}`, { job: job.name })}
            </SheetDescription>
          </SheetHeader>
          {open && member ? (
            <OverridesLoader
              key={member.targetId}
              job={job}
              member={member}
              access={sheetAccess}
              onCancel={requestClose}
              onClose={() => {
                dirty.current = false;
                onOpenChange(false);
              }}
              onDirtyChange={(value) => {
                dirty.current = value;
              }}
              onSaved={onSaved}
            />
          ) : null}
        </SheetContent>
      </Sheet>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t("editor.discard.title")}
        description={<p>{t("editor.discard.description")}</p>}
        confirmLabel={t("editor.discard.confirm")}
        cancelLabel={t("editor.discard.keep")}
        destructive
        onConfirm={() => {
          setConfirming(false);
          dirty.current = false;
          onOpenChange(false);
        }}
      />
    </>
  );
}

interface LoaderProps {
  job: BackupJob;
  member: JobMember;
  access: JobsAccess;
  onCancel: () => void;
  onClose: () => void;
  onDirtyChange: (dirty: boolean) => void;
  onSaved: (member: JobMember) => void;
}

function OverridesLoader(props: LoaderProps) {
  const { t } = useTranslation("backupjobs");
  const defaults = useJobDefaults(props.job.kind);
  if (defaults.isError) {
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
  if (!defaults.data) {
    return (
      <div aria-busy="true" className="space-y-4 p-6">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }
  return <OverridesForm {...props} defaults={defaults.data} />;
}

function OverridesForm({
  job,
  member,
  access,
  defaults,
  onCancel,
  onClose,
  onDirtyChange,
  onSaved,
}: LoaderProps & { defaults: JobDefaults }) {
  const { t } = useTranslation("backupjobs");
  const problemText = useProblemText();
  const identity = useConfirmIdentity();
  const formId = React.useId();
  const ids = (name: string) => `${formId}-${name}`;
  const summaryRef = React.useRef<HTMLDivElement>(null);
  // The sheet starts from this once; a refetch of the lists must not overwrite the person's edits.
  const [initial] = React.useState<OverridesDraft>(() =>
    overridesDraftOf(job.kind, member, job, defaults),
  );
  const [draft, setDraft] = React.useState<OverridesDraft>(initial);
  const [attempted, setAttempted] = React.useState(false);
  const [saveError, setSaveError] = React.useState<unknown>(null);
  const [attempts, setAttempts] = React.useState(0);
  const save = useSetMemberOverrides(job.id);
  const closed = access.closed;

  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  React.useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  const edit = (next: Partial<OverridesDraft>) => {
    setDraft((current) => ({ ...current, ...next }));
    setSaveError(null);
  };
  const editSettings = (patch: Partial<SettingsDraft>) =>
    edit({ settings: { ...draft.settings, ...patch } });
  const setOn = (group: OverrideGroup, value: boolean) =>
    edit({ on: { ...draft.on, [group]: value } });

  const problems = checkOverrides(draft);
  const shown = attempted ? problems : {};
  const settingsProblems = shown.settings ?? {};
  const settingsText = (field: keyof typeof settingsProblems) =>
    problemText(settingsProblems[field]);
  const schedule = shown.endpointSchedule ?? {};

  const submit = async (): Promise<void> => {
    setAttempted(true);
    setSaveError(null);
    if (hasProblems(checkOverrides(draft)) || closed) {
      setAttempts((count) => count + 1);
      return;
    }
    try {
      await save.mutateAsync({ targetId: member.targetId, overrides: overridesOfDraft(draft) });
      onSaved(member);
      onClose();
    } catch (error) {
      if (isRecentSignInRequired(error)) {
        identity.ask(() => void submit());
      } else {
        setSaveError(error);
        setAttempts((count) => count + 1);
      }
    }
  };

  React.useEffect(() => {
    if (attempts > 0) {
      summaryRef.current?.focus();
    }
  }, [attempts]);

  const serverProblem = jobProblemOf(saveError);
  const errorText = saveError
    ? serverProblem
      ? serverProblem.message
      : t(jobErrorKey(saveError))
    : null;
  const groups = overrideGroupsOf(job.kind);
  const detailError = attempted && hasProblems(problems);

  const group = (id: OverrideGroup, children: React.ReactNode) => (
    <EditorSection
      key={id}
      id={ids(id)}
      title={t(`overrides.groups.${id}.title`)}
      description={draft.on[id] ? undefined : t(`overrides.groups.${id}.follows`)}
    >
      <div className="flex items-start justify-between gap-4 rounded-md border p-3">
        <Label htmlFor={ids(`${id}-on`)}>{t(`overrides.groups.${id}.switch`)}</Label>
        <Switch
          id={ids(`${id}-on`)}
          checked={draft.on[id]}
          disabled={closed}
          onCheckedChange={(checked) => setOn(id, checked)}
        />
      </div>
      {draft.on[id] ? children : null}
    </EditorSection>
  );

  const body: Record<OverrideGroup, React.ReactNode> = {
    schedule:
      job.kind === "mail" ? (
        <CadenceFields
          idPrefix={ids("cadence")}
          draft={draft.cadence}
          onChange={(cadence) => edit({ cadence })}
          attempted={attempted}
          disabled={closed}
        />
      ) : (
        <EndpointScheduleFields
          idPrefix={ids("schedule-fields")}
          draft={draft.endpointSchedule}
          onChange={(endpointSchedule) => edit({ endpointSchedule })}
          problems={{
            intervalMinutes: problemText(schedule.intervalMinutes),
            timeOfDay: problemText(schedule.timeOfDay),
            timeZone: problemText(schedule.timeZone),
          }}
          disabled={closed}
        />
      ),
    verify: (
      <CadenceFields
        idPrefix={ids("verify-cadence")}
        draft={draft.verifyCadence}
        onChange={(verifyCadence) => edit({ verifyCadence })}
        attempted={attempted}
        disabled={closed}
      />
    ),
    folders: (
      <FoldersField
        idPrefix={ids("folders-field")}
        paths={draft.settings.paths}
        onChange={(paths) => editSettings({ paths })}
        machines={[{ id: member.targetId, name: member.name }]}
        error={settingsText("paths")}
        disabled={closed}
      />
    ),
    exclusions: (
      <ExclusionsField
        idPrefix={ids("exclusions-field")}
        value={{
          excludes: draft.settings.excludes,
          largerEnabled: draft.settings.largerEnabled,
          largerGib: draft.settings.largerGib,
        }}
        onChange={(value) => editSettings(value)}
        excludesError={settingsText("excludes")}
        largerError={settingsText("larger")}
        disabled={closed}
      />
    ),
    bandwidth: (
      <div className="space-y-4">
        <BandwidthField
          id={ids("bandwidth-field")}
          value={draft.settings.bandwidth}
          onChange={(bandwidth) => editSettings({ bandwidth })}
          error={settingsText("bandwidth")}
          disabled={closed}
        />
        <BandwidthWindowsField
          idPrefix={ids("windows")}
          rows={draft.settings.bandwidthWindows}
          onChange={(bandwidthWindows) => editSettings({ bandwidthWindows })}
          // The zone the machine will read them in: its own schedule's when it has one, else the job's.
          zone={
            draft.on.schedule
              ? draft.endpointSchedule.timeZone
              : (job.schedule?.timeZone ?? draft.endpointSchedule.timeZone)
          }
          check={windowCheckOf(draft.settings.bandwidthWindows, attempted)}
          disabled={closed}
        />
      </div>
    ),
    hooks: (
      <HooksField
        idPrefix={ids("hooks-field")}
        settings={draft.settings}
        onChange={editSettings}
        error={settingsText("hooks")}
        disabled={closed}
      />
    ),
    retention: (
      <RetentionField
        idPrefix={ids("retention-field")}
        settings={{ ...draft.settings, retentionOwn: true }}
        onChange={(patch) => editSettings({ ...patch, retentionOwn: true })}
        problems={{
          keepDaily: settingsText("keepDaily"),
          keepWeekly: settingsText("keepWeekly"),
          keepMonthly: settingsText("keepMonthly"),
        }}
        disabled={closed}
      />
    ),
  };

  return (
    <>
      <form
        className="flex min-h-0 flex-1 flex-col"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="flex-1 space-y-4 overflow-y-auto p-6">
          <JobsAccessNote access={access} />
          <div ref={summaryRef} tabIndex={-1} className="space-y-3 outline-none empty:hidden">
            {detailError ? (
              <Alert variant="destructive">
                <TriangleAlert aria-hidden="true" />
                <AlertDescription>{t("editor.fix.description")}</AlertDescription>
              </Alert>
            ) : null}
            {errorText ? (
              <Alert variant="destructive">
                <TriangleAlert aria-hidden="true" />
                <AlertDescription>{errorText}</AlertDescription>
              </Alert>
            ) : null}
          </div>
          {groups.map((id) => group(id, body[id]))}
        </div>
        <SheetFooter className="flex-row justify-end gap-2 border-t border-border p-4">
          <Button type="button" variant="outline" onClick={onCancel} disabled={save.isPending}>
            {t("common:actions.cancel")}
          </Button>
          <Button
            type="submit"
            loading={save.isPending}
            disabled={closed}
            aria-describedby={closed ? access.noteId : undefined}
            title={closed ? access.reason : undefined}
          >
            {t("overrides.save")}
          </Button>
        </SheetFooter>
      </form>
      {identity.dialog}
    </>
  );
}
