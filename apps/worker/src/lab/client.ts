/**
 * The lab's side of the lab API (apps/worker/src/endpoints/lab-api.ts, docs/BAREMETAL.md 12.3).
 * The lab knows only these messages: no database, no key, no repository credential. The shapes
 * are written down here again on purpose: the lab bundle imports nothing of the server.
 */
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export type LabFirmware = "uefi-sb" | "uefi" | "bios";
export type LabController = "nvme" | "sata";

export interface LeasedProbe {
  id: string;
  snapshotId: string;
  origin: string;
  spkiCheck: string | null;
  iso: { sha256: string; version: string; fileName: string; size: number };
  hardware: {
    firmware: LabFirmware;
    disks: {
      id: string;
      sizeBytes: number;
      logicalSectorSize: 512 | 4096;
      controller: LabController;
      serial: string;
    }[];
    nic: "e1000e" | "virtio-net";
    memoryMiB: number;
    cpus: number;
  };
  /** What the probe restores (the room its disks take at most). */
  restoreBytes: number;
  answers: Record<string, unknown>;
  passphrase: string;
  timeouts: { totalMs: number; bootMs: number };
}

export type LeaseAnswer = { probe: LeasedProbe } | { probe: null; reason: string };

export type ProbePhase = "iso" | "restore" | "released" | "boot" | "cleanup";

export interface ProbeResult {
  outcome: "booted" | "restore_stopped" | "boot_timeout" | "lab_error";
  bootSerial: string;
  error: { code: string; message: string } | null;
  kvm: boolean;
  firmware: LabFirmware;
  controllers: LabController[];
  restoreMs: number | null;
  bootMs: number | null;
  labVersion: string;
}

export interface LabClient {
  next(state: { labVersion: string; kvm: boolean }): Promise<LeaseAnswer>;
  event(id: string, phase: ProbePhase, detail?: string): Promise<{ go: boolean }>;
  result(id: string, result: ProbeResult): Promise<void>;
  /** Download the ISO into `file`, checked against its SHA-256 before it is renamed into place. */
  downloadIso(sha256: string, file: string): Promise<void>;
}

/** The largest serial console a result carries (the server's limit). */
export const MAX_BOOT_SERIAL = 64 * 1024;

/** The end of a console text within the server's limit, without control characters but newline. */
export function serialTail(text: string, max = MAX_BOOT_SERIAL): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the console's own control characters go
  const cleaned = text.replace(/\r\n/g, "\n").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
  return cleaned.length > max ? cleaned.slice(cleaned.length - max) : cleaned;
}

export function labClient(base: string, token: string, fetchFn: typeof fetch = fetch): LabClient {
  const root = base.replace(/\/+$/, "");
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const post = async (path: string, body: unknown): Promise<unknown> => {
    const response = await fetchFn(`${root}/internal/lab${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`lab API ${path}: ${response.status} ${text.slice(0, 200)}`);
    }
    return text ? JSON.parse(text) : null;
  };
  return {
    next: async (state) => (await post("/next", state)) as LeaseAnswer,
    event: async (id, phase, detail) =>
      (await post(`/probes/${encodeURIComponent(id)}/event`, {
        phase,
        ...(detail ? { detail: detail.slice(0, 300) } : {}),
      })) as { go: boolean },
    result: async (id, result) => {
      await post(`/probes/${encodeURIComponent(id)}/result`, result);
    },
    downloadIso: async (sha256, file) => {
      if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error("not a SHA-256");
      const response = await fetchFn(`${root}/internal/lab/iso/${sha256}`, {
        headers: { authorization: headers.authorization },
        signal: AbortSignal.timeout(60 * 60_000),
      });
      if (!response.ok || !response.body) {
        throw new Error(`lab API iso: ${response.status}`);
      }
      const partial = `${file}.part`;
      const hash = createHash("sha256");
      const tap = new Transform({
        transform(chunk, _encoding, done) {
          hash.update(chunk as Buffer);
          done(null, chunk);
        },
      });
      try {
        await pipeline(
          Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
          tap,
          createWriteStream(partial, { mode: 0o600 }),
        );
        const actual = hash.digest("hex");
        if (actual !== sha256) throw new Error(`the ISO has SHA-256 ${actual}, not ${sha256}`);
        await rename(partial, file);
      } finally {
        await rm(partial, { force: true });
      }
    },
  };
}
