import { describe, expect, it } from "vitest";
import { defaultEndpointConfig } from "./config.js";
import {
  cleanDataFolderReport,
  DATA_FOLDER_CANDIDATES,
  enrollmentProfile,
  excludePatternMatches,
  isExcludedPath,
  isFolderBackedUp,
  missingDataFolders,
  withDataFolder,
} from "./data-folders.js";

const options = { timeZone: "Europe/Berlin" };
const server = defaultEndpointConfig("linux", "server", options);
const client = defaultEndpointConfig("linux", "client", options);

describe("data folder reports", () => {
  it("keeps the candidates of the system, once and in their order", () => {
    expect(
      cleanDataFolderReport("linux", ["/var/lib/mysql", "/opt", "/opt", "/etc/shadow", 7]),
    ).toEqual(["/opt", "/var/lib/mysql"]);
  });

  it("reads a missing report as none (an agent before 0.4.0)", () => {
    expect(cleanDataFolderReport("linux", undefined)).toBeNull();
    expect(cleanDataFolderReport("linux", null)).toBeNull();
    expect(cleanDataFolderReport("linux", [])).toEqual([]);
  });

  it("checks no folders on macOS and Windows", () => {
    expect(DATA_FOLDER_CANDIDATES.darwin).toEqual([]);
    expect(cleanDataFolderReport("darwin", ["/opt"])).toEqual([]);
  });
});

describe("restic exclude patterns", () => {
  it("matches the path and everything below an absolute pattern", () => {
    expect(excludePatternMatches("/var/lib/docker", "/var/lib/docker")).toBe(true);
    expect(excludePatternMatches("/var/lib/docker", "/var/lib/docker/volumes")).toBe(true);
    expect(excludePatternMatches("/var/lib/docker", "/var/lib")).toBe(false);
    expect(excludePatternMatches("/var/lib/docker", "/var/lib/dockerd")).toBe(false);
    expect(excludePatternMatches("/var/lib/docker/*", "/var/lib/docker")).toBe(false);
    expect(excludePatternMatches("/var/lib/docker/*", "/var/lib/docker/volumes/x")).toBe(true);
  });

  it("matches a relative pattern from any folder on", () => {
    expect(excludePatternMatches("*.tmp", "/srv/a.tmp")).toBe(true);
    expect(excludePatternMatches("**/node_modules", "/opt/app/node_modules/x")).toBe(true);
    expect(excludePatternMatches("**/.cache", "/opt")).toBe(false);
  });

  it("lets the last matching pattern decide", () => {
    const excludes = ["/var/lib/docker/*", "!/var/lib/docker/volumes"];
    expect(isExcludedPath(excludes, "/var/lib/docker/volumes/db/_data")).toBe(false);
    expect(isExcludedPath(excludes, "/var/lib/docker/overlay2")).toBe(true);
  });
});

describe("whether a folder is backed up", () => {
  it("says what the client folders leave out (#59)", () => {
    const reported = ["/opt", "/srv", "/var/lib/postgresql", "/var/lib/docker/volumes"];
    expect(missingDataFolders(reported, client)).toEqual([
      "/opt",
      "/var/lib/postgresql",
      "/var/lib/docker/volumes",
    ]);
  });

  it("counts the Docker volumes as left out by the default exclusion of /var/lib/docker", () => {
    expect(isFolderBackedUp(server, "/var/lib/postgresql")).toBe(true);
    expect(isFolderBackedUp(server, "/var/lib/docker/volumes")).toBe(false);
  });

  it("does not see through an excluded parent", () => {
    const selection = {
      paths: ["/var/lib"],
      excludes: ["/var/lib/docker", "!/var/lib/docker/volumes"],
    };
    // restic does not go into /var/lib/docker, so the take-back never applies.
    expect(isFolderBackedUp(selection, "/var/lib/docker/volumes")).toBe(false);
  });
});

describe("adding a data folder", () => {
  it("adds the folder to the paths", () => {
    expect(withDataFolder(client, "/opt")).toEqual({
      paths: [...client.paths, "/opt"],
      excludes: client.excludes,
    });
  });

  it("replaces the paths below the folder", () => {
    expect(withDataFolder({ paths: ["/etc", "/opt/app"], excludes: [] }, "/opt").paths).toEqual([
      "/etc",
      "/opt",
    ]);
  });

  it("narrows the exclusion of /var/lib/docker to everything but the volumes", () => {
    const next = withDataFolder(server, "/var/lib/docker/volumes");
    expect(next.paths).toEqual(server.paths);
    expect(next.excludes).not.toContain("/var/lib/docker");
    expect(next.excludes).toContain("/var/lib/docker/*");
    expect(next.excludes).toContain("!/var/lib/docker/volumes");
    expect(isFolderBackedUp(next, "/var/lib/docker/volumes")).toBe(true);
    expect(isFolderBackedUp(next, "/var/lib/docker/overlay2")).toBe(false);
  });

  it("adds the volumes of a client job as a path of their own", () => {
    const next = withDataFolder(
      { paths: ["/etc"], excludes: ["/var/lib/docker", "/tmp"] },
      "/var/lib/docker/volumes",
    );
    expect(next).toEqual({
      paths: ["/etc", "/var/lib/docker/volumes"],
      excludes: ["/var/lib/docker/*", "!/var/lib/docker/volumes", "/tmp"],
    });
    expect(isFolderBackedUp(next, "/var/lib/docker/volumes")).toBe(true);
  });

  it("drops an exclusion of the folder itself and keeps patterns with wildcards", () => {
    expect(withDataFolder({ paths: ["/"], excludes: ["/opt", "/var/*"] }, "/opt")).toEqual({
      paths: ["/"],
      excludes: ["/var/*"],
    });
  });
});

describe("the profile at enrollment", () => {
  const container = { virtualization: "container", technology: "lxc", desktop: false } as const;
  const vm = { virtualization: "vm", technology: "kvm", desktop: false } as const;

  it("makes a Linux client in a container or a VM without a desktop a server", () => {
    expect(enrollmentProfile("client", "linux", container)).toEqual({
      profile: "server",
      reason: "container",
    });
    expect(enrollmentProfile("client", "linux", vm)).toEqual({ profile: "server", reason: "vm" });
  });

  it("keeps the token's profile otherwise", () => {
    expect(enrollmentProfile("client", "linux", { ...vm, desktop: true }).profile).toBe("client");
    expect(
      enrollmentProfile("client", "linux", {
        virtualization: "none",
        technology: "",
        desktop: false,
      }).profile,
    ).toBe("client");
    expect(enrollmentProfile("client", "darwin", vm).profile).toBe("client");
    expect(enrollmentProfile("client", "linux", null).profile).toBe("client");
    expect(enrollmentProfile("server", "linux", container)).toEqual({
      profile: "server",
      reason: null,
    });
  });
});
