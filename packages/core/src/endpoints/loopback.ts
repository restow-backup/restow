/**
 * The server's own access to an endpoint's repository: a restic REST listener
 * on the loopback interface with the maintenance credential.
 *
 * Retention (`forget --prune`), `check`, restore tests, downloads, browsing
 * and the first `init` all need more than the agent's append-only access. They
 * run restic on the server against this listener, which serves the very same
 * protocol code as the public endpoint (./restic-rest.ts) with the full-access
 * principal. It exists for one operation only:
 *
 *   - it listens on 127.0.0.1 with a port the operating system picks,
 *   - it wants HTTP Basic credentials that are random for this listener and are
 *     handed to the restic child through its environment,
 *   - it is closed when the operation ends.
 *
 * So the maintenance credential never crosses the network, is never stored and
 * is never valid again after the run that used it.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import type { StorageBackend } from "../storage/backend.js";
import { handleResticRequest } from "./restic-rest.js";
import { parseBasicAuthorization } from "./tokens.js";

export const MAINTENANCE_USERNAME = "restow-maintenance";

export interface LoopbackRepository {
  /** `rest:http://127.0.0.1:<port>/`: the restic repository URL. */
  readonly url: string;
  readonly username: string;
  readonly password: string;
  /** Requests served so far (tests, logs). */
  readonly requests: () => number;
  close(): Promise<void>;
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function toRequest(req: IncomingMessage, url: URL): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) {
      continue;
    }
    for (const single of Array.isArray(value) ? value : [value]) {
      headers.append(name, single);
    }
  }
  const method = req.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";
  return new Request(url, {
    method,
    headers,
    body: hasBody ? (Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>) : undefined,
    // Node requires it for a streamed request body.
    duplex: "half",
  } as RequestInit);
}

async function send(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name] = value;
  });
  res.writeHead(response.status, headers);
  if (!response.body) {
    res.end();
    return;
  }
  const body = Readable.fromWeb(response.body as never);
  res.on("close", () => body.destroy());
  body.on("error", () => res.destroy());
  body.pipe(res);
}

/**
 * Start the listener for one repository. `prefix` is the repository's storage
 * prefix (`endpoints/<endpoint id>/`).
 */
export async function serveMaintenanceRepository(
  storage: StorageBackend,
  prefix: string,
): Promise<LoopbackRepository> {
  const password = randomBytes(32).toString("base64url");
  let served = 0;
  const server: Server = createServer((req, res) => {
    void (async () => {
      const credentials = parseBasicAuthorization(req.headers.authorization);
      if (
        !credentials ||
        credentials.username !== MAINTENANCE_USERNAME ||
        !constantTimeEqual(credentials.password, password)
      ) {
        res.writeHead(401, { "www-authenticate": 'Basic realm="restow"' });
        res.end();
        return;
      }
      served += 1;
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      try {
        const response = await handleResticRequest(toRequest(req, url), {
          storage,
          prefix,
          principal: "maintenance",
          path: url.pathname,
          query: url.searchParams,
        });
        await send(res, response);
      } catch {
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "text/plain" });
        }
        res.end("internal error\n");
      }
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `rest:http://127.0.0.1:${port}/`,
    username: MAINTENANCE_USERNAME,
    password,
    requests: () => served,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
