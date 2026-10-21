import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowUpCircle, Ban, Pause, Play } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { ConfirmDialog } from "@/components/kit";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { useTenantScope } from "@/features/endpoints/hooks";
import { errorMessageKey } from "@/lib/api";

import {
  cancelGuestBackup,
  cancelQueuedBackups,
  type PveCancelResult,
  type PveNode,
  pveKeys,
  requestNodeUpdate,
  setNodeQueuePaused,
} from "./api.js";
import { PVE_NAMESPACE } from "./i18n.js";

/**
 * Stopping backups of VMs and containers (0.4.2, docs/PVE.md "Stopping a backup"): a running
 * backup stops with the node's next heartbeat (seconds), a queued one is withdrawn at once.
 * Every action asks first and is audited by the server; only the roles that may start a backup
 * see these pages at all.
 */

function useRefresh() {
  const queryClient = useQueryClient();
  const { tenantId } = useTenantScope();
  return () => void queryClient.invalidateQueries({ queryKey: pveKeys.all(tenantId) });
}

/** The toast after a cancel: what was withdrawn and what is being stopped. */
function useCancelToast() {
  const { t } = useTranslation(PVE_NAMESPACE);
  return (result: PveCancelResult) => {
    if (result.stopping > 0) {
      toast.success(t("cancel.stopping"), { description: t("cancel.stoppingNote") });
    } else if (result.withdrawn > 0) {
      toast.success(t("cancel.withdrawn", { count: result.withdrawn }));
    } else {
      toast.info(t("cancel.nothingQueued"));
    }
  };
}

/** "Cancelling…" while the node has not stopped it yet, with who asked. */
export function CancellingBadge({ by }: { by?: string | null }) {
  const { t } = useTranslation(PVE_NAMESPACE);
  return (
    <Badge
      variant="warning"
      data-slot="pve-cancelling"
      title={by ? t("cancel.requestedBy", { name: by }) : undefined}
    >
      {t("cancel.cancelling")}
    </Badge>
  );
}

/** "Cancelled by <user>" (or just "Cancelled" when nobody is named). */
export function CancelledBadge({ by }: { by?: string | null }) {
  const { t } = useTranslation(PVE_NAMESPACE);
  return (
    <Badge variant="muted" data-slot="pve-cancelled">
      {by ? t("cancel.cancelledBy", { name: by }) : t("cancel.cancelled")}
    </Badge>
  );
}

export interface CancelBackupButtonProps {
  guestId: string;
  /** The guest's name for the question and the accessible label. */
  name: string;
  /** What runs: a backup on the node, or one that waits for it. */
  activity: "running" | "queued";
  /** A stop was asked for already: the button is replaced by "Cancelling…". */
  cancelling?: boolean;
  cancelledBy?: string | null;
  size?: "sm" | "default";
  variant?: "outline" | "ghost";
  /**
   * The button of a table row (VMs & containers): the short label ("Stop", "Withdraw"), and
   * while the stop is pending a disabled button with a spinner instead of the badge, all with
   * `className` (a fixed width), so the row keeps its size whatever the guest does.
   */
  compact?: boolean;
  className?: string;
}

/** Stop the guest's running backup, or withdraw its queued one, after a question. */
export function CancelBackupButton({
  guestId,
  name,
  activity,
  cancelling = false,
  cancelledBy,
  size = "sm",
  variant = "outline",
  compact = false,
  className,
}: CancelBackupButtonProps) {
  const { t } = useTranslation(PVE_NAMESPACE);
  const { t: tc } = useTranslation();
  const refresh = useRefresh();
  const done = useCancelToast();
  const [open, setOpen] = React.useState(false);
  const cancel = useMutation({
    mutationFn: () => cancelGuestBackup(guestId),
    onSuccess: (result) => {
      done(result);
      refresh();
    },
    onError: refresh,
  });
  if (cancelling) {
    return compact ? (
      <Button
        type="button"
        size={size}
        variant={variant}
        loading
        className={className}
        title={cancelledBy ? t("cancel.requestedBy", { name: cancelledBy }) : undefined}
        data-slot="pve-cancelling"
      >
        <span className="min-w-0 truncate">{t("guests.action.cancelling")}</span>
      </Button>
    ) : (
      <CancellingBadge by={cancelledBy} />
    );
  }
  const running = activity === "running";
  const label = compact
    ? running
      ? t("guests.action.stop")
      : t("guests.action.withdraw")
    : running
      ? t("cancel.stop")
      : t("cancel.withdraw");
  return (
    <>
      <Button
        type="button"
        size={size}
        variant={variant}
        className={className}
        onClick={() => setOpen(true)}
        aria-label={running ? t("cancel.stopOf", { name }) : t("cancel.withdrawOf", { name })}
        data-slot="pve-cancel-backup"
      >
        <Ban aria-hidden="true" />
        <span className="min-w-0 truncate">{label}</span>
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={running ? t("cancel.stopTitle", { name }) : t("cancel.withdrawTitle", { name })}
        description={running ? t("cancel.stopBody") : t("cancel.withdrawBody")}
        confirmLabel={running ? t("cancel.stopConfirm") : t("cancel.withdrawConfirm")}
        cancelLabel={t("cancel.keep")}
        destructive
        pending={cancel.isPending}
        error={cancel.error ? tc(errorMessageKey(cancel.error)) : undefined}
        onConfirm={() => cancel.mutateAsync().then(() => setOpen(false))}
      />
    </>
  );
}

/** "Cancel all queued": every backup that waits, of one node or (without a node) the tenant. */
export function CancelQueuedButton({
  node,
  count,
}: {
  node: Pick<PveNode, "id" | "name"> | null;
  count: number;
}) {
  const { t } = useTranslation(PVE_NAMESPACE);
  const [open, setOpen] = React.useState(false);
  if (count <= 0) {
    return null;
  }
  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => setOpen(true)}
        data-slot="pve-cancel-queued"
      >
        <Ban aria-hidden="true" />
        {t("cancel.allQueued", { count })}
      </Button>
      <CancelQueuedDialog node={node} count={count} open={open} onOpenChange={setOpen} />
    </>
  );
}

/** The question of "Cancel all queued", for a button or a menu entry that opens it. */
export function CancelQueuedDialog({
  node,
  count,
  open,
  onOpenChange: setOpen,
}: {
  node: Pick<PveNode, "id" | "name"> | null;
  count: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation(PVE_NAMESPACE);
  const { t: tc } = useTranslation();
  const refresh = useRefresh();
  const done = useCancelToast();
  const cancel = useMutation({
    mutationFn: () => cancelQueuedBackups(node?.id ?? null),
    onSuccess: (result) => {
      done(result);
      refresh();
    },
    onError: refresh,
  });
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={setOpen}
      title={
        node
          ? t("cancel.allQueuedNodeTitle", { count, node: node.name })
          : t("cancel.allQueuedTitle", { count })
      }
      description={t("cancel.allQueuedBody")}
      confirmLabel={t("cancel.withdrawConfirm")}
      cancelLabel={t("cancel.keep")}
      destructive
      pending={cancel.isPending}
      error={cancel.error ? tc(errorMessageKey(cancel.error)) : undefined}
      onConfirm={() => cancel.mutateAsync().then(() => setOpen(false))}
    />
  );
}

/** Pause or resume a node's queue (the mutation, with its toast). */
export function useNodeQueueChange(node: Pick<PveNode, "id" | "name" | "queuePausedAt">) {
  const { t } = useTranslation(PVE_NAMESPACE);
  const { t: tc } = useTranslation();
  const refresh = useRefresh();
  const paused = Boolean(node.queuePausedAt);
  return useMutation({
    mutationFn: () => setNodeQueuePaused(node.id, !paused),
    onSuccess: () => {
      toast.success(
        paused ? t("queue.resumed", { node: node.name }) : t("queue.paused", { node: node.name }),
      );
      refresh();
    },
    onError: (error) => {
      toast.error(tc(errorMessageKey(error)));
      refresh();
    },
  });
}

/** The question before a node's queue is paused, for a button or a menu entry that opens it. */
export function PauseQueueDialog({
  node,
  open,
  onOpenChange,
}: {
  node: PveNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation(PVE_NAMESPACE);
  const change = useNodeQueueChange(node);
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("queue.pauseTitle", { node: node.name })}
      description={t("queue.pauseBody")}
      confirmLabel={t("queue.pause")}
      pending={change.isPending}
      onConfirm={() => change.mutateAsync().then(() => onOpenChange(false))}
    />
  );
}

/** Pause or resume a node's queue: while paused, no backup starts on the node. */
export function NodeQueueButton({ node }: { node: PveNode }) {
  const { t } = useTranslation(PVE_NAMESPACE);
  const [open, setOpen] = React.useState(false);
  const paused = Boolean(node.queuePausedAt);
  const change = useNodeQueueChange(node);
  if (node.queuePausedAt === undefined) {
    // A server before 0.4.2 has no queue control.
    return null;
  }
  if (paused) {
    return (
      <Button
        type="button"
        size="sm"
        variant="outline"
        loading={change.isPending}
        onClick={() => change.mutate()}
        data-slot="pve-queue-resume"
      >
        <Play aria-hidden="true" />
        {t("queue.resume")}
      </Button>
    );
  }
  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        onClick={() => setOpen(true)}
        data-slot="pve-queue-pause"
      >
        <Pause aria-hidden="true" />
        {t("queue.pause")}
      </Button>
      <PauseQueueDialog node={node} open={open} onOpenChange={setOpen} />
    </>
  );
}

/** "Paused by <user>" next to a node whose queue is held. */
export function QueuePausedBadge({ node }: { node: PveNode }) {
  const { t } = useTranslation(PVE_NAMESPACE);
  if (!node.queuePausedAt) {
    return null;
  }
  return (
    <Badge variant="warning" data-slot="pve-queue-paused">
      {node.queuePausedBy
        ? t("queue.pausedBy", { name: node.queuePausedBy })
        : t("queue.pausedBadge")}
    </Badge>
  );
}

/** "Update now": the node installs the offered restow-pve release as soon as it is idle. */
export function NodeUpdateButton({ node }: { node: PveNode }) {
  const { t } = useTranslation(PVE_NAMESPACE);
  const { t: tc } = useTranslation();
  const refresh = useRefresh();
  const update = useMutation({
    mutationFn: () => requestNodeUpdate(node.id),
    onSuccess: () => {
      toast.success(t("update.requested", { node: node.name }), {
        description: t("update.requestedNote"),
      });
      refresh();
    },
    onError: (error) => toast.error(tc(errorMessageKey(error))),
  });
  if (!node.updateVersion) {
    return null;
  }
  if (node.updateRequestedAt) {
    return (
      <Badge variant="info" data-slot="pve-node-updating" title={t("update.requestedNote")}>
        {t("update.pending", { version: node.updateVersion })}
      </Badge>
    );
  }
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      loading={update.isPending}
      onClick={() => update.mutate()}
      title={t("update.available", { version: node.updateVersion })}
      data-slot="pve-node-update"
    >
      <ArrowUpCircle aria-hidden="true" />
      {t("update.now", { version: node.updateVersion })}
    </Button>
  );
}
