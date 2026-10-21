import type { ColumnDef } from "@tanstack/react-table";
import { Ban, Pause, Play, Server, Unplug } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { DataTable, EmptyState, RelativeTime, rowActionsColumn } from "@/components/kit";
import { Badge } from "@/components/ui/badge";

import type { PveNode } from "./api.js";
import {
  CancelQueuedDialog,
  NodeUpdateButton,
  PauseQueueDialog,
  useNodeQueueChange,
} from "./cancel-controls.js";
import { PVE_NAMESPACE } from "./i18n.js";

/**
 * The Proxmox VE nodes of VMs & containers: name and cluster, whether the node reports
 * (heartbeat), its restow-pve version and whether a newer one is offered, the Proxmox VE
 * version, its guests, its queue and its problems. Queue control and revoking are in the row's
 * menu (each asks first).
 */

export interface NodeRow extends PveNode {
  cluster: string;
  /** Guests the overview lists on this node. */
  guests: number;
}

/**
 * The restow-pve version of a node as the table shows it: what it runs, the release it would
 * update to (null: up to date, or the server knows no newer one), whether it is behind the
 * release the server offers, and whether "update now" is pending. The one place that reads the
 * version fields of a node. A server from 0.4.3 says `outdated` and `offeredVersion`; an older
 * one only `updateVersion`, which then decides.
 */
export function nodeVersion(
  node: Pick<
    PveNode,
    "helperVersion" | "updateVersion" | "updateRequestedAt" | "outdated" | "offeredVersion"
  >,
) {
  const outdated = typeof node.outdated === "boolean" ? node.outdated : Boolean(node.updateVersion);
  const update = outdated ? (node.offeredVersion ?? node.updateVersion ?? null) : null;
  return {
    version: node.helperVersion,
    outdated,
    update,
    updating: Boolean(update && node.updateRequestedAt),
  };
}

export const NODE_COLUMN_SIZES = {
  name: 170,
  status: 180,
  helper: 200,
  pve: 96,
  guests: 80,
  queue: 140,
  problems: 180,
  actions: 48,
} as const;

function problemLabel(t: (key: string, options?: Record<string, unknown>) => string, code: string) {
  const key = `problems.${code}`;
  const label = t(key);
  return label === key ? t("problems.unknown", { code }) : label;
}

/** The resume entry needs the mutation of its node; a menu entry cannot hold a hook. */
function ResumeRunner({ node, onDone }: { node: PveNode; onDone: () => void }) {
  const change = useNodeQueueChange(node);
  const started = React.useRef(false);
  React.useEffect(() => {
    if (!started.current) {
      started.current = true;
      change.mutateAsync().finally(onDone);
    }
  }, [change, onDone]);
  return null;
}

export function NodesTable({
  nodes,
  loading = false,
  onRevoke,
}: {
  nodes: readonly NodeRow[] | undefined;
  loading?: boolean;
  onRevoke: (node: NodeRow) => void;
}) {
  const { t } = useTranslation(PVE_NAMESPACE);
  const [pausing, setPausing] = React.useState<NodeRow | null>(null);
  const [resuming, setResuming] = React.useState<NodeRow | null>(null);
  const [withdrawing, setWithdrawing] = React.useState<NodeRow | null>(null);
  const columns = React.useMemo<ColumnDef<NodeRow>[]>(
    () => [
      {
        id: "name",
        accessorKey: "name",
        header: t("nodes.node"),
        size: NODE_COLUMN_SIZES.name,
        meta: { label: t("nodes.node") },
        cell: ({ row }) => (
          <span title={`${row.original.name} · ${row.original.cluster}`}>
            <span className="font-medium">{row.original.name}</span>
            <span className="text-muted-foreground"> · {row.original.cluster}</span>
          </span>
        ),
      },
      {
        id: "status",
        accessorFn: (node) => (node.online ? 1 : 0),
        header: t("nodes.status"),
        size: NODE_COLUMN_SIZES.status,
        meta: { label: t("nodes.status") },
        cell: ({ row }) => (
          <span className="flex min-w-0 items-center gap-2">
            <Badge variant={row.original.online ? "outline" : "warning"}>
              {row.original.online ? t("nodes.online") : t("nodes.offline")}
            </Badge>
            <span className="min-w-0 truncate text-xs text-muted-foreground">
              <RelativeTime value={row.original.lastSeenAt} fallback={t("nodes.never")} />
            </span>
          </span>
        ),
      },
      {
        id: "helper",
        accessorFn: (node) => node.helperVersion ?? "",
        header: t("nodes.helper"),
        size: NODE_COLUMN_SIZES.helper,
        meta: { label: t("nodes.helper") },
        cell: ({ row }) => {
          const version = nodeVersion(row.original);
          return (
            <span className="flex min-w-0 items-center gap-2" data-slot="pve-node-version">
              <span
                className="tabular-nums"
                title={
                  version.update ? t("update.available", { version: version.update }) : undefined
                }
              >
                {version.version ?? ""}
              </span>
              {version.update ? (
                <span className="min-w-0 truncate">
                  <NodeUpdateButton node={row.original} />
                </span>
              ) : null}
            </span>
          );
        },
      },
      {
        id: "pve",
        accessorFn: (node) => node.pveVersion ?? "",
        header: t("nodes.pveVersion"),
        size: NODE_COLUMN_SIZES.pve,
        meta: { label: t("nodes.pveVersion") },
        cell: ({ row }) => <span className="tabular-nums">{row.original.pveVersion ?? ""}</span>,
      },
      {
        id: "guests",
        accessorKey: "guests",
        header: t("nodes.guests"),
        size: NODE_COLUMN_SIZES.guests,
        meta: { label: t("nodes.guests"), numeric: true },
      },
      {
        id: "queue",
        accessorFn: (node) => node.queuedBackups ?? 0,
        header: t("queue.title"),
        size: NODE_COLUMN_SIZES.queue,
        meta: { label: t("queue.title") },
        cell: ({ row }) =>
          row.original.queuePausedAt ? (
            <Badge
              variant="warning"
              title={
                row.original.queuePausedBy
                  ? t("queue.pausedBy", { name: row.original.queuePausedBy })
                  : undefined
              }
              data-slot="pve-queue-paused"
            >
              {t("queue.pausedBadge")}
            </Badge>
          ) : (row.original.queuedBackups ?? 0) > 0 ? (
            <span className="tabular-nums">
              {t("queue.waiting", { count: row.original.queuedBackups ?? 0 })}
            </span>
          ) : (
            <span className="text-muted-foreground">{t("queue.empty")}</span>
          ),
      },
      {
        id: "problems",
        accessorFn: (node) => node.problems.length,
        header: t("nodes.problems"),
        size: NODE_COLUMN_SIZES.problems,
        meta: { label: t("nodes.problems") },
        cell: ({ row }) => {
          const labels = row.original.problems.map((code) => problemLabel(t, code));
          if (labels.length === 0) {
            return <span className="text-muted-foreground">{t("nodes.noProblems")}</span>;
          }
          return (
            <span className="flex min-w-0 items-center gap-1" title={labels.join("\n")}>
              <Badge variant="warning" className="min-w-0 justify-start">
                <span className="min-w-0 truncate">{labels[0]}</span>
              </Badge>
              {labels.length > 1 ? (
                <Badge variant="muted" className="px-1.5">
                  +{labels.length - 1}
                </Badge>
              ) : null}
            </span>
          );
        },
      },
      rowActionsColumn<NodeRow>({
        name: (node) => node.name,
        actions: (node) => [
          ...(node.queuePausedAt === undefined
            ? []
            : node.queuePausedAt
              ? [
                  {
                    id: "resume",
                    label: t("queue.resume"),
                    icon: Play,
                    onSelect: () => setResuming(node),
                  },
                ]
              : [
                  {
                    id: "pause",
                    label: t("queue.pause"),
                    icon: Pause,
                    onSelect: () => setPausing(node),
                  },
                ]),
          ...((node.queuedBackups ?? 0) > 0
            ? [
                {
                  id: "withdraw",
                  label: t("cancel.allQueued", { count: node.queuedBackups ?? 0 }),
                  icon: Ban,
                  onSelect: () => setWithdrawing(node),
                },
              ]
            : []),
          {
            id: "revoke",
            label: t("nodes.revoke"),
            icon: Unplug,
            destructive: true,
            onSelect: () => onRevoke(node),
          },
        ],
      }),
    ],
    [t, onRevoke],
  );
  return (
    <>
      <DataTable<NodeRow>
        id="pve-nodes"
        label={t("nodes.title")}
        columns={columns}
        data={nodes}
        getRowId={(node) => node.id}
        loading={loading}
        fixedLayout
        skeletonRows={2}
        maxHeight="none"
        columnsMenu={false}
        sorting={{ mode: "client", initial: [{ id: "name", desc: false }] }}
        empty={<EmptyState variant="plain" icon={Server} title={t("nodes.empty")} />}
      />
      {pausing ? (
        <PauseQueueDialog
          node={pausing}
          open
          onOpenChange={(open) => (open ? undefined : setPausing(null))}
        />
      ) : null}
      {resuming ? <ResumeRunner node={resuming} onDone={() => setResuming(null)} /> : null}
      {withdrawing ? (
        <CancelQueuedDialog
          node={withdrawing}
          count={withdrawing.queuedBackups ?? 0}
          open
          onOpenChange={(open) => (open ? undefined : setWithdrawing(null))}
        />
      ) : null}
    </>
  );
}
