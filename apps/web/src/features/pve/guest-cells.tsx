import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Play } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { useTenantScope } from "@/features/endpoints/hooks";
import { errorMessageKey } from "@/lib/api";
import { formatBytes } from "@/lib/format";
import { cn } from "@/lib/utils";

import { backupNow, type PveGuest, type PveNode, pveKeys } from "./api.js";
import { progressPercent } from "./backup-progress.js";
import { CancelBackupButton } from "./cancel-controls.js";
import { type GuestStatus, guestStatuses } from "./guest-status.js";
import { PVE_NAMESPACE } from "./i18n.js";

/**
 * The cells of a guest row (VMs & containers): one state badge and a small indicator beside
 * it, one action button whatever the guest does, and the backup's size on one line. Each part
 * has a fixed size, so a row never changes its height or its columns their width while the
 * figures poll in (0.4.3, "the page jumps").
 */

/**
 * The width of the row's action button in every variant: "Back up now", "Stop", "Withdraw",
 * "Stopping…" and the spinner while a request is on its way. The label is cut if a language
 * makes it longer; the button's accessible name is the full text.
 */
export const GUEST_ACTION_CLASS = "w-36 justify-start";

/** The width of the state badge; its label is cut with an ellipsis (the panel has all of it). */
export const GUEST_STATUS_BADGE_CLASS = "max-w-40 min-w-0";

/** The slot beside the badge: a small bar while a backup runs, or how many more states apply. */
export const GUEST_STATUS_SLOT_CLASS = "inline-flex w-16 shrink-0 items-center gap-1";

/** The label of a state, `guests.status.<key>`. */
export function useStatusLabel() {
  const { t } = useTranslation(PVE_NAMESPACE);
  return (status: Pick<GuestStatus, "key">) => t(`guests.status.${status.key}`);
}

/** One state as a badge (the table's primary state, or one of the panel's list). */
export function GuestStatusBadge({
  status,
  className,
}: {
  status: GuestStatus;
  className?: string;
}) {
  const label = useStatusLabel();
  const text = label(status);
  return (
    <Badge
      variant={status.tone}
      data-slot="pve-guest-status"
      data-status={status.key}
      title={text}
      className={cn("justify-start", className)}
    >
      <span className="min-w-0 truncate">{text}</span>
    </Badge>
  );
}

/**
 * The State cell: the state with the highest priority, and beside it either the progress of a
 * running backup (a small bar and the percentage) or "+2" for further problems.
 */
export function GuestStatusCell({
  guest,
  statuses,
}: {
  guest: Pick<PveGuest, "activity" | "progress" | "name" | "vmid">;
  statuses: readonly GuestStatus[];
}) {
  const { t } = useTranslation(PVE_NAMESPACE);
  const label = useStatusLabel();
  const primary = statuses[0] as GuestStatus;
  const more = statuses.slice(1).filter((status) => status.problem);
  const percent = guest.activity === "running" ? progressPercent(guest.progress) : null;
  return (
    <div className="flex min-w-0 items-center gap-2" data-slot="pve-guest-state">
      <GuestStatusBadge status={primary} className={GUEST_STATUS_BADGE_CLASS} />
      <span className={GUEST_STATUS_SLOT_CLASS} data-slot="pve-guest-state-slot">
        {guest.activity === "running" ? (
          percent === null ? (
            <span className="h-1.5 w-full animate-pulse rounded-full bg-info/30 motion-reduce:animate-none" />
          ) : (
            <>
              <span
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
                aria-label={t("guests.progressLabel", { name: guest.name ?? String(guest.vmid) })}
                className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted"
              >
                <span className="block h-full bg-info" style={{ width: `${percent}%` }} />
              </span>
              <span className="w-[4ch] text-right text-xs text-muted-foreground tabular-nums">
                {percent}%
              </span>
            </>
          )
        ) : more.length > 0 ? (
          <Badge
            variant="muted"
            className="px-1.5"
            title={more.map(label).join("\n")}
            data-slot="pve-guest-more-states"
          >
            +{more.length}
            <span className="sr-only">: {more.map(label).join(", ")}</span>
          </Badge>
        ) : null}
      </span>
    </div>
  );
}

/** A short date in the user's language: "3 Oct" / "3. Okt.". */
export function shortDate(value: string, language: string): string {
  return new Intl.DateTimeFormat(language, { day: "numeric", month: "short" }).format(
    new Date(value),
  );
}

/**
 * The backups of a guest on one line (#58): how large the first (full) backup was and when,
 * and what the last follow-up backup added: "First: 32 GB on 3 Oct · Last: +210 MB". What the
 * newest restore point holds is in the tooltip; everything in full in the detail panel.
 */
export function BackupSizeLine({ guest }: { guest: Pick<PveGuest, "backups"> }) {
  const { t, i18n } = useTranslation(PVE_NAMESPACE);
  const language = i18n.resolvedLanguage ?? i18n.language;
  const last = guest.backups?.last ?? null;
  const first = guest.backups?.first ?? null;
  if (!last && !first) {
    return <span className="text-muted-foreground">{t("guests.backupNone")}</span>;
  }
  const firstText = first
    ? t("guests.backupLine.first", {
        size: formatBytes(first.added ?? first.contains, language),
        date: shortDate(first.at, language),
      })
    : null;
  // The newest point is the first backup itself until a follow-up ran.
  const followUp = last && first && last.at !== first.at && last.added !== null;
  const lastText = followUp
    ? t("guests.backupLine.last", { size: formatBytes(last?.added ?? 0, language) })
    : null;
  const title = [
    firstText,
    lastText,
    last ? t("guests.backupContains", { size: formatBytes(last.contains, language) }) : null,
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <span className="tabular-nums" title={title} data-slot="pve-backup-size">
      {firstText}
      {lastText ? <span className="text-muted-foreground"> · {lastText}</span> : null}
    </span>
  );
}

/**
 * Ask before an action reaches the Restow server's own VM (see `useSelfBackupGuard`); the
 * page owns the one dialog, the rows call it.
 */
export type SelfBackupGuard = (
  guests: readonly PveGuest[],
  run: (confirmed: boolean) => void | Promise<void>,
) => void;

/** "Back up now" of one guest, with its own pending state (other rows stay usable). */
export function useBackupNow() {
  const { t } = useTranslation(PVE_NAMESPACE);
  const { t: tc } = useTranslation();
  const queryClient = useQueryClient();
  const { tenantId } = useTenantScope();
  return useMutation({
    mutationFn: ({ id, confirmSelfBackup }: { id: string; confirmSelfBackup?: boolean }) =>
      backupNow(id, false, { confirmSelfBackup }),
    onSuccess: (result) => {
      if (result.alreadyQueued) {
        toast.info(t("guests.backupAlreadyQueued"));
      } else {
        toast.success(t("guests.backupQueued"));
      }
      void queryClient.invalidateQueries({ queryKey: pveKeys.all(tenantId) });
    },
    onError: (error) => toast.error(tc(errorMessageKey(error))),
  });
}

/**
 * The one action of a guest row: "Back up now", or while its backup waits "Withdraw", while it
 * runs "Stop", while a stop is pending "Stopping…". Every variant has the same size
 * (`GUEST_ACTION_CLASS`), so the row does not move when the guest changes state.
 */
export function GuestActionButton({
  guest,
  guard,
  className = GUEST_ACTION_CLASS,
  variant = "outline",
}: {
  guest: PveGuest;
  guard: SelfBackupGuard;
  className?: string;
  variant?: "outline" | "ghost";
}) {
  const { t } = useTranslation(PVE_NAMESPACE);
  const backup = useBackupNow();
  const name = guest.name ?? String(guest.vmid);
  if (guest.activity) {
    return (
      <CancelBackupButton
        guestId={guest.id}
        name={name}
        activity={guest.activity}
        cancelling={guest.cancelling}
        cancelledBy={guest.cancelledBy}
        compact
        variant={variant}
        className={className}
      />
    );
  }
  const template = guest.kind === "vm" && guest.template;
  return (
    <Button
      type="button"
      size="sm"
      variant={variant}
      className={className}
      loading={backup.isPending}
      disabled={template || !guest.present}
      aria-label={t("inventory.actions.backupNowOf", { name })}
      data-slot="pve-backup-now"
      onClick={() =>
        guard([guest], (confirmSelfBackup) => backup.mutate({ id: guest.id, confirmSelfBackup }))
      }
    >
      <Play aria-hidden="true" />
      <span className="min-w-0 truncate">{t("guests.backupNow")}</span>
    </Button>
  );
}

/**
 * Every state of a guest as badges (the detail panel): the states by priority, then what the
 * guest is (privileged) and how its VM disks were read. No error text: the panel shows that in
 * full beneath.
 */
export function GuestState({
  guest,
  node,
}: {
  guest: PveGuest;
  node?: Pick<PveNode, "online" | "queuePausedAt"> | null;
}) {
  const { t } = useTranslation(PVE_NAMESPACE);
  const statuses = guestStatuses(guest, node);
  return (
    <ul
      className="flex flex-wrap gap-1.5"
      aria-label={t("sheet.state")}
      data-slot="pve-guest-states"
    >
      {statuses.map((status) => (
        <li key={status.key} className="min-w-0">
          <GuestStatusBadge status={status} className="max-w-full" />
        </li>
      ))}
      {guest.privileged && guest.kind === "ct" ? (
        <li>
          <Badge variant="warning">{t("guests.privileged")}</Badge>
        </li>
      ) : null}
      {guest.bitmapState ? (
        <li>
          <Badge variant="info">
            {guest.bitmapState === "incremental" ? t("guests.incremental") : t("guests.fullRead")}
          </Badge>
        </li>
      ) : null}
    </ul>
  );
}
