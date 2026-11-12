/**
 * The CONNECT proxy of a probe (docs/BAREMETAL.md 12.3): the only way out of the probe's virtual
 * machine. QEMU forwards one guest address (10.0.2.100:3128, the answers' `network.proxy`) to
 * this listener on 127.0.0.1; it takes `CONNECT <host>:<port>` for exactly the instance's origin
 * and connects that tunnel to the installation's TLS edge (`RESTOW_LAB_TLS_UPSTREAM`, e.g.
 * `caddy:443`; else the origin itself). Every other request, host or port is refused. The
 * tunnel carries TLS end to end: the proxy sees neither code nor credentials, and the ISO checks
 * the certificate (or the instance check value) as it would anywhere.
 */
import { createServer, type Server, type Socket, connect as tcpConnect } from "node:net";

export interface ProbeProxy {
  port: number;
  /** Tunnels opened (for the log). */
  tunnels: () => number;
  close: () => Promise<void>;
}

export interface ProxyOptions {
  /** The one `host:port` the guest may reach (the instance's origin). */
  allow: string;
  /** Where the tunnel goes: `host:port` of the TLS edge (default: `allow` itself). */
  upstream?: string | null;
  connect?: (port: number, host: string) => Socket;
}

const HOST_PORT = /^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]{1,253}):(\d{1,5})$/;
const MAX_HEADER = 8 * 1024;

/** `host:port` of an origin (`https://host[:port]`). */
export function proxyTarget(origin: string): string {
  const url = new URL(origin);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`origin ${origin}`);
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  return `${url.hostname.toLowerCase()}:${port}`;
}

function split(hostPort: string): { host: string; port: number } {
  const match = HOST_PORT.exec(hostPort);
  if (!match) throw new Error(`not host:port: ${hostPort}`);
  const port = Number(match[2]);
  if (port < 1 || port > 65535) throw new Error(`port ${port}`);
  return { host: (match[1] as string).replace(/^\[|\]$/g, ""), port };
}

/**
 * Whether a request head asks for the allowed tunnel. Only `CONNECT <allow> HTTP/1.x`; the
 * header lines that follow are ignored (no authentication, no forwarding of other requests).
 */
export function allowedConnect(head: string, allow: string): boolean {
  const first = head.split("\r\n", 1)[0] ?? "";
  const match = /^CONNECT (\S+) HTTP\/1\.[01]$/.exec(first);
  return match !== null && (match[1] as string).toLowerCase() === allow.toLowerCase();
}

export function startProbeProxy(options: ProxyOptions): Promise<ProbeProxy> {
  split(options.allow);
  const upstream = split(options.upstream?.trim() || options.allow);
  const connect = options.connect ?? ((port: number, host: string) => tcpConnect(port, host));
  let tunnels = 0;
  const sockets = new Set<Socket>();
  const server: Server = createServer((client) => {
    sockets.add(client);
    client.on("close", () => sockets.delete(client));
    client.on("error", () => client.destroy());
    let head = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) {
        if (head.length > MAX_HEADER)
          client.end("HTTP/1.1 431 Request Header Fields Too Large\r\n\r\n");
        return;
      }
      client.off("data", onData);
      const text = head.subarray(0, end).toString("latin1");
      const rest = head.subarray(end + 4);
      if (!allowedConnect(text, options.allow)) {
        client.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
        return;
      }
      const remote = connect(upstream.port, upstream.host);
      sockets.add(remote);
      remote.on("close", () => sockets.delete(remote));
      remote.once("connect", () => {
        tunnels += 1;
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (rest.length > 0) remote.write(rest);
        client.pipe(remote);
        remote.pipe(client);
      });
      remote.on("error", () => {
        if (!client.destroyed) client.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n");
        remote.destroy();
      });
      client.on("close", () => remote.destroy());
    };
    client.on("data", onData);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        port: typeof address === "object" && address ? address.port : 0,
        tunnels: () => tunnels,
        close: () =>
          new Promise<void>((done) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}
