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
    });
    expect(config.cliImage).toMatch(/@sha256:[0-9a-f]{64}$/);
  });

  it("takes the project directory the operator set", () => {
    expect(loadMounterConfig({ RESTOW_MOUNTER_PROJECT_DIR: "/opt/restow/" }).projectDir).toBe(
      "/opt/restow",
    );
  });

  it("refuses unsafe values", () => {
    for (const env of [
      { RESTOW_MOUNTER_PROJECT_DIR: "relative" },
      { RESTOW_MOUNTER_PROJECT_DIR: "/opt/a,b" },
      { RESTOW_MOUNTER_PROJECT_NAME: "Bad Name" },
      { RESTOW_MOUNTER_CLI_IMAGE: "docker:27-cli" },
      { RESTOW_MOUNTER_PORT: "0" },
      { RESTOW_MOUNTER_HEALTH_TIMEOUT_SECONDS: "1" },
    ]) {
      expect(() => loadMounterConfig(env), JSON.stringify(env)).toThrow(MounterConfigError);
    }
  });
});
