import { Activity } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { DisabledReason, StatusBadge, type StatusTone } from "@/components/kit";
import { Button } from "@/components/ui/button";

import type { BaremetalProbe, BaremetalProbeReport } from "../api.js";
import { useEndpointFormat, useRequestBootProbe } from "../hooks.js";
import { endpointErrorKey } from "../presenters.js";

/** A probe with a rating: green only for the restored system that started (green is proof). */
const READINESS_TONE: Record<"green" | "red" | "none", StatusTone> = {
  green: "success",
  red: "destructive",
  none: "warning",
};

/** Why "Probe now" cannot plan a probe, or null when it can. */
export function probeNowBlocked(probe: BaremetalProbe): string | null {
  if (!probe.lab.present) return "baremetal.probe.blocked.no_lab";
  if (!probe.lab.kvm) return "baremetal.probe.blocked.no_kvm";
  if (probe.pending) return `baremetal.probe.blocked.${probe.pending}`;
  if (probe.reason === "not_systemd" || probe.reason === "no_disks") {
    return `baremetal.probe.reasons.${probe.reason}`;
  }
  return null;
}

/** What the restored system showed, in the words of the report's cause. */
export function probeCauseKey(report: BaremetalProbeReport): string {
  if (report.notPossible) return `baremetal.probe.reasons.${report.notPossible}`;
  const kind = report.cause?.kind;
  switch (kind) {
    case "booted":
    case "recovery_failed":
    case "verification_failed":
      return `baremetal.probe.cause.${kind}`;
    case "boot_failed":
      return `baremetal.probe.pattern.${report.cause?.pattern ?? "unknown"}`;
    default:
      return "baremetal.probe.cause.incomplete";
  }
}

function Report({ report }: { report: BaremetalProbeReport }) {
  const { t } = useTranslation("endpoints");
  const format = useEndpointFormat();
  const tone = READINESS_TONE[report.readiness ?? "none"];
  const evidence =
    report.cause?.line ?? report.cause?.codes?.join(", ") ?? report.cause?.checks?.join(", ");
  return (
    <div className="space-y-2" data-slot="baremetal-probe-report">
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">{t("baremetal.probe.checkedAt")}</dt>
        <dd>{format.dateTime(report.checkedAt)}</dd>
        <dt className="text-muted-foreground">{t("baremetal.probe.result")}</dt>
        <dd>
          <StatusBadge tone={tone} data-slot="baremetal-probe-readiness">
            {t(`baremetal.probe.readiness.${report.readiness ?? "none"}`)}
          </StatusBadge>
          <span className="ml-2">{t(probeCauseKey(report))}</span>
        </dd>
        {report.firmware ? (
          <>
            <dt className="text-muted-foreground">{t("baremetal.probe.hardware")}</dt>
            <dd>
              {t(`baremetal.probe.firmware.${report.firmware}`)}
              {report.controllers.length > 0
                ? `, ${report.controllers.map((c) => c.toUpperCase()).join(", ")}`
                : ""}
            </dd>
          </>
        ) : null}
        {report.emptyFilesystems.length + report.emptyDirs.length > 0 ? (
          <>
            <dt className="text-muted-foreground">{t("baremetal.probe.leftEmpty")}</dt>
            <dd className="font-mono text-xs">
              {[...report.emptyFilesystems, ...report.emptyDirs].join(", ")}
            </dd>
          </>
        ) : null}
      </dl>
      {evidence ? (
        <p className="font-mono text-xs break-all" data-slot="baremetal-probe-evidence">
          {evidence}
        </p>
      ) : null}
      {report.serialTail ? (
        <details>
          <summary className="cursor-pointer text-sm text-muted-foreground">
            {t("baremetal.probe.serial")}
          </summary>
          <pre className="mt-1 max-h-64 overflow-auto rounded-md bg-muted p-2 text-xs whitespace-pre-wrap">
            {report.serialTail}
          </pre>
        </details>
      ) : null}
    </div>
  );
}

/**
 * The boot probe on the bare metal card (docs/BAREMETAL.md 12.3, 12.4): why the machine is not
 * green yet (no lab, no KVM, planned, running, not possible), the newest probe with its evidence,
 * and "Probe now" for an admin.
 */
export function BaremetalProbeSection({
  endpointId,
  probe,
}: {
  endpointId: string;
  probe: BaremetalProbe;
}) {
  const { t } = useTranslation("endpoints");
  const request = useRequestBootProbe(endpointId);
  const blocked = probeNowBlocked(probe);
  const run = () =>
    request.mutate(undefined, {
      onSuccess: () => toast.success(t("baremetal.probe.requested")),
      onError: (error) =>
        toast.error(t("baremetal.probe.requestFailed"), {
          description: t(endpointErrorKey(error)),
        }),
    });
  return (
    <section className="space-y-2" data-slot="baremetal-probe">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">{t("baremetal.probe.title")}</h3>
        <DisabledReason reason={blocked ? t(blocked) : null}>
          <Button
            variant="outline"
            size="sm"
            onClick={run}
            disabled={blocked !== null || request.isPending}
            data-action="baremetal-probe-now"
          >
            <Activity aria-hidden="true" />
            {t("baremetal.probe.now")}
          </Button>
        </DisabledReason>
      </div>
      {probe.reason ? (
        <p className="text-sm text-muted-foreground" data-slot="baremetal-probe-reason">
          {t(`baremetal.probe.reasons.${probe.reason}`)}
        </p>
      ) : null}
      {probe.latest ? <Report report={probe.latest} /> : null}
    </section>
  );
}
