import { Link } from "@tanstack/react-router";
import { ArrowLeft, Download, KeyRound, Link2 } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { PageHeader, StatusBadge } from "@/components/kit";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { NotFoundPage } from "@/routes/not-found";

import {
  type Baremetal,
  type BaremetalSnapshot,
  type EndpointDetail,
  type Recovery,
  type RecoveryIso,
  type ReplacementHardware,
  recoveryIsoDownloadUrl,
} from "../api.js";
import {
  useBaremetal,
  useEndpoint,
  useEndpointFormat,
  useRecoveries,
  useRecovery,
  useRecoveryIso,
  useTenantScope,
} from "../hooks.js";
import { endpointDetailTo } from "../paths.js";
import { endpointName, recoveryOpen } from "../presenters.js";
import { CommandBox } from "./enroll-dialog.js";
import { MinimumSizes } from "./minimum-sizes.js";
import { RebindDialog } from "./rebind-dialog.js";
import { RecoveryCodeDialog } from "./recovery-code-dialog.js";
import { RecoveryLive } from "./recovery-live.js";
import { RecoveryHints, RecoveryWarnings } from "./recovery-verification.js";

/**
 * Whether a machine can be restored on bare metal from here (docs/BAREMETAL.md 14.6, 22): the
 * preview is on, the installation offers a verified recovery ISO, the machine runs Linux, has a
 * whole machine backup with a layout and nothing makes it impossible. A release lists the ISO in
 * its signed checksums from M4 on; before that this is never true, so the button and the wizard
 * stay hidden.
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

/**
 * The open code or session of a machine, if there is one: it stays reachable (follow, release,
 * end, revoke, extend) even when the conditions above no longer hold, since removing the machine
 * is refused while a session runs.
 */
export function openRecoveryOf(recoveries: readonly Recovery[] | undefined): Recovery | null {
  return recoveries?.find((recovery) => recoveryOpen(recovery.status)) ?? null;
}

/**
 * The session the wizard follows: the open one, else the newest that ended with a result
 * (succeeded or failed), so its verification and hints stay on the page afterwards.
 */
export function followedRecoveryOf(recoveries: readonly Recovery[] | undefined): Recovery | null {
  return (
    openRecoveryOf(recoveries) ??
    recoveries?.find(
      (recovery) => recovery.status === "succeeded" || recovery.status === "failed",
    ) ??
    null
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

/**
 * How far this instance got with its own copy (docs/BAREMETAL.md 26.13): shown while the download
 * still comes from the release page, and as a note when a newer rebuild was skipped.
 */
function IsoLocalState({ iso }: { iso: RecoveryIso }) {
  const { t } = useTranslation("endpoints");
  const format = useEndpointFormat();
  const local = iso.local;
  if (!local) return null;
  const reason = local.problem ? t(`recovery.iso.local.problem.${local.problem}`) : null;
  let text: string | null = null;
  if (iso.source === "instance") {
    // The copy is here; only a skipped rebuild is worth a word.
    text = reason ? t("recovery.iso.local.skipped", { reason }) : null;
  } else if (local.status === "fetching") {
    text =
      local.bytesTotal && local.bytesDone !== null
        ? t("recovery.iso.local.fetching", {
            done: format.bytes(local.bytesDone),
            total: format.bytes(local.bytesTotal),
          })
        : t("recovery.iso.local.fetchingUnknown", { done: format.bytes(local.bytesDone ?? 0) });
  } else if (local.status === "failed") {
    text = t("recovery.iso.local.failed", {
      reason: reason ?? t("recovery.iso.local.problem.network"),
    });
  } else if (local.status === "not_fetched") {
    text = t("recovery.iso.local.notFetched");
  } else if (local.status === "disabled") {
    text = t("recovery.iso.local.disabled");
  }
  if (!text && !(iso.source !== "instance" && local.importDir)) return null;
  return (
    <div className="grid gap-0.5" data-slot="recovery-iso-local" data-status={local.status}>
      {text ? <p className="text-xs text-muted-foreground">{text}</p> : null}
      {iso.source !== "instance" && local.importDir ? (
        <p className="text-xs text-muted-foreground" data-slot="recovery-iso-import">
          {t("recovery.iso.local.importHint", { folder: local.importDir })}
        </p>
      ) : null}
    </div>
  );
}

function IsoStep({ iso }: { iso: RecoveryIso }) {
  const { t } = useTranslation("endpoints");
  const format = useEndpointFormat();
  const { tenantId } = useTenantScope();
  const href = recoveryIsoDownloadUrl(iso, tenantId);
  return (
    <>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">{t("recovery.iso.version")}</dt>
        <dd data-slot="recovery-iso-version">
          {iso.rebuild
            ? t("recovery.iso.rebuild", { version: iso.version, rebuild: iso.rebuild })
            : iso.version}
        </dd>
        <dt className="text-muted-foreground">{t("recovery.iso.file")}</dt>
        <dd className="font-mono text-xs break-all">{iso.fileName}</dd>
        {iso.sizeBytes ? (
          <>
            <dt className="text-muted-foreground">{t("recovery.iso.size")}</dt>
            <dd>{format.bytes(iso.sizeBytes)}</dd>
          </>
        ) : null}
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
      {href ? (
        <div className="grid gap-1">
          <div>
            <a
              href={href}
              className={buttonVariants({ variant: "outline", size: "sm" })}
              data-source={iso.source ?? undefined}
              data-slot="recovery-iso-download"
            >
              <Download aria-hidden="true" />
              {t("recovery.iso.download")}
            </a>
          </div>
          {iso.source ? (
            <p className="text-xs text-muted-foreground" data-slot="recovery-iso-source">
              {t(
                iso.source === "instance" && iso.local?.origin === "import"
                  ? "recovery.iso.source.instanceImport"
                  : `recovery.iso.source.${iso.source}`,
              )}
            </p>
          ) : null}
          {iso.source === "instance" && iso.githubUrl ? (
            <p className="text-xs" data-slot="recovery-iso-fallback">
              <a href={iso.githubUrl} className="underline underline-offset-2">
                {t("recovery.iso.githubFallback")}
              </a>
            </p>
          ) : null}
          <IsoLocalState iso={iso} />
        </div>
      ) : null}
      {iso.sumsUrl || iso.signatureUrl ? (
        <ul className="grid gap-0.5 text-sm" data-slot="recovery-iso-sums">
          {iso.sumsUrl ? (
            <li>
              <a href={iso.sumsUrl} className="underline underline-offset-2">
                {t("recovery.iso.checksums")}
              </a>
            </li>
          ) : null}
          {iso.signatureUrl ? (
            <li>
              <a href={iso.signatureUrl} className="underline underline-offset-2">
                {t("recovery.iso.signature")}
              </a>
            </li>
          ) : null}
        </ul>
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
      {iso.sourcesUrl || iso.firmwareLicensesUrl ? (
        <ul className="grid gap-0.5 text-sm" data-slot="recovery-iso-licences">
          {iso.sourcesUrl ? (
            <li>
              <a href={iso.sourcesUrl} className="underline underline-offset-2">
                {t("recovery.iso.sources")}
              </a>
            </li>
          ) : null}
          {iso.firmwareLicensesUrl ? (
            <li>
              <a href={iso.firmwareLicensesUrl} className="underline underline-offset-2">
                {t("recovery.iso.firmwareLicenses")}
              </a>
            </li>
          ) : null}
        </ul>
      ) : null}
    </>
  );
}

const CHECK_TONE: Record<
  BaremetalSnapshot["check"],
  "success" | "destructive" | "warning" | "neutral"
> = {
  passed: "success",
  failed: "destructive",
  incomplete: "warning",
  none: "neutral",
};

/**
 * The snapshots the wizard offers, newest first: from the server's list, or (an older server)
 * the newest layout's snapshot alone.
 */
export function wizardSnapshots(baremetal: Baremetal): BaremetalSnapshot[] {
  if (baremetal.snapshots && baremetal.snapshots.length > 0) {
    return baremetal.snapshots;
  }
  const latest = baremetal.latest;
  if (!latest?.snapshotId) {
    return [];
  }
  return [
    {
      snapshotId: latest.snapshotId,
      time: latest.capturedAt,
      layoutId: latest.layoutId,
      layoutSha256: latest.sha256,
      sameLayoutAsNewest: true,
      check:
        baremetal.check?.readiness === "green"
          ? "passed"
          : baremetal.check?.readiness === "red"
            ? "failed"
            : baremetal.check?.readiness === "yellow"
              ? "incomplete"
              : "none",
      verdict: latest.verdict,
    },
  ];
}

/** The snapshot chosen first (14.6 step 1): the newest that passed its check, else the newest. */
export function defaultSnapshot(snapshots: readonly BaremetalSnapshot[]): BaremetalSnapshot | null {
  const usable = snapshots.filter((snapshot) => snapshot.verdict !== "unsupported");
  return usable.find((snapshot) => snapshot.check === "passed") ?? usable[0] ?? null;
}

function SnapshotStep({
  snapshots,
  selected,
  onSelect,
}: {
  snapshots: BaremetalSnapshot[];
  selected: string | null;
  onSelect: (snapshotId: string) => void;
}) {
  const { t } = useTranslation("endpoints");
  const format = useEndpointFormat();
  if (snapshots.length === 0) {
    return <p className="text-sm text-muted-foreground">{t("recovery.wizard.snapshots.none")}</p>;
  }
  return (
    <fieldset className="grid gap-2" data-slot="wizard-snapshots">
      <legend className="mb-1 text-sm text-muted-foreground">
        {t("recovery.wizard.snapshots.choose")}
      </legend>
      {snapshots.map((snapshot) => {
        const id = `wizard-snapshot-${snapshot.snapshotId}`;
        const unusable = snapshot.verdict === "unsupported";
        return (
          <label
            key={snapshot.snapshotId}
            htmlFor={id}
            className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-sm has-[:checked]:border-primary"
            data-snapshot={snapshot.snapshotId}
          >
            <input
              id={id}
              type="radio"
              name="wizard-snapshot"
              value={snapshot.snapshotId}
              checked={selected === snapshot.snapshotId}
              disabled={unusable}
              onChange={() => onSelect(snapshot.snapshotId)}
            />
            <span>{format.dateTime(snapshot.time)}</span>
            <span className="font-mono text-xs">{snapshot.snapshotId.slice(0, 8)}</span>
            <StatusBadge tone={CHECK_TONE[snapshot.check]} data-slot="snapshot-check">
              {t(`recovery.wizard.snapshots.check.${snapshot.check}`)}
            </StatusBadge>
            <StatusBadge tone="neutral" data-slot="snapshot-layout">
              {snapshot.sameLayoutAsNewest
                ? t("recovery.wizard.snapshots.sameLayout")
                : t("recovery.wizard.snapshots.otherLayout")}
            </StatusBadge>
            {unusable ? (
              <span className="text-xs text-muted-foreground">
                {t("recovery.wizard.snapshots.unsupported")}
              </span>
            ) : null}
          </label>
        );
      })}
    </fieldset>
  );
}

/** Step 2: what the replacement hardware needs for the chosen backup (14.6, 2.2). */
export function HardwareGuide({ hardware }: { hardware: ReplacementHardware }) {
  const { t } = useTranslation("endpoints");
  const format = useEndpointFormat();
  const keymap = hardware.keymap.layout
    ? hardware.keymap.variant
      ? `${hardware.keymap.layout} (${hardware.keymap.variant})`
      : hardware.keymap.layout
    : null;
  const missing = hardware.storageDriversOtherController.filter((driver) => !driver.ok);
  const present = hardware.storageDriversOtherController.filter((driver) => driver.ok);
  return (
    <div className="grid gap-3" data-slot="wizard-hardware">
      <ul className="list-disc space-y-1 pl-5 text-sm">
        <li data-slot="hardware-firmware">
          {t(`recovery.wizard.firmware.${hardware.firmwareMode}`)}
          {hardware.biosNeedsCsm ? ` ${t("recovery.wizard.hardware.csm")}` : ""}
        </li>
        {hardware.secureBoot ? (
          <li data-slot="hardware-secure-boot">
            {hardware.requiredCAs.length > 0
              ? t("recovery.wizard.hardware.secureBootCa", {
                  issuers: hardware.requiredCAs.join("; "),
                })
              : t("recovery.wizard.secureBoot")}
          </li>
        ) : null}
        <li data-slot="hardware-disks">
          {t("recovery.wizard.hardware.disks", { count: hardware.disks.length })}
          <ul className="list-[circle] pl-5">
            {hardware.disks.map((disk) => (
              <li key={disk.id} data-disk={disk.id}>
                {disk.minBytes !== null
                  ? t("recovery.wizard.hardware.diskMin", {
                      disk: disk.kname,
                      min: format.bytes(disk.minBytes),
                      size: format.bytes(disk.sizeBytes),
                    })
                  : t("recovery.wizard.hardware.diskSize", {
                      disk: disk.kname,
                      size: format.bytes(disk.sizeBytes),
                    })}
              </li>
            ))}
          </ul>
        </li>
        <li data-slot="hardware-ram">
          {t("recovery.wizard.hardware.ram", {
            min: format.bytes(hardware.ramMinBytes),
            recommended: format.bytes(hardware.ramRecommendedBytes),
          })}
        </li>
        <li>{t("recovery.wizard.cable")}</li>
        {present.length > 0 ? (
          <li data-slot="hardware-controllers">
            {t("recovery.wizard.hardware.controllers", {
              modules: present.map((driver) => driver.module).join(", "),
            })}
          </li>
        ) : (
          <li>{t("recovery.wizard.hardware.controllersHint")}</li>
        )}
        {missing.length > 0 ? (
          <li data-slot="hardware-driver-missing">
            {t("recovery.wizard.hardware.driverMissing", {
              modules: missing.map((driver) => driver.module).join(", "),
            })}
          </li>
        ) : null}
        {hardware.hardwareRaidHint.map((raid) => (
          <li key={raid.disk} data-slot="hardware-raid">
            {t("recovery.wizard.hardware.hwRaid", {
              disk: hardware.disks.find((disk) => disk.id === raid.disk)?.kname ?? raid.disk,
              min: raid.minBytes !== null ? format.bytes(raid.minBytes) : "-",
            })}
          </li>
        ))}
        {hardware.luksVolumes > 0 ? (
          <li data-slot="hardware-encryption">
            {t("recovery.wizard.hardware.encryption")}
            {keymap ? ` ${t("recovery.wizard.hardware.keymapAtBoot", { layout: keymap })}` : ""}
            {hardware.keymap.grubCryptodisk ? ` ${t("recovery.wizard.hardware.keymapGrub")}` : ""}
          </li>
        ) : null}
        {hardware.tpm || hardware.tokenTypes.length > 0 ? (
          <li data-slot="hardware-tpm">
            {t("recovery.wizard.hardware.tpm", { tokens: hardware.tokenTypes.join(", ") })}
          </li>
        ) : null}
        <li>{t("recovery.wizard.oldDisks")}</li>
      </ul>
      <div className="grid gap-1 text-sm">
        <p>
          <span className="font-medium">{t("recovery.wizard.hardware.mayChangeTitle")}</span>{" "}
          {t("recovery.wizard.hardware.mayChange")}
        </p>
        <p>
          <span className="font-medium">{t("recovery.wizard.hardware.mayNotChangeTitle")}</span>{" "}
          {t("recovery.wizard.hardware.mayNotChange")}
        </p>
      </div>
    </div>
  );
}

/** Step 6: rebind, and what the ISO advised for the time after the restore. */
function AfterStep({ endpointId, recoveryId }: { endpointId: string; recoveryId: string | null }) {
  const { t } = useTranslation("endpoints");
  const recovery = useRecovery(endpointId, recoveryId).data;
  const hints = recovery?.verification?.hints ?? [];
  const warnings = recovery?.warnings ?? [];
  const ended = recovery ? !recoveryOpen(recovery.status) : false;
  if (!recovery || !ended) {
    return null;
  }
  return (
    <section className="grid gap-2" data-slot="wizard-after">
      <h3 className="text-sm font-medium">{t("recovery.wizard.after.title")}</h3>
      {hints.length === 0 && warnings.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("recovery.wizard.after.none")}</p>
      ) : null}
      <RecoveryHints hints={hints} />
      <RecoveryWarnings warnings={warnings} />
      {hints.length > 0 ? (
        <p className="text-xs text-muted-foreground">{t("recovery.isoReported")}</p>
      ) : null}
    </section>
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
  const [coding, setCoding] = React.useState(false);
  const [rebinding, setRebinding] = React.useState(false);
  const [recoveryId, setRecoveryId] = React.useState<string | null>(openRecoveryId);
  React.useEffect(() => {
    if (openRecoveryId && !recoveryId) setRecoveryId(openRecoveryId);
  }, [openRecoveryId, recoveryId]);
  const snapshots = wizardSnapshots(baremetal);
  const [snapshotId, setSnapshotId] = React.useState<string | null>(
    () => defaultSnapshot(snapshots)?.snapshotId ?? null,
  );
  const selected = snapshots.find((snapshot) => snapshot.snapshotId === snapshotId) ?? null;
  const name = endpointName(detail);
  const hardware =
    (selected ? baremetal.hardwareByLayout?.[selected.layoutId] : undefined) ??
    (selected?.sameLayoutAsNewest !== false ? baremetal.hardware : null) ??
    null;
  const firmware = baremetal.latest?.summary.firmware;
  const latestSnapshot = baremetal.latest?.snapshotId ?? null;
  const restoreBytes =
    baremetal.check && (selected === null || selected.snapshotId === latestSnapshot)
      ? Object.values(baremetal.check.restoreSizes).reduce((sum, size) => sum + size.bytes, 0)
      : null;
  return (
    <div className="grid gap-4" data-slot="baremetal-wizard">
      <StepCard step="snapshot" index={0}>
        <SnapshotStep snapshots={snapshots} selected={snapshotId} onSelect={setSnapshotId} />
        <p className="text-sm text-muted-foreground">{t("recovery.wizard.snapshotHint")}</p>
      </StepCard>
      <StepCard step="hardware" index={1}>
        {hardware ? (
          <HardwareGuide hardware={hardware} />
        ) : (
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
        )}
        {baremetal.check?.minimumSizes &&
        (selected === null || selected.snapshotId === latestSnapshot) ? (
          <MinimumSizes sizes={baremetal.check.minimumSizes} />
        ) : null}
      </StepCard>
      <StepCard step="iso" index={2}>
        <IsoStep iso={iso} />
      </StepCard>
      <StepCard step="code" index={3}>
        <p className="text-sm text-muted-foreground">{t("recovery.wizard.codeIntro")}</p>
        <div>
          <Button
            onClick={() => setCoding(true)}
            data-action="open-recovery-code"
            disabled={snapshots.length > 0 && selected === null}
          >
            <KeyRound aria-hidden="true" />
            {t("recovery.issue")}
          </Button>
        </div>
        <RecoveryCodeDialog
          endpointId={detail.id}
          machineName={name}
          snapshotId={selected?.snapshotId ?? baremetal.latest?.snapshotId ?? undefined}
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
        <AfterStep endpointId={detail.id} recoveryId={recoveryId} />
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

/**
 * The page `/inventory/<id>/bare-metal`: the wizard while a restore is available (see above);
 * otherwise only the open code or session, if there is one, and else not found.
 */
export function BaremetalWizardPage({ endpointId }: { endpointId: string }) {
  const { t } = useTranslation("endpoints");
  const detail = useEndpoint(endpointId);
  const baremetal = useBaremetal(endpointId);
  const iso = useRecoveryIso();
  const recoveries = useRecoveries(endpointId);
  if (detail.isPending || baremetal.isPending || iso.isPending) {
    return null;
  }
  if (!detail.data) {
    return <NotFoundPage />;
  }
  const available = baremetalRestoreAvailable(baremetal.data, iso.data, detail.data.os);
  const open = openRecoveryOf(recoveries.data);
  if (!available && recoveries.isPending) {
    return null;
  }
  if (!available && !open) {
    return <NotFoundPage />;
  }
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
      {available ? (
        <BaremetalWizardView
          detail={detail.data}
          baremetal={baremetal.data as Baremetal}
          iso={iso.data as RecoveryIso}
          openRecoveryId={followedRecoveryOf(recoveries.data)?.id ?? null}
        />
      ) : open ? (
        <div className="grid gap-4" data-slot="baremetal-recovery-only">
          <p className="text-sm text-muted-foreground">{t("recovery.wizard.liveOnly")}</p>
          <StepCard step="live" index={0}>
            <RecoveryLive endpointId={detail.data.id} recoveryId={open.id} />
          </StepCard>
        </div>
      ) : null}
    </div>
  );
}
