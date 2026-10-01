import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

/**
 * A fake Docker Engine API on a unix socket, for testing the Engine client and the
 * helper runner: it records what it is asked and answers with scripted results.
 */

export interface RecordedRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
}

export interface FakeContainerSpec {
  /** Exit code the helper "command" ends with. */
  exitCode: number;
  stdout?: Buffer[];
  stderr?: Buffer[];
  /** The container never exits on its own (timeout tests). */
  hang?: boolean;
}

export class FakeEngineApi {
  readonly requests: RecordedRequest[] = [];
  readonly created = new Map<string, unknown>();
  readonly removed: string[] = [];
  readonly killed: string[] = [];
  socketPath = "";
  private server: http.Server | null = null;
  private dir = "";
  private nextId = 1;

  /** Answer for the next helper container that is created. */
  nextContainer: FakeContainerSpec = { exitCode: 0 };
  private readonly containerSpecs = new Map<string, FakeContainerSpec>();

  pingStatus = 200;
  images = new Set<string>();
  pullError: string | null = null;
  createStatus = 201;
  startStatus = 204;
  self: unknown = null;
  /** Ids returned by the label listing. */
  labelled: string[] = [];
  private readonly waiters = new Map<string, () => void>();

  async start(): Promise<void> {
    this.dir = await fs.mkdtemp(path.join(os.tmpdir(), "osu-"));
    this.socketPath = path.join(this.dir, "e.sock");
    this.server = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const url = new URL(request.url ?? "/", "http://docker");
        const raw = Buffer.concat(chunks).toString("utf8");
        let body: unknown = null;
        try {
          body = raw ? JSON.parse(raw) : null;
        } catch {
          body = raw;
        }
        const recorded: RecordedRequest = {
          method: request.method ?? "GET",
          path: url.pathname,
          query: url.searchParams,
          body,
        };
        this.requests.push(recorded);
        this.handle(recorded, response);
      });
    });
    await new Promise<void>((resolve) => this.server?.listen(this.socketPath, resolve));
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
    await fs.rm(this.dir, { recursive: true, force: true });
  }

  callsTo(method: string, pathPrefix: string): RecordedRequest[] {
    return this.requests.filter(
      (request) => request.method === method && request.path.startsWith(pathPrefix),
    );
  }

  /** One multiplexed log frame. */
  static frame(stream: 0 | 1 | 2, data: string | Buffer): Buffer {
    const payload = typeof data === "string" ? Buffer.from(data) : data;
    const header = Buffer.alloc(8);
    header[0] = stream;
    header.writeUInt32BE(payload.length, 4);
    return Buffer.concat([header, payload]);
  }

  private json(response: http.ServerResponse, status: number, body: unknown): void {
    response.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
  }

  private handle(request: RecordedRequest, response: http.ServerResponse): void {
    const { method, path: route } = request;
    if (method === "GET" && route === "/_ping") {
      response.writeHead(this.pingStatus).end(this.pingStatus === 200 ? "OK" : "nope");
      return;
    }
    if (method === "GET" && route === "/containers/json") {
      this.json(
        response,
        200,
        this.labelled.map((Id) => ({ Id })),
      );
      return;
    }
    const containerMatch = /^\/containers\/([^/]+)\/(json|start|wait|logs|kill)$/.exec(route);
    if (method === "GET" && containerMatch?.[2] === "json") {
      const id = decodeURIComponent(containerMatch[1] as string);
      if (this.self && (id === "self-host" || id === (this.self as { Id: string }).Id)) {
        this.json(response, 200, this.self);
      } else {
        this.json(response, 404, { message: `No such container: ${id}` });
      }
      return;
    }
    if (method === "GET" && route.startsWith("/images/") && route.endsWith("/json")) {
      const name = decodeURIComponent(route.slice("/images/".length, -"/json".length));
      if (this.images.has(name)) {
        this.json(response, 200, { Id: "sha256:abc" });
      } else {
        this.json(response, 404, { message: `No such image: ${name}` });
      }
      return;
    }
    if (method === "POST" && route === "/images/create") {
      const image = `${request.query.get("fromImage")}:${request.query.get("tag")}`;
      response.writeHead(200, { "Content-Type": "application/json" });
      response.write(`${JSON.stringify({ status: "Pulling from library/docker" })}\n`);
      if (this.pullError) {
        response.end(
          `${JSON.stringify({ errorDetail: { message: this.pullError }, error: this.pullError })}\n`,
        );
      } else {
        this.images.add(image);
        response.end(`${JSON.stringify({ status: "Status: Downloaded newer image" })}\n`);
      }
      return;
    }
    if (method === "POST" && route === "/containers/create") {
      if (this.createStatus !== 201) {
        this.json(response, this.createStatus, { message: "create refused" });
        return;
      }
      const id = `helper${this.nextId++}`.padEnd(16, "0");
      this.created.set(id, request.body);
      this.containerSpecs.set(id, this.nextContainer);
      this.nextContainer = { exitCode: 0 };
      this.json(response, 201, { Id: id });
      return;
    }
    if (containerMatch) {
      const id = containerMatch[1] as string;
      const spec = this.containerSpecs.get(id);
      switch (`${method} ${containerMatch[2]}`) {
        case "POST start":
          if (this.startStatus !== 204) {
            this.json(response, this.startStatus, { message: "start refused" });
          } else {
            response.writeHead(204).end();
          }
          return;
        case "POST wait":
          if (spec?.hang) {
            this.waiters.set(id, () => this.json(response, 200, { StatusCode: 137 }));
            request.query.get("condition");
            response.on("close", () => this.waiters.delete(id));
          } else {
            this.json(response, 200, { StatusCode: spec?.exitCode ?? 0 });
          }
          return;
        case "POST kill":
          this.killed.push(id);
          this.waiters.get(id)?.();
          response.writeHead(204).end();
          return;
        case "GET logs": {
          response.writeHead(200, { "Content-Type": "application/vnd.docker.multiplexed-stream" });
          const frames = [
            ...(spec?.stdout ?? []).map((data) => FakeEngineApi.frame(1, data)),
            ...(spec?.stderr ?? []).map((data) => FakeEngineApi.frame(2, data)),
          ];
          // Split the stream at awkward places to exercise the decoder.
          const all = Buffer.concat(frames);
          const middle = Math.floor(all.length / 2);
          response.write(all.subarray(0, middle));
          setTimeout(() => response.end(all.subarray(middle)), 5);
          return;
        }
        default:
          break;
      }
    }
    const deleteMatch = /^\/containers\/([^/]+)$/.exec(route);
    if (method === "DELETE" && deleteMatch) {
      this.removed.push(deleteMatch[1] as string);
      response.writeHead(204).end();
      return;
    }
    this.json(response, 404, { message: `unhandled ${method} ${route}` });
  }
}

/** Inspect data for the updater's own container as Docker reports it. */
export function selfContainer(
  overrides: { stateMount?: unknown; labels?: Record<string, string> } = {},
): unknown {
  return {
    Id: "selfselfselfself",
    Config: {
      Labels: {
        "com.docker.compose.project": "restow",
        "com.docker.compose.project.working_dir": "/srv/restow",
        ...(overrides.labels ?? {}),
      },
    },
    Mounts: [
      { Type: "bind", Source: "/var/run/docker.sock", Destination: "/var/run/docker.sock" },
      { Type: "bind", Source: "/srv/restow", Destination: "/srv/restow" },
      overrides.stateMount ?? {
        Type: "volume",
        Name: "restow_restow-updater",
        Source: "/var/lib/docker/volumes/x/_data",
        Destination: "/state",
      },
      {
        Type: "volume",
        Name: "restow_restow-updater-shared",
        Source: "/x",
        Destination: "/updater-shared",
      },
    ],
  };
}
