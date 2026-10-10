import * as http from "node:http";
import type { Redactor } from "./redact.js";

/**
 * A small client for the Docker Engine API over its unix socket. It covers exactly
 * what the helper runner and the self-inspection need: ping, inspect a container or
 * an image, pull an image, create/start/wait/kill/remove a container, read its log
 * and list containers by label. Requests use the unversioned API path, so the
 * daemon answers in its own current version.
 */

export class EngineApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = "EngineApiError";
  }
}

export interface EngineClientOptions {
  socketPath: string;
  redactor: Redactor;
  /** Timeout for requests that answer at once (default 30 s). */
  requestTimeoutMs?: number;
}

export interface ContainerMount {
  Type: string;
  Name?: string;
  Source: string;
  Destination: string;
  RW?: boolean;
}

export interface ContainerInspect {
  Id: string;
  Name?: string;
  /** The id (`sha256:...`) of the image the container was created from. */
  Image?: string;
  Config?: { Labels?: Record<string, string> | null; Env?: string[] | null; Image?: string };
  Mounts?: ContainerMount[];
  State?: { Status?: string; Running?: boolean; ExitCode?: number };
}

export interface CreateContainerBody {
  Image: string;
  Entrypoint: string[];
  Cmd: string[];
  WorkingDir?: string;
  Env?: string[];
  Labels?: Record<string, string>;
  NetworkDisabled?: boolean;
  HostConfig: {
    Binds: string[];
    NetworkMode?: string;
    AutoRemove?: boolean;
    SecurityOpt?: string[];
    Privileged?: boolean;
    /** The mounter's runner containers (docs/FILESHARES.md 3.4). */
    CapDrop?: string[];
    CapAdd?: string[];
    ReadonlyRootfs?: boolean;
    Tmpfs?: Record<string, string>;
    /** Bytes. */
    Memory?: number;
    MemorySwap?: number;
    PidsLimit?: number;
    LogConfig?: { Type: string; Config: Record<string, string> };
  };
}

/** One entry of `GET /containers/json`. */
export interface ContainerSummary {
  Id: string;
  Labels: Record<string, string>;
  /** `created`, `running`, `exited`, ... */
  State: string;
  /** The id of the image (`sha256:...`). */
  ImageID: string;
  /** Unix seconds. */
  Created: number;
}

export interface CreateVolumeBody {
  Name: string;
  Driver: string;
  DriverOpts?: Record<string, string>;
  Labels?: Record<string, string>;
}

export interface VolumeSummary {
  Name: string;
  Labels: Record<string, string> | null;
}

export interface LogLimits {
  /** Keep at most this many bytes of stdout (the beginning). */
  maxStdoutBytes: number;
  /** Keep the last this many bytes of stderr. */
  stderrTailBytes: number;
}

export interface ContainerLogs {
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
}

interface RawResponse {
  status: number;
  body: Buffer;
}

interface RequestOptions {
  query?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  signal?: AbortSignal;
  maxBodyBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BODY = 8 * 1024 * 1024;

/** Incremental decoder for the multiplexed stream the Engine API uses for container logs. */
export class LogDemuxer {
  private pending: Buffer = Buffer.alloc(0);

  constructor(private readonly onFrame: (stream: "stdout" | "stderr", data: Buffer) => void) {}

  push(chunk: Buffer): void {
    this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
    while (this.pending.length >= 8) {
      const type = this.pending[0];
      const size = this.pending.readUInt32BE(4);
      if (this.pending.length < 8 + size) {
        return;
      }
      const data = this.pending.subarray(8, 8 + size);
      if (type === 1) {
        this.onFrame("stdout", data);
      } else if (type === 2) {
        this.onFrame("stderr", data);
      }
      this.pending = this.pending.subarray(8 + size);
    }
  }
}

export class EngineClient {
  private readonly timeoutMs: number;

  constructor(private readonly options: EngineClientOptions) {
    this.timeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  get socketPath(): string {
    return this.options.socketPath;
  }

  // -- Low level ------------------------------------------------------------

  private open(
    method: string,
    path: string,
    options: RequestOptions,
    onResponse: (response: http.IncomingMessage) => void,
    onError: (error: Error) => void,
  ): http.ClientRequest {
    const query = options.query ? `?${new URLSearchParams(options.query).toString()}` : "";
    const payload = options.body === undefined ? null : Buffer.from(JSON.stringify(options.body));
    const headers: Record<string, string | number> = { Host: "docker" };
    if (payload) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = payload.length;
    }
    const request = http.request(
      { socketPath: this.options.socketPath, method, path: `${path}${query}`, headers },
      onResponse,
    );
    const timeout = options.timeoutMs ?? this.timeoutMs;
    if (timeout > 0) {
      request.setTimeout(timeout, () =>
        request.destroy(new Error("Docker Engine request timed out")),
      );
    }
    request.on("error", onError);
    options.signal?.addEventListener("abort", () => request.destroy(new Error("Aborted")), {
      once: true,
    });
    request.end(payload ?? undefined);
    return request;
  }

  private request(
    method: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<RawResponse> {
    const maxBody = options.maxBodyBytes ?? DEFAULT_MAX_BODY;
    return new Promise<RawResponse>((resolve, reject) => {
      this.open(
        method,
        path,
        options,
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size <= maxBody) {
              chunks.push(chunk);
            }
          });
          response.on("end", () =>
            resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks) }),
          );
          response.on("error", (error) => reject(this.wrap(error)));
        },
        (error) => reject(this.wrap(error)),
      );
    });
  }

  private wrap(error: Error): EngineApiError {
    return new EngineApiError(this.options.redactor.oneLine(error.message, 500), null);
  }

  private failure(response: RawResponse, action: string): EngineApiError {
    let message = response.body.toString("utf8");
    try {
      const parsed = JSON.parse(message) as { message?: unknown };
      if (typeof parsed.message === "string") {
        message = parsed.message;
      }
    } catch {
      // Not JSON: use the text.
    }
    return new EngineApiError(
      this.options.redactor.oneLine(`${action} failed (HTTP ${response.status}): ${message}`, 500),
      response.status,
    );
  }

  private json<T>(response: RawResponse, action: string): T {
    if (response.status < 200 || response.status >= 300) {
      throw this.failure(response, action);
    }
    return JSON.parse(response.body.toString("utf8")) as T;
  }

  // -- Operations -----------------------------------------------------------

  async ping(): Promise<void> {
    const response = await this.request("GET", "/_ping", { timeoutMs: 10_000 });
    if (response.status !== 200) {
      throw this.failure(response, "Docker ping");
    }
  }

  /** The container's details; null when there is none by that id or name. */
  async inspectContainer(idOrName: string): Promise<ContainerInspect | null> {
    const response = await this.request("GET", `/containers/${encodeURIComponent(idOrName)}/json`);
    if (response.status === 404) {
      return null;
    }
    return this.json<ContainerInspect>(response, "Inspecting a container");
  }

  async imageExists(reference: string): Promise<boolean> {
    const response = await this.request("GET", `/images/${encodeURI(reference)}/json`);
    if (response.status === 404) {
      return false;
    }
    if (response.status !== 200) {
      throw this.failure(response, "Inspecting an image");
    }
    return true;
  }

  /** The registry digests (`name@sha256:...`) a local image is known by; null when there is no such image. */
  async imageRepoDigests(reference: string): Promise<string[] | null> {
    const response = await this.request("GET", `/images/${encodeURI(reference)}/json`);
    if (response.status === 404) {
      return null;
    }
    const info = this.json<{ RepoDigests?: unknown }>(response, "Inspecting an image");
    return Array.isArray(info.RepoDigests)
      ? info.RepoDigests.filter((entry): entry is string => typeof entry === "string")
      : [];
  }

  /** Pull an image; resolves when the stream ends without an error message. */
  async pullImage(reference: string, timeoutMs = 10 * 60_000): Promise<void> {
    const { fromImage, tag } = splitReference(reference);
    const query: Record<string, string> = { fromImage };
    if (tag) {
      query.tag = tag;
    }
    await new Promise<void>((resolve, reject) => {
      this.open(
        "POST",
        "/images/create",
        { query, timeoutMs },
        (response) => {
          let buffer = "";
          let errorMessage: string | null = null;
          if ((response.statusCode ?? 0) >= 400) {
            const chunks: Buffer[] = [];
            response.on("data", (chunk: Buffer) => chunks.push(chunk));
            response.on("end", () =>
              reject(
                this.failure(
                  { status: response.statusCode ?? 0, body: Buffer.concat(chunks) },
                  "Pulling an image",
                ),
              ),
            );
            return;
          }
          const consume = (line: string): void => {
            if (!line.trim()) {
              return;
            }
            try {
              const parsed = JSON.parse(line) as {
                error?: string;
                errorDetail?: { message?: string };
              };
              const message = parsed.errorDetail?.message ?? parsed.error;
              if (message) {
                errorMessage = message;
              }
            } catch {
              // Progress text that is not JSON is ignored.
            }
          };
          response.on("data", (chunk: Buffer) => {
            buffer += chunk.toString("utf8");
            let newline = buffer.indexOf("\n");
            while (newline !== -1) {
              consume(buffer.slice(0, newline));
              buffer = buffer.slice(newline + 1);
              newline = buffer.indexOf("\n");
            }
          });
          response.on("end", () => {
            consume(buffer);
            if (errorMessage) {
              reject(
                new EngineApiError(
                  this.options.redactor.oneLine(`Pulling an image failed: ${errorMessage}`, 500),
                  null,
                ),
              );
            } else {
              resolve();
            }
          });
          response.on("error", (error) => reject(this.wrap(error)));
        },
        (error) => reject(this.wrap(error)),
      );
    });
  }

  async createContainer(body: CreateContainerBody, name: string): Promise<string> {
    const response = await this.request("POST", "/containers/create", { query: { name }, body });
    return this.json<{ Id: string }>(response, "Creating a container").Id;
  }

  async startContainer(id: string): Promise<void> {
    const response = await this.request("POST", `/containers/${id}/start`);
    if (response.status !== 204 && response.status !== 304) {
      throw this.failure(response, "Starting a container");
    }
  }

  /** Wait until the container has stopped; returns its exit code. */
  async waitContainer(id: string, signal?: AbortSignal): Promise<number> {
    const response = await this.request("POST", `/containers/${id}/wait`, {
      query: { condition: "not-running" },
      timeoutMs: 0,
      signal,
    });
    return this.json<{ StatusCode: number }>(response, "Waiting for a container").StatusCode;
  }

  async killContainer(id: string): Promise<void> {
    const response = await this.request("POST", `/containers/${id}/kill`);
    // 409: not running any more.
    if (response.status !== 204 && response.status !== 409 && response.status !== 404) {
      throw this.failure(response, "Stopping a container");
    }
  }

  async removeContainer(id: string): Promise<void> {
    const response = await this.request("DELETE", `/containers/${id}`, {
      query: { force: "1", v: "1" },
    });
    if (response.status !== 204 && response.status !== 404) {
      throw this.failure(response, "Removing a container");
    }
  }

  /** The container's output, decoded and capped. */
  async containerLogs(id: string, limits: LogLimits): Promise<ContainerLogs> {
    return await new Promise<ContainerLogs>((resolve, reject) => {
      this.open(
        "GET",
        `/containers/${id}/logs`,
        { query: { stdout: "1", stderr: "1" }, timeoutMs: 60_000 },
        (response) => {
          if ((response.statusCode ?? 0) !== 200) {
            const chunks: Buffer[] = [];
            response.on("data", (chunk: Buffer) => chunks.push(chunk));
            response.on("end", () =>
              reject(
                this.failure(
                  { status: response.statusCode ?? 0, body: Buffer.concat(chunks) },
                  "Reading container output",
                ),
              ),
            );
            return;
          }
          const stdout: Buffer[] = [];
          let stdoutBytes = 0;
          let stdoutTruncated = false;
          let stderr: Buffer = Buffer.alloc(0);
          const demuxer = new LogDemuxer((stream, data) => {
            if (stream === "stdout") {
              const room = limits.maxStdoutBytes - stdoutBytes;
              if (room <= 0) {
                stdoutTruncated = true;
              } else if (data.length > room) {
                stdoutTruncated = true;
                stdout.push(data.subarray(0, room));
                stdoutBytes += room;
              } else {
                stdout.push(data);
                stdoutBytes += data.length;
              }
            } else {
              stderr = Buffer.concat([stderr, data]);
              if (stderr.length > limits.stderrTailBytes * 2) {
                stderr = stderr.subarray(stderr.length - limits.stderrTailBytes);
              }
            }
          });
          response.on("data", (chunk: Buffer) => demuxer.push(chunk));
          response.on("end", () =>
            resolve({
              stdout: Buffer.concat(stdout).toString("utf8"),
              stderr: stderr
                .subarray(Math.max(0, stderr.length - limits.stderrTailBytes))
                .toString("utf8"),
              stdoutTruncated,
            }),
          );
          response.on("error", (error) => reject(this.wrap(error)));
        },
        (error) => reject(this.wrap(error)),
      );
    });
  }

  // -- Volumes (the mounter: NFS probe volumes and its managed volumes) -------

  /** Create a volume; returns its name. */
  async createVolume(spec: CreateVolumeBody): Promise<string> {
    const response = await this.request("POST", "/volumes/create", { body: spec });
    return this.json<{ Name: string }>(response, "Creating a volume").Name;
  }

  /** Remove a volume; a volume that does not exist counts as removed. Throws when it is in use. */
  async removeVolume(name: string): Promise<void> {
    const response = await this.request("DELETE", `/volumes/${encodeURIComponent(name)}`);
    if (response.status !== 204 && response.status !== 404) {
      throw this.failure(response, "Removing a volume");
    }
  }

  /** Volumes that carry every one of these labels (`key` or `key=value`). */
  async listVolumes(labels: readonly string[]): Promise<VolumeSummary[]> {
    const response = await this.request("GET", "/volumes", {
      query: { filters: JSON.stringify({ label: labels }) },
    });
    const body = this.json<{ Volumes?: VolumeSummary[] | null }>(response, "Listing volumes");
    return (body.Volumes ?? []).map((volume) => ({
      Name: volume.Name,
      Labels: volume.Labels ?? {},
    }));
  }

  /** Containers (running or not) that carry every one of these labels (`key` or `key=value`). */
  async listContainers(labels: readonly string[]): Promise<ContainerSummary[]> {
    const response = await this.request("GET", "/containers/json", {
      query: { all: "1", filters: JSON.stringify({ label: labels }) },
    });
    return this.json<Partial<ContainerSummary>[]>(response, "Listing containers").map((entry) => ({
      Id: entry.Id ?? "",
      Labels: entry.Labels ?? {},
      State: entry.State ?? "",
      ImageID: entry.ImageID ?? "",
      Created: entry.Created ?? 0,
    }));
  }

  /** Stop a container: SIGTERM, then SIGKILL after `timeoutSeconds`. A missing or stopped one counts as stopped. */
  async stopContainer(id: string, timeoutSeconds: number): Promise<void> {
    const response = await this.request("POST", `/containers/${id}/stop`, {
      query: { t: String(timeoutSeconds) },
      timeoutMs: (timeoutSeconds + 30) * 1000,
    });
    if (response.status !== 204 && response.status !== 304 && response.status !== 404) {
      throw this.failure(response, "Stopping a container");
    }
  }

  /** Whether a network of this name exists. */
  async networkExists(name: string): Promise<boolean> {
    const response = await this.request("GET", `/networks/${encodeURIComponent(name)}`);
    if (response.status === 404) {
      return false;
    }
    if (response.status !== 200) {
      throw this.failure(response, "Inspecting a network");
    }
    return true;
  }

  /** Ids of all containers (running or not) that carry a label. */
  async listContainersByLabel(label: string): Promise<string[]> {
    const response = await this.request("GET", "/containers/json", {
      query: { all: "1", filters: JSON.stringify({ label: [label] }) },
    });
    return this.json<{ Id: string }[]>(response, "Listing containers").map((entry) => entry.Id);
  }
}

/** `host:5000/org/name:tag` -> repository and tag; a digest reference has no tag part. */
export function splitReference(reference: string): { fromImage: string; tag: string | null } {
  if (reference.includes("@")) {
    return { fromImage: reference, tag: null };
  }
  const slash = reference.lastIndexOf("/");
  const colon = reference.lastIndexOf(":");
  if (colon > slash) {
    return { fromImage: reference.slice(0, colon), tag: reference.slice(colon + 1) };
  }
  return { fromImage: reference, tag: "latest" };
}
