import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  endpointPrefix,
  isoChecksum,
  listWithSizes,
  ONESHOT_BOOT_TIMEOUT_MS,
  ONESHOT_ISO_DOWNLOADS,
  REBUILD_SUMS_ASSET,
  RELEASE_SUMS_ASSET,
  readReleaseFile,
  storedRebuildDir,
} from "@restow/core";
import {
  type EndpointRecovery,
  type EndpointRecoveryHardware,
  type EndpointRecoveryOneshot,
  endpointLayouts,
  endpointRecoveries,
  endpoints,
} from "@restow/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db.js";
import { type Transaction, withTenantTx } from "../../lib/tenant-context.js";
import { ProblemError } from "../../problem.js";
import { raiseTenantEvent } from "./alerts.js";
import { auditEndpoint, ENDPOINT_AUDIT_ACTIONS, recoveryActor } from "./audit.js";
import { agentRoot } from "./distribution.js";
import { ENDPOINT_PROBLEMS } from "./problems.js";
import { baremetalSnapshot } from "./recovery-codes.js";
import { recoveryIsoSelection } from "./recovery-iso.js";
import { forgetRecoverySession, type RecoverySessionAccess } from "./recovery-session-cache.js";
import { backendHolding, tenantStorage } from "./repository.js";
import type { OneshotChecksInput, RecoveryOneshotExchangeInput } from "./schemas.js";

/**
 * The server's side of a oneshot restore (docs/BAREMETAL-ONESHOT.md 6): the command on a fresh
 * machine exchanges its code before the machine switches into the recovery environment, reports
 * its checks, fetches the recovery ISO through its session, and the recovery environment reports
 * back after the switch (`booted`). The credentials go out only after that report: the command
 * itself never asks for them (and could not get them before the release either).
 *
 * What the machine reports is kept in `oneshot.reported` and `oneshot.booted`; what the admin
 * decides in `oneshot.decided`, written only by the release (recovery-codes.ts).
 */

/** What the command reports with its exchange, apart from the fields of the ISO's exchange. */
export type OneshotExchangeReport = Pick<
  RecoveryOneshotExchangeInput,
  "target" | "checks" | "sshKeys"
>;

export interface OneshotExchangeExtras {
  /** The ISO the session fetches through `GET …/sessions/current/iso` (null: no copy here). */
  iso: { version: string; fileName: string; sha256: string; sizeBytes: number } | null;
  /** `passphrase`: the layout has LUKS volumes; `ramBytes`: what the restore needs (15). */
  needs: { passphrase: boolean; ramBytes: number };
}

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

/** The memory a oneshot restore needs (docs/BAREMETAL-ONESHOT.md 15): 2 GiB at least. */
export function oneshotRamBytes(indexBytes: number): number {
  return Math.max(2 * GIB, 600 * MIB + 2 * Math.max(0, indexBytes) + 512 * MIB);
}

/** The fields the exchange sets on a oneshot code: its session's end, and the machine's report. */
export function oneshotClaim(
  row: EndpointRecovery,
  report: OneshotExchangeReport,
  agentVersion: string,
): { expiresAt: Date; oneshot: EndpointRecoveryOneshot } {
  const validityHours = row.oneshot?.validityHours ?? 12;
  return {
    expiresAt: new Date(row.issuedAt.getTime() + validityHours * 60 * 60 * 1000),
    oneshot: {
      ...(row.oneshot ?? { validityHours }),
      validityHours,
      reported: {
        target: report.target as Record<string, unknown>,
        checks: report.checks as Record<string, unknown>,
        sshKeys: report.sshKeys,
        agentVersion,
      },
    },
  };
}

/** Whether the layout of the code's snapshot has LUKS volumes (the command asks the passphrase). */
async function layoutHasLuks(tx: Transaction, row: EndpointRecovery): Promise<boolean> {
  if (row.snapshotId === null) return false;
  const snapshot = await baremetalSnapshot(tx, row.endpointId, row.snapshotId);
  if (!snapshot) return false;
  const [layout] = await tx
    .select({ manifest: endpointLayouts.manifest })
    .from(endpointLayouts)
    .where(eq(endpointLayouts.id, snapshot.layoutId))
    .limit(1);
  const luks = (layout?.manifest as { luks?: unknown } | undefined)?.luks;
  return Array.isArray(luks) && luks.length > 0;
}

/** The ISO on offer with a copy here, or null (the session can fetch only a copy here). */
async function offeredLocalIso(): Promise<OneshotExchangeExtras["iso"]> {
  const selection = await recoveryIsoSelection(agentRoot());
  const offered = selection.offered;
  if (!offered || !selection.local) return null;
  return {
    version: offered.version,
    fileName: offered.fileName,
    sha256: offered.sha256,
    sizeBytes: selection.local.size,
  };
}

/** Add what a oneshot command needs to the answer of its exchange. */
export async function withOneshotExtras<T extends { oneshot?: OneshotExchangeExtras }>(
  answer: T,
  row: EndpointRecovery,
): Promise<T> {
  if (row.kind !== "oneshot") return answer;
  const passphrase = await withTenantTx(db, row.tenantId, (tx) => layoutHasLuks(tx, row));
  let indexBytes = 0;
  try {
    const prefix = endpointPrefix(row.endpointId);
    const storage = await backendHolding(await tenantStorage(db, row.tenantId), prefix);
    const index = await listWithSizes(storage, `${prefix}index/`);
    indexBytes = index.reduce((sum, entry) => sum + entry.size, 0);
  } catch {
    // Unknown: the minimum stands.
  }
  return {
    ...answer,
    oneshot: {
      iso: await offeredLocalIso(),
      needs: { passphrase, ramBytes: oneshotRamBytes(indexBytes) },
    },
  };
}

function oneshotOnly(access: RecoverySessionAccess): void {
  if (access.kind !== "oneshot") {
    throw new ProblemError(404, "Not Found", { detail: "This session is no oneshot restore." });
  }
}

function stateConflict(status: string, detail: string): ProblemError {
  return new ProblemError(409, "Not possible in this state", {
    type: ENDPOINT_PROBLEMS.recoveryStateConflict,
    detail,
    extensions: { status },
  });
}

/**
 * The checks of the command after its test load (docs/BAREMETAL-ONESHOT.md 8.2): only while the
 * session waits for its release, so an admin sees them before releasing. They replace the checks
 * of the exchange; the rest of the report stays.
 */
export async function recordOneshotChecks(
  access: RecoverySessionAccess,
  checks: OneshotChecksInput,
  now: Date = new Date(),
): Promise<void> {
  oneshotOnly(access);
  await withTenantTx(db, access.tenantId, async (tx) => {
    const [row] = await tx
      .update(endpointRecoveries)
      .set({
        oneshot: sql`jsonb_set(${endpointRecoveries.oneshot}, '{reported,checks}', ${JSON.stringify(checks)}::jsonb)`,
        updatedAt: now,
      })
      .where(
        and(
          eq(endpointRecoveries.id, access.id),
          eq(endpointRecoveries.status, "pending_approval"),
          sql`${endpointRecoveries.oneshot} ? 'reported'`,
        ),
      )
      .returning({ id: endpointRecoveries.id });
    if (!row) {
      throw stateConflict(
        access.status,
        "The checks are taken only while the session waits for its release.",
      );
    }
  });
  forgetRecoverySession(access.id);
}

/** The files of the offered ISO: the image itself and its signed checksums. */
export type OneshotIsoFile = "iso" | "sums" | "signature";

export interface OneshotIsoServed {
  fileName: string;
  /** The image: a path and its size; the checksums: their bytes. */
  path?: string;
  size?: number;
  bytes?: Buffer;
}

/** The signed checksum list that names the offered ISO, and its signature, from this instance. */
async function offeredSums(): Promise<{ name: string; sums: Buffer; signature: Buffer } | null> {
  const selection = await recoveryIsoSelection(agentRoot());
  const offered = selection.offered;
  if (!offered) return null;
  const candidates: { sums: string; signature: string }[] = [];
  if (offered.rebuild === null) {
    const sums = await readReleaseFile(offered.version, "SHA256SUMS", agentRoot());
    const signature = await readReleaseFile(offered.version, "SHA256SUMS.sig", agentRoot());
    if (
      sums &&
      signature &&
      isoChecksum(sums.toString("utf8"), offered.fileName) === offered.sha256
    ) {
      return { name: RELEASE_SUMS_ASSET, sums, signature };
    }
    return null;
  }
  const dirs = [
    ...(selection.storeDir
      ? [storedRebuildDir(selection.storeDir, offered.version, offered.rebuild)]
      : []),
    ...selection.dropDirs,
  ];
  for (const dir of dirs) {
    candidates.push({
      sums: join(dir, REBUILD_SUMS_ASSET),
      signature: join(dir, `${REBUILD_SUMS_ASSET}.sig`),
    });
  }
  for (const candidate of candidates) {
    const sums = await readFile(candidate.sums).catch(() => null);
    const signature = sums ? await readFile(candidate.signature).catch(() => null) : null;
    if (
      sums &&
      signature &&
      isoChecksum(sums.toString("utf8"), offered.fileName) === offered.sha256
    ) {
      return { name: REBUILD_SUMS_ASSET, sums, signature };
    }
  }
  return null;
}

/**
 * The recovery ISO through the session (docs/BAREMETAL-ONESHOT.md 6.4): only before the session
 * reported back from the recovery environment, only while it waits or is active, the image at most
 * three times per session. The same verified copy as every other download of the instance; the
 * command checks it against the signed checksums itself.
 */
export async function oneshotIso(
  access: RecoverySessionAccess,
  file: OneshotIsoFile,
  now: Date = new Date(),
): Promise<OneshotIsoServed> {
  oneshotOnly(access);
  if (access.status !== "pending_approval" && access.status !== "active") {
    throw stateConflict(access.status, "The ISO is fetched before the switch only.");
  }
  if (access.oneshot?.booted) {
    throw stateConflict(access.status, "The recovery environment runs already.");
  }
  const notHere = () =>
    new ProblemError(404, "No recovery ISO here", {
      detail:
        "This installation has no verified copy of the recovery ISO yet (Recovery ISO: the worker downloads it).",
    });
  if (file !== "iso") {
    const sums = await offeredSums();
    if (!sums) throw notHere();
    return file === "sums"
      ? { fileName: sums.name, bytes: sums.sums }
      : { fileName: `${sums.name}.sig`, bytes: sums.signature };
  }
  const selection = await recoveryIsoSelection(agentRoot());
  if (!selection.offered || !selection.local) throw notHere();
  const counted = await withTenantTx(db, access.tenantId, async (tx) => {
    const [row] = await tx
      .update(endpointRecoveries)
      .set({
        oneshot: sql`jsonb_set(${endpointRecoveries.oneshot}, '{isoDownloads}', to_jsonb(coalesce((${endpointRecoveries.oneshot}->>'isoDownloads')::int, 0) + 1))`,
        updatedAt: now,
      })
      .where(
        and(
          eq(endpointRecoveries.id, access.id),
          inArray(endpointRecoveries.status, ["pending_approval", "active"]),
          sql`coalesce((${endpointRecoveries.oneshot}->>'isoDownloads')::int, 0) < ${ONESHOT_ISO_DOWNLOADS}`,
          sql`NOT (${endpointRecoveries.oneshot} ? 'booted')`,
        ),
      )
      .returning({ id: endpointRecoveries.id });
    return row !== undefined;
  });
  if (!counted) {
    throw new ProblemError(429, "Too many downloads", {
      type: "urn:restow:problem:rate-limited",
      detail: `A session fetches the recovery ISO at most ${ONESHOT_ISO_DOWNLOADS} times.`,
    });
  }
  return {
    fileName: selection.offered.fileName,
    path: selection.local.path,
    size: selection.local.size,
  };
}

/**
 * Whether the hardware the recovery environment found is the machine the command reported (same
 * firmware, the same disks by size and, where both name it, serial and WWN; the same network
 * cards by MAC). A consistency check, no proof: whoever has the session secret can report anything.
 */
export function sameMachine(
  before: EndpointRecoveryHardware,
  after: EndpointRecoveryHardware,
): boolean {
  if (before.firmware !== after.firmware || before.disks.length !== after.disks.length)
    return false;
  const left = [...after.disks];
  for (const disk of before.disks) {
    const index = left.findIndex(
      (other) =>
        other.sizeBytes === disk.sizeBytes &&
        (disk.serial === "" || other.serial === "" || other.serial === disk.serial) &&
        (disk.wwn === "" || other.wwn === "" || other.wwn === disk.wwn),
    );
    if (index < 0) return false;
    left.splice(index, 1);
  }
  const macs = (hw: EndpointRecoveryHardware) =>
    hw.nics
      .map((nic) => nic.mac.toLowerCase())
      .filter((mac) => mac !== "")
      .sort()
      .join(",");
  return macs(before) === macs(after);
}

/**
 * The recovery environment reports back after the switch (docs/BAREMETAL-ONESHOT.md 6.4): only an
 * active (released) session, once; again with the same hardware it answers the same. Hardware that
 * is not the reported machine ends the session (`failed`, `hardware_changed`).
 */
export async function reportOneshotBooted(
  access: RecoverySessionAccess,
  hardware: EndpointRecoveryHardware,
  ip: string | null,
  now: Date = new Date(),
): Promise<{ status: string; bootedAt: string }> {
  oneshotOnly(access);
  const result = await withTenantTx(db, access.tenantId, async (tx) => {
    const [row] = await tx
      .select()
      .from(endpointRecoveries)
      .where(eq(endpointRecoveries.id, access.id))
      .for("update")
      .limit(1);
    if (row?.status !== "active") {
      throw stateConflict(
        row?.status ?? access.status,
        "Only a released session reports back from the recovery environment.",
      );
    }
    if (row.oneshot?.booted) {
      if (!sameMachine(row.oneshot.booted.hardware, hardware)) {
        throw stateConflict(row.status, "The session reported back from other hardware before.");
      }
      return { status: row.status, bootedAt: row.oneshot.booted.at };
    }
    if (!row.hardware || !sameMachine(row.hardware, hardware)) {
      await tx
        .update(endpointRecoveries)
        .set({ status: "failed", finishedAt: now, updatedAt: now })
        .where(eq(endpointRecoveries.id, row.id));
      await auditEndpoint(tx, {
        tenantId: row.tenantId,
        actor: recoveryActor(row.id, ip),
        action: ENDPOINT_AUDIT_ACTIONS.recoveryFinished,
        endpointId: row.endpointId,
        details: { recoveryId: row.id, status: "failed", reason: "hardware_changed", ip },
      });
      await raiseTenantEvent(tx, {
        tenantId: row.tenantId,
        event: "endpoint.recovery.failed",
        level: "error",
        message:
          "A recovery onto a fresh machine failed: the recovery environment reported other hardware than the machine that redeemed the code.",
        details: {
          endpointId: row.endpointId,
          objectName: await endpointNameOf(tx, row.endpointId),
          recoveryId: row.id,
          reason: "hardware_changed",
          ip,
        },
        now,
      });
      return { status: "failed", bootedAt: null };
    }
    const booted = { at: now.toISOString(), hardware };
    await tx
      .update(endpointRecoveries)
      .set({
        oneshot: sql`jsonb_set(${endpointRecoveries.oneshot}, '{booted}', ${JSON.stringify(booted)}::jsonb)`,
        updatedAt: now,
      })
      .where(eq(endpointRecoveries.id, row.id));
    await auditEndpoint(tx, {
      tenantId: row.tenantId,
      actor: recoveryActor(row.id, ip),
      action: ENDPOINT_AUDIT_ACTIONS.recoveryBooted,
      endpointId: row.endpointId,
      details: { recoveryId: row.id, ip },
    });
    return { status: row.status, bootedAt: booted.at };
  });
  forgetRecoverySession(access.id);
  if (result.bootedAt === null) {
    throw new ProblemError(409, "Other hardware", {
      type: ENDPOINT_PROBLEMS.recoveryStateConflict,
      detail:
        "The recovery environment found other hardware than the machine that redeemed the code; the session has ended.",
      extensions: { status: "failed", reason: "hardware_changed" },
    });
  }
  return { status: result.status, bootedAt: result.bootedAt };
}

async function endpointNameOf(tx: Transaction, endpointId: string): Promise<string> {
  const [row] = await tx
    .select({ hostname: endpoints.hostname, displayName: endpoints.displayName })
    .from(endpoints)
    .where(eq(endpoints.id, endpointId))
    .limit(1);
  return row ? row.displayName?.trim() || row.hostname : endpointId;
}

/** The credentials of a oneshot session go only to the recovery environment (after `booted`). */
export function assertOneshotBooted(access: RecoverySessionAccess): void {
  if (access.kind === "oneshot" && !access.oneshot?.booted) {
    throw new ProblemError(409, "Not in the recovery environment yet", {
      type: ENDPOINT_PROBLEMS.recoveryNotBooted,
      detail:
        "The credentials of a restore onto a fresh machine go only to its recovery environment, after it reported back.",
    });
  }
}

/** What the session routes tell a oneshot session about its release (`GET …/current`). */
export function oneshotCurrent(access: RecoverySessionAccess): {
  decided: EndpointRecoveryOneshot["decided"] | null;
  booted: boolean;
} | null {
  if (access.kind !== "oneshot") return null;
  return { decided: access.oneshot?.decided ?? null, booted: Boolean(access.oneshot?.booted) };
}

/** A released oneshot session that did not report back from the recovery environment in time. */
export function oneshotBootOverdue(
  row: Pick<EndpointRecovery, "kind" | "status" | "approvedAt" | "oneshot">,
  now: Date,
): boolean {
  return (
    row.kind === "oneshot" &&
    row.status === "active" &&
    row.approvedAt !== null &&
    !row.oneshot?.booted &&
    now.getTime() - row.approvedAt.getTime() > ONESHOT_BOOT_TIMEOUT_MS
  );
}
