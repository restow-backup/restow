import { Link } from "@tanstack/react-router";
import { ArrowLeft, Download, KeyRound, Link2 } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { PageHeader, StatusBadge } from "@/components/kit";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { NotFoundPage } from "@/routes/not-found";

import type { Baremetal, EndpointDetail, RecoveryIso } from "../api.js";
import {
  useBaremetal,
  useEndpoint,
  useEndpointFormat,
  useRecoveries,
  useRecoveryIso,
} from "../hooks.js";
import { endpointDetailTo } from "../paths.js";
import { endpointName, recoveryOpen } from "../presenters.js";
import { CommandBox } from "./enroll-dialog.js";
import { MinimumSizes } from "./minimum-sizes.js";
import { RebindDialog } from "./rebind-dialog.js";
import { RecoveryCodeDialog } from "./recovery-code-dialog.js";
import { RecoveryLive } from "./recovery-live.js";

/**
 * Whether a machine can be restored on bare metal from here (docs/BAREMETAL.md 14.6, 22): the
 * preview is on, the installation offers a verified recovery ISO, the machine runs Linux, has a
 * whole machine backup with a layout and nothing makes it impossible. Until a release ships the
 * ISO (M4) this is never true, so the button and the wizard stay hidden.
 */
export function baremetalRestoreAvailable(
  baremetal: Pick<Baremetal, "preview" | "latest" | "notPossible"> | undefined,
  iso: Pick<RecoveryIso, "verified"> | undefined,
  os: string | undefined,
): boolean {
  return Boolean(
    baremetal?.preview &&
      iso?.verified &&
      os === "linux" &&
      baremetal.latest &&
      !baremetal.notPossible,
  );
}

export const WIZARD_STEPS = ["snapshot", "hardware", "iso", "code", "live", "after"] as const;
type WizardStep = (typeof WIZARD_STEPS)[number];

function StepCard({
  step,
  index,
  children,
}: {
  step: WizardStep;
  index: number;
  children: React.ReactNode;
}) {
  const { t } = useTranslation("endpoints");
  return (
    <Card data-step={step}>
      <CardHeader>
        <CardTitle className="text-base">
          {index + 1}. {t(`recovery.wizard.steps.${step}`)}
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">{children}</CardContent>
    </Card>
  );
}

function IsoStep({ iso }: { iso: RecoveryIso }) {
  const { t } = useTranslation("endpoints");
  return (
    <>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">{t("recovery.iso.version")}</dt>
        <dd>{iso.version}</dd>
        <dt className="text-muted-foreground">{t("recovery.iso.file")}</dt>
        <dd className="font-mono text-xs break-all">{iso.fileName}</dd>
        <dt className="text-muted-foreground">SHA-256</dt>
        <dd className="font-mono text-xs break-all">{iso.sha256}</dd>
        {iso.releaseKeyFingerprint ? (
          <>
            <dt className="text-muted-foreground">{t("recovery.iso.fingerprint")}</dt>
            <dd className="font-mono text-xs break-all">{iso.releaseKeyFingerprint}</dd>
          </>
        ) : null}
      </dl>
      <p className="text-sm text-muted-foreground">{t("recovery.iso.fingerprintHint")}</p>
      {iso.url ? (
        <div>
          <a href={iso.url} className={buttonVariants({ variant: "outline", size: "sm" })}>
            <Download aria-hidden="true" />
            {t("recovery.iso.download")}
          </a>
        </div>
      ) : null}
      <p className="text-sm font-medium">{t("recovery.iso.verifyCommands")}</p>
      {(["linux", "macos", "windows"] as const).map((system) =>
        iso.commands[system].length > 0 ? (
          <div key={system} className="grid gap-1">
            <span className="text-xs text-muted-foreground">
              {t(`recovery.iso.system.${system}`)}
            </span>
            <CommandBox command={iso.commands[system].join("\n")} label={t("recovery.copy")} />
          </div>
        ) : null,
      )}
      <p className="text-sm text-muted-foreground">{t("recovery.iso.writeUsb")}</p>
    </>
  );
}

export function BaremetalWizardView({
  detail,
  baremetal,
  iso,
  openRecoveryId,
}: {
  detail: EndpointDetail;
  baremetal: Baremetal;
  iso: RecoveryIso;
  openRecoveryId: string | null;
}) {
  const { t } = useTranslation("endpoints");
  const format = useEndpointFormat();
  const [coding, setCoding] = React.useState(false);
  const [rebinding, setRebinding] = React.useState(false);
  const [recoveryId, setRecoveryId] = React.useState<string | null>(openRecoveryId);
  React.useEffect(() => {
    if (openRecoveryId && !recoveryId) setRecoveryId(openRecoveryId);
  }, [openRecoveryId, recoveryId]);
  const latest = baremetal.latest;
  const name = endpointName(detail);
  const firmware = latest?.summary.firmware;
  const restoreBytes = baremetal.check
    ? Object.values(baremetal.check.restoreSizes).reduce((sum, size) => sum + size.bytes, 0)
    : null;
  return (
    <div className="grid gap-4" data-slot="baremetal-wizard">
      <StepCard step="snapshot" index={0}>
        {latest ? (
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted-foreground">{t("baremetal.capturedAt")}</dt>
            <dd>{format.dateTime(latest.capturedAt)}</dd>
            <dt className="text-muted-foreground">{t("baremetal.snapshot")}</dt>
            <dd className="font-mono text-xs">{latest.snapshotId?.slice(0, 8)}</dd>
            <dt className="text-muted-foreground">{t("baremetal.check.title")}</dt>
            <dd>
              <StatusBadge tone="neutral">
                {baremetal.check
                  ? t(`baremetal.check.result.${baremetal.check.readiness}`)
                  : t("baremetal.check.pending")}
              </StatusBadge>
            </dd>
          </dl>
        ) : null}
        <p className="text-sm text-muted-foreground">{t("recovery.wizard.snapshotHint")}</p>
      </StepCard>
      <StepCard step="hardware" index={1}>
        <ul className="list-disc space-y-1 pl-5 text-sm">
          {firmware ? (
            <li>
              {t(`recovery.wizard.firmware.${firmware.mode === "bios" ? "bios" : "uefi"}`)}
              {firmware.secureBoot ? ` ${t("recovery.wizard.secureBoot")}` : ""}
            </li>
          ) : null}
          <li>{t("recovery.wizard.cable")}</li>
          <li>{t("recovery.wizard.oldDisks")}</li>
        </ul>
        {baremetal.check?.minimumSizes ? (
          <MinimumSizes sizes={baremetal.check.minimumSizes} />
        ) : null}
        <p className="text-xs text-muted-foreground">{t("recovery.wizard.hardwareLater")}</p>
      </StepCard>
      <StepCard step="iso" index={2}>
        <IsoStep iso={iso} />
      </StepCard>
      <StepCard step="code" index={3}>
        <p className="text-sm text-muted-foreground">{t("recovery.wizard.codeIntro")}</p>
        <div>
          <Button onClick={() => setCoding(true)} data-action="open-recovery-code">
            <KeyRound aria-hidden="true" />
            {t("recovery.issue")}
          </Button>
        </div>
        <RecoveryCodeDialog
          endpointId={detail.id}
          machineName={name}
          snapshotId={latest?.snapshotId ?? undefined}
          restoreBytes={restoreBytes}
          open={coding}
          onOpenChange={setCoding}
          onIssued={(issued) => setRecoveryId(issued.id)}
        />
      </StepCard>
      <StepCard step="live" index={4}>
        {recoveryId ? (
          <RecoveryLive endpointId={detail.id} recoveryId={recoveryId} />
        ) : (
          <p className="text-sm text-muted-foreground">{t("recovery.wizard.liveEmpty")}</p>
        )}
      </StepCard>
      <StepCard step="after" index={5}>
        <p className="text-sm text-muted-foreground">{t("recovery.wizard.afterIntro")}</p>
        <div>
          <Button variant="outline" onClick={() => setRebinding(true)} data-action="open-rebind">
            <Link2 aria-hidden="true" />
            {t("rebind.action")}
          </Button>
        </div>
        <RebindDialog
          machine={detail}
          purpose="baremetal"
          open={rebinding}
          onOpenChange={setRebinding}
        />
      </StepCard>
    </div>
  );
}

/** The page `/inventory/<id>/bare-metal`: not found unless a restore is available (see above). */
export function BaremetalWizardPage({ endpointId }: { endpointId: string }) {
  const { t } = useTranslation("endpoints");
  const detail = useEndpoint(endpointId);
  const baremetal = useBaremetal(endpointId);
  const iso = useRecoveryIso();
  const recoveries = useRecoveries(endpointId);
  if (detail.isPending || baremetal.isPending || iso.isPending) {
    return null;
  }
  if (!detail.data || !baremetalRestoreAvailable(baremetal.data, iso.data, detail.data.os)) {
    return <NotFoundPage />;
  }
  const open = recoveries.data?.find((recovery) => recoveryOpen(recovery.status)) ?? null;
  return (
    <div className="space-y-6">
      <PageHeader
        title={t("recovery.wizard.title", { name: endpointName(detail.data) })}
        description={t("recovery.wizard.description")}
        actions={
          <Link
            to={endpointDetailTo(endpointId)}
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            <ArrowLeft aria-hidden="true" />
            {t("recovery.wizard.back")}
          </Link>
        }
      />
      <BaremetalWizardView
        detail={detail.data}
        baremetal={baremetal.data as Baremetal}
        iso={iso.data as RecoveryIso}
        openRecoveryId={open?.id ?? null}
      />
    </div>
  );
}
