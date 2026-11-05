import { useTranslation } from "react-i18next";

import type { LayoutStackNode, LayoutSummary as Summary } from "../api.js";
import { useEndpointFormat } from "../hooks.js";

/** Colours of the partitions in a disk bar, by what lies on them. */
const CONTENT_CLASS: Record<Summary["disks"][number]["partitions"][number]["content"], string> = {
  esp: "bg-chart-3/70",
  bios_boot: "bg-chart-3/40",
  filesystem: "bg-chart-1/70",
  luks: "bg-chart-2/70",
  md: "bg-chart-4/70",
  pv: "bg-chart-5/70",
  swap: "bg-muted-foreground/40",
  plain: "bg-chart-2/40",
  empty: "bg-muted",
  other: "bg-muted-foreground/20",
};

function DiskBar({ disk }: { disk: Summary["disks"][number] }) {
  const { t } = useTranslation("endpoints");
  const format = useEndpointFormat();
  const total = Math.max(disk.sizeBytes, 1);
  return (
    <li className="space-y-1" data-slot="layout-disk">
      <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
        <span className="font-mono font-medium">{disk.kname}</span>
        <span className="text-muted-foreground">
          {[disk.model, format.bytes(disk.sizeBytes), disk.transport, disk.tableType?.toUpperCase()]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </p>
      <div
        className="flex h-5 w-full overflow-hidden rounded-sm border bg-muted/30"
        role="img"
        aria-label={t("baremetal.summary.diskBar", {
          disk: disk.kname,
          count: disk.partitions.length,
        })}
      >
        {disk.partitions.map((partition) => (
          <div
            key={partition.number}
            className={`h-full border-r border-background last:border-r-0 ${CONTENT_CLASS[partition.content]}`}
            style={{ width: `${Math.max((partition.sizeBytes / total) * 100, 0.5)}%` }}
            title={`${partition.number}: ${t(`baremetal.content.${partition.content}`)}${
              partition.label ? ` (${partition.label})` : ""
            }, ${format.bytes(partition.sizeBytes)}`}
          />
        ))}
      </div>
      <ul className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
        {disk.partitions.map((partition) => (
          <li key={partition.number}>
            {partition.number}: {t(`baremetal.content.${partition.content}`)}
            {partition.label ? ` "${partition.label}"` : ""} · {format.bytes(partition.sizeBytes)}
          </li>
        ))}
      </ul>
    </li>
  );
}

function StackTree({ nodes }: { nodes: LayoutStackNode[] }) {
  const { t } = useTranslation("endpoints");
  const format = useEndpointFormat();
  if (nodes.length === 0) {
    return null;
  }
  return (
    <ul className="space-y-0.5 border-l pl-3 text-xs">
      {nodes.map((node) => (
        <li key={node.id}>
          <span className="text-muted-foreground">{t(`baremetal.stack.${node.kind}`)}</span>{" "}
          <span className="font-mono break-all">{node.label}</span>
          {node.sizeBytes !== null ? (
            <span className="text-muted-foreground"> · {format.bytes(node.sizeBytes)}</span>
          ) : null}
          <StackTree nodes={node.children} />
        </li>
      ))}
    </ul>
  );
}

/**
 * The layout of a machine as the bare metal card shows it (docs/BAREMETAL.md 14.6): the disks as
 * bars with their partitions, the storage stack as a tree, and firmware, Secure Boot, boot
 * loader, distribution and encryption as facts.
 */
export function LayoutSummary({ summary }: { summary: Summary }) {
  const { t } = useTranslation("endpoints");
  const yesNo = (value: boolean | null) =>
    value === null
      ? t("baremetal.summary.unknown")
      : value
        ? t("baremetal.summary.on")
        : t("baremetal.summary.off");
  const facts: [string, string][] = [
    [
      t("baremetal.summary.system"),
      [summary.os.prettyName ?? summary.os.id, summary.os.arch, summary.os.kernel].join(" · "),
    ],
    [t("baremetal.summary.firmware"), t(`baremetal.summary.firmwareMode.${summary.firmware.mode}`)],
    [t("baremetal.summary.secureBoot"), yesNo(summary.firmware.secureBoot)],
    [
      t("baremetal.summary.bootloader"),
      [
        summary.bootloader.kind,
        summary.bootloader.platform,
        summary.bootloader.shim ? "shim" : null,
      ]
        .filter(Boolean)
        .join(" · "),
    ],
    [
      t("baremetal.summary.initramfs"),
      [summary.initramfs.generator ?? t("baremetal.summary.unknown"), summary.initramfs.keymap]
        .filter(Boolean)
        .join(" · "),
    ],
    [
      t("baremetal.summary.encryption"),
      summary.encryption.luks + summary.encryption.plainCrypt === 0
        ? t("baremetal.summary.noEncryption")
        : t("baremetal.summary.encryptionCount", {
            luks: summary.encryption.luks,
            plain: summary.encryption.plainCrypt,
          }) +
          (summary.encryption.tokenTypes.length > 0
            ? ` (${summary.encryption.tokenTypes.join(", ")})`
            : ""),
    ],
  ];
  return (
    <div className="space-y-4" data-slot="layout-summary">
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
        {facts.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="break-words">{value}</dd>
          </div>
        ))}
      </dl>
      <div className="space-y-2">
        <h4 className="text-sm font-medium">{t("baremetal.summary.disks")}</h4>
        <ul className="space-y-3">
          {summary.disks.map((disk) => (
            <DiskBar key={disk.id} disk={disk} />
          ))}
        </ul>
      </div>
      <div className="space-y-2">
        <h4 className="text-sm font-medium">{t("baremetal.summary.stack")}</h4>
        <StackTree nodes={summary.stack} />
      </div>
    </div>
  );
}
