import type { FsEntry } from "./source.js";

/**
 * The messages between the API and the sandboxed reader (sandbox.ts, sandbox-child.ts). The
 * child holds no secret and reaches no storage: it asks its parent for the bytes of a disk
 * (`read`), and the parent answers from the restore point's block map.
 */

export interface VolumeInfo {
  id: string;
  fsType: string;
  label: string | null;
  size: number;
  note: string | null;
}

export type ParentMessage =
  | { t: "init"; disks: { device: string; size: number }[] }
  | { t: "data"; id: number; data?: Buffer; error?: string }
  | { t: "op"; id: number; op: "volumes" }
  | { t: "op"; id: number; op: "list"; path: string }
  | { t: "op"; id: number; op: "stat"; path: string }
  | { t: "op"; id: number; op: "open"; path: string }
  | { t: "op"; id: number; op: "read"; path: string; offset: number; length: number };

export type ChildMessage =
  | { t: "ready" }
  | { t: "read"; id: number; disk: number; offset: number; length: number }
  | {
      t: "result";
      id: number;
      ok: true;
      value:
        | { volumes: VolumeInfo[]; skipped: { id: string; reason: string }[] }
        | FsEntry[]
        | FsEntry
        | null
        | { size: number }
        | Buffer;
    }
  | { t: "result"; id: number; ok: false; code: string; message: string };
