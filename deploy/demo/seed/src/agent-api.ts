import { ApiRequestError } from "./http-client.js";

/**
 * The client of the agent API (`/agent/v1`, docs/AGENT.md) for the demo's
 * simulated machines: JSON over HTTP, HTTP Basic `endpointId:agentSecret`
 * after the enrollment, the shapes of agent/internal/api/types.go. Inside the
 * demo's network the api is plain http, and every write carries the seed's
 * token for the demo guard.
 */

export interface EnrollRequest {
  token: string;
  hostname: string;
  os: string;
  arch: string;
  agentVersion: string;
  osVersion: string;
}

export interface AgentConfig {
  profile: "server" | "client";
  schedule: { kind: string; intervalMinutes?: number; timeOfDay?: string; timeZone?: string };
  paths: string[];
  excludes: string[];
  hooks: { pre?: string; post?: string };
  bandwidthKbps: number | null;
  onlyOnAcPower: boolean;
  useVss: boolean;
  configVersion: number | string;
}

export interface EnrollResponse {
  endpointId: string;
  agentSecret: string;
  repository: { url: string; password: string };
  config?: AgentConfig;
  restic?: { version: string };
}

export interface HeartbeatRequest {
  agentVersion: string;
  osVersion: string;
  state: "idle" | "running";
  nextRunAt: string | null;
  configVersion: number | string;
}

export interface AgentTask {
  id: string;
  kind: "backup_now" | "restore" | "verify_sample" | "update_config" | "uninstall";
  params?: Record<string, unknown>;
}

export interface SampleFile {
  path: string;
  sha256: string;
  size?: number;
}

export interface RunError {
  path?: string;
  message: string;
  code?: string;
}

export interface FinishRequest {
  status: "succeeded" | "partial" | "failed";
  finishedAt: string;
  snapshotId?: string;
  stats?: {
    filesNew: number;
    filesChanged: number;
    filesUnmodified: number;
    dataAdded: number;
    totalFilesProcessed: number;
    totalBytesProcessed: number;
  };
  sample?: SampleFile[];
  errors: RunError[];
  logTail: string;
}

export interface Credentials {
  endpointId: string;
  secret: string;
}

/** `Authorization` value of an agent: HTTP Basic with the endpoint id and its secret. */
export function basicAuthorization(credentials: Credentials): string {
  return `Basic ${Buffer.from(`${credentials.endpointId}:${credentials.secret}`).toString("base64")}`;
}

const RETRY_STATUSES = new Set([429, 502, 503, 504]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class AgentApi {
  constructor(
    private readonly baseUrl: string,
    private readonly seedToken: string,
    private credentials?: Credentials,
  ) {}

  /** The login every call after the enrollment uses. */
  setCredentials(credentials: Credentials): void {
    this.credentials = credentials;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      accept: "application/json",
      "x-restow-demo-seed-token": this.seedToken,
    };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
    }
    if (this.credentials) {
      headers.authorization = basicAuthorization(this.credentials);
    }
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      let parsed: unknown = null;
      if (text.length > 0) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text;
        }
      }
      if (response.status >= 400) {
        if (RETRY_STATUSES.has(response.status) && attempt < 5) {
          await sleep(2000 * (attempt + 1));
          continue;
        }
        throw new ApiRequestError(method, path, response.status, parsed);
      }
      return parsed as T;
    }
  }

  enroll(request: EnrollRequest): Promise<EnrollResponse> {
    return this.call("POST", "/agent/v1/enroll", request);
  }

  config(): Promise<AgentConfig> {
    return this.call("GET", "/agent/v1/config");
  }

  heartbeat(request: HeartbeatRequest): Promise<{ tasks: AgentTask[] }> {
    return this.call("POST", "/agent/v1/heartbeat", request);
  }

  async startRun(request: {
    kind: "backup" | "restore" | "verify_sample";
    taskId?: string;
    startedAt: string;
  }): Promise<string> {
    const answer = await this.call<{ runId: string }>("POST", "/agent/v1/runs", request);
    return String(answer.runId);
  }

  async finishRun(runId: string, request: FinishRequest): Promise<void> {
    await this.call("POST", `/agent/v1/runs/${runId}/finish`, request);
  }
}
