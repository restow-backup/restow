import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isAuthorized, loadOrCreateSecret, secretsEqual } from "./auth.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "restow-updater-auth-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("shared secret", () => {
  it("generates 32 random bytes as hex on first start, mode 0600", async () => {
    const shared = path.join(dir, "shared");
    const secret = await loadOrCreateSecret(shared);
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    const stat = await fs.stat(path.join(shared, "secret"));
    expect(stat.mode & 0o777).toBe(0o600);
    expect((await fs.readFile(path.join(shared, "secret"), "utf8")).trim()).toBe(secret);
    expect((await fs.readdir(shared)).sort()).toEqual(["secret"]);
  });

  it("reuses the secret afterwards and repairs a loosened mode", async () => {
    const first = await loadOrCreateSecret(dir);
    await fs.chmod(path.join(dir, "secret"), 0o644);
    const second = await loadOrCreateSecret(dir);
    expect(second).toBe(first);
    expect((await fs.stat(path.join(dir, "secret"))).mode & 0o777).toBe(0o600);
  });

  it("creates a new secret when the file is empty or malformed", async () => {
    await fs.writeFile(path.join(dir, "secret"), "not a secret\n");
    const secret = await loadOrCreateSecret(dir);
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect((await fs.readFile(path.join(dir, "secret"), "utf8")).trim()).toBe(secret);
  });

  it("generates different secrets for different installations", async () => {
    const other = await fs.mkdtemp(path.join(os.tmpdir(), "restow-updater-auth-"));
    try {
      expect(await loadOrCreateSecret(dir)).not.toBe(await loadOrCreateSecret(other));
    } finally {
      await fs.rm(other, { recursive: true, force: true });
    }
  });
});

describe("bearer check", () => {
  const secret = "a".repeat(64);

  it("accepts exactly the secret", () => {
    expect(isAuthorized(`Bearer ${secret}`, secret)).toBe(true);
    expect(isAuthorized(`bearer ${secret}`, secret)).toBe(true);
    expect(isAuthorized(`Bearer ${secret} `, secret)).toBe(true);
  });

  it.each([
    [undefined],
    [null],
    [""],
    ["Bearer"],
    ["Bearer "],
    [`Bearer ${"b".repeat(64)}`],
    [`Bearer ${secret.slice(1)}`],
    [`Bearer ${secret}x`],
    [`Basic ${secret}`],
    [secret],
  ])("rejects %s", (header) => {
    expect(isAuthorized(header as string | null | undefined, secret)).toBe(false);
  });

  it("compares with timingSafeEqual on equal-length digests (length does not throw)", () => {
    expect(secretsEqual("abc", "abc")).toBe(true);
    expect(secretsEqual("abc", "abcd")).toBe(false);
    expect(secretsEqual("", "x")).toBe(false);
  });
});
