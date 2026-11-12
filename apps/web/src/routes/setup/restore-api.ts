import { apiFetch, apiPutBytes, NetworkError, SETUP_TOKEN_HEADER } from "@/lib/api";

/**
 * Restoring an installation from a database dump in the setup wizard (apps/api
 * routes/setup-restore.ts, behind the setup token). The work is the updater's: the wizard
 * uploads a dump in parts (or picks one the updater kept), starts the restore, reads the report
 * and activates it.
 */

export interface DumpInfo {
  file: string;
  bytes: number;
  createdAt: string;
}

export interface RestoreTargetFinding {
  tenantId: string;
  tenantName: string | null;
  targetId: string;
  outcome: string;
  storageMaxSeq: number | null;
  dbSeq: number;
  unknownKeyVersions: number[];
  detail: string | null;
}

export type RestoreRefusalCode =
  | "master_key_mismatch"
  | "dump_too_new"
  | "not_restow"
  | "setup_incomplete";

export interface RestoreReport {
  ok: boolean;
  refusal: { code: RestoreRefusalCode; message: string; requiredMigrations?: number } | null;
  dumpName: string | null;
  migrations: { restored: number | null; shipped: number; after: number | null };
  installation: {
    publicUrl: string | null;
    operatingMode: string | null;
    setupCompletedAt: string | null;
  };
  counts: {
    users: number;
    providerOwners: number;
    tenants: number;
    storageTargets: number;
    clusterNodes: number;
  };
  restoreMode: { id: string; created: boolean } | null;
  keys: Record<
    "tenantKeys" | "installationSecrets" | "tenantSecrets",
    { checked: number; failed: number }
  >;
  storage: {
    checked: boolean;
    targets: RestoreTargetFinding[];
    unreachable: number;
    ahead: number;
    error: string | null;
  };
  preparedAt: string;
}

export type RestoreStatus =
  | "running"
  | "awaiting_confirmation"
  | "done"
  | "refused"
  | "failed"
  | "aborted"
  | "needs_attention";

export type RestorePhase =
  | "restoring"
  | "preparing"
  | "awaiting_confirmation"
  | "activating"
  | "starting";

export interface RestoreOperation {
  id: string;
  status: RestoreStatus;
  phase: RestorePhase;
  dump: string;
  startedAt: string;
  finishedAt: string | null;
  report: RestoreReport | null;
  message: string | null;
  servicesStopped: boolean;
}

export type RestoreUnavailableReason =
  | "updater_disabled"
  | "updater_unreachable"
  | "updater_incompatible"
  | "demo";

export interface RestoreInfo {
  available: boolean;
  reason: RestoreUnavailableReason | null;
  dumps: DumpInfo[];
  operation: RestoreOperation | null;
  partBytes: number;
}

/** The wizard keeps whether it activated a restore across the api's restart (restore-done-step.tsx). */
export const RESTORE_ACTIVATED_KEY = "restow.setup.restoreActivated";

const headers = (token: string) => ({ [SETUP_TOKEN_HEADER]: token });

export function fetchRestoreInfo(token: string): Promise<RestoreInfo> {
  return apiFetch<RestoreInfo>("/setup/restore", { tenantId: null, headers: headers(token) });
}

export function startRestore(
  token: string,
  dump: string,
): Promise<{ operation: RestoreOperation }> {
  return apiFetch("/setup/restore/start", {
    method: "POST",
    body: { dump },
    tenantId: null,
    headers: headers(token),
  });
}

export function activateRestore(
  token: string,
  acceptUnreachable: boolean,
): Promise<{ operation: RestoreOperation }> {
  return apiFetch("/setup/restore/activate", {
    method: "POST",
    body: { confirm: true, ...(acceptUnreachable ? { acceptUnreachable: true } : {}) },
    tenantId: null,
    headers: headers(token),
  });
}

export function abortRestore(token: string): Promise<{ operation: RestoreOperation }> {
  return apiFetch("/setup/restore/abort", {
    method: "POST",
    body: {},
    tenantId: null,
    headers: headers(token),
  });
}

interface UploadView {
  id: string;
  bytes: number;
  received: number;
}

function putPart(token: string, id: string, offset: number, part: Blob): Promise<UploadView> {
  return apiPutBytes<UploadView>(
    `/setup/restore/uploads/${encodeURIComponent(id)}?offset=${offset}`,
    part,
    { headers: headers(token) },
  );
}

// ---- SHA-256 of a whole file, part by part (the browser's digest takes one buffer only) --------

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (value: number, bits: number): number => (value >>> bits) | (value << (32 - bits));

/** Incremental SHA-256 (FIPS 180-4): `update` as often as needed, then `hex` once. */
export class Sha256 {
  private readonly state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  private readonly words = new Uint32Array(64);
  private readonly block = new Uint8Array(64);
  private filled = 0;
  private length = 0;

  update(data: Uint8Array): this {
    this.length += data.length;
    let offset = 0;
    if (this.filled > 0) {
      const take = Math.min(64 - this.filled, data.length);
      this.block.set(data.subarray(0, take), this.filled);
      this.filled += take;
      offset = take;
      if (this.filled === 64) {
        this.compress(this.block, 0);
        this.filled = 0;
      }
    }
    for (; offset + 64 <= data.length; offset += 64) {
      this.compress(data, offset);
    }
    if (offset < data.length) {
      this.block.set(data.subarray(offset), 0);
      this.filled = data.length - offset;
    }
    return this;
  }

  hex(): string {
    const bits = this.length * 8;
    const tail = new Uint8Array(this.filled < 56 ? 64 : 128);
    tail.set(this.block.subarray(0, this.filled));
    tail[this.filled] = 0x80;
    const view = new DataView(tail.buffer);
    view.setUint32(tail.length - 8, Math.floor(bits / 0x100000000));
    view.setUint32(tail.length - 4, bits >>> 0);
    for (let offset = 0; offset < tail.length; offset += 64) {
      this.compress(tail, offset);
    }
    return Array.from(this.state, (word) => word.toString(16).padStart(8, "0")).join("");
  }

  private compress(data: Uint8Array, offset: number): void {
    const words = this.words;
    const view = new DataView(data.buffer, data.byteOffset + offset, 64);
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(index * 4);
    }
    for (let index = 16; index < 64; index += 1) {
      const w15 = words[index - 15] as number;
      const w2 = words[index - 2] as number;
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
      words[index] = ((words[index - 16] as number) + s0 + (words[index - 7] as number) + s1) | 0;
    }
    const state = this.state;
    let [a, b, c, d, e, f, g, h] = Array.from(state) as [
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    for (let index = 0; index < 64; index += 1) {
      const temp1 =
        (h +
          (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) +
          ((e & f) ^ (~e & g)) +
          (K[index] as number) +
          (words[index] as number)) |
        0;
      const temp2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) | 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) | 0;
    }
    state[0] = ((state[0] as number) + a) | 0;
    state[1] = ((state[1] as number) + b) | 0;
    state[2] = ((state[2] as number) + c) | 0;
    state[3] = ((state[3] as number) + d) | 0;
    state[4] = ((state[4] as number) + e) | 0;
    state[5] = ((state[5] as number) + f) | 0;
    state[6] = ((state[6] as number) + g) | 0;
    state[7] = ((state[7] as number) + h) | 0;
  }
}

export interface UploadProgress {
  /** hashing: the file is read once to compute its checksum; uploading: the parts go up. */
  phase: "hashing" | "uploading" | "checking";
  done: number;
  total: number;
}

/**
 * Upload a dump: its checksum first (read part by part), then the parts; a part whose answer
 * was lost is sent again (the updater answers with where the upload stands). Resolves with the
 * dump's name on the updater.
 */
export async function uploadDump(
  token: string,
  file: File,
  partBytes: number,
  onProgress: (progress: UploadProgress) => void,
  signal?: AbortSignal,
): Promise<DumpInfo> {
  const hash = new Sha256();
  for (let offset = 0; offset < file.size; offset += partBytes) {
    signal?.throwIfAborted();
    hash.update(new Uint8Array(await file.slice(offset, offset + partBytes).arrayBuffer()));
    onProgress({
      phase: "hashing",
      done: Math.min(file.size, offset + partBytes),
      total: file.size,
    });
  }
  const started = await apiFetch<UploadView>("/setup/restore/uploads", {
    method: "POST",
    body: { bytes: file.size, sha256: hash.hex() },
    tenantId: null,
    headers: headers(token),
    signal,
  });
  let received = started.received;
  let attempts = 0;
  while (received < file.size) {
    signal?.throwIfAborted();
    try {
      const view = await putPart(
        token,
        started.id,
        received,
        file.slice(received, received + partBytes),
      );
      received = view.received;
      attempts = 0;
      onProgress({ phase: "uploading", done: received, total: file.size });
    } catch (error) {
      attempts += 1;
      if (!(error instanceof NetworkError) || attempts > 5) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempts));
    }
  }
  onProgress({ phase: "checking", done: file.size, total: file.size });
  const completed = await apiFetch<{ dump: DumpInfo }>(
    `/setup/restore/uploads/${encodeURIComponent(started.id)}/complete`,
    { method: "POST", body: {}, tenantId: null, headers: headers(token), signal },
  );
  return completed.dump;
}
