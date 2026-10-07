import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EngineClient } from "./engine-api.js";
import { FakeEngineApi } from "./fake-engine-api.js";
import { memoryLogger } from "./logger.js";
import { Redactor } from "./redact.js";
import { HELPER_LABEL } from "./runner-helper.js";
import {
  EngineSelfRecreateLauncher,
  MOUNTER_RECREATE_LABEL,
  MOUNTER_RECREATE_TARGET,
  SELF_RECREATE_LABEL,
  selfRecreateCommand,
} from "./self-recreate.js";

let api: FakeEngineApi;
let redactor: Redactor;

beforeEach(async () => {
  api = new FakeEngineApi();
  await api.start();
  api.images.add("docker:27-cli");
  redactor = new Redactor();
});

afterEach(async () => {
  await api.stop();
});

function launcher(composeFile: string | null = null): EngineSelfRecreateLauncher {
  return new EngineSelfRecreateLauncher({
    engine: new EngineClient({ socketPath: api.socketPath, redactor, requestTimeoutMs: 2000 }),
    redactor,
    logger: memoryLogger(redactor),
    cliImage: "docker:27-cli",
    hostProjectDir: "/opt/restow",
    dockerSocket: "/var/run/docker.sock",
    projectName: "restow",
    composeFile,
  });
}

describe("selfRecreateCommand", () => {
  it("recreates only the updater service, without building, with the project's own files", () => {
    expect(selfRecreateCommand("restow", null)).toEqual([
      "docker",
      "compose",
      "-p",
      "restow",
      "--profile",
      "updater",
      "up",
      "-d",
      "--no-deps",
      "--no-build",
      "--pull",
      "missing",
      "updater",
    ]);
    expect(selfRecreateCommand("restow", "compose.yaml").slice(4, 6)).toEqual([
      "-f",
      "compose.yaml",
    ]);
  });
});

describe("EngineSelfRecreateLauncher", () => {
  it("starts a helper with its own label, the socket and the project at the host path, no network", async () => {
    const handle = await launcher().launch();
    const body = [...api.created.values()][0] as Record<string, unknown>;
    expect(body).toMatchObject({
      Image: "docker:27-cli",
      Entrypoint: [],
      Cmd: selfRecreateCommand("restow", null),
      WorkingDir: "/opt/restow",
      Labels: { [SELF_RECREATE_LABEL]: "1" },
      NetworkDisabled: true,
      HostConfig: {
        Binds: ["/var/run/docker.sock:/var/run/docker.sock", "/opt/restow:/opt/restow"],
        NetworkMode: "none",
        Privileged: false,
        SecurityOpt: ["no-new-privileges:true"],
      },
    });
    // Not the label the new updater removes on its start.
    expect(body.Labels).not.toHaveProperty(HELPER_LABEL);
    expect(await handle.wait(5000)).toEqual({ exitCode: 0, output: "" });
    expect(api.removed).toHaveLength(1);
  });

  it("reports the helper's exit code and output tail", async () => {
    api.nextContainer = { exitCode: 1, stderr: [Buffer.from("no such service: updater\n")] };
    const handle = await launcher().launch();
    const result = await handle.wait(5000);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("no such service: updater");
  });

  it("does not remove a helper that is still running when it gives up waiting", async () => {
    api.nextContainer = { exitCode: 0, hang: true };
    const handle = await launcher().launch();
    expect((await handle.wait(50)).exitCode).toBeNull();
    expect(api.removed).toEqual([]);
  });

  it("throws and cleans up when the helper cannot be started", async () => {
    api.startStatus = 500;
    await expect(launcher().launch()).rejects.toThrow();
    expect(api.removed).toHaveLength(1);
  });

  it("removes only finished helpers of an earlier self-update", async () => {
    api.labelled = ["done0000000000000", "busy0000000000000"];
    api.running.set("done0000000000000", false);
    api.running.set("busy0000000000000", true);
    expect(await launcher().removeFinished()).toBe(1);
    expect(api.removed).toEqual(["done0000000000000"]);
  });

  it("recreates the mounter with the mounts profile under a label of its own", async () => {
    const mounter = new EngineSelfRecreateLauncher({
      engine: new EngineClient({ socketPath: api.socketPath, redactor, requestTimeoutMs: 2000 }),
      redactor,
      logger: memoryLogger(redactor),
      cliImage: "docker:27-cli",
      hostProjectDir: "/opt/restow",
      dockerSocket: "/var/run/docker.sock",
      projectName: "restow",
      composeFile: null,
      target: MOUNTER_RECREATE_TARGET,
    });
    const handle = await mounter.launch();
    const body = [...api.created.values()][0] as Record<string, unknown>;
    expect(body).toMatchObject({
      Cmd: [
        "docker",
        "compose",
        "-p",
        "restow",
        "--profile",
        "mounts",
        "up",
        "-d",
        "--no-deps",
        "--no-build",
        "--pull",
        "missing",
        "mounter",
      ],
      Labels: { [MOUNTER_RECREATE_LABEL]: "1" },
      NetworkDisabled: true,
    });
    expect(body.Labels).not.toHaveProperty(SELF_RECREATE_LABEL);
    expect(await handle.wait(5000)).toEqual({ exitCode: 0, output: "" });
    expect(api.removed).toHaveLength(1);
  });
});

describe("EngineClient.imageRepoDigests", () => {
  it("lists the registry digests of a local image, and null when there is none", async () => {
    const engine = new EngineClient({ socketPath: api.socketPath, redactor });
    api.images.add("ghcr.io/restow-backup/restow:0.2.0");
    api.repoDigests.set("ghcr.io/restow-backup/restow:0.2.0", [
      `ghcr.io/restow-backup/restow@sha256:${"a".repeat(64)}`,
    ]);
    expect(await engine.imageRepoDigests("ghcr.io/restow-backup/restow:0.2.0")).toEqual([
      `ghcr.io/restow-backup/restow@sha256:${"a".repeat(64)}`,
    ]);
    expect(await engine.imageRepoDigests("restow:missing")).toBeNull();
  });
});
