import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ConfigError,
  PROJECT_MOUNT,
  findComposeFile,
  loadConfig,
  resolveProjectLocation,
} from "./config.js";
import { DEFAULT_CLI_IMAGE, DEFAULT_COSIGN_IMAGE } from "./signature.js";

const PINNED_CLI = `docker:28-cli@sha256:${"a".repeat(64)}`;
const PINNED_COSIGN = `registry.example.com/mirror/cosign:v3.1.3@sha256:${"b".repeat(64)}`;

const REQUIRED = { RESTOW_UPDATER_PROJECT_DIR: "/srv/restow" };

describe("loadConfig", () => {
  it("applies the documented defaults", () => {
    expect(loadConfig(REQUIRED)).toEqual({
      port: 8090,
      stateDir: "/state",
      sharedDir: "/updater-shared",
      projectDir: "/srv/restow",
      projectName: null,
      composeFile: null,
      apiUrl: "http://api:3000",
      imageVariant: "full",
      imageRepository: "ghcr.io/restow-backup/restow",
      webImageRepository: "ghcr.io/restow-backup/restow-web",
      cliImage: DEFAULT_CLI_IMAGE,
      cosignImage: DEFAULT_COSIGN_IMAGE,
      verifySignatures: true,
      selfUpdate: true,
      healthTimeoutSeconds: 600,
      minFreeMb: 1024,
      dockerSocket: "/var/run/docker.sock",
      version: null,
      // Deny by default: `source` mode stays off until the operator names a source.
      sourceAllowlist: [],
    });
  });

  it("reads every variable", () => {
    const config = loadConfig({
      RESTOW_UPDATER_PORT: "9000",
      RESTOW_UPDATER_STATE_DIR: "/var/lib/updater/state/",
      RESTOW_UPDATER_SHARED_DIR: "/shared",
      RESTOW_UPDATER_PROJECT_DIR: "/opt/restow/",
      RESTOW_UPDATER_PROJECT_NAME: "my-restow",
      RESTOW_UPDATER_COMPOSE_FILE: "compose.prod.yml",
      RESTOW_UPDATER_API_URL: "http://restow-api:3000/",
      RESTOW_UPDATER_IMAGE_REPOSITORY: "registry.example.com:5000/acme/restow",
      RESTOW_UPDATER_WEB_IMAGE_REPOSITORY: "registry.example.com:5000/acme/restow-web",
      RESTOW_UPDATER_CLI_IMAGE: PINNED_CLI,
      RESTOW_UPDATER_COSIGN_IMAGE: PINNED_COSIGN,
      RESTOW_UPDATER_VERIFY_SIGNATURES: "FALSE",
      RESTOW_UPDATER_HEALTH_TIMEOUT_SECONDS: "120",
      RESTOW_UPDATER_MIN_FREE_MB: "0",
      RESTOW_UPDATER_DOCKER_SOCKET: "/run/docker.sock",
      RESTOW_VERSION: " 0.1.0 ",
      RESTOW_UPDATER_SOURCE_HOSTS: "GitHub.com/Acme/Restow, git.example.com",
    });
    expect(config).toMatchObject({
      port: 9000,
      stateDir: "/var/lib/updater/state",
      sharedDir: "/shared",
      projectDir: "/opt/restow",
      projectName: "my-restow",
      composeFile: "compose.prod.yml",
      apiUrl: "http://restow-api:3000",
      imageRepository: "registry.example.com:5000/acme/restow",
      cliImage: PINNED_CLI,
      cosignImage: PINNED_COSIGN,
      verifySignatures: false,
      healthTimeoutSeconds: 120,
      minFreeMb: 0,
      dockerSocket: "/run/docker.sock",
      version: "0.1.0",
      sourceAllowlist: [
        { host: "github.com", repository: "acme/restow" },
        { host: "git.example.com", repository: null },
      ],
    });
  });

  it("stays on the Community images when the image is the Community build", () => {
    const config = loadConfig({ ...REQUIRED, RESTOW_IMAGE_VARIANT: "community" });
    expect(config.imageVariant).toBe("community");
    expect(config.imageRepository).toBe("ghcr.io/restow-backup/restow-community");
    expect(config.webImageRepository).toBe("ghcr.io/restow-backup/restow-web-community");
  });

  it("reads RESTOW_IMAGE_VARIANT=full exactly like an image without the variable", () => {
    expect(loadConfig({ ...REQUIRED, RESTOW_IMAGE_VARIANT: "full" })).toEqual(loadConfig(REQUIRED));
  });

  it("lets the operator's repositories win over the variant's defaults", () => {
    const config = loadConfig({
      ...REQUIRED,
      RESTOW_IMAGE_VARIANT: "community",
      RESTOW_UPDATER_IMAGE_REPOSITORY: "registry.example.com/acme/restow-community",
      RESTOW_UPDATER_WEB_IMAGE_REPOSITORY: "registry.example.com/acme/restow-web-community",
    });
    expect(config).toMatchObject({
      imageVariant: "community",
      imageRepository: "registry.example.com/acme/restow-community",
      webImageRepository: "registry.example.com/acme/restow-web-community",
    });
  });

  it("refuses an unknown variant instead of guessing which images to install", () => {
    expect(() => loadConfig({ ...REQUIRED, RESTOW_IMAGE_VARIANT: "enterprise" })).toThrow(
      /RESTOW_IMAGE_VARIANT must be full or community/,
    );
  });

  it("takes the project directory as optional: without it the mount at /project decides", () => {
    expect(loadConfig({}).projectDir).toBeNull();
    expect(loadConfig({ RESTOW_UPDATER_PROJECT_DIR: "  " }).projectDir).toBeNull();
    expect(() => loadConfig({ RESTOW_UPDATER_PROJECT_DIR: "relative/path" })).toThrow(ConfigError);
  });

  it("updates itself by default and only `false` switches that off", () => {
    expect(loadConfig(REQUIRED).selfUpdate).toBe(true);
    expect(loadConfig({ ...REQUIRED, RESTOW_UPDATER_SELF_UPDATE: "true" }).selfUpdate).toBe(true);
    expect(loadConfig({ ...REQUIRED, RESTOW_UPDATER_SELF_UPDATE: "FALSE" }).selfUpdate).toBe(false);
    expect(() => loadConfig({ ...REQUIRED, RESTOW_UPDATER_SELF_UPDATE: "no" })).toThrow(
      /RESTOW_UPDATER_SELF_UPDATE must be true or false/,
    );
  });

  it.each([
    ["RESTOW_UPDATER_PORT", "0"],
    ["RESTOW_UPDATER_PORT", "abc"],
    ["RESTOW_UPDATER_STATE_DIR", "state"],
    ["RESTOW_UPDATER_PROJECT_DIR", "/srv/a:b"],
    ["RESTOW_UPDATER_PROJECT_DIR", "/srv/../etc"],
    ["RESTOW_UPDATER_PROJECT_NAME", "Bad Name"],
    ["RESTOW_UPDATER_COMPOSE_FILE", "../other.yml"],
    ["RESTOW_UPDATER_API_URL", "ftp://api"],
    ["RESTOW_UPDATER_API_URL", "http://user:pw@api:3000"],
    ["RESTOW_UPDATER_IMAGE_REPOSITORY", "ghcr.io/x/restow:1.0"],
    ["RESTOW_UPDATER_IMAGE_REPOSITORY", "UPPER/case"],
    ["RESTOW_UPDATER_CLI_IMAGE", "docker cli"],
    // A tag can be moved under the updater; only a digest pins the image.
    ["RESTOW_UPDATER_CLI_IMAGE", "docker:27-cli"],
    ["RESTOW_UPDATER_CLI_IMAGE", "docker:27-cli@sha256:abc"],
    ["RESTOW_UPDATER_COSIGN_IMAGE", "ghcr.io/sigstore/cosign/cosign:v3.1.3"],
    ["RESTOW_UPDATER_VERIFY_SIGNATURES", "maybe"],
    ["RESTOW_UPDATER_SELF_UPDATE", "1"],
    ["RESTOW_UPDATER_HEALTH_TIMEOUT_SECONDS", "5"],
    ["RESTOW_UPDATER_MIN_FREE_MB", "-1"],
    ["RESTOW_UPDATER_SOURCE_HOSTS", "bad host"],
    ["RESTOW_UPDATER_SOURCE_HOSTS", "git.example.com/acme"],
    ["RESTOW_UPDATER_SOURCE_HOSTS", "https://git.example.com/acme/restow"],
    ["RESTOW_UPDATER_SOURCE_HOSTS", "git.example.com/a/b/c"],
  ])("rejects %s=%s", (name, value) => {
    expect(() => loadConfig({ ...REQUIRED, [name]: value })).toThrow(ConfigError);
  });

  it("lists every problem and never echoes the values", () => {
    try {
      loadConfig({
        RESTOW_UPDATER_API_URL: "http://user:topsecret@api:3000",
        RESTOW_UPDATER_PORT: "-3",
        RESTOW_UPDATER_PROJECT_DIR: "relative/path",
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const problems = (error as ConfigError).problems;
      expect(problems.length).toBe(3);
      expect((error as Error).message).not.toContain("topsecret");
    }
  });

  it("does not read any application credential", () => {
    const config = loadConfig({
      ...REQUIRED,
      DATABASE_URL: "postgres://x:y@z/db",
      RESTOW_MASTER_KEY: "k".repeat(32),
    });
    expect(JSON.stringify(config)).not.toContain("postgres://");
    expect(JSON.stringify(config)).not.toContain("kkkk");
  });
});

describe("findComposeFile", () => {
  it("returns the first default that exists, or the explicit file", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "restow-updater-config-"));
    try {
      expect(await findComposeFile(dir, null)).toBeNull();
      await fs.writeFile(path.join(dir, "compose.yaml"), "name: x\n");
      expect(await findComposeFile(dir, null)).toBe("compose.yaml");
      await fs.writeFile(path.join(dir, "docker-compose.yml"), "name: x\n");
      expect(await findComposeFile(dir, null)).toBe("docker-compose.yml");
      expect(await findComposeFile(dir, "compose.yaml")).toBe("compose.yaml");
      expect(await findComposeFile(dir, "missing.yml")).toBeNull();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("resolveProjectLocation", () => {
  const bind = (Source: string, Destination = PROJECT_MOUNT) => ({
    Type: "bind",
    Source,
    Destination,
  });

  it("uses RESTOW_PROJECT_DIR on both sides when it is set", () => {
    expect(resolveProjectLocation("/opt/restow", { mounts: [bind("/elsewhere")] })).toEqual({
      hostDir: "/opt/restow",
      localDir: "/opt/restow",
    });
  });

  it("reads the host path from the bind mount at /project when it is not set", () => {
    expect(resolveProjectLocation(null, { mounts: [bind("/opt/restow")] })).toEqual({
      hostDir: "/opt/restow",
      localDir: PROJECT_MOUNT,
    });
  });

  it("names the problem when neither is there, or the source is not a plain path", () => {
    expect(resolveProjectLocation(null, null)).toHaveProperty("problem");
    expect(resolveProjectLocation(null, { mounts: [bind("/opt/restow", "/data")] })).toHaveProperty(
      "problem",
    );
    expect(
      resolveProjectLocation(null, {
        mounts: [{ Type: "volume", Source: "/var/lib/docker/x", Destination: PROJECT_MOUNT }],
      }),
    ).toHaveProperty("problem");
    expect(resolveProjectLocation(null, { mounts: [bind("/opt/a:b")] })).toHaveProperty("problem");
  });
});
