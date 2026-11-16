/**
 * The lab API of the worker (docs/BAREMETAL.md 12.3, 25.C7): the recovery lab (compose profile
 * `recovery-lab`) asks here for work and reports what it saw. It has no database URL, no master
 * key and never a repository password: a probe hands it a one-time recovery code, and the ISO in
 * its virtual machine runs the same recovery a person runs (code exchange, session, credentials
 * through the `reader` route, release, finish). The worker rates the probe from what the
 * recovery reported itself and from the serial console the lab hands in.
 *
 * Only on the main host, only with `RESTOW_LAB_TOKEN` (at least 32 characters; the lab sends it as
 * `Authorization: Bearer`). Routes, all under `/internal/lab`:
 *
 *   POST /next                    the lab's state (version, KVM) and at most one probe, leased
 *                                 once: a code is made and only its proof's hash stored
 *   GET  /iso/:sha256             the verified recovery ISO the probe boots
 *   POST /probes/:id/event        a phase of a leased probe; the answer says whether to go on
 *   POST /probes/:id/result       the end of a leased probe, once: the `boot_probe` report
 *
 * A probe is addressed by its id only; the tenant is read from its row, so a lab cannot write to
 * any other row than a probe it leased.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  canonicalOrigin,
  formatRecoveryCode,
  generateRecoveryCode,
  hashRecoveryCodeProof,
  judgeBootProbe,
  type LabResult,
  labResultSchema,
  measureInstanceSpki,
  PROBE_BOOT_TIMEOUT_MS,
  PROBE_EXPIRY_MS,
  PROBE_TIMEOUT_MS,
  type ProbeHardware,
  type ProbeSelection,
  parseRecoveryVerification,
  probeAnswers,
  probeHardware,
  RECOVERY_LOG_MAX_BYTES,
  type RecoveryIsoSelection,
  recoveryCodeProof,
  recoveryIsoDropDirs,
  recoveryIsoStoreDir,
  redactRecoveryLogBatch,
  selectRecoveryIso,
  spkiCheckOf,
} from "@restow/core";
import {
  endpointRecoveries,
  endpointRecoveryLog,
  endpointReports,
  finishRecovery,
  type RecoveryLabState,
  settings,
} from "@restow/db";
import { and, asc, eq, gt, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { appendAuditEntry } from "../audit.js";
import { isUuid, withTenantTx } from "../handlers/framework.js";
import {
  labMaxRestoreBytesFromEnv,
  probePlanOf,
  stageOneOf,
  writeNotPossibleReport,
} from "./boot-probe.js";
import type { EndpointJobDeps } from "./common.js";

/** The shortest token the lab API accepts. */
export const LAB_TOKEN_MIN_LENGTH = 32;
/** The port of the lab API (only on the compose network, never published). */
export const LAB_API_PORT = 8095;
/**
 * The largest body the lab may send: a result with two consoles of 64 K characters each (up to
 * three bytes per character in JSON) and a relayed finish of at most 160 KiB.
 */
const MAX_BODY_BYTES = 1024 * 1024;
/** The end of the serial console a report keeps as evidence. */
const SERIAL_TAIL_BYTES = 4096;
const OPEN_STATES = ["issued", "pending_approval", "active", "finishing"] as const;

export interface LabApiOptions {
  token: string;
  /** Probes that may run at the same time (`RESTOW_LAB_CONCURRENCY`, 1 to 8, default 1). */
  concurrency: number;
  maxRestoreBytes: number;
  /** The address of this installation when Settings name none (`RESTOW_PUBLIC_URL`). */
  publicUrl: string | null;
  /** The instance check value when it cannot be measured (`RESTOW_PUBLIC_TLS_SPKI`). */
  spkiSha256: string | null;
  /** Where the TLS edge answers from inside (`RESTOW_LAB_TLS_UPSTREAM`, e.g. `caddy:443`). */
  tlsUpstream: string | null;
  /** The verified ISO this installation offers (tests replace it). */
  selectIso: () => Promise<RecoveryIsoSelection>;
  /** Measures the instance check value (tests replace it). */
  measureSpki: (origin: string, connectTo: string | null) => Promise<string | null>;
}

function spkiHash(value: string | undefined): string | null {
  const trimmed = value?.trim().toLowerCase().replace(/:/g, "");
  return trimmed && /^[0-9a-f]{64}$/.test(trimmed) ? trimmed : null;
}

/** The lab API's options from the environment, or null when it stays off (no token). */
export function labApiOptionsFromEnv(
  env: Record<string, string | undefined> = process.env,
): LabApiOptions | null {
  const token = env.RESTOW_LAB_TOKEN?.trim() ?? "";
  if (token.length < LAB_TOKEN_MIN_LENGTH) return null;
  const concurrency = Number(env.RESTOW_LAB_CONCURRENCY?.trim() || "1");
  const storeDir = recoveryIsoStoreDir(env);
  const dropDirs = recoveryIsoDropDirs(storeDir, env.RESTOW_RECOVERY_ISO_DIR?.trim() || null);
  return {
    token,
    concurrency:
      Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 8 ? concurrency : 1,
    maxRestoreBytes: labMaxRestoreBytesFromEnv(env),
    publicUrl: env.RESTOW_PUBLIC_URL?.trim() || null,
    spkiSha256: spkiHash(env.RESTOW_PUBLIC_TLS_SPKI),
    tlsUpstream: env.RESTOW_LAB_TLS_UPSTREAM?.trim() || null,
    selectIso: () => selectRecoveryIso({ storeDir, dropDirs }),
    measureSpki: async (origin, connectTo) =>
      (await measureInstanceSpki(origin, { timeoutMs: 5000 })) ??
      (connectTo ? await measureInstanceSpki(origin, { timeoutMs: 5000, connectTo }) : null),
  };
}

/** Whether the request carries the token (constant time, on the hashes). */
export function labTokenMatches(header: string | undefined, token: string): boolean {
  const match = /^Bearer\s+(\S+)$/.exec(header?.trim() ?? "");
  if (!match) return false;
  const given = createHash("sha256")
    .update(match[1] as string)
    .digest();
  const expected = createHash("sha256").update(token).digest();
  return timingSafeEqual(given, expected);
}

const PROBE_PHASES = ["iso", "restore", "released", "boot", "cleanup"] as const;

function onlyKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => keys.includes(key))
  );
}

/** The most probes a lab can say it runs (its concurrency is far below). */
const MAX_RUNNING_REPORTED = 32;

export interface NextBody {
  labVersion: string;
  kvm: boolean;
  /**
   * The probes the lab runs right now. A lab of 0.5.0 always sends it; without it (an older lab)
   * no leased probe is ended (`releaseOrphanedProbes`).
   */
  running?: string[];
}

/** The body of `next`: the lab's version, whether it has KVM and the probes it runs. */
export function parseNextBody(value: unknown): NextBody | null {
  if (!onlyKeys(value, ["labVersion", "kvm", "running"])) return null;
  const { labVersion, kvm, running } = value;
  if (typeof labVersion !== "string" || labVersion.length > 64 || typeof kvm !== "boolean") {
    return null;
  }
  if (
    running !== undefined &&
    (!Array.isArray(running) ||
      running.length > MAX_RUNNING_REPORTED ||
      !running.every((id) => typeof id === "string" && isUuid(id)))
  ) {
    return null;
  }
  return {
    labVersion: labVersion.replace(/[^\x20-\x7e]/g, ""),
    kvm,
    ...(running !== undefined ? { running: [...new Set(running as string[])] } : {}),
  };
}

export interface ProbeEventBody {
  phase: (typeof PROBE_PHASES)[number];
  detail?: string;
}

/** The body of `event`: a phase and an optional line. */
export function parseEventBody(value: unknown): ProbeEventBody | null {
  if (!onlyKeys(value, ["phase", "detail"])) return null;
  const { phase, detail } = value;
  if (!(PROBE_PHASES as readonly unknown[]).includes(phase)) return null;
  if (detail !== undefined && (typeof detail !== "string" || detail.length > 300)) return null;
  return { phase: phase as ProbeEventBody["phase"], ...(detail !== undefined ? { detail } : {}) };
}

/** A probe the lab leased: what it needs to run it, and nothing that opens the repository. */
export interface LeasedProbe {
  id: string;
  snapshotId: string;
  origin: string;
  spkiCheck: string | null;
  iso: { sha256: string; version: string; fileName: string; size: number };
  hardware: ProbeHardware;
  /** What the probe restores: the lab checks its free space against it. */
  restoreBytes: number;
  /** The answers file for fw_cfg (`opt/restow/answers`), with the code and the passphrase. */
  answers: Record<string, unknown>;
  /** The passphrase of the probe's LUKS volumes; the lab types it at the boot of the copy. */
  passphrase: string;
  timeouts: { totalMs: number; bootMs: number };
}

export type LeaseResult =
  | { probe: LeasedProbe }
  | { probe: null; reason: "no_kvm" | "busy" | "iso_missing" | "instance_unknown" | "none" };

/**
 * The probes the lab no longer runs: leased and still open, but missing from the lab's `running`
 * list. The lab lost them (it was restarted, or a result never arrived); without this each kept
 * a place of the lab's concurrency until it expired (PROBE_TIMEOUT_MS), and the lab answered
 * "busy" meanwhile. Each ends as a `lab_error` with code `lab_restarted` through the normal
 * result path: its code and access end, its report is incomplete (no rating), and the planning
 * plans the machine's next probe as after any probe that proved nothing. One lab per
 * installation (docs/BAREMETAL.md 12.3): every leased probe is that lab's.
 */
export async function releaseOrphanedProbes(
  deps: EndpointJobDeps,
  options: Pick<LabApiOptions, "maxRestoreBytes">,
  lab: { labVersion: string; kvm: boolean; running: readonly string[] },
): Promise<string[]> {
  const now = deps.runtime.now();
  const open = await deps.providerDb
    .select({
      id: endpointRecoveries.id,
      tenantId: endpointRecoveries.tenantId,
      endpointId: endpointRecoveries.endpointId,
      snapshotId: endpointRecoveries.snapshotId,
    })
    .from(endpointRecoveries)
    .where(
      and(
        eq(endpointRecoveries.kind, "probe"),
        isNotNull(endpointRecoveries.codeHash),
        inArray(endpointRecoveries.status, [...OPEN_STATES]),
        gt(endpointRecoveries.expiresAt, now),
      ),
    );
  const running = new Set(lab.running);
  const released: string[] = [];
  for (const probe of open) {
    if (running.has(probe.id)) continue;
    // The hardware the probe was leased with, for the report (firmware, controllers).
    const stage = probe.snapshotId
      ? await withTenantTx(deps.db, probe.tenantId, (tx) =>
          stageOneOf(tx, probe.endpointId, probe.snapshotId as string),
        )
      : null;
    const hardware = stage?.manifest ? probeHardware(stage.manifest) : null;
    const outcome = await storeProbeResult(
      deps,
      probe.id,
      {
        outcome: "lab_error",
        bootSerial: "",
        error: {
          code: "lab_restarted",
          message:
            "The lab no longer runs this probe (it was restarted, or its result never arrived).",
        },
        kvm: lab.kvm,
        firmware: hardware?.firmware ?? "uefi",
        controllers: hardware ? [...new Set(hardware.disks.map((disk) => disk.controller))] : [],
        restoreMs: null,
        bootMs: null,
        labVersion: lab.labVersion,
      },
      options,
    );
    if (outcome.status === "stored") {
      released.push(probe.id);
      deps.runtime.logger.warn("boot probe released: the lab no longer runs it", {
        probeId: probe.id,
        endpointId: probe.endpointId,
      });
    }
  }
  return released;
}

/** The lab asked: its state is stored, then at most one planned probe is leased to it. */
export async function leaseBootProbe(
  deps: EndpointJobDeps,
  options: LabApiOptions,
  lab: NextBody,
): Promise<LeaseResult> {
  if (lab.running !== undefined) {
    await releaseOrphanedProbes(deps, options, { ...lab, running: lab.running });
  }
  const now = deps.runtime.now();
  const state: RecoveryLabState = {
    seenAt: now.toISOString(),
    version: lab.labVersion,
    kvm: lab.kvm,
  };
  await deps.providerDb
    .insert(settings)
    .values({ recoveryLab: state })
    .onConflictDoUpdate({ target: settings.singleton, set: { recoveryLab: state } });
  if (!lab.kvm) return { probe: null, reason: "no_kvm" };
  // One lease at a time across workers: the count of running probes and the lease belong together.
  return deps.providerDb.transaction(async (ptx) => {
    await ptx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('restow:lab-lease'))`);
    const [running] = await ptx
      .select({ count: sql<number>`count(*)::int` })
      .from(endpointRecoveries)
      .where(
        and(
          eq(endpointRecoveries.kind, "probe"),
          isNotNull(endpointRecoveries.codeHash),
          inArray(endpointRecoveries.status, [...OPEN_STATES]),
          gt(endpointRecoveries.expiresAt, now),
        ),
      );
    if ((running?.count ?? 0) >= options.concurrency) return { probe: null, reason: "busy" };
    const candidates = await ptx
      .select({
        id: endpointRecoveries.id,
        tenantId: endpointRecoveries.tenantId,
        endpointId: endpointRecoveries.endpointId,
        snapshotId: endpointRecoveries.snapshotId,
        issuedAt: endpointRecoveries.issuedAt,
      })
      .from(endpointRecoveries)
      .where(
        and(
          eq(endpointRecoveries.kind, "probe"),
          eq(endpointRecoveries.status, "issued"),
          isNull(endpointRecoveries.codeHash),
          gt(endpointRecoveries.expiresAt, now),
        ),
      )
      .orderBy(asc(endpointRecoveries.issuedAt))
      .limit(5);
    if (candidates.length === 0) return { probe: null, reason: "none" };
    const iso = await options.selectIso();
    if (!iso.offered || !iso.local) return { probe: null, reason: "iso_missing" };
    const [row] = await ptx.select({ publicUrl: settings.publicUrl }).from(settings).limit(1);
    const origin = canonicalOrigin(row?.publicUrl?.trim() || options.publicUrl || "", {
      allowHttp: true,
    });
    if (!origin) return { probe: null, reason: "instance_unknown" };
    const spki = options.spkiSha256 ?? (await options.measureSpki(origin, options.tlsUpstream));
    for (const candidate of candidates) {
      const leased = await withTenantTx(deps.db, candidate.tenantId, async (tx) => {
        const stage = candidate.snapshotId
          ? await stageOneOf(tx, candidate.endpointId, candidate.snapshotId)
          : null;
        const close = () =>
          tx
            .update(endpointRecoveries)
            .set({ status: "failed", finishedAt: now, updatedAt: now })
            .where(
              and(eq(endpointRecoveries.id, candidate.id), isNull(endpointRecoveries.codeHash)),
            );
        if (stage?.readiness !== "green" || !stage.manifest || !stage.bootChainFingerprint) {
          // The snapshot was forgotten or its stage 1 is no longer green: nothing to probe.
          await close();
          return null;
        }
        const plan = probePlanOf(stage, options.maxRestoreBytes);
        if (!plan.possible) {
          await writeNotPossibleReport(
            tx,
            candidate.tenantId,
            candidate.endpointId,
            stage,
            plan,
            now,
          );
          await close();
          return null;
        }
        const code = generateRecoveryCode();
        const [taken] = await tx
          .update(endpointRecoveries)
          .set({
            codeHash: hashRecoveryCodeProof(recoveryCodeProof(origin, code)),
            instanceOrigin: origin,
            spkiSha256: spki,
            // The probe's own three hours start now, within the 48 hours of the row.
            expiresAt: new Date(
              Math.min(
                now.getTime() + PROBE_EXPIRY_MS,
                candidate.issuedAt.getTime() + 47 * 3600_000,
              ),
            ),
            updatedAt: now,
          })
          .where(
            and(
              eq(endpointRecoveries.id, candidate.id),
              eq(endpointRecoveries.status, "issued"),
              isNull(endpointRecoveries.codeHash),
            ),
          )
          .returning({ id: endpointRecoveries.id });
        if (!taken) return null;
        const hardware = probeHardware(stage.manifest);
        const passphrase = randomBytes(18).toString("base64url");
        const selection = plan as Extract<ProbeSelection, { possible: true }>;
        return {
          id: candidate.id,
          snapshotId: stage.snapshotId,
          origin,
          spkiCheck: spkiCheckOf(spki),
          iso: {
            sha256: iso.offered?.sha256 ?? "",
            version: iso.offered?.version ?? "",
            fileName: iso.offered?.fileName ?? "",
            size: iso.local?.size ?? 0,
          },
          hardware,
          restoreBytes: selection.restoreBytes,
          answers: probeAnswers({
            origin,
            code: formatRecoveryCode(code),
            spkiCheck: spkiCheckOf(spki),
            snapshotId: stage.snapshotId,
            hardware,
            selection,
            passphrase,
          }),
          passphrase,
          timeouts: { totalMs: PROBE_TIMEOUT_MS, bootMs: PROBE_BOOT_TIMEOUT_MS },
        } satisfies LeasedProbe;
      });
      if (leased) return { probe: leased };
    }
    return { probe: null, reason: "none" };
  });
}

/** The leased probe a lab names, with its tenant; null for anything else. */
async function leasedProbe(deps: EndpointJobDeps, id: string) {
  if (!isUuid(id)) return null;
  const [row] = await deps.providerDb
    .select()
    .from(endpointRecoveries)
    .where(
      and(
        eq(endpointRecoveries.id, id),
        eq(endpointRecoveries.kind, "probe"),
        isNotNull(endpointRecoveries.codeHash),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function alreadyReported(deps: EndpointJobDeps, tenantId: string, id: string) {
  return withTenantTx(deps.db, tenantId, async (tx) => {
    const [report] = await tx
      .select({ id: endpointReports.id })
      .from(endpointReports)
      .where(
        and(
          eq(endpointReports.kind, "boot_probe"),
          sql`${endpointReports.summary}->>'probeId' = ${id}`,
        ),
      )
      .limit(1);
    return report ?? null;
  });
}

/** A phase of a leased probe; `go: false` tells the lab to stop (finished, cancelled, expired). */
export async function probeEvent(
  deps: EndpointJobDeps,
  id: string,
  event: ProbeEventBody,
): Promise<{ go: boolean } | null> {
  const row = await leasedProbe(deps, id);
  if (!row) return null;
  const now = deps.runtime.now();
  await deps.providerDb
    .update(settings)
    .set({
      recoveryLab: sql`jsonb_set(coalesce(${settings.recoveryLab}, '{}'::jsonb), '{seenAt}', to_jsonb(${now.toISOString()}::text))`,
    })
    .where(isNotNull(settings.recoveryLab));
  deps.runtime.logger.info("boot probe phase", {
    probeId: id,
    endpointId: row.endpointId,
    phase: event.phase,
    detail: event.detail?.replace(/[^\x20-\x7e]/g, " ").slice(0, 300),
  });
  const open =
    (OPEN_STATES as readonly string[]).includes(row.status) &&
    row.expiresAt.getTime() > now.getTime() &&
    row.cancelRequestedAt === null;
  // After the release the recovery ends (succeeded or failed) and the boot of the copy follows.
  const ended = row.status === "succeeded" || row.status === "failed";
  return { go: open || (ended && event.phase !== "iso") };
}

export type ResultOutcome =
  | { status: "stored"; reportId: string; readiness: "green" | "red" | "yellow" }
  | { status: "unknown" }
  | { status: "already_reported" };

/**
 * The end of a probe (12.3): rated from the recovery's own report (status, verification, the
 * codes of a failure) and the serial console of the restored system (@restow/core
 * `judgeBootProbe`), written as a `boot_probe` report with the fingerprints of the snapshot's
 * stage 1. A session that is still open is closed as failed: its code and access end with the
 * probe. The serial console goes into the recovery's log (redacted, within its 2 MiB).
 *
 * After its release the ISO has no network: it writes its finish to the console, and the lab
 * hands it in (`recoveryFinish`, length and SHA-256 checked there). A session that is still
 * `finishing` (released, never any other state) is finished with it first, by the API's rules
 * (@restow/db `finishRecovery`: redacted, no warning code of the server's own, a success the
 * verification report does not bear out stored as failed), audited with the lab as the actor; the
 * probe is rated from the row as it is then. The end of the restore console (`restoreSerial`)
 * goes into the log too, before the boot's.
 */
export async function storeProbeResult(
  deps: EndpointJobDeps,
  id: string,
  result: LabResult,
  options: Pick<LabApiOptions, "maxRestoreBytes">,
): Promise<ResultOutcome> {
  const row = await leasedProbe(deps, id);
  if (!row) return { status: "unknown" };
  if (await alreadyReported(deps, row.tenantId, id)) return { status: "already_reported" };
  const now = deps.runtime.now();
  return withTenantTx(deps.db, row.tenantId, async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`probe-result:${id}`}))`);
    const [again] = await tx
      .select({ id: endpointReports.id })
      .from(endpointReports)
      .where(
        and(
          eq(endpointReports.kind, "boot_probe"),
          sql`${endpointReports.summary}->>'probeId' = ${id}`,
        ),
      )
      .limit(1);
    if (again) return { status: "already_reported" as const };
    const [current] = await tx
      .select()
      .from(endpointRecoveries)
      .where(eq(endpointRecoveries.id, id))
      .for("update")
      .limit(1);
    if (!current) return { status: "unknown" as const };
    let recovery = current;
    if (result.recoveryFinish && current.status === "finishing") {
      const finished = await finishRecovery(tx, {
        recovery: current,
        finish: result.recoveryFinish,
        actor: { label: `lab:probe:${id}`, userId: null, ip: null },
        relayedBy: "lab",
        now,
        audit: (event) => appendAuditEntry(tx, event),
      });
      const [reread] = await tx
        .select()
        .from(endpointRecoveries)
        .where(eq(endpointRecoveries.id, id))
        .limit(1);
      recovery = reread ?? current;
      deps.runtime.logger.info("boot probe: the finish relayed by the lab was stored", {
        probeId: id,
        reported: result.recoveryFinish.status,
        status: finished.status,
        reason: finished.contradiction?.code ?? null,
      });
    } else if (result.recoveryFinish) {
      deps.runtime.logger.warn(
        "boot probe: a relayed finish was ignored, the session is not finishing",
        {
          probeId: id,
          status: current.status,
        },
      );
    }
    const judgement = judgeBootProbe(
      {
        status: recovery.status,
        verification: parseRecoveryVerification(recovery.verification),
        warnings: recovery.warnings ?? [],
      },
      result,
    );
    if ((OPEN_STATES as readonly string[]).includes(recovery.status)) {
      await tx
        .update(endpointRecoveries)
        .set({ status: "failed", finishedAt: now, updatedAt: now })
        .where(eq(endpointRecoveries.id, id));
    }
    const stage = current.snapshotId
      ? await stageOneOf(tx, current.endpointId, current.snapshotId)
      : null;
    const plan = stage?.manifest ? probePlanOf(stage, options.maxRestoreBytes) : null;
    const serial = redactRecoveryLogBatch(result.bootSerial.split(/\r?\n/)).lines;
    const serialText = serial.join("\n");
    const tail = Buffer.from(serialText, "utf8");
    const readiness = judgement.readiness ?? "yellow";
    const [report] = await tx
      .insert(endpointReports)
      .values({
        tenantId: current.tenantId,
        endpointId: current.endpointId,
        kind: "boot_probe",
        origin: "server",
        snapshotId: current.snapshotId,
        runId: stage?.runId ?? null,
        readiness,
        checkedAt: now,
        summary: {
          probeId: id,
          layoutFingerprint: stage?.layoutFingerprint ?? null,
          bootChainFingerprint: stage?.bootChainFingerprint ?? null,
          cause: judgement.cause,
          notPossible: null,
          labOutcome: result.outcome,
          recoveryStatus: recovery.status,
          firmware: result.firmware,
          controllers: result.controllers,
          kvm: result.kvm,
          emptyFilesystems: plan?.possible ? plan.emptyFilesystems : [],
          emptyDirs: plan?.possible ? plan.emptyDirs : [],
          restoreBytes: plan?.restoreBytes ?? null,
          restoreMs: result.restoreMs,
          bootMs: result.bootMs,
          labVersion: result.labVersion,
          serialTail:
            tail.length > SERIAL_TAIL_BYTES
              ? tail.subarray(tail.length - SERIAL_TAIL_BYTES).toString("utf8")
              : serialText,
        },
      })
      .returning({ id: endpointReports.id });
    // The end of the restore console (the ISO's log after its release) and the console of the
    // restored system beside the ISO's own lines, as far as the log has room.
    const restoreSerial = result.restoreSerial
      ? redactRecoveryLogBatch(result.restoreSerial.split(/\r?\n/)).lines
      : [];
    let room = RECOVERY_LOG_MAX_BYTES - current.logBytes;
    const kept: string[] = [];
    for (const line of [
      ...restoreSerial.map((l) => `[probe restore] ${l}`),
      ...serial.map((l) => `[probe boot] ${l}`),
    ]) {
      const size = Buffer.byteLength(line, "utf8") + 1;
      if (size > room) break;
      kept.push(line);
      room -= size;
    }
    if (kept.length > 0) {
      await tx.insert(endpointRecoveryLog).values({
        tenantId: current.tenantId,
        recoveryId: id,
        lines: kept.join("\n"),
        createdAt: now,
      });
      await tx
        .update(endpointRecoveries)
        .set({ logBytes: RECOVERY_LOG_MAX_BYTES - room })
        .where(eq(endpointRecoveries.id, id));
    }
    deps.runtime.logger.info("boot probe finished", {
      probeId: id,
      endpointId: current.endpointId,
      readiness,
      cause: judgement.cause.kind,
      outcome: result.outcome,
    });
    return { status: "stored" as const, reportId: report?.id ?? "", readiness };
  });
}

function send(res: ServerResponse, status: number, body?: unknown): void {
  if (body === undefined) {
    res.writeHead(status).end();
    return;
  }
  const text = JSON.stringify(body);
  res
    .writeHead(status, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(text),
      "cache-control": "no-store",
    })
    .end(text);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new RangeError("body too large");
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "null");
}

/** One request of the lab. */
export async function handleLabRequest(
  deps: EndpointJobDeps,
  options: LabApiOptions,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!labTokenMatches(req.headers.authorization, options.token)) {
    send(res, 401, { error: "unauthorized" });
    return;
  }
  const path = new URL(req.url ?? "/", "http://lab").pathname;
  try {
    if (req.method === "POST" && path === "/internal/lab/next") {
      const body = parseNextBody(await readJson(req));
      if (!body) return send(res, 400, { error: "invalid_body" });
      return send(res, 200, await leaseBootProbe(deps, options, body));
    }
    const iso = /^\/internal\/lab\/iso\/([0-9a-f]{64})$/.exec(path);
    if (req.method === "GET" && iso) {
      const selection = await options.selectIso();
      if (!selection.local || selection.offered?.sha256 !== iso[1]) {
        return send(res, 404, { error: "iso_unknown" });
      }
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": selection.local.size,
      });
      createReadStream(selection.local.path).pipe(res);
      return;
    }
    const probe = /^\/internal\/lab\/probes\/([^/]+)\/(event|result)$/.exec(path);
    if (req.method === "POST" && probe) {
      const id = probe[1] as string;
      if (probe[2] === "event") {
        const body = parseEventBody(await readJson(req));
        if (!body) return send(res, 400, { error: "invalid_body" });
        const answer = await probeEvent(deps, id, body);
        return answer ? send(res, 200, answer) : send(res, 404, { error: "probe_unknown" });
      }
      const body = labResultSchema.safeParse(await readJson(req));
      if (!body.success) return send(res, 400, { error: "invalid_body" });
      const outcome = await storeProbeResult(deps, id, body.data, options);
      if (outcome.status === "unknown") return send(res, 404, { error: "probe_unknown" });
      if (outcome.status === "already_reported")
        return send(res, 409, { error: "already_reported" });
      return send(res, 200, { reportId: outcome.reportId, readiness: outcome.readiness });
    }
    send(res, 404, { error: "not_found" });
  } catch (error) {
    if (error instanceof RangeError || error instanceof SyntaxError) {
      send(res, 400, { error: "invalid_body" });
      return;
    }
    deps.runtime.logger.error("lab API request failed", {
      path,
      errorMessage: error instanceof Error ? error.message.slice(0, 300) : String(error),
    });
    if (!res.headersSent) send(res, 500, { error: "internal" });
  }
}

/** The lab API's listener; closed with the worker. */
export function startLabApi(
  deps: EndpointJobDeps,
  options: LabApiOptions,
  listen: { port?: number; host?: string } = {},
): Promise<Server> {
  const server = createServer((req, res) => {
    void handleLabRequest(deps, options, req, res);
  });
  server.requestTimeout = 10 * 60 * 1000;
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(listen.port ?? LAB_API_PORT, listen.host ?? "0.0.0.0", () => resolve(server));
  });
}
