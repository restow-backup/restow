import {
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
  createServer,
  request,
} from "node:http";
import { Agent } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * restic cannot add a header of its own to the requests of its REST backend,
 * and the demo's guard (apps/api middleware/demo-guard.ts) refuses every write
 * that does not carry the seed's token. This is a few dozen lines of reverse
 * proxy that only the seed's restic processes talk to: it listens on the
 * loopback of the seed container, forwards `/agent/restic/...` to the api
 * (streaming both ways, nothing is buffered) and adds `X-Restow-Demo-Seed-Token`.
 * Everything else is refused. The credentials restic sends (the endpoint's own
 * HTTP Basic login) pass through untouched: the api still authenticates the
 * endpoint and enforces append-only exactly as for a real agent.
 */

const RESTIC_PREFIX = "/agent/restic/";
const TOKEN_HEADER = "x-restow-demo-seed-token";
/** Hop-by-hop headers (RFC 9110, section 7.6.1) and the ones the proxy sets itself. */
const DROPPED = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  TOKEN_HEADER,
]);

export interface ResticProxy {
  /** `http://127.0.0.1:<port>`: what the repository URL of the simulated agents points at. */
  origin: string;
  close(): Promise<void>;
}

/** Headers to send upstream: the client's, minus hop-by-hop ones, plus the seed token. */
export function upstreamHeaders(
  incoming: IncomingHttpHeaders,
  seedToken: string,
): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(incoming)) {
    if (value !== undefined && !DROPPED.has(name.toLowerCase())) {
      headers[name] = value;
    }
  }
  headers[TOKEN_HEADER] = seedToken;
  return headers;
}

function refuse(response: ServerResponse, status: number, text: string): void {
  response.writeHead(status, { "content-type": "text/plain" });
  response.end(text);
}

export async function startResticProxy(target: string, seedToken: string): Promise<ResticProxy> {
  const upstream = new URL(target);
  const agent = new Agent({ keepAlive: true, maxSockets: 8 });
  const server = createServer((incoming: IncomingMessage, response: ServerResponse) => {
    const path = incoming.url ?? "/";
    if (!path.startsWith(RESTIC_PREFIX) || path.includes("..")) {
      refuse(response, 404, "only the restic REST backend is proxied");
      return;
    }
    const forwarded = request(
      {
        agent,
        protocol: upstream.protocol,
        hostname: upstream.hostname,
        port: upstream.port,
        method: incoming.method,
        path,
        headers: upstreamHeaders(incoming.headers, seedToken),
      },
      (answer) => {
        response.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(response);
      },
    );
    forwarded.on("error", () => {
      if (!response.headersSent) {
        refuse(response, 502, "the api is not reachable");
      } else {
        response.destroy();
      }
    });
    response.on("close", () => forwarded.destroy());
    incoming.pipe(forwarded);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        agent.destroy();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/**
 * The repository URL an agent was given (`rest:https://<instance>/agent/restic/<id>/`),
 * with the instance's address replaced by the proxy's: inside the demo's network
 * the public address is not reachable (and carries no token).
 */
export function rewriteRepositoryUrl(repositoryUrl: string, origin: string): string {
  const prefix = "rest:";
  if (!repositoryUrl.startsWith(prefix)) {
    throw new Error("the repository URL is not a restic REST URL");
  }
  const url = new URL(repositoryUrl.slice(prefix.length));
  return `${prefix}${origin}${url.pathname}`;
}
