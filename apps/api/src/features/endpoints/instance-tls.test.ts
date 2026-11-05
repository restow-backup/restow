/**
 * The instance check value (docs/BAREMETAL.md 9.2): the SHA-256 of the DER SubjectPublicKeyInfo of
 * the certificate a TLS server presents, for an RSA and an EC key, made in the test with openssl;
 * nothing for plain HTTP, a closed port or a server that never answers.
 */
import { execFileSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createNetServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:tls";
import { afterAll, describe, expect, it } from "vitest";
import { measureInstanceSpki } from "./instance-tls.js";

const dir = mkdtempSync(join(tmpdir(), "restow-instance-tls-"));
const servers: Server[] = [];

function certificate(name: string, keyArgs: string[]): { key: Buffer; cert: Buffer } {
  const key = join(dir, `${name}.key`);
  const cert = join(dir, `${name}.crt`);
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      ...keyArgs,
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "1",
      "-subj",
      "/CN=restow.test",
    ],
    { stdio: "ignore" },
  );
  return { key: readFileSync(key), cert: readFileSync(cert) };
}

function spkiOf(cert: Buffer): string {
  const der = new X509Certificate(cert).publicKey.export({ type: "spki", format: "der" });
  return createHash("sha256").update(der).digest("hex");
}

async function listen(server: Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return typeof address === "object" && address ? address.port : 0;
}

afterAll(() => {
  for (const server of servers) server.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("measureInstanceSpki", () => {
  it.each([
    ["rsa", ["-newkey", "rsa:2048"]],
    ["ec", ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256"]],
  ])("hashes the SubjectPublicKeyInfo of an %s certificate", async (name, args) => {
    const pair = certificate(name, args);
    const port = await listen(createServer(pair, (socket) => socket.end()));
    const measured = await measureInstanceSpki(`https://127.0.0.1:${port}`);
    expect(measured).toBe(spkiOf(pair.cert));
    expect(measured).toMatch(/^[0-9a-f]{64}$/);
  });

  it("measures nothing for plain HTTP, a closed port or a server that stays silent", async () => {
    expect(await measureInstanceSpki("http://127.0.0.1:1")).toBeNull();
    expect(await measureInstanceSpki("not a url")).toBeNull();
    const closed = await listen(createNetServer());
    servers.pop()?.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(
      await measureInstanceSpki(`https://127.0.0.1:${closed}`, { timeoutMs: 2000 }),
    ).toBeNull();
    const silent = await listen(createNetServer(() => undefined));
    const started = Date.now();
    expect(await measureInstanceSpki(`https://127.0.0.1:${silent}`, { timeoutMs: 300 })).toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
