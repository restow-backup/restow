import { Info } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { Alert, AlertDescription } from "@/components/ui/alert";

import { type JobsWriteBlock, useJobsWriteBlock } from "../access.js";

/**
 * What the viewer may do with jobs, for the controls of a page: whether they are
 * closed, why in one sentence, and the id of the element that says it, which every
 * closed control names with `aria-describedby` (and in `title`), so the reason
 * is at the button before anybody clicks.
 */
export interface JobsAccess {
  block: JobsWriteBlock | null;
  closed: boolean;
  /** Id of the note that says why (render {@link JobsAccessNote} with the same access). */
  noteId: string;
  /** The sentence; undefined while the controls are open. */
  reason: string | undefined;
}

export function useJobsAccess(): JobsAccess {
  const { t } = useTranslation("backupjobs");
  const block = useJobsWriteBlock();
  const noteId = React.useId();
  return {
    block,
    closed: block !== null,
    noteId,
    reason: block === null ? undefined : t(`access.${block}`),
  };
}

/** The props a closed control carries: the reason by id and as a tooltip. */
export function closedProps(access: JobsAccess): {
  "aria-describedby"?: string;
  title?: string;
} {
  return access.closed ? { "aria-describedby": access.noteId, title: access.reason } : {};
}

/** The one sentence on top of a page whose controls are closed; nothing while they are open. */
export function JobsAccessNote({ access, className }: { access: JobsAccess; className?: string }) {
  if (access.block === null) {
    return null;
  }
  return (
    <Alert
      variant="info"
      id={access.noteId}
      className={className}
      data-slot="access-note"
      data-reason={access.block}
    >
      <Info aria-hidden="true" />
      <AlertDescription>{access.reason}</AlertDescription>
    </Alert>
  );
}
