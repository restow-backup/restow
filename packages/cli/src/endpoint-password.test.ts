/**
 * `restow-restore endpoint-password`: the repository password of a server or
 * client, opened from the storage and the KEK alone (docs/AGENT.md, "Restore
 * ohne Restow"). The last test is the proof that matters: a restic repository
 * the server would have written, opened by plain restic with nothing but the
 * password this command recovered.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Dek,
  LocalStorageBackend,
  endpointPasswordKey,
  resticBinary,
  sealEndpointPassword,
  wrapDek,
} from "@restow/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCli } from "./cli.js";

const TENANT_ID = "5d2c1b0a-9f8e-4d7c-8b6a-1234567890ab";
const ENDPOINT_ID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const dek: Dek = { version: 1, material: Buffer.alloc(32, 0x5a) };
const kek = Buffer.alloc(32, 0x6b);

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "restow-cli-endpoint-"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A storage target as the server leaves it: the wrapped tenant key and the sealed password. */
async function storage(name: string, password: string) {
  const dir = join(root, name);
  const backend = new LocalStorageBackend(join(dir, "store"));
  await backend.put(`tenants/${TENANT_ID}/keys/1`, wrapDek(kek, dek));
  await backend.put(
    endpointPasswordKey(ENDPOINT_ID),
    sealEndpointPassword({ tenantId: TENANT_ID, endpointId: ENDPOINT_ID, password, dek }),
  );
  const keyFile = join(dir, "kek.key");
  await writeFile(keyFile, kek.toString("base64"), "utf8");
  return { dir, storageDir: join(dir, "store"), keyFile };
}

async function run(args: string[]) {
  let stdout = "";
  let stderr = "";
  const code = await runCli(args, {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  return { code, stdout, stderr };
}

describe("restow-restore endpoint-password", () => {
  it("prints the password, and only the password, with a warning beside it", async () => {
    const store = await storage("print", "the-repository-password");
    const result = await run([
      "endpoint-password",
      "--storage",
      store.storageDir,
      "--key",
      store.keyFile,
      "--endpoint",
      ENDPOINT_ID,
    ]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toBe("the-repository-password\n");
    expect(result.stderr).toContain("warning:");
    expect(result.stderr).toContain(
      `restic -r ${join(store.storageDir, "endpoints", ENDPOINT_ID)}`,
    );
    expect(result.stderr).not.toContain("the-repository-password");
  });

  it("writes it into a new file only the operator can read, and never over one", async () => {
    const store = await storage("file", "pw-in-a-file");
    const out = join(store.dir, "password.txt");
    const args = [
      "endpoint-password",
      "--storage",
      store.storageDir,
      "--key",
      store.keyFile,
      "--endpoint",
      ENDPOINT_ID,
      "--out",
      out,
    ];
    const first = await run(args);
    expect(first.code, first.stderr).toBe(0);
    expect(first.stdout).toBe("");
    expect(await readFile(out, "utf8")).toBe("pw-in-a-file\n");
    expect((await stat(out)).mode & 0o777).toBe(0o600);
    const again = await run(args);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain("EEXIST");
  });

  it("refuses a wrong key, a missing password, another endpoint's and a bad id", async () => {
    const store = await storage("refusals", "secret-pw");
    const base = ["endpoint-password", "--storage", store.storageDir];
    const wrongKey = join(store.dir, "wrong.key");
    await writeFile(wrongKey, randomBytes(32).toString("base64"));
    const wrong = await run([...base, "--key", wrongKey, "--endpoint", ENDPOINT_ID]);
    expect(wrong.code).toBe(1);
    expect(wrong.stdout).toBe("");

    const other = "ffffffff-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
    const missing = await run([...base, "--key", store.keyFile, "--endpoint", other]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("no sealed repository password");

    // The document of one endpoint copied into another endpoint's folder does not open there.
    const backend = new LocalStorageBackend(store.storageDir);
    await backend.put(
      endpointPasswordKey(other),
      await backend.get(endpointPasswordKey(ENDPOINT_ID)),
    );
    const moved = await run([...base, "--key", store.keyFile, "--endpoint", other]);
    expect(moved.code).toBe(1);
    expect(moved.stdout).toBe("");

    const bad = await run([...base, "--key", store.keyFile, "--endpoint", "../../etc"]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("is not an endpoint id");
  });
});

function resticAvailable(): boolean {
  const result = spawnSync(resticBinary(), ["version"], { encoding: "utf8" });
  return result.status === 0 && /^restic 0\.\d+/.test(result.stdout);
}

describe.skipIf(!resticAvailable())("restoring a server's backup without the server", () => {
  it("opens the repository with plain restic and the recovered password, and restores byte for byte", async () => {
    const password = randomBytes(32).toString("base64url");
    const store = await storage("e2e", password);
    const repository = join(store.storageDir, "endpoints", ENDPOINT_ID);
    const source = join(store.dir, "machine");
    await mkdir(source, { recursive: true });
    const content = randomBytes(50_000);
    await writeFile(join(source, "database.dump"), content);
    const restic = (args: string[], env: Record<string, string>) =>
      spawnSync(resticBinary(), args, {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH ?? "",
          HOME: store.dir,
          RESTIC_CACHE_DIR: join(store.dir, "cache"),
          ...env,
        },
      });
    // What the server and the agent would have left in the storage target.
    const made = { RESTIC_REPOSITORY: repository, RESTIC_PASSWORD: password };
    expect(restic(["init"], made).status).toBe(0);
    expect(restic(["backup", source], made).status).toBe(0);

    // The server and its database are gone: only the storage and the KEK are left.
    const out = join(store.dir, "recovered-password");
    const recovered = await run([
      "endpoint-password",
      "--storage",
      store.storageDir,
      "--key",
      store.keyFile,
      "--endpoint",
      ENDPOINT_ID,
      "--out",
      out,
    ]);
    expect(recovered.code, recovered.stderr).toBe(0);
    const target = join(store.dir, "restored");
    const restored = restic(
      ["-r", repository, "--password-file", out, "restore", "latest", "--target", target],
      {},
    );
    expect(restored.status, restored.stderr).toBe(0);
    expect((await readFile(join(target, source, "database.dump"))).equals(content)).toBe(true);
  }, 120_000);
});
