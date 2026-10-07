import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EnvFile,
  EnvFileError,
  assertSafeEnvValue,
  assignedKey,
  assignedValue,
  captureKeys,
  envValueOf,
  parseEnvLines,
  postgresSettings,
  renderEnvLines,
  restoreKeys,
  setKeys,
} from "./env-file.js";

const KEYS = ["RESTOW_IMAGE", "RESTOW_WEB_IMAGE"] as const;
const NEW = {
  RESTOW_IMAGE: "ghcr.io/x/restow:0.2.0",
  RESTOW_WEB_IMAGE: "ghcr.io/x/restow-web:0.2.0",
};

/** Set both variables, then restore: the text must come back byte for byte. */
function roundTrip(original: string): string {
  const captured = captureKeys(original, KEYS);
  const changed = setKeys(original, NEW);
  expect(changed).not.toBe(original);
  return restoreKeys(changed, captured);
}

describe("line model", () => {
  it.each([
    [""],
    ["A=1"],
    ["A=1\n"],
    ["A=1\nB=2"],
    ["A=1\r\nB=2\r\n"],
    ["A=1\r\nB=2"],
    ["\n\n"],
    ["A=1\n\r\nB=2\n"],
    ["# c\n\nA=1\n"],
  ])("parses and renders %j unchanged", (text) => {
    expect(renderEnvLines(parseEnvLines(text))).toBe(text);
  });

  it("recognises assignments, not comments", () => {
    expect(assignedKey("RESTOW_IMAGE=x")).toBe("RESTOW_IMAGE");
    expect(assignedKey("  export RESTOW_IMAGE = x")).toBe("RESTOW_IMAGE");
    expect(assignedKey("# RESTOW_IMAGE=x")).toBeNull();
    expect(assignedKey("just text")).toBeNull();
    expect(assignedKey("")).toBeNull();
  });

  it("parses values with quotes and inline comments", () => {
    expect(assignedValue("A=plain")).toBe("plain");
    expect(assignedValue('A="quoted value" # comment')).toBe("quoted value");
    expect(assignedValue("A='single # not a comment'")).toBe("single # not a comment");
    expect(assignedValue("A=value # comment")).toBe("value");
    expect(assignedValue("A=")).toBe("");
    expect(assignedValue('A="esc \\" quote"')).toBe('esc " quote');
    expect(assignedValue("A=with#hash")).toBe("with#hash");
  });
});

describe("setKeys / restoreKeys", () => {
  it("replaces existing assignments in place and keeps every other line byte for byte", () => {
    const original = [
      "# header comment",
      "",
      "POSTGRES_PASSWORD=pw pw with space",
      "RESTOW_IMAGE=ghcr.io/x/restow:0.1.0",
      "  # indented comment",
      'RESTOW_WEB_IMAGE="ghcr.io/x/restow-web:0.1.0" # pinned',
      "LAST=1",
      "",
    ].join("\n");
    expect(setKeys(original, NEW)).toBe(
      [
        "# header comment",
        "",
        "POSTGRES_PASSWORD=pw pw with space",
        "RESTOW_IMAGE=ghcr.io/x/restow:0.2.0",
        "  # indented comment",
        "RESTOW_WEB_IMAGE=ghcr.io/x/restow-web:0.2.0",
        "LAST=1",
        "",
      ].join("\n"),
    );
    expect(roundTrip(original)).toBe(original);
  });

  it("appends absent variables and restores them to absent", () => {
    const original = "A=1\n# c\nB=2\n";
    expect(setKeys(original, NEW)).toBe(
      `${original}RESTOW_IMAGE=ghcr.io/x/restow:0.2.0\nRESTOW_WEB_IMAGE=ghcr.io/x/restow-web:0.2.0\n`,
    );
    expect(roundTrip(original)).toBe(original);
  });

  it("restores an empty existing value as empty (not as absent)", () => {
    const original = "RESTOW_IMAGE=\nRESTOW_WEB_IMAGE=\nA=1\n";
    const captured = captureKeys(original, KEYS);
    expect(captured.RESTOW_IMAGE).toEqual({ present: true, line: "RESTOW_IMAGE=", value: "" });
    expect(roundTrip(original)).toBe(original);
  });

  it("handles a CRLF file", () => {
    const original = "# c\r\nA=1\r\nRESTOW_IMAGE=old\r\nB=2\r\n";
    const changed = setKeys(original, NEW);
    expect(changed).toBe(
      "# c\r\nA=1\r\nRESTOW_IMAGE=ghcr.io/x/restow:0.2.0\r\nB=2\r\nRESTOW_WEB_IMAGE=ghcr.io/x/restow-web:0.2.0\r\n",
    );
    expect(roundTrip(original)).toBe(original);
  });

  it("handles a file without a trailing newline, keeping it that way", () => {
    const original = "A=1\nB=2";
    const changed = setKeys(original, NEW);
    expect(changed.endsWith("restow-web:0.2.0")).toBe(true);
    expect(changed.split("\n")).toHaveLength(4);
    expect(roundTrip(original)).toBe(original);
    const withKey = "A=1\nRESTOW_IMAGE=old";
    expect(setKeys(withKey, { RESTOW_IMAGE: "x:1" })).toBe("A=1\nRESTOW_IMAGE=x:1");
    expect(roundTrip(withKey)).toBe(withKey);
  });

  it("handles an empty file and a CRLF file without trailing newline", () => {
    expect(roundTrip("")).toBe("");
    expect(roundTrip("A=1\r\nB=2")).toBe("A=1\r\nB=2");
  });

  it("replaces the last of several assignments (the one Compose uses) and restores it", () => {
    const original = "RESTOW_IMAGE=first\nA=1\nRESTOW_IMAGE=second\n";
    const changed = setKeys(original, { RESTOW_IMAGE: "x:2" });
    expect(changed).toBe("RESTOW_IMAGE=first\nA=1\nRESTOW_IMAGE=x:2\n");
    expect(restoreKeys(changed, captureKeys(original, ["RESTOW_IMAGE"]))).toBe(original);
  });

  it("keeps an export prefix", () => {
    expect(setKeys("export RESTOW_IMAGE=old\n", { RESTOW_IMAGE: "x:1" })).toBe(
      "export RESTOW_IMAGE=x:1\n",
    );
  });

  it("ignores commented-out assignments", () => {
    const original = "# RESTOW_IMAGE=old\nA=1\n";
    const changed = setKeys(original, { RESTOW_IMAGE: "x:1" });
    expect(changed).toBe("# RESTOW_IMAGE=old\nA=1\nRESTOW_IMAGE=x:1\n");
    expect(restoreKeys(changed, captureKeys(original, ["RESTOW_IMAGE"]))).toBe(original);
  });

  it("re-adds a variable that was removed in the meantime", () => {
    const original = "RESTOW_IMAGE=old\nA=1\n";
    const captured = captureKeys(original, ["RESTOW_IMAGE"]);
    expect(restoreKeys("A=1\n", captured)).toBe("A=1\nRESTOW_IMAGE=old\n");
  });

  it("rejects values and names that are not plain", () => {
    for (const value of ["a b", "a$b", 'a"b', "a`b`", "", "a\nb", "x#y", "-x"]) {
      expect(() => assertSafeEnvValue("RESTOW_IMAGE", value)).toThrow(EnvFileError);
    }
    expect(() => setKeys("", { "bad-name": "x" })).toThrow(EnvFileError);
    expect(() =>
      assertSafeEnvValue("RESTOW_IMAGE", "ghcr.io/x/y:1.2.3-rc.1@sha256:abc"),
    ).not.toThrow();
  });
});

describe("postgresSettings", () => {
  it("defaults to restow/restow", () => {
    expect(postgresSettings("A=1\n")).toEqual({ user: "restow", db: "restow" });
    expect(postgresSettings("POSTGRES_USER=\nPOSTGRES_DB=\n")).toEqual({
      user: "restow",
      db: "restow",
    });
  });

  it("reads the values Compose would use", () => {
    expect(postgresSettings('POSTGRES_USER=backup_admin\nPOSTGRES_DB="app-db" # x\n')).toEqual({
      user: "backup_admin",
      db: "app-db",
    });
  });

  it("refuses values that would be interpreted as options or contain odd characters", () => {
    for (const text of [
      "POSTGRES_DB=--file=/x\n",
      "POSTGRES_USER=a b\n",
      "POSTGRES_DB=a;b\n",
      "POSTGRES_USER=${X}\n",
    ]) {
      expect(() => postgresSettings(text)).toThrow(EnvFileError);
    }
  });

  it("envValueOf finds the last assignment", () => {
    expect(envValueOf("A=1\nA=2\n", "A")).toBe("2");
    expect(envValueOf("A=1\n", "B")).toBeNull();
  });
});

describe("EnvFile", () => {
  let dir: string;
  let file: EnvFile;
  let target: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "restow-updater-env-"));
    target = path.join(dir, ".env");
    file = new EnvFile(target);
  });

  afterEach(async () => {
    await fs.chmod(dir, 0o700).catch(() => undefined);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("applies and restores atomically, keeping the mode and leaving no temporary file", async () => {
    const original = "# c\nPOSTGRES_PASSWORD=pw\nRESTOW_IMAGE=old:1\n";
    await fs.writeFile(target, original, { mode: 0o640 });
    await fs.chmod(target, 0o640);
    const captured = await file.capture(KEYS);
    await file.apply(NEW);
    expect(await fs.readFile(target, "utf8")).toContain("RESTOW_IMAGE=ghcr.io/x/restow:0.2.0");
    expect((await fs.stat(target)).mode & 0o777).toBe(0o640);
    await file.restore(captured);
    expect(await fs.readFile(target, "utf8")).toBe(original);
    expect((await fs.stat(target)).mode & 0o777).toBe(0o640);
    expect(await fs.readdir(dir)).toEqual([".env"]);
  });

  it("does not rewrite the file when nothing changes", async () => {
    await fs.writeFile(target, "RESTOW_IMAGE=x:1\n");
    const before = (await fs.stat(target)).ino;
    await file.apply({ RESTOW_IMAGE: "x:1" });
    expect((await fs.stat(target)).ino).toBe(before);
  });

  it("follows a symlink instead of replacing it", async () => {
    const real = path.join(dir, "real.env");
    await fs.writeFile(real, "A=1\n");
    await fs.symlink(real, target);
    await file.apply({ RESTOW_IMAGE: "x:1" });
    expect((await fs.lstat(target)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(real, "utf8")).toBe("A=1\nRESTOW_IMAGE=x:1\n");
  });

  it("writes and restores the two image lines only, never its own image or anything else", async () => {
    const original = "RESTOW_IMAGE=a:1\nRESTOW_UPDATER_IMAGE=restow:pinned\nPOSTGRES_PASSWORD=pw\n";
    await fs.writeFile(target, original);
    const attempts: Record<string, string>[] = [
      { RESTOW_UPDATER_IMAGE: "evil:1" },
      { RESTOW_IMAGE: "b:2", POSTGRES_PASSWORD: "x" },
      { RESTOW_UPDATER_SOURCE_HOSTS: "evil.example" },
    ];
    for (const assignments of attempts) {
      await expect(file.apply(assignments)).rejects.toMatchObject({ reason: "invalid_setting" });
    }
    await expect(
      file.restore({
        RESTOW_UPDATER_IMAGE: { present: true, line: "RESTOW_UPDATER_IMAGE=x", value: "x" },
      }),
    ).rejects.toMatchObject({ reason: "invalid_setting" });
    expect(await fs.readFile(target, "utf8")).toBe(original);
  });

  it("writes its own image only pinned by digest, and puts it back exactly", async () => {
    const pinned = `ghcr.io/restow-backup/restow:0.2.1@sha256:${"e".repeat(64)}`;
    const original = "RESTOW_IMAGE=a:1\nRESTOW_UPDATER_IMAGE=\nPOSTGRES_PASSWORD=pw";
    await fs.writeFile(target, original);
    for (const value of [
      "ghcr.io/restow-backup/restow:0.2.1",
      "evil:1 # x",
      `x@sha256:${"e".repeat(10)}`,
    ]) {
      await expect(file.pinUpdaterImage(value)).rejects.toMatchObject({ reason: "invalid_value" });
    }
    expect(await fs.readFile(target, "utf8")).toBe(original);
    const before = await file.pinUpdaterImage(pinned);
    expect(before).toEqual({ present: true, line: "RESTOW_UPDATER_IMAGE=", value: "" });
    expect(await fs.readFile(target, "utf8")).toBe(
      `RESTOW_IMAGE=a:1\nRESTOW_UPDATER_IMAGE=${pinned}\nPOSTGRES_PASSWORD=pw`,
    );
    await file.restoreUpdaterImage(before);
    expect(await fs.readFile(target, "utf8")).toBe(original);
  });

  it("appends its own image when .env has no line for it", async () => {
    const pinned = `ghcr.io/restow-backup/restow-community:0.2.1@sha256:${"e".repeat(64)}`;
    await fs.writeFile(target, "RESTOW_IMAGE=a:1\n");
    const before = await file.pinUpdaterImage(pinned);
    expect(await fs.readFile(target, "utf8")).toBe(
      `RESTOW_IMAGE=a:1\nRESTOW_UPDATER_IMAGE=${pinned}\n`,
    );
    await file.restoreUpdaterImage(before);
    expect(await fs.readFile(target, "utf8")).toBe("RESTOW_IMAGE=a:1\n");
  });

  it("pins the mounter's image the same way and refuses any other line", async () => {
    const pinned = `ghcr.io/restow-backup/restow:0.3.0@sha256:${"f".repeat(64)}`;
    await fs.writeFile(target, "RESTOW_IMAGE=a:1\n");
    await file.pinImage("RESTOW_MOUNTER_IMAGE", pinned);
    expect(await fs.readFile(target, "utf8")).toBe(
      `RESTOW_IMAGE=a:1\nRESTOW_MOUNTER_IMAGE=${pinned}\n`,
    );
    await expect(file.pinImage("RESTOW_IMAGE", pinned)).rejects.toMatchObject({
      reason: "invalid_setting",
    });
    await expect(file.pinImage("RESTOW_MOUNTER_IMAGE", "x:1")).rejects.toMatchObject({
      reason: "invalid_value",
    });
  });

  it("moves a pinned mounter line to a newer image in place, keeping everything else", async () => {
    const old = `ghcr.io/restow-backup/restow:0.3.0@sha256:${"f".repeat(64)}`;
    const next = `ghcr.io/restow-backup/restow:0.3.1@sha256:${"e".repeat(64)}`;
    await fs.writeFile(
      target,
      `# mine\nRESTOW_IMAGE=a:1\nexport RESTOW_MOUNTER_IMAGE=${old}\nOTHER=x\n`,
    );
    const before = await file.pinImage("RESTOW_MOUNTER_IMAGE", next);
    expect(await fs.readFile(target, "utf8")).toBe(
      `# mine\nRESTOW_IMAGE=a:1\nexport RESTOW_MOUNTER_IMAGE=${next}\nOTHER=x\n`,
    );
    expect(before).toMatchObject({ present: true });
    // A tag is never written, not even over a pinned line.
    await expect(
      file.pinImage("RESTOW_MOUNTER_IMAGE", "ghcr.io/restow-backup/restow:0.3.2"),
    ).rejects.toMatchObject({ reason: "invalid_value" });
    expect(await fs.readFile(target, "utf8")).toContain(next);
  });

  it("appends the image lines an update writes when .env has none", async () => {
    await fs.writeFile(target, "POSTGRES_PASSWORD=pw\n");
    const captured = await file.capture(KEYS);
    await file.apply({
      RESTOW_IMAGE: "ghcr.io/restow-backup/restow-community:0.2.1",
      RESTOW_WEB_IMAGE: "ghcr.io/restow-backup/restow-web-community:0.2.1",
    });
    expect(await fs.readFile(target, "utf8")).toBe(
      "POSTGRES_PASSWORD=pw\nRESTOW_IMAGE=ghcr.io/restow-backup/restow-community:0.2.1\nRESTOW_WEB_IMAGE=ghcr.io/restow-backup/restow-web-community:0.2.1\n",
    );
    await file.restore(captured);
    expect(await fs.readFile(target, "utf8")).toBe("POSTGRES_PASSWORD=pw\n");
  });

  it("reports a missing file", async () => {
    await expect(file.read()).rejects.toMatchObject({ reason: "missing" });
    await expect(file.assertWritable()).rejects.toMatchObject({ reason: "missing" });
  });

  it.skipIf(process.getuid?.() === 0)("reports an unwritable file and directory", async () => {
    await fs.writeFile(target, "A=1\n");
    await fs.chmod(target, 0o400);
    await expect(file.assertWritable()).rejects.toMatchObject({ reason: "unwritable" });
    await fs.chmod(target, 0o600);
    await fs.chmod(dir, 0o500);
    await expect(file.assertWritable()).rejects.toMatchObject({ reason: "unwritable" });
  });

  it("passes for a normal file", async () => {
    await fs.writeFile(target, "A=1\n");
    await expect(file.assertWritable()).resolves.toBeUndefined();
  });
});
