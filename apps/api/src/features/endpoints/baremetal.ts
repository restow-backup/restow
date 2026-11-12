import {
  agentVersionAtLeast,
  type BaremetalNotPossibleReason,
  type BaremetalProbeFacts,
  type BaremetalReadinessState,
  type BaremetalStateDetail,
  baremetalReadiness,
  keyFilesOf,
  type LayoutManifest,
  type LayoutSummary,
  type LayoutUnsupported,
  type LinuxLayoutManifest,
  labPresent,
  layoutFingerprint,
  PROBE_EXPIRY_MS,
  type ProbePendingReason,
  parseLayoutManifest,
  probeNotPossible,
  type ReplacementHardware,
  replacementHardware,
  summarizeLayout,
  WHOLE_MACHINE_AGENT_VERSION,
} from "@restow/core";
import {
  bootProbeReports,
  type Database,
  type Endpoint,
  type EndpointRun,
  endpointLayouts,
  endpointRecoveries,
  endpointReports,
  endpointRuns,
  endpoints,
  loadRecoveryLab,
  pendingBootProbe,
  type RecoveryLabState,
} from "@restow/db";
import { and, desc, eq, inArray, isNotNull, isNull, like, or, sql } from "drizzle-orm";
import { config } from "../../config.js";
import { providerDb } from "../../db.js";
import { type Transaction, withTenantTx } from "../../lib/tenant-context.js";
import { ProblemError } from "../../problem.js";
import type { AgentContext } from "./agent-auth.js";
import { auditEndpoint, ENDPOINT_AUDIT_ACTIONS, type EndpointActor } from "./audit.js";
import { ENDPOINT_PROBLEMS } from "./problems.js";
import {
  type ActiveRecoveryDto,
  activeRecoveriesOf,
  baremetalSnapshots,
} from "./recovery-codes.js";
import type { FinishRunInput } from "./schemas.js";

/**
 * Bare metal on the server (docs/BAREMETAL.md 4.3, 12, 14.3): the layout manifests the agent sends
 * with a whole machine backup are checked and stored once per machine and content
 * (`endpoint_layouts`), the run points at its layout, and the machine's page reads the newest
 * layout's summary with the stage 1 report of its snapshot (M2) and the rating that follows
 * (@restow/core `baremetalReadiness`). Since M4 the state also carries what the restore wizard
 * needs: the whole machine snapshots with their check, what replacement hardware needs per layout
 * (@restow/core `replacementHardware`) and the running recovery session. Since M5 the boot probe
 * of the lab (12.3) decides whether a machine with a green stage 1 is green, overdue or red.
 */

export type BaremetalState = BaremetalReadinessState;
export type BaremetalNotPossible = BaremetalNotPossibleReason;

export interface BaremetalLatestDto {
  layoutId: string;
  runId: string;
  snapshotId: string | null;
  capturedAt: string;
  sha256: string;
  fingerprint: string;
  verdict: string;
  unsupported: LayoutUnsupported[];
  summary: LayoutSummary;
}

export interface SnapshotHintDto {
  vg: string;
  sizeBytes: number;
  freeBytes: number;
  suggestedFreeBytes: number;
  mounts: string[];
}

/** The stage 1 report of the newest layout's snapshot (12.1), as the worker wrote it. */
export interface BaremetalCheckDto {
  reportId: string;
  checkedAt: string;
  snapshotId: string | null;
  readiness: "green" | "red" | "yellow";
  incomplete: string | null;
  checks: unknown[];
  restoreSizes: Record<string, unknown>;
  minimumSizes: Record<string, unknown> | null;
  planner: Record<string, unknown> | null;
  bootChainFingerprint: string | null;
}

/** A whole machine snapshot the wizard offers (14.6 step 1), newest first. */
export interface BaremetalSnapshotDto {
  snapshotId: string;
  time: string;
  layoutId: string;
  layoutSha256: string;
  /** The same layout as the newest whole machine backup. */
  sameLayoutAsNewest: boolean;
  check: "passed" | "failed" | "incomplete" | "none";
  verdict: string;
}

/** The newest boot probe report for the fingerprints of the newest stage 1 (12.3). */
export interface BootProbeReportDto {
  reportId: string;
  checkedAt: string;
  snapshotId: string | null;
  /** null: the probe proved nothing (the lab, a time limit) and is repeated. */
  readiness: "green" | "red" | null;
  cause: Record<string, unknown> | null;
  notPossible: string | null;
  firmware: string | null;
  controllers: string[];
  kvm: boolean | null;
  emptyFilesystems: string[];
  emptyDirs: string[];
  restoreBytes: number | null;
  /** The end of the serial console of the restored system, as evidence (at most 4 KiB). */
  serialTail: string;
}

export interface BaremetalProbeDto {
  /** The lab asked for work within the last ten minutes, and whether it has KVM. */
  lab: { present: boolean; kvm: boolean };
  /** A probe of the machine is planned (the lab has not taken it) or runs. */
  pending: "planned" | "running" | null;
  /** Why no probe proves the boot yet, when the state is `layout_checked`. */
  reason: ProbePendingReason | null;
  latest: BootProbeReportDto | null;
}

/** Layouts the hardware guide is computed for (the snapshots rarely have more). */
const MAX_HARDWARE_LAYOUTS = 10;

export interface BaremetalDto {
  /** Whole machine backups are switched on for this installation (RESTOW_BAREMETAL_PREVIEW). */
  preview: boolean;
  /** The machine's job backs it up as a whole. */
  enabled: boolean;
  state: BaremetalState;
  /** `incomplete`: stage 1 ran but could not finish (a yellow report). */
  stateDetail: BaremetalStateDetail;
  notPossible: BaremetalNotPossible | null;
  latest: BaremetalLatestDto | null;
  check: BaremetalCheckDto | null;
  /** The machine's volume group has no room for snapshots (6.1): what to leave free. */
  snapshotHint: SnapshotHintDto | null;
  /** The whole machine snapshots, newest first (at most 50). */
  snapshots: BaremetalSnapshotDto[];
  /** What replacement hardware needs for the newest layout (14.6 step 2); null without one. */
  hardware: ReplacementHardware | null;
  /** The same per layout of the listed snapshots (at most 10 layouts), by layout id. */
  hardwareByLayout: Record<string, ReplacementHardware>;
  /** The running recovery session (pending approval, active, finishing), if there is one. */
  activeRecovery: ActiveRecoveryDto | null;
  /** The boot probe; null until stage 1 of the newest snapshot is green. */
  probe: BaremetalProbeDto | null;
}

export interface LayoutDto {
  id: string;
  sha256: string;
  createdAt: string;
  manifest: Record<string, unknown>;
}

const LAYOUT_REJECTED = "layout_rejected";

/**
 * Store the layout of a finished backup run and return its id, or null with the hint
 * `layout_rejected` added to `errors` when the manifest is refused. Kept only for a backup that
 * made a snapshot; the run's status stays as the agent reported it either way.
 */
export async function storeRunLayout(
  tx: Transaction,
  agent: AgentContext,
  run: Pick<EndpointRun, "id" | "kind">,
  input: Pick<FinishRunInput, "layout" | "snapshotId" | "status">,
  errors: { path?: string; message: string; code?: string }[],
): Promise<string | null> {
  if (input.layout === undefined || input.layout === null) {
    return null;
  }
  if (run.kind !== "backup" || input.snapshotId === undefined || input.status === "failed") {
    return null;
  }
  const parsed = parseLayoutManifest(input.layout);
  if (!parsed.ok) {
    errors.push({ code: LAYOUT_REJECTED, message: `layout refused: ${parsed.reason}` });
    return null;
  }
  if (parsed.manifest.platform !== "linux") {
    errors.push({
      code: LAYOUT_REJECTED,
      message: "layout refused: macOS layouts are kept from a later release",
    });
    return null;
  }
  const manifest = parsed.manifest;
  await tx
    .insert(endpointLayouts)
    .values({
      tenantId: agent.tenantId,
      endpointId: agent.endpointId,
      sha256: parsed.sha256,
      format: manifest.format,
      schemaVersion: manifest.schemaVersion,
      platform: manifest.platform,
      // The value as the agent sent it (unknown keys included), not the parsed one.
      manifest: JSON.parse(parsed.canonical) as Record<string, unknown>,
      summary: summarizeLayout(manifest) as unknown as Record<string, unknown>,
      verdict: manifest.verdict,
      layoutFingerprint: layoutFingerprint(manifest),
    })
    .onConflictDoNothing({ target: [endpointLayouts.endpointId, endpointLayouts.sha256] });
  const [row] = await tx
    .select({ id: endpointLayouts.id })
    .from(endpointLayouts)
    .where(
      and(
        eq(endpointLayouts.endpointId, agent.endpointId),
        eq(endpointLayouts.sha256, parsed.sha256),
      ),
    )
    .limit(1);
  return row?.id ?? null;
}

function loadEndpoint(
  tx: Transaction,
  tenantId: string,
  id: string,
): Promise<Endpoint | undefined> {
  return tx
    .select()
    .from(endpoints)
    .where(
      and(
        eq(endpoints.tenantId, tenantId),
        eq(endpoints.id, id),
        // A removed machine whose backups are still stored keeps its page (#65).
        or(
          isNull(endpoints.removedAt),
          sql`coalesce(${endpoints.removal}->>'state', '') <> 'done'`,
        ),
      ),
    )
    .limit(1)
    .then((rows) => rows[0]);
}

/** The newest run that recorded a layout, with the layout. */
async function latestLayoutRun(tx: Transaction, endpointId: string) {
  const [row] = await tx
    .select({
      runId: endpointRuns.id,
      snapshotId: endpointRuns.snapshotId,
      layout: endpointLayouts,
    })
    .from(endpointRuns)
    .innerJoin(endpointLayouts, eq(endpointLayouts.id, endpointRuns.layoutId))
    .where(and(eq(endpointRuns.endpointId, endpointId), isNotNull(endpointRuns.layoutId)))
    .orderBy(desc(endpointRuns.startedAt))
    .limit(1);
  return row ?? null;
}

/** The newest stage 1 report of a snapshot. */
async function latestCheckOf(
  tx: Transaction,
  endpointId: string,
  snapshotId: string,
): Promise<BaremetalCheckDto | null> {
  const [report] = await tx
    .select()
    .from(endpointReports)
    .where(
      and(
        eq(endpointReports.endpointId, endpointId),
        eq(endpointReports.kind, "baremetal_check"),
        eq(endpointReports.snapshotId, snapshotId),
      ),
    )
    .orderBy(desc(endpointReports.checkedAt))
    .limit(1);
  if (!report || report.readiness === null) {
    return null;
  }
  const summary = report.summary as Record<string, unknown>;
  const record = (value: unknown) =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  return {
    reportId: report.id,
    checkedAt: report.checkedAt.toISOString(),
    snapshotId: report.snapshotId,
    readiness: report.readiness,
    incomplete: typeof summary.incomplete === "string" ? summary.incomplete : null,
    checks: Array.isArray(summary.checks) ? summary.checks : [],
    restoreSizes: record(summary.restoreSizes) ?? {},
    minimumSizes: record(summary.minimumSizes),
    planner: record(summary.planner),
    bootChainFingerprint:
      typeof summary.bootChainFingerprint === "string" ? summary.bootChainFingerprint : null,
  };
}

/**
 * The volume group whose missing free space kept sources of the backup from a snapshot
 * (`backup.liveReasons` = `vg_no_space`), with the room to leave: 10 % of the group.
 */
export function snapshotHintOf(manifest: LayoutManifest): SnapshotHintDto | null {
  if (manifest.platform !== "linux") {
    return null;
  }
  const sources = Object.entries(manifest.backup.liveReasons)
    .filter(([, reason]) => reason === "vg_no_space")
    .map(([source]) => source);
  if (sources.length === 0) {
    return null;
  }
  const fsOfMount = new Map(manifest.mounts.map((mount) => [mount.target, mount.fs]));
  const vgOfFs = new Map<string, string>();
  for (const fs of manifest.filesystems) {
    const lv = fs.devices.find((device) => device.kind === "lv");
    if (lv && lv.kind === "lv") vgOfFs.set(fs.id, lv.vg);
  }
  const byVg = new Map<string, string[]>();
  for (const source of sources) {
    const fs = fsOfMount.get(source);
    const vg = fs ? vgOfFs.get(fs) : undefined;
    if (vg) byVg.set(vg, [...(byVg.get(vg) ?? []), source]);
  }
  const [first] = [...byVg.entries()];
  const group = first ? manifest.lvm.vgs.find((vg) => vg.name === first[0]) : undefined;
  if (!first || !group) {
    return null;
  }
  return {
    vg: group.name,
    sizeBytes: group.sizeBytes,
    freeBytes: group.freeBytes,
    suggestedFreeBytes: Math.ceil(group.sizeBytes / 10),
    mounts: [...first[1]].sort(),
  };
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** The boot probe report a rating names, for the card (12.3). */
async function bootProbeReportOf(
  tx: Transaction,
  reportId: string,
): Promise<BootProbeReportDto | null> {
  const [report] = await tx
    .select()
    .from(endpointReports)
    .where(eq(endpointReports.id, reportId))
    .limit(1);
  if (!report) return null;
  const summary = report.summary as Record<string, unknown>;
  const record = (value: unknown) =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  return {
    reportId: report.id,
    checkedAt: report.checkedAt.toISOString(),
    snapshotId: report.snapshotId,
    readiness: report.readiness === "green" || report.readiness === "red" ? report.readiness : null,
    cause: record(summary.cause),
    notPossible: typeof summary.notPossible === "string" ? summary.notPossible : null,
    firmware: typeof summary.firmware === "string" ? summary.firmware : null,
    controllers: stringList(summary.controllers),
    kvm: typeof summary.kvm === "boolean" ? summary.kvm : null,
    emptyFilesystems: stringList(summary.emptyFilesystems),
    emptyDirs: stringList(summary.emptyDirs),
    restoreBytes: typeof summary.restoreBytes === "number" ? summary.restoreBytes : null,
    serialTail: typeof summary.serialTail === "string" ? summary.serialTail.slice(-4096) : "",
  };
}

/**
 * The boot probe facts of a machine whose newest stage 1 is green: its probe reports for the
 * fingerprints of that report, the open probe and the lab (12.4).
 */
export async function bootProbeFactsOf(
  tx: Transaction,
  endpointId: string,
  fingerprints: { layoutFingerprint: string; bootChainFingerprint: string | null },
  manifest: LinuxLayoutManifest | null,
  lab: RecoveryLabState | null,
  now: Date,
): Promise<{ facts: BaremetalProbeFacts; latestReportId: string | null }> {
  const reports = fingerprints.bootChainFingerprint
    ? await bootProbeReports(tx, endpointId, {
        layoutFingerprint: fingerprints.layoutFingerprint,
        bootChainFingerprint: fingerprints.bootChainFingerprint,
      })
    : [];
  const pending = await pendingBootProbe(tx, endpointId, now);
  return {
    facts: {
      probes: reports,
      notPossible: manifest ? probeNotPossible(manifest) : null,
      lab: labPresent(lab, now),
      pending: pending?.state ?? null,
    },
    latestReportId: reports[0]?.id ?? null,
  };
}

/**
 * The bare metal state of a machine for a list (the "Bare Metal" column of the readiness overview):
 * the same rating as the card, without the wizard's parts. Null for a machine that is neither
 * backed up as a whole nor has a layout.
 */
export async function baremetalStateOf(
  tx: Transaction,
  endpoint: Endpoint,
  lab: RecoveryLabState | null,
  now: Date,
): Promise<BaremetalState | null> {
  const enabled = endpoint.config.wholeMachine === true;
  const latestRow = await latestLayoutRun(tx, endpoint.id);
  if (!enabled && !latestRow) return null;
  const check = latestRow?.snapshotId
    ? await latestCheckOf(tx, endpoint.id, latestRow.snapshotId)
    : null;
  const parsed = latestRow ? parseLayoutManifest(latestRow.layout.manifest) : null;
  const manifest = parsed?.ok && parsed.manifest.platform === "linux" ? parsed.manifest : null;
  const probe =
    latestRow && check?.readiness === "green"
      ? await bootProbeFactsOf(
          tx,
          endpoint.id,
          {
            layoutFingerprint: latestRow.layout.layoutFingerprint,
            bootChainFingerprint: check.bootChainFingerprint,
          },
          manifest,
          lab,
          now,
        )
      : null;
  return baremetalReadiness({
    enabled,
    os: endpoint.os,
    arch: endpoint.arch,
    virtualization: endpoint.settings.agent?.machine?.virtualization ?? null,
    agentTooOld: !agentVersionAtLeast(endpoint.agentVersion, WHOLE_MACHINE_AGENT_VERSION),
    latestLayout: latestRow ? { verdict: latestRow.layout.verdict } : null,
    latestReport: check ? { readiness: check.readiness } : null,
    ...(probe ? { probe: probe.facts } : {}),
    now,
  }).state;
}

/** The bare metal card of a machine's page (restore role and up). */
export async function getBaremetalState(
  database: Database,
  tenantId: string,
  endpointId: string,
  now: Date = new Date(),
  lab?: RecoveryLabState | null,
): Promise<BaremetalDto> {
  const labState = lab === undefined ? await loadRecoveryLab(providerDb) : lab;
  return withTenantTx(database, tenantId, async (tx) => {
    const endpoint = await loadEndpoint(tx, tenantId, endpointId);
    if (!endpoint) {
      throw new ProblemError(404, "Endpoint not found");
    }
    const enabled = endpoint.config.wholeMachine === true;
    const latestRow = await latestLayoutRun(tx, endpointId);
    let latest: BaremetalLatestDto | null = null;
    let snapshotHint: SnapshotHintDto | null = null;
    if (latestRow) {
      const parsed = parseLayoutManifest(latestRow.layout.manifest);
      const manifest = parsed.ok ? parsed.manifest : null;
      latest = {
        layoutId: latestRow.layout.id,
        runId: latestRow.runId,
        snapshotId: latestRow.snapshotId,
        capturedAt:
          manifest?.capturedAt ?? latestRow.layout.createdAt.toISOString().replace(/\.\d+Z$/, "Z"),
        sha256: latestRow.layout.sha256,
        fingerprint: latestRow.layout.layoutFingerprint,
        verdict: latestRow.layout.verdict,
        unsupported: manifest?.platform === "linux" ? manifest.unsupported : [],
        summary: latestRow.layout.summary as unknown as LayoutSummary,
      };
      snapshotHint = manifest ? snapshotHintOf(manifest) : null;
    }
    const check = latest?.snapshotId
      ? await latestCheckOf(tx, endpointId, latest.snapshotId)
      : null;
    const listed = await baremetalSnapshots(tx, endpointId);
    const newestSha = latest?.sha256 ?? listed[0]?.layoutSha256 ?? null;
    const snapshots: BaremetalSnapshotDto[] = listed.map((snapshot) => ({
      snapshotId: snapshot.id,
      time: snapshot.time,
      layoutId: snapshot.layoutId,
      layoutSha256: snapshot.layoutSha256,
      sameLayoutAsNewest: snapshot.layoutSha256 === newestSha,
      check: snapshot.check,
      verdict: snapshot.verdict,
    }));
    // The hardware guide per layout, from the newest snapshot of each and its stage 1 report.
    const newestOfLayout = new Map<string, (typeof listed)[number]>();
    for (const snapshot of listed) {
      if (!newestOfLayout.has(snapshot.layoutId) && newestOfLayout.size < MAX_HARDWARE_LAYOUTS) {
        newestOfLayout.set(snapshot.layoutId, snapshot);
      }
    }
    if (latestRow && !newestOfLayout.has(latestRow.layout.id)) {
      newestOfLayout.set(latestRow.layout.id, {
        id: latestRow.snapshotId ?? "",
        time: "",
        layoutId: latestRow.layout.id,
        layoutSha256: latestRow.layout.sha256,
        verdict: latestRow.layout.verdict,
        check: "none",
        restoreSizes: null,
        minimumSizes: check?.minimumSizes ?? null,
        planner: check?.planner ?? null,
      });
    }
    const layoutRows =
      newestOfLayout.size === 0
        ? []
        : await tx
            .select({ id: endpointLayouts.id, manifest: endpointLayouts.manifest })
            .from(endpointLayouts)
            .where(
              and(
                eq(endpointLayouts.endpointId, endpointId),
                inArray(endpointLayouts.id, [...newestOfLayout.keys()]),
              ),
            );
    const hardwareByLayout: Record<string, ReplacementHardware> = {};
    for (const row of layoutRows) {
      const parsed = parseLayoutManifest(row.manifest);
      const snapshot = newestOfLayout.get(row.id);
      if (!parsed.ok || parsed.manifest.platform !== "linux" || !snapshot) continue;
      hardwareByLayout[row.id] = replacementHardware(parsed.manifest, {
        minimumSizes: snapshot.minimumSizes,
        planner: snapshot.planner,
      });
    }
    const hardware = latestRow ? (hardwareByLayout[latestRow.layout.id] ?? null) : null;
    const activeRecovery = (await activeRecoveriesOf(tx, [endpointId])).get(endpointId) ?? null;
    const latestManifest = latestRow ? parseLayoutManifest(latestRow.layout.manifest) : null;
    const probeInput =
      latest && check?.readiness === "green"
        ? await bootProbeFactsOf(
            tx,
            endpointId,
            {
              layoutFingerprint: latest.fingerprint,
              bootChainFingerprint: check.bootChainFingerprint,
            },
            latestManifest?.ok && latestManifest.manifest.platform === "linux"
              ? latestManifest.manifest
              : null,
            labState,
            now,
          )
        : null;
    const rating = baremetalReadiness({
      enabled,
      os: endpoint.os,
      arch: endpoint.arch,
      virtualization: endpoint.settings.agent?.machine?.virtualization ?? null,
      agentTooOld: !agentVersionAtLeast(endpoint.agentVersion, WHOLE_MACHINE_AGENT_VERSION),
      latestLayout: latest ? { verdict: latest.verdict } : null,
      latestReport: check ? { readiness: check.readiness } : null,
      ...(probeInput ? { probe: probeInput.facts } : {}),
      now,
    });
    const probe: BaremetalProbeDto | null = probeInput
      ? {
          lab: probeInput.facts.lab,
          pending: probeInput.facts.pending,
          reason: rating.probe?.reason ?? null,
          latest: probeInput.latestReportId
            ? await bootProbeReportOf(tx, probeInput.latestReportId)
            : null,
        }
      : null;
    return {
      preview: config.baremetalPreview,
      enabled,
      state: rating.state,
      stateDetail: rating.detail,
      notPossible: rating.notPossible,
      latest,
      check,
      snapshotHint,
      snapshots,
      hardware,
      hardwareByLayout,
      activeRecovery,
      probe,
    };
  });
}

/**
 * "Probe now" on the machine's page (12.3): a probe of the newest whole machine snapshot is planned
 * at once (the lab takes it at its next request). Only for a machine whose newest stage 1 is
 * green and with a lab that has KVM; an open probe of the machine is answered instead of a
 * second one. Audited as `endpoint.boot_probe.requested`.
 */
export async function requestBootProbe(
  database: Database,
  tenantId: string,
  endpointId: string,
  actor: EndpointActor,
  now: Date = new Date(),
  lab?: RecoveryLabState | null,
): Promise<{ id: string; state: "planned" | "running" }> {
  const notPossible = (reason: string, detail: string) =>
    new ProblemError(409, "Boot probe not possible", {
      type: ENDPOINT_PROBLEMS.baremetalNotAvailable,
      detail,
      extensions: { reason },
    });
  if (!config.baremetalPreview) {
    throw notPossible(
      "preview_off",
      "Bare metal is a preview this installation has not switched on.",
    );
  }
  const present = labPresent(lab === undefined ? await loadRecoveryLab(providerDb) : lab, now);
  if (!present.present) {
    throw notPossible(
      "no_lab",
      "This installation runs no recovery lab (compose profile recovery-lab).",
    );
  }
  if (!present.kvm) {
    throw notPossible("no_kvm", "The recovery lab has no KVM; it cannot boot a probe.");
  }
  return withTenantTx(database, tenantId, async (tx) => {
    const endpoint = await loadEndpoint(tx, tenantId, endpointId);
    if (!endpoint || endpoint.removedAt) {
      throw new ProblemError(404, "Endpoint not found");
    }
    const latestRow = await latestLayoutRun(tx, endpointId);
    const check = latestRow?.snapshotId
      ? await latestCheckOf(tx, endpointId, latestRow.snapshotId)
      : null;
    if (!latestRow?.snapshotId || check?.readiness !== "green") {
      throw notPossible(
        "not_checked",
        "Stage 1 of the newest whole machine backup has not passed; the boot probe follows it.",
      );
    }
    const parsed = parseLayoutManifest(latestRow.layout.manifest);
    const reason =
      parsed.ok && parsed.manifest.platform === "linux" ? probeNotPossible(parsed.manifest) : null;
    if (reason) {
      throw notPossible(reason, "This machine cannot be booted by the probe.");
    }
    // Serialised per machine, so two requests plan one probe.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`probe:${endpointId}`}))`);
    const open = await pendingBootProbe(tx, endpointId, now);
    if (open) {
      return open;
    }
    const [created] = await tx
      .insert(endpointRecoveries)
      .values({
        tenantId,
        endpointId,
        kind: "probe",
        status: "issued",
        requireApproval: false,
        snapshotId: latestRow.snapshotId,
        issuedAt: now,
        expiresAt: new Date(now.getTime() + PROBE_EXPIRY_MS),
        createdBy: actor.userId,
        updatedAt: now,
      })
      .returning({ id: endpointRecoveries.id });
    if (!created) {
      throw new Error("probe insert returned no row");
    }
    await auditEndpoint(tx, {
      tenantId,
      actor,
      action: ENDPOINT_AUDIT_ACTIONS.bootProbeRequested,
      endpointId,
      details: { recoveryId: created.id, snapshotId: latestRow.snapshotId },
    });
    return { id: created.id, state: "planned" as const };
  });
}

/** One stored layout with its full manifest (serial numbers, admins only). */
export async function getLayout(
  database: Database,
  tenantId: string,
  endpointId: string,
  layoutId: string,
): Promise<LayoutDto> {
  return withTenantTx(database, tenantId, async (tx) => {
    const endpoint = await loadEndpoint(tx, tenantId, endpointId);
    const [layout] = endpoint
      ? await tx
          .select()
          .from(endpointLayouts)
          .where(and(eq(endpointLayouts.endpointId, endpointId), eq(endpointLayouts.id, layoutId)))
          .limit(1)
      : [];
    if (!layout) {
      throw new ProblemError(404, "Layout not found");
    }
    return {
      id: layout.id,
      sha256: layout.sha256,
      createdAt: layout.createdAt.toISOString(),
      manifest: layout.manifest,
    };
  });
}

/**
 * The LUKS key files a snapshot may hold (docs/BAREMETAL.md 5.4): those of the layout its run
 * recorded and of the machine's newest layout, so a key file is locked in every snapshot once any
 * layout names it. Empty for a machine without layouts.
 */
export async function keyFilesForSnapshot(
  tx: Transaction,
  endpointId: string,
  snapshotId: string,
): Promise<string[]> {
  const snapshot = snapshotId.toLowerCase();
  const ofSnapshot = await tx
    .select({ manifest: endpointLayouts.manifest })
    .from(endpointRuns)
    .innerJoin(endpointLayouts, eq(endpointLayouts.id, endpointRuns.layoutId))
    .where(
      and(
        eq(endpointRuns.endpointId, endpointId),
        snapshot.length >= 64
          ? eq(endpointRuns.snapshotId, snapshot)
          : like(endpointRuns.snapshotId, `${snapshot}%`),
      ),
    )
    .limit(4);
  const newest = await tx
    .select({ manifest: endpointLayouts.manifest })
    .from(endpointLayouts)
    .where(eq(endpointLayouts.endpointId, endpointId))
    .orderBy(desc(endpointLayouts.createdAt))
    .limit(1);
  const files = new Set<string>();
  for (const { manifest } of [...ofSnapshot, ...newest]) {
    const parsed = parseLayoutManifest(manifest);
    if (parsed.ok) {
      for (const file of keyFilesOf(parsed.manifest)) files.add(file);
    }
  }
  return [...files].sort();
}

/** Run {@link keyFilesForSnapshot} in its own tenant transaction. */
export function loadKeyFiles(
  database: Database,
  tenantId: string,
  endpointId: string,
  snapshotId: string,
): Promise<string[]> {
  return withTenantTx(database, tenantId, (tx) => keyFilesForSnapshot(tx, endpointId, snapshotId));
}
