/**
 * Resumable upload sessions, shared by OneDrive file restores and Outlook
 * attachment restores. Fragments are PUT to the pre-authenticated `uploadUrl`
 * with a `Content-Range`; the session answers 202 with the next expected range
 * until the last fragment, which returns the created item (200/201).
 *
 * Fragment sizes must be multiples of 320 KiB. OneDrive accepts 5–60 MiB per
 * fragment (docs/MICROSOFT.md), Outlook attachments at most 4 MiB.
 */
import type { Readable } from "node:stream";
import type { GraphClient, GraphRequest } from "../client.js";
import { GraphError } from "../errors.js";
import { bodyOrThrow } from "./common.js";

/** Every fragment length must be a multiple of this. */
export const UPLOAD_FRAGMENT_UNIT = 320 * 1024;
export const DRIVE_MIN_FRAGMENT_BYTES = 5 * 1024 * 1024;
export const DRIVE_MAX_FRAGMENT_BYTES = 60 * 1024 * 1024;
export const DRIVE_DEFAULT_FRAGMENT_BYTES = 10 * 1024 * 1024;
/** Outlook allows up to 4 MiB per fragment; 12 units is the largest multiple below that. */
export const OUTLOOK_MAX_FRAGMENT_BYTES = 12 * UPLOAD_FRAGMENT_UNIT;

export interface FragmentBounds {
  min: number;
  max: number;
}

export const DRIVE_FRAGMENT_BOUNDS: FragmentBounds = {
  min: DRIVE_MIN_FRAGMENT_BYTES,
  max: DRIVE_MAX_FRAGMENT_BYTES,
};

export const OUTLOOK_FRAGMENT_BOUNDS: FragmentBounds = {
  min: UPLOAD_FRAGMENT_UNIT,
  max: OUTLOOK_MAX_FRAGMENT_BYTES,
};

/** Clamp a requested fragment size into bounds and round it down to a whole unit. */
export function normalizeFragmentSize(requested: number, bounds: FragmentBounds): number {
  const clamped = Math.min(bounds.max, Math.max(bounds.min, Math.floor(requested)));
  const units = Math.max(1, Math.floor(clamped / UPLOAD_FRAGMENT_UNIT));
  return units * UPLOAD_FRAGMENT_UNIT;
}

/** What Graph returns from createUploadSession (both OneDrive and Outlook). */
export interface UploadSessionInfo {
  uploadUrl: string;
  expirationDateTime?: string | null;
  nextExpectedRanges?: string[] | null;
}

/** Reads `length` bytes at `offset`; lets the upload resume after a range mismatch. */
export type RangeReader = (offset: number, length: number) => Promise<Buffer>;

export type UploadSource = Buffer | Readable | RangeReader;

export interface UploadOptions {
  fragmentSize?: number;
  bounds?: FragmentBounds;
  onProgress?: (progress: { uploadedBytes: number; totalBytes: number }) => void;
}

export interface UploadOutcome<TResult> {
  status: number;
  headers: Record<string, string>;
  /** The created resource (DriveItem for OneDrive; empty for Outlook, see `location`). */
  result: TResult | undefined;
  /** Outlook answers the final fragment with 201 and the attachment URL in Location. */
  location: string | undefined;
  uploadedBytes: number;
  fragments: number;
}

export class UploadSessionError extends Error {
  constructor(
    message: string,
    readonly details: { status?: number; nextExpectedRanges?: string[] },
  ) {
    super(message);
    this.name = "UploadSessionError";
  }
}

/** Parse Graph's `nextExpectedRanges` ("0-", "5242880-10485759") into the next start offset. */
export function nextExpectedOffset(ranges: readonly string[] | null | undefined): number | null {
  const first = ranges?.[0];
  if (!first) {
    return null;
  }
  const start = Number.parseInt(first.split("-")[0] ?? "", 10);
  return Number.isFinite(start) ? start : null;
}

/** Yield fragments of exactly `size` bytes (the last may be shorter) from a readable. */
export async function* readFragments(
  readable: Readable,
  size: number,
): AsyncGenerator<Buffer, void, unknown> {
  let pending: Buffer[] = [];
  let pendingLength = 0;
  for await (const chunk of readable) {
    let buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    while (pendingLength + buffer.length >= size) {
      const take = size - pendingLength;
      pending.push(buffer.subarray(0, take));
      yield Buffer.concat(pending, size);
      pending = [];
      pendingLength = 0;
      buffer = buffer.subarray(take);
    }
    if (buffer.length > 0) {
      pending.push(buffer);
      pendingLength += buffer.length;
    }
  }
  if (pendingLength > 0) {
    yield Buffer.concat(pending, pendingLength);
  }
}

function toRangeReader(source: UploadSource): RangeReader | null {
  if (typeof source === "function") {
    return source;
  }
  if (Buffer.isBuffer(source)) {
    return async (offset, length) => source.subarray(offset, offset + length);
  }
  return null;
}

/**
 * Upload `totalBytes` from `source` to an existing session. With a buffer or a
 * range reader the upload resumes from whatever the session reports as missing;
 * with a plain readable it can only proceed sequentially and fails on a mismatch.
 */
export async function uploadToSession<TResult = unknown>(
  client: GraphClient,
  session: UploadSessionInfo,
  source: UploadSource,
  totalBytes: number,
  options: UploadOptions = {},
): Promise<UploadOutcome<TResult>> {
  const bounds = options.bounds ?? DRIVE_FRAGMENT_BOUNDS;
  const fragmentSize = normalizeFragmentSize(options.fragmentSize ?? bounds.max, bounds);
  const startOffset = nextExpectedOffset(session.nextExpectedRanges) ?? 0;

  if (totalBytes === 0) {
    // An empty file is a single PUT with an empty body and `Content-Range: bytes */0`.
    const outcome = await putFragment<TResult>(
      client,
      session.uploadUrl,
      Buffer.alloc(0),
      "bytes */0",
    );
    options.onProgress?.({ uploadedBytes: 0, totalBytes: 0 });
    return { ...outcome, uploadedBytes: 0, fragments: 1 };
  }

  const reader = toRangeReader(source);
  const state = { offset: startOffset, fragments: 0 };
  const putAt = async (fragment: Buffer): Promise<UploadOutcome<TResult> | number> => {
    const end = state.offset + fragment.length - 1;
    const outcome = await putFragment<TResult>(
      client,
      session.uploadUrl,
      fragment,
      `bytes ${state.offset}-${end}/${totalBytes}`,
    );
    state.fragments += 1;
    if (!outcome.pending) {
      options.onProgress?.({ uploadedBytes: totalBytes, totalBytes });
      return { ...outcome, uploadedBytes: totalBytes, fragments: state.fragments };
    }
    const next = nextExpectedOffset(outcome.nextExpectedRanges) ?? end + 1;
    options.onProgress?.({ uploadedBytes: Math.min(next, totalBytes), totalBytes });
    return next;
  };

  if (reader) {
    while (state.offset < totalBytes) {
      const length = Math.min(fragmentSize, totalBytes - state.offset);
      const fragment = await reader(state.offset, length);
      if (fragment.length !== length) {
        throw new UploadSessionError(
          `Range reader returned ${fragment.length} bytes at ${state.offset}, expected ${length}`,
          {},
        );
      }
      const result = await putAt(fragment);
      if (typeof result !== "number") {
        return result;
      }
      state.offset = result;
    }
    throw new UploadSessionError("Upload session did not complete after the last fragment", {
      nextExpectedRanges: [`${state.offset}-`],
    });
  }

  if (startOffset % fragmentSize !== 0) {
    throw new UploadSessionError(
      `Cannot resume a sequential source at offset ${startOffset} with fragments of ${fragmentSize}`,
      { nextExpectedRanges: session.nextExpectedRanges ?? undefined },
    );
  }
  let skip = startOffset / fragmentSize;
  for await (const fragment of readFragments(source as Readable, fragmentSize)) {
    if (skip > 0) {
      skip -= 1;
      continue;
    }
    const result = await putAt(fragment);
    if (typeof result !== "number") {
      return result;
    }
    if (result !== state.offset + fragment.length) {
      throw new UploadSessionError(
        `Upload session expects offset ${result} but the source is sequential`,
        { status: 202, nextExpectedRanges: [`${result}-`] },
      );
    }
    state.offset = result;
  }
  throw new UploadSessionError("Source ended before the upload session was complete", {
    nextExpectedRanges: [`${state.offset}-`],
  });
}

interface FragmentOutcome<TResult> {
  status: number;
  headers: Record<string, string>;
  result: TResult | undefined;
  location: string | undefined;
  /** True while the session still expects more fragments. */
  pending: boolean;
  nextExpectedRanges: string[] | undefined;
}

/**
 * OneDrive answers an intermediate fragment with 202, Outlook with 200; both carry
 * `nextExpectedRanges`. The final fragment returns the item (OneDrive 200/201 with
 * a DriveItem body) or 201 with a Location header (Outlook) and no ranges.
 */
function isPendingFragment(status: number, body: unknown): boolean {
  if (status === 202) {
    return true;
  }
  return (
    status === 200 &&
    typeof body === "object" &&
    body !== null &&
    Array.isArray((body as Partial<UploadSessionInfo>).nextExpectedRanges)
  );
}

async function putFragment<TResult>(
  client: GraphClient,
  uploadUrl: string,
  fragment: Buffer,
  contentRange: string,
): Promise<FragmentOutcome<TResult>> {
  const req: GraphRequest = {
    method: "PUT",
    url: uploadUrl,
    auth: false,
    headers: {
      "Content-Length": String(fragment.length),
      "Content-Range": contentRange,
      "Content-Type": "application/octet-stream",
    },
    rawBody: fragment,
  };
  const response = await client.request<UploadSessionInfo | TResult | undefined>(req);
  if (response.status === 404) {
    throw new UploadSessionError("Upload session expired or was cancelled", { status: 404 });
  }
  if (response.status === 416) {
    const status = await getUploadSessionStatus(client, uploadUrl);
    throw new UploadSessionError("Upload fragment was outside the expected range", {
      status: 416,
      nextExpectedRanges: status.nextExpectedRanges ?? undefined,
    });
  }
  const body = bodyOrThrow(response, req);
  const pending = isPendingFragment(response.status, body);
  const asSession = (body ?? {}) as Partial<UploadSessionInfo>;
  return {
    status: response.status,
    headers: response.headers,
    result: pending ? undefined : (body as TResult | undefined),
    location: response.headers.location,
    pending,
    nextExpectedRanges: pending ? (asSession.nextExpectedRanges ?? undefined) : undefined,
  };
}

/** Ask the session which ranges are still missing. */
export async function getUploadSessionStatus(
  client: GraphClient,
  uploadUrl: string,
): Promise<UploadSessionInfo> {
  const req: GraphRequest = { method: "GET", url: uploadUrl, auth: false };
  const response = await client.request<UploadSessionInfo>(req);
  const body = bodyOrThrow(response, req);
  return { ...body, uploadUrl };
}

/** Abandon a session so partial data does not linger on the server. */
export async function cancelUploadSession(client: GraphClient, uploadUrl: string): Promise<void> {
  const req: GraphRequest = { method: "DELETE", url: uploadUrl, auth: false };
  const response = await client.request(req);
  if (response.status !== 204 && response.status !== 404) {
    throw new GraphError({
      status: response.status,
      method: "DELETE",
      url: uploadUrl,
      headers: response.headers,
      payload: response.body,
    });
  }
}
