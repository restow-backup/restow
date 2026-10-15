import { describe, expect, it } from "vitest";
import { MounterConfigError, loadMounterConfig } from "./config.js";

describe("loadMounterConfig", () => {
  it("has defaults that match the compose files", () => {
    const config = loadMounterConfig({});
    expect(config).toMatchObject({
      port: 8091,
      stateDir: "/state",
      sharedDir: "/mounter-shared",
      projectDir: null,
      projectName: null,
      dockerSocket: "/var/run/docker.sock",
      healthTimeoutSeconds: 300,
      probeTimeoutSeconds: 60,
      version: null,
      runner: {
        maxRunners: 8,
        apiUrl: "http://api:3000",
        networkKey: "runners",
        execTimeoutSeconds: 60,
        maxMemoryMiB: 16384,
        selinux: false,
      },
    });
    expect(config.cliImage).toMatch(/@sha256:[0-9a-f]{64}$/);
  });

  it("takes the project directory the operator set", () => {
    expect(loadMounterConfig({ RESTOW_MOUNTER_PROJECT_DIR: "/opt/restow/" }).projectDir).toBe(
      "/opt/restow",
    );
  });

  it("reads the runner settings", () => {
    const config = loadMounterConfig({
      RESTOW_MOUNTER_MAX_RUNNERS: "3",
      RESTOW_MOUNTER_RUNNER_API_URL: "http://api:3000/",
      RESTOW_MOUNTER_SELINUX_CONTEXT: "true",
    });
    expect(config.runner).toMatchObject({
      maxRunners: 3,
      apiUrl: "http://api:3000",
      selinux: true,
    });
  });

  it("refuses unsafe values", () => {
    for (const env of [
      { RESTOW_MOUNTER_PROJECT_DIR: "relative" },
      { RESTOW_MOUNTER_PROJECT_DIR: "/opt/a,b" },
      { RESTOW_MOUNTER_PROJECT_NAME: "Bad Name" },
      { RESTOW_MOUNTER_CLI_IMAGE: "docker:27-cli" },
      { RESTOW_MOUNTER_PORT: "0" },
      { RESTOW_MOUNTER_HEALTH_TIMEOUT_SECONDS: "1" },
      { RESTOW_MOUNTER_MAX_RUNNERS: "0" },
      { RESTOW_MOUNTER_RUNNER_API_URL: "http://user:pw@api:3000" },
      { RESTOW_MOUNTER_RUNNER_API_URL: "http://api:3000/path" },
      { RESTOW_MOUNTER_RUNNER_NETWORK: "Bad Net" },
      { RESTOW_MOUNTER_RUNNER_EXEC_TIMEOUT_SECONDS: "1" },
      { RESTOW_MOUNTER_RUNNER_MAX_MEMORY_MIB: "10" },
      { RESTOW_MOUNTER_SELINUX_CONTEXT: "maybe" },
    ]) {
      expect(() => loadMounterConfig(env), JSON.stringify(env)).toThrow(MounterConfigError);
    }
  });
});
