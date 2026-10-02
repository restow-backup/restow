import { TriangleAlert } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { ConfirmDialog } from "@/components/kit";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

import type { BackupJob } from "../api.js";
import { memberInputsOf } from "../form.js";
import { useAddJobMembers } from "../hooks.js";
import { type MemberConflict, conflictsOf, jobErrorKey } from "../problems.js";
import { type JobsAccess, JobsAccessNote } from "./access-note.js";
import { MemberPicker, type PickerValue } from "./member-picker.js";

export interface AddMembersSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  job: BackupJob;
  access: JobsAccess;
  /** How many were added (the page shows the toast). */
  onAdded: (count: number) => void;
}

const NOTHING: PickerValue = { selected: [], moves: [] };

/**
 * "Add" on the scope tab: the same picker as the job editor, in a sheet of its own. Objects or
 * machines that belong to another job are taken over only after "Move here" (or, when
 * another administrator took them meanwhile, after the question that follows the refusal).
 */
export function AddMembersSheet({
  open,
  onOpenChange,
  job,
  access,
  onAdded,
}: AddMembersSheetProps) {
  const { t } = useTranslation("backupjobs");
  const [value, setValue] = React.useState<PickerValue>(NOTHING);
  const [conflicts, setConflicts] = React.useState<MemberConflict[] | null>(null);
  const [error, setError] = React.useState<unknown>(null);
  const [confirming, setConfirming] = React.useState(false);
  const add = useAddJobMembers(job.id);
  const noteId = React.useId();
  const sheetAccess = React.useMemo<JobsAccess>(() => ({ ...access, noteId }), [access, noteId]);
  const dirty = value.selected.length > 0;

  // Every opening starts empty.
  const [wasOpen, setWasOpen] = React.useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setValue(NOTHING);
      setError(null);
      setConflicts(null);
    }
  }

  const close = () => onOpenChange(false);
  const submit = async (move: boolean): Promise<void> => {
    setError(null);
    try {
      const result = await add.mutateAsync({
        members: memberInputsOf(value.selected),
        ...(move || value.moves.length > 0 ? { move: true } : {}),
      });
      onAdded(value.selected.length);
      void result;
      close();
    } catch (failure) {
      const taken = conflictsOf(failure);
      if (taken && taken.length > 0) {
        setConflicts(taken);
      } else {
        setError(failure);
      }
    }
  };

  return (
    <>
      <Sheet
        open={open}
        onOpenChange={(next) => {
          if (next) onOpenChange(true);
          else if (dirty) setConfirming(true);
          else close();
        }}
      >
        <SheetContent
          side="right"
          className="flex w-full flex-col gap-0 p-0 sm:max-w-2xl"
          data-slot="add-members-sheet"
        >
          <SheetHeader className="border-b border-border p-6 pr-12">
            <SheetTitle className="text-lg">{t(`addMembers.title.${job.kind}`)}</SheetTitle>
            <SheetDescription>
              {t(`addMembers.description.${job.kind}`, { job: job.name })}
            </SheetDescription>
          </SheetHeader>
          <form
            className="flex min-h-0 flex-1 flex-col"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              if (value.selected.length > 0 && !access.closed) {
                void submit(false);
              }
            }}
          >
            <div className="flex-1 space-y-4 overflow-y-auto p-6">
              <JobsAccessNote access={sheetAccess} />
              {error ? (
                <Alert variant="destructive">
                  <TriangleAlert aria-hidden="true" />
                  <AlertDescription>{t(jobErrorKey(error))}</AlertDescription>
                </Alert>
              ) : null}
              <MemberPicker
                idPrefix="add-members"
                kind={job.kind}
                jobId={job.id}
                value={value}
                onChange={setValue}
                disabled={access.closed}
              />
            </div>
            <SheetFooter className="flex-row justify-end gap-2 border-t border-border p-4">
              <Button
                type="button"
                variant="outline"
                onClick={() => (dirty ? setConfirming(true) : close())}
                disabled={add.isPending}
              >
                {t("common:actions.cancel")}
              </Button>
              <Button
                type="submit"
                loading={add.isPending}
                disabled={access.closed || value.selected.length === 0}
                aria-describedby={access.closed ? sheetAccess.noteId : undefined}
                title={access.closed ? access.reason : undefined}
              >
                {value.selected.length === 0
                  ? t("addMembers.submit")
                  : t("addMembers.submitSome", { count: value.selected.length })}
              </Button>
            </SheetFooter>
          </form>
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
          close();
        }}
      />
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
          setConflicts(null);
          void submit(true);
        }}
      >
        <ul className="max-h-48 space-y-1 overflow-auto text-sm">
          {(conflicts ?? []).map((conflict) => {
            const member = value.selected.find((candidate) => candidate.id === conflict.targetId);
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
    </>
  );
}
