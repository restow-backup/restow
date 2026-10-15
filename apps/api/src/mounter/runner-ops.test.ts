import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Redactor } from "../updater/redact.js";
import { PROBE_LABEL } from "./protocol.js";
import {
  RunnerRedactor,
  SELINUX_CONTEXT,
  capabilitiesFor,
  classifyMountError,
  escapeOptionValue,
  execContainerSpec,
  isExpiredKey,
  runContainerSpec,
  runNames,
  shareVolumeOptions,
} from "./runner-ops.js";
import { RUNNER_LABEL, type ShareSpec, shareSpecSchema } from "./runner-protocol.js";

const VECTORS = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../../../../packages/core/src/file-shares/testdata/specs.json", import.meta.url),
    ),
    "utf8",
  ),
) as {
  specs: { valid: unknown[] };
  options: { spec: number; access: "ro" | "rw"; type: string; device: string; o: string }[];
};

const specs = VECTORS.specs.valid.map((spec) => shareSpecSchema.parse(spec) as ShareSpec);

describe("volume options", () => {
  it("match the golden option strings", () => {
    for (const golden of VECTORS.options) {
      const spec = specs[golden.spec] as ShareSpec;
      expect(shareVolumeOptions(spec, golden.access)).toEqual({
        type: golden.type,
        device: golden.device,
        o: golden.o,
      });
    }
  });

  it("never generate SMB1, raw NTLM, Kerberos or cifsacl, always pin the address", () => {
    for (const spec of specs) {
      for (const access of ["ro", "rw"] as const) {
        const { o } = shareVolumeOptions(spec, access);
        expect(o.startsWith(`addr=${spec.address},`)).toBe(true);
        expect(o).not.toMatch(/vers=1\.0|vers=2\.0,|sec=ntlm(?!ssp)|krb5|cifsacl/);
        expect(o.split(",")).toContain(access);
      }
    }
  });

  it("adds the SELinux context only when asked for", () => {
    const spec = specs[2] as ShareSpec;
    expect(shareVolumeOptions(spec, "ro").o).not.toContain("context=");
    expect(shareVolumeOptions(spec, "ro", true).o.endsWith(`,${SELINUX_CONTEXT}`)).toBe(true);
  });

  it("doubles commas in the password and nothing else", () => {
    for (const [password, escaped] of [
      [",", ",,"],
      [",,", ",,,,"],
      ["$", "$"],
      ["%", "%"],
      ["=", "="],
      ['"', '"'],
      ["'", "'"],
      [" ", " "],
      ["\\", "\\"],
      ["Ünïcödé", "Ünïcödé"],
    ] as const) {
      expect(escapeOptionValue(password)).toBe(escaped);
      const spec = { ...(specs[0] as ShareSpec), password } as ShareSpec;
      expect(shareVolumeOptions(spec, "ro").o).toContain(`,password=${escaped},domain=CORP,`);
    }
  });
});

describe("redaction", () => {
  const password = "s3cr,et = pa ss";
  const spec = { ...(specs[0] as ShareSpec), password } as ShareSpec;

  it("removes every fragment of the password from Docker's real error format", () => {
    const options = shareVolumeOptions(spec, "ro");
    const docker = `Error response from daemon: error while mounting volume '/var/lib/docker/volumes/restow-share-0f1e2d3c-source/_data': failed to mount local volume: mount ${options.device}:/var/lib/docker/volumes/restow-share-0f1e2d3c-source/_data, data: ${options.o}: permission denied`;
    const redactor = RunnerRedactor.forShare(new Redactor(), spec);
    const out = redactor.redact(docker);
    for (const fragment of ["s3cr", "et = pa ss", "pa ss", password, escapeOptionValue(password)]) {
      expect(out).not.toContain(fragment);
    }
    expect(out).not.toContain("username=backup");
    expect(out).toContain("permission denied");
    expect(classifyMountError(docker)).toBe("mount.auth_failed");
  });

  it("removes password= and pass= pairs it was not told about", () => {
    const redactor = new RunnerRedactor(new Redactor(), []);
    expect(redactor.redact("mount error: pass=abc,password=def x")).toBe(
      "mount error: pass=[redacted],password=[redacted] x",
    );
    expect(redactor.redact("failed: data: addr=1.2.3.4,password=zz,,y")).toBe(
      "failed: data: [redacted]",
    );
  });

  it("removes the run token and caps tails", () => {
    const token = "T".repeat(43);
    const redactor = RunnerRedactor.forShare(new Redactor(), specs[2] as ShareSpec, [token]);
    expect(redactor.oneLine(`token is ${token}\n next`)).toBe("token is [redacted] next");
    expect(redactor.tail("x".repeat(5000), 4096).length).toBe(4099);
  });
});

describe("mount error classification", () => {
  const table: [string, string][] = [
    ["mount error(13): Permission denied", "mount.auth_failed"],
    [
      "failed to mount local volume: mount //a/b:/x, data: ...: key has expired",
      "mount.auth_failed",
    ],
    ["mount: no route to host", "mount.unreachable"],
    ["mount: host is down", "mount.unreachable"],
    ["mount: connection refused", "mount.unreachable"],
    ["mount: connection timed out", "mount.unreachable"],
    ["mount: network is unreachable", "mount.unreachable"],
    ["mount: no such file or directory", "mount.not_found"],
    ["mount: no such device or address", "mount.not_found"],
    ["mount: operation not supported", "mount.version"],
    ["mount: protocol not supported", "mount.version"],
    ["mount: invalid argument", "mount.version"],
    ["mount: unknown filesystem type 'cifs'", "mount.client_missing"],
    ["mount: no such device", "mount.client_missing"],
    ["mount: something else", "mount.failed"],
  ];
  for (const [message, code] of table) {
    it(`${message} -> ${code}`, () => {
      expect(classifyMountError(message)).toBe(code);
    });
  }
  it("tells an expired password", () => {
    expect(isExpiredKey("mount: key has expired")).toBe(true);
    expect(isExpiredKey("mount: permission denied")).toBe(false);
  });
});

describe("container specifications", () => {
  const runId = "0f1e2d3c-4b5a-4968-8776-655443322110";
  const shareId = "5b0c6f0e-9f5c-4c8a-9d55-1a2b3c4d5e6f";
  const names = runNames(runId, shareId, "source");

  it("names a run's volumes and container", () => {
    expect(names).toEqual({
      container: `restow-runner-${runId}`,
      shareVolume: "restow-share-0f1e2d3c-source",
      scratchVolume: `restow-share-scratch-${runId}`,
      cacheVolume: `restow-share-cache-${shareId}`,
    });
  });

  it("runs a backup with the file capabilities only, on the runners network", () => {
    const body = runContainerSpec({
      image: "sha256:api",
      runId,
      kind: "backup",
      token: "T".repeat(43),
      apiUrl: "http://api:3000",
      network: "restow_runners",
      protocol: "smb",
      ...names,
      readOnly: true,
      memoryMiB: 2048,
      goMemLimitMiB: 1638,
      deadline: "2026-10-12T22:00:00.000Z",
      shareId,
    });
    expect(body.Image).toBe("sha256:api");
    expect(body.Entrypoint).toEqual(["/usr/local/bin/restow-share"]);
    expect(body.Cmd).toEqual(["run"]);
    expect(body.HostConfig.NetworkMode).toBe("restow_runners");
    expect(body.HostConfig.CapDrop).toEqual(["ALL"]);
    expect(body.HostConfig.CapAdd).toEqual(["DAC_READ_SEARCH", "DAC_OVERRIDE"]);
    expect(body.HostConfig.ReadonlyRootfs).toBe(true);
    expect(body.HostConfig.Privileged).toBe(false);
    expect(body.HostConfig.SecurityOpt).toEqual(["no-new-privileges:true"]);
    expect(body.HostConfig.Memory).toBe(2048 * 1024 * 1024);
    expect(body.HostConfig.MemorySwap).toBe(body.HostConfig.Memory);
    expect(body.HostConfig.PidsLimit).toBe(256);
    expect(body.HostConfig.Binds).toEqual([
      "restow-share-0f1e2d3c-source:/share:ro",
      `restow-share-scratch-${runId}:/.restow`,
      `restow-share-cache-${shareId}:/cache`,
    ]);
    expect(body.Env).toContain("GOMEMLIMIT=1638MiB");
    expect(body.Env).toContain(`RESTOW_SHARE_RUN_ID=${runId}`);
    expect(body.Labels?.[RUNNER_LABEL]).toBe(runId);
    // No secret in the command line.
    expect(JSON.stringify(body.Cmd)).not.toContain("T".repeat(43));
  });

  it("gives a restore the owner capabilities and a writable share", () => {
    expect(capabilitiesFor("restore")).toEqual([
      "DAC_READ_SEARCH",
      "DAC_OVERRIDE",
      "CHOWN",
      "FOWNER",
      "FSETID",
    ]);
  });

  it("runs a test without network, labelled as a probe", () => {
    const body = execContainerSpec({
      image: "sha256:api",
      request: { op: "list", share: specs[0] as ShareSpec, path: "A B", limit: 50 },
      volume: "restow-share-exec-1",
    });
    expect(body.NetworkDisabled).toBe(true);
    expect(body.HostConfig.NetworkMode).toBe("none");
    expect(body.Cmd).toEqual(["list", "--path", "A B", "--limit", "50"]);
    expect(body.Labels).toEqual({ [PROBE_LABEL]: "1" });
    expect(body.HostConfig.Binds).toEqual(["restow-share-exec-1:/share:ro"]);
    expect(body.Env).toEqual([
      "RESTOW_SHARE_EXPECT=smb",
      "HOME=/tmp",
      "PATH=/usr/local/bin:/usr/bin:/bin",
    ]);
  });
});
