import type { BackupJob, JobKind } from "../api.js";
import type { JobsAccess } from "./access-note.js";
import { CopyJobEditor, type CopyPrefill } from "./copy-job-editor.js";
import { JobEditor } from "./job-editor.js";
import { ShareJobEditor } from "./share-job-editor.js";

export interface KindEditorProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kind: JobKind;
  job: BackupJob | null;
  preselect?: readonly string[];
  /** Source, target and folder of a new copy job. */
  copy?: CopyPrefill;
  access: JobsAccess;
  onSaved: (change: "created" | "updated", job: BackupJob) => void;
}

/**
 * The editor of a job of any kind: mail and machine jobs share one editor, file share jobs and
 * copy jobs have their own (docs/FILESHARES.md 12.5, 12.6).
 */
export function KindEditor({ kind, copy, ...props }: KindEditorProps) {
  if (kind === "share") {
    return <ShareJobEditor {...props} />;
  }
  if (kind === "copy") {
    const { preselect: _preselect, ...rest } = props;
    return <CopyJobEditor {...rest} prefill={copy} />;
  }
  return <JobEditor kind={kind} {...props} />;
}
