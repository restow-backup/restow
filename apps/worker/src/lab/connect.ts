/**
 * The connector between a probe's virtual machine and the lab's CONNECT proxy (docs/BAREMETAL.md
 * 12.3). QEMU's `guestfwd=...-cmd:` starts it once for every TCP connection the guest opens to
 * the proxy's guest address, with that connection on its standard input and output (one socket),
 * and it joins it to the proxy on 127.0.0.1:<port>. A `guestfwd` to `tcp:` gave all connections
 * of the guest one shared channel: after the first, every further connection hung, and recover
 * ended each try with "proxy: ... i/o timeout".
 *
 * It reaches nothing but the given port on the loopback address; what the guest may reach beyond
 * it is the proxy's decision (one CONNECT target only). Plain erasable TypeScript with only
 * `node:` imports, like qemu.ts.
 *
 *   node connect.js <port>
 */
import { Socket, connect as tcpConnect } from "node:net";
import type { Duplex } from "node:stream";
import { pathToFileURL } from "node:url";

/** The proxy's port from the arguments: exactly one, 1 to 65535. */
export function connectorPort(argv: readonly string[]): number | null {
  if (argv.length !== 1 || !/^\d{1,5}$/.test(argv[0] ?? "")) return null;
  const port = Number(argv[0]);
  return port >= 1 && port <= 65535 ? port : null;
}

/** Join `guest` to 127.0.0.1:`port`; resolves when either side ends. */
export function relay(
  guest: Duplex,
  port: number,
  connect: (port: number) => Duplex = (p) => tcpConnect(p, "127.0.0.1"),
): Promise<void> {
  return new Promise((resolve) => {
    const upstream = connect(port);
    let done = false;
    const end = () => {
      if (done) return;
      done = true;
      guest.destroy();
      upstream.destroy();
      resolve();
    };
    guest.on("error", end);
    upstream.on("error", end);
    guest.on("close", end);
    upstream.on("close", end);
    guest.pipe(upstream);
    upstream.pipe(guest);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = connectorPort(process.argv.slice(2));
  if (port === null) process.exit(2);
  // fd 0, 1 and 2 are the same socket of the guest's connection: nothing may be written to stderr.
  await relay(new Socket({ fd: 0, readable: true, writable: true }), port);
  process.exit(0);
}
