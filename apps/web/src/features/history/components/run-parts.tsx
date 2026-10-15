import {
  Cloud,
  Inbox,
  Laptop,
  type LucideIcon,
  Mail,
  Network,
  Server,
  ShieldAlert,
  ShieldCheck,
  ShieldQuestion,
  ShieldX,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { StatusBadge } from "@/components/kit";
import { cn } from "@/lib/utils";

import type { Run, RunRestoreCheck, RunState, SubjectKind } from "../api";
import { checkView, stateView } from "../presenters";

/** The small pieces every place that shows a run shares: its state, its subject, its restore check. */

/** What the run is, in one badge. A running run is Lapis with a pulsing dot (still, with reduced motion). */
export function RunStateBadge({
  run,
  className,
}: {
  run: Pick<Run, "state" | "kind" | "checkIncomplete">;
  className?: string;
}) {
  const { t } = useTranslation("history");
  const view = stateView(run);
  return (
    <StatusBadge
      tone={view.tone}
      live={view.live}
      icon={!view.live && view.tone !== "neutral"}
      className={cn("whitespace-nowrap", className)}
      data-state={run.state}
    >
      {t(`state.${view.key}`)}
    </StatusBadge>
  );
}

const SUBJECT_ICON: Readonly<Record<SubjectKind, LucideIcon>> = {
  mailbox: Mail,
  onedrive: Cloud,
  imap: Inbox,
  server: Server,
  client: Laptop,
  file_share: Network,
};

export function SubjectIcon({ kind, className }: { kind: SubjectKind; className?: string }) {
  const Icon = SUBJECT_ICON[kind];
  return <Icon aria-hidden="true" className={cn("size-4 shrink-0", className)} />;
}

const CHECK_ICON = {
  passed: ShieldCheck,
  warning: ShieldAlert,
  failed: ShieldX,
  running: ShieldQuestion,
  queued: ShieldQuestion,
  unverified: ShieldQuestion,
  none: ShieldQuestion,
} as const;

/**
 * The restore check of a backup, in words: green only when it read the backup back and found it
 * whole. Nothing for a run that has no backup to check.
 */
export function RestoreCheckChip({
  check,
  className,
}: {
  check: Pick<RunRestoreCheck, "state">;
  className?: string;
}) {
  const { t } = useTranslation("history");
  const view = checkView(check);
  if (view.key === "none") {
    return null;
  }
  return (
    <StatusBadge
      tone={view.tone}
      icon={CHECK_ICON[view.key]}
      className={cn("whitespace-nowrap", className)}
      data-check={view.key}
    >
      {t(`restoreCheck.${view.key}`)}
    </StatusBadge>
  );
}

/** What a run did, for headings and rows: "Backup · Anna" (the type for maintenance runs). */
export function useRunTitle() {
  const { t } = useTranslation("history");
  return (run: Pick<Run, "kind" | "type" | "subject">): string => {
    // Maintenance runs, and the copy runs of file shares, are named by their type.
    const kind =
      (run.kind === "maintenance" || run.type === "copy") &&
      t(`type.${run.type}`, { defaultValue: "" })
        ? t(`type.${run.type}`)
        : t(`kind.${run.kind}`);
    return run.subject ? t("runTitle", { kind, subject: run.subject.name }) : kind;
  };
}

/** A run's state spelled out for a screen reader or a toast. */
export function stateWord(
  t: (key: string) => string,
  state: RunState,
  run: Pick<Run, "kind" | "checkIncomplete">,
) {
  return t(`state.${stateView({ ...run, state }).key}`);
}
