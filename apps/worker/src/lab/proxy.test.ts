/**
 * The probe's CONNECT proxy (docs/BAREMETAL.md 12.3): the VM reaches the instance's origin and
 * nothing else; the tunnel goes to the TLS edge named for it.
 */
import { connect, createServer, type Server } from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import { allowedConnect, proxyTarget, startProbeProxy } from "./proxy.js";

const servers: Server[] = [];

/** An upstream that answers every byte with "echo:" and the byte. */
async function upstream(): Promise<number> {
  const server = createServer((socket) => socket.on("data", (d) => socket.write(`echo:${d}`)));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return typeof address === "object" && address ? address.port : 0;
}

afterAll(() => {
  for (const server of servers) server.close();
});

function ask(port: number, request: string, after?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    let text = "";
    socket.on("data", (d) => {
      text += d.toString("latin1");
      if (after && text.includes("200 Connection Established") && !text.includes("echo:")) {
        socket.write(after);
      }
      if (text.includes("echo:") || /^HTTP\/1\.1 [45]\d\d/.test(text)) socket.end();
    });
    socket.on("end", () => resolve(text));
    socket.on("error", reject);
    socket.write(request);
  });
}

describe("the CONNECT proxy of a probe", () => {
  it("knows the origin's host and port", () => {
    expect(proxyTarget("https://Restow.Contoso.example")).toBe("restow.contoso.example:443");
    expect(proxyTarget("https://restow.contoso.example:8443")).toBe("restow.contoso.example:8443");
    expect(allowedConnect("CONNECT a.example:443 HTTP/1.1\r\nHost: x", "a.example:443")).toBe(true);
    expect(allowedConnect("CONNECT a.example:444 HTTP/1.1", "a.example:443")).toBe(false);
    expect(allowedConnect("GET http://a.example/ HTTP/1.1", "a.example:443")).toBe(false);
  });

  it("tunnels the origin to the TLS edge, and refuses every other host, port and request", async () => {
    const edge = await upstream();
    const proxy = await startProbeProxy({
      allow: "restow.contoso.example:443",
      upstream: `127.0.0.1:${edge}`,
    });
    try {
      const tunnel = await ask(
        proxy.port,
        "CONNECT restow.contoso.example:443 HTTP/1.1\r\nHost: restow.contoso.example:443\r\n\r\n",
        "hello",
      );
      expect(tunnel).toContain("HTTP/1.1 200 Connection Established");
      expect(tunnel).toContain("echo:hello");
      for (const request of [
        "CONNECT evil.example:443 HTTP/1.1\r\n\r\n",
        "CONNECT restow.contoso.example:22 HTTP/1.1\r\n\r\n",
        `CONNECT 127.0.0.1:${edge} HTTP/1.1\r\n\r\n`,
        "GET http://restow.contoso.example/ HTTP/1.1\r\nHost: restow.contoso.example\r\n\r\n",
      ]) {
        expect(await ask(proxy.port, request)).toMatch(/^HTTP\/1\.1 403 Forbidden/);
      }
      expect(proxy.tunnels()).toBe(1);
    } finally {
      await proxy.close();
    }
  });
});
