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
    return <CancellingBadge by={cancelledBy} />;
  }
  const running = activity === "running";
  return (
    <>
      <Button
        type="button"
        size={size}
        variant={variant}
        onClick={() => setOpen(true)}
        aria-label={running ? t("cancel.stopOf", { name }) : t("cancel.withdrawOf", { name })}
        data-slot="pve-cancel-backup"
      >
        <Ban aria-hidden="true" />
        {running ? t("cancel.stop") : t("cancel.withdraw")}
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
  const { t: tc } = useTranslation();
  const refresh = useRefresh();
  const done = useCancelToast();
  const [open, setOpen] = React.useState(false);
  const cancel = useMutation({
    mutationFn: () => cancelQueuedBackups(node?.id ?? null),
    onSuccess: (result) => {
      done(result);
      refresh();
    },
    onError: refresh,
  });
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
    </>
  );
}

/** Pause or resume a node's queue: while paused, no backup starts on the node. */
export function NodeQueueButton({ node }: { node: PveNode }) {
  const { t } = useTranslation(PVE_NAMESPACE);
  const { t: tc } = useTranslation();
  const refresh = useRefresh();
  const [open, setOpen] = React.useState(false);
  const paused = Boolean(node.queuePausedAt);
  const change = useMutation({
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
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={t("queue.pauseTitle", { node: node.name })}
        description={t("queue.pauseBody")}
        confirmLabel={t("queue.pause")}
        pending={change.isPending}
        onConfirm={() => change.mutateAsync().then(() => setOpen(false))}
      />
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
