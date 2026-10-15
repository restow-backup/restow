/**
 * An in-memory S3 bucket with versioning and strict Object Lock semantics, for
 * tests of immutable backups (storage/immutability.ts) when no real S3 with
 * Object Lock is at hand. It follows the AWS rules the code relies on:
 *
 *   - every write is a new version; a DeleteObject without a version id only
 *     stacks a delete marker on top (nothing is freed, nothing is lost);
 *   - a version under COMPLIANCE retention cannot be deleted before its date,
 *     by anyone; under GOVERNANCE only with the bypass header;
 *   - a COMPLIANCE retention can be extended, never shortened or turned into
 *     GOVERNANCE; a GOVERNANCE one only shortened with the bypass header;
 *   - a write with Object Lock parameters needs Content-MD5 (or a checksum);
 *   - a bucket without Object Lock refuses Object Lock parameters.
 *
 * Commands are told apart by class name, so it serves an S3Client's `send`.
 */
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import type { S3Client } from "@aws-sdk/client-s3";

interface Version {
  readonly versionId: string;
  readonly marker: boolean;
  readonly body: Buffer;
  readonly lastModified: Date;
  mode: "GOVERNANCE" | "COMPLIANCE" | null;
  retainUntil: Date | null;
}

interface Upload {
  readonly key: string;
  readonly mode: "GOVERNANCE" | "COMPLIANCE" | null;
  readonly retainUntil: Date | null;
  readonly parts: Map<number, Buffer>;
}

/** Error shaped like the SDK's service exceptions. */
function s3Error(name: string, status: number, message = name): Error {
  return Object.assign(new Error(message), {
    name,
    Code: name,
    $metadata: { httpStatusCode: status },
  });
}

export interface FakeObjectLockS3Options {
  readonly objectLock?: boolean;
  /** Bucket default retention, applied to writes without explicit parameters. */
  readonly defaultRetention?: { mode: "GOVERNANCE" | "COMPLIANCE"; days: number };
  readonly now?: () => Date;
}

export class FakeObjectLockS3 {
  readonly objects = new Map<string, Version[]>();
  readonly calls: { command: string; input: Record<string, unknown> }[] = [];
  private readonly uploads = new Map<string, Upload>();
  private counter = 0;
  now: () => Date;
  readonly objectLock: boolean;
  readonly defaultRetention: FakeObjectLockS3Options["defaultRetention"];
  /** Simulate a storage that drops the Object Lock headers (verification must notice). */
  ignoreLockHeaders = false;

  readonly config = { requestChecksumCalculation: async () => "WHEN_REQUIRED" as const };

  constructor(options: FakeObjectLockS3Options = {}) {
    this.objectLock = options.objectLock ?? true;
    this.defaultRetention = options.defaultRetention;
    this.now = options.now ?? (() => new Date());
  }

  /** This fake as the S3Client the backend expects. */
  asClient(): S3Client {
    return this as unknown as S3Client;
  }

  private nextVersionId(): string {
    this.counter += 1;
    return `v${String(this.counter).padStart(6, "0")}`;
  }

  private current(key: string): Version | null {
    const versions = this.objects.get(key);
    const latest = versions?.[versions.length - 1];
    return latest && !latest.marker ? latest : null;
  }

  private version(key: string, versionId: string | undefined): Version | null {
    if (!versionId) {
      return this.current(key);
    }
    return this.objects.get(key)?.find((version) => version.versionId === versionId) ?? null;
  }

  private locked(version: Version, bypass: boolean): boolean {
    if (!version.retainUntil || version.retainUntil.getTime() <= this.now().getTime()) {
      return false;
    }
    return version.mode === "COMPLIANCE" || !bypass;
  }

  private store(
    key: string,
    body: Buffer,
    mode: "GOVERNANCE" | "COMPLIANCE" | null,
    retainUntil: Date | null,
  ): string {
    let lockMode = this.ignoreLockHeaders ? null : mode;
    let until = this.ignoreLockHeaders ? null : retainUntil;
    if (!until && this.defaultRetention && this.objectLock) {
      lockMode = this.defaultRetention.mode;
      until = new Date(this.now().getTime() + this.defaultRetention.days * 86_400_000);
    }
    const versionId = this.nextVersionId();
    const versions = this.objects.get(key) ?? [];
    versions.push({
      versionId,
      marker: false,
      body,
      lastModified: this.now(),
      mode: until ? lockMode : null,
      retainUntil: until,
    });
    this.objects.set(key, versions);
    return versionId;
  }

  private checkLockParameters(input: Record<string, unknown>, integrity: boolean): void {
    if (input.ObjectLockRetainUntilDate === undefined && input.ObjectLockMode === undefined) {
      return;
    }
    if (!this.objectLock) {
      throw s3Error("InvalidRequest", 400, "Bucket is missing Object Lock Configuration");
    }
    if (!(input.ObjectLockRetainUntilDate instanceof Date) || !input.ObjectLockMode) {
      throw s3Error("InvalidArgument", 400, "both mode and retain-until date are required");
    }
    if (!integrity) {
      throw s3Error(
        "InvalidRequest",
        400,
        "Content-MD5 OR x-amz-checksum- HTTP header is required for Put Object requests with Object Lock parameters",
      );
    }
  }

  async send(command: { constructor: { name: string }; input: unknown }): Promise<unknown> {
    const name = command.constructor.name;
    const input = (command.input ?? {}) as Record<string, unknown>;
    this.calls.push({ command: name, input });
    const key = typeof input.Key === "string" ? input.Key : "";
    switch (name) {
      case "PutObjectCommand": {
        this.checkLockParameters(input, !!input.ContentMD5 || !!input.ChecksumAlgorithm);
        const body = Buffer.isBuffer(input.Body)
          ? input.Body
          : Buffer.from((input.Body as Uint8Array | string | undefined) ?? "");
        if (typeof input.ContentMD5 === "string") {
          const md5 = createHash("md5").update(body).digest("base64");
          if (md5 !== input.ContentMD5) {
            throw s3Error("BadDigest", 400);
          }
        }
        const versionId = this.store(
          key,
          body,
          (input.ObjectLockMode as Version["mode"]) ?? null,
          (input.ObjectLockRetainUntilDate as Date | undefined) ?? null,
        );
        return { VersionId: versionId };
      }
      case "CreateMultipartUploadCommand": {
        this.checkLockParameters(input, true);
        const uploadId = `upload-${this.nextVersionId()}`;
        this.uploads.set(uploadId, {
          key,
          mode: (input.ObjectLockMode as Version["mode"]) ?? null,
          retainUntil: (input.ObjectLockRetainUntilDate as Date | undefined) ?? null,
          parts: new Map(),
        });
        return { UploadId: uploadId };
      }
      case "UploadPartCommand": {
        const upload = this.uploads.get(input.UploadId as string);
        if (!upload) {
          throw s3Error("NoSuchUpload", 404);
        }
        if (upload.retainUntil && !input.ContentMD5 && !input.ChecksumAlgorithm) {
          throw s3Error("InvalidRequest", 400, "Content-MD5 required for a part under Object Lock");
        }
        upload.parts.set(input.PartNumber as number, Buffer.from(input.Body as Buffer));
        return { ETag: `"part-${String(input.PartNumber)}"` };
      }
      case "CompleteMultipartUploadCommand": {
        const upload = this.uploads.get(input.UploadId as string);
        if (!upload) {
          throw s3Error("NoSuchUpload", 404);
        }
        this.uploads.delete(input.UploadId as string);
        const body = Buffer.concat(
          [...upload.parts.entries()].sort(([a], [b]) => a - b).map(([, part]) => part),
        );
        return { VersionId: this.store(upload.key, body, upload.mode, upload.retainUntil) };
      }
      case "AbortMultipartUploadCommand": {
        this.uploads.delete(input.UploadId as string);
        return {};
      }
      case "HeadObjectCommand": {
        const version = this.version(key, input.VersionId as string | undefined);
        if (!version || version.marker) {
          throw s3Error("NotFound", 404);
        }
        return {
          ContentLength: version.body.length,
          ETag: `"${createHash("md5").update(version.body).digest("hex")}"`,
          LastModified: version.lastModified,
          ...(version.retainUntil
            ? { ObjectLockMode: version.mode, ObjectLockRetainUntilDate: version.retainUntil }
            : {}),
          VersionId: version.versionId,
        };
      }
      case "GetObjectCommand": {
        const version = this.version(key, input.VersionId as string | undefined);
        if (!version || version.marker) {
          throw s3Error("NoSuchKey", 404);
        }
        let bytes = version.body;
        const range =
          typeof input.Range === "string" ? /^bytes=(\d+)-(\d+)$/.exec(input.Range) : null;
        if (range) {
          bytes = bytes.subarray(Number(range[1]), Number(range[2]) + 1);
        }
        const body = Readable.from([bytes]) as Readable & {
          transformToByteArray(): Promise<Uint8Array>;
        };
        body.transformToByteArray = async () => new Uint8Array(bytes);
        return { Body: body, ContentLength: bytes.length };
      }
      case "ListObjectsV2Command": {
        const prefix = (input.Prefix as string | undefined) ?? "";
        const contents = [...this.objects.keys()]
          .filter((name) => name.startsWith(prefix) && this.current(name))
          .sort()
          .map((name) => ({ Key: name, Size: (this.current(name) as Version).body.length }));
        return { Contents: contents, IsTruncated: false };
      }
      case "ListObjectVersionsCommand": {
        const prefix = (input.Prefix as string | undefined) ?? "";
        const versions: Record<string, unknown>[] = [];
        const markers: Record<string, unknown>[] = [];
        for (const [name, list] of [...this.objects.entries()].sort(([a], [b]) =>
          a < b ? -1 : 1,
        )) {
          if (!name.startsWith(prefix)) {
            continue;
          }
          for (const version of list) {
            (version.marker ? markers : versions).push({
              Key: name,
              VersionId: version.versionId,
            });
          }
        }
        return { Versions: versions, DeleteMarkers: markers, IsTruncated: false };
      }
      case "DeleteObjectCommand": {
        const list = this.objects.get(key);
        if (!input.VersionId) {
          if (list) {
            list.push({
              versionId: this.nextVersionId(),
              marker: true,
              body: Buffer.alloc(0),
              lastModified: this.now(),
              mode: null,
              retainUntil: null,
            });
          }
          return { DeleteMarker: true };
        }
        const version = this.version(key, input.VersionId as string);
        if (!version || !list) {
          return {};
        }
        if (this.locked(version, input.BypassGovernanceRetention === true)) {
          throw s3Error(
            "AccessDenied",
            403,
            "Access Denied because object protected by object lock.",
          );
        }
        list.splice(list.indexOf(version), 1);
        if (list.length === 0) {
          this.objects.delete(key);
        }
        return {};
      }
      case "PutObjectRetentionCommand": {
        if (!this.objectLock) {
          throw s3Error("InvalidRequest", 400, "Bucket is missing Object Lock Configuration");
        }
        const version = this.version(key, input.VersionId as string | undefined);
        if (!version) {
          throw s3Error("NoSuchKey", 404);
        }
        const retention = input.Retention as { Mode: Version["mode"]; RetainUntilDate: Date };
        const active =
          version.retainUntil !== null && version.retainUntil.getTime() > this.now().getTime();
        if (active && version.mode === "COMPLIANCE") {
          if (
            retention.Mode !== "COMPLIANCE" ||
            retention.RetainUntilDate.getTime() < (version.retainUntil as Date).getTime()
          ) {
            throw s3Error("AccessDenied", 403, "a COMPLIANCE retention cannot be shortened");
          }
        }
        if (
          active &&
          version.mode === "GOVERNANCE" &&
          retention.RetainUntilDate.getTime() < (version.retainUntil as Date).getTime() &&
          input.BypassGovernanceRetention !== true
        ) {
          throw s3Error("AccessDenied", 403, "shortening GOVERNANCE needs the bypass permission");
        }
        version.mode = retention.Mode;
        version.retainUntil = retention.RetainUntilDate;
        return {};
      }
      case "GetObjectLockConfigurationCommand": {
        if (!this.objectLock) {
          throw s3Error("ObjectLockConfigurationNotFoundError", 404);
        }
        return {
          ObjectLockConfiguration: {
            ObjectLockEnabled: "Enabled",
            ...(this.defaultRetention
              ? {
                  Rule: {
                    DefaultRetention: {
                      Mode: this.defaultRetention.mode,
                      Days: this.defaultRetention.days,
                    },
                  },
                }
              : {}),
          },
        };
      }
      default:
        throw new Error(`the fake S3 does not implement ${name}`);
    }
  }
}
