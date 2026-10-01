import type {
  CreateUploadInput,
  ImportUploadDto,
  MailFileFormat,
  SegmentAck,
  UploadRefusal,
} from "../types";

/**
 * What the upload engine needs from a file. A browser `File` satisfies it; so
 * does a `Blob` with a name, which is what the tests use. The engine only ever
 * calls `slice`, one segment at a time: a whole file is never read.
 */
export interface UploadSource {
  readonly name: string;
  readonly size: number;
  slice(start?: number, end?: number): Blob;
}

/** The calls the engine makes against `/imports/uploads` (implemented in ../api.ts, mocked in tests). */
export interface UploadTransport {
  create(input: CreateUploadInput, signal: AbortSignal): Promise<ImportUploadDto>;
  get(uploadId: string, signal: AbortSignal): Promise<ImportUploadDto>;
  putSegment(
    uploadId: string,
    index: number,
    body: Blob,
    sha256: string | null,
    signal: AbortSignal,
  ): Promise<SegmentAck>;
  complete(uploadId: string, signal: AbortSignal): Promise<ImportUploadDto>;
  remove(uploadId: string): Promise<void>;
}

/** Why an upload stopped, as a stable code the UI maps to a translated sentence. */
export type UploadErrorCode =
  /** The server cannot be reached (after all retries). */
  | "network"
  /** The server answered with an error (after all retries). */
  | "server"
  /** The session ended; signing in again allows resuming. */
  | "unauthorized"
  | "forbidden"
  /** The file exceeds the server limit (413). */
  | "too_large"
  /** A zero-byte file. */
  | "empty"
  /** The upload no longer exists or expired on the server. */
  | "gone"
  /** The staging area of the organization is full (422 import-staging-full); freeing space helps. */
  | "staging_full"
  /** The upload is not accepting segments any more (409). */
  | "conflict"
  /** A segment kept arriving damaged. */
  | "corrupt"
  /** The server rejected the request as invalid (422). */
  | "invalid"
  /** The browser could not read the file from disk. */
  | "unreadable"
  | "unknown";

export type UploadStatus =
  | "queued"
  | "opening"
  | "uploading"
  | "completing"
  | "ready"
  | "refused"
  | "failed"
  | "cancelled";

export interface UploadItem {
  localId: string;
  name: string;
  size: number;
  status: UploadStatus;
  uploadId: string | null;
  segmentCount: number;
  segmentsDone: number;
  /** Bytes the server has acknowledged. */
  uploadedBytes: number;
  /** An earlier upload of this file was found on the server and continued. */
  resumed: boolean;
  detectedFormat: MailFileFormat | null;
  refusal: UploadRefusal | null;
  error: UploadErrorCode | null;
  /** The current wait before a segment is sent again. */
  retrying: { index: number; attempt: number; delayMs: number } | null;
}

/** Events the engine reports; the reducer in state.ts turns them into `UploadItem`s. */
export type UploadEvent =
  | { type: "opening"; localId: string }
  | {
      type: "started";
      localId: string;
      uploadId: string;
      segmentSize: number;
      segmentCount: number;
      /** Bytes already on the server when the upload was continued. */
      receivedBytes: number;
      receivedSegments: number;
      resumed: boolean;
    }
  | { type: "segment"; localId: string; index: number; bytes: number }
  | { type: "retrying"; localId: string; index: number; attempt: number; delayMs: number }
  | { type: "completing"; localId: string }
  | { type: "ready"; localId: string; upload: ImportUploadDto }
  | { type: "refused"; localId: string; upload: ImportUploadDto }
  | { type: "failed"; localId: string; code: UploadErrorCode }
  | { type: "cancelled"; localId: string };
