import { describe, expect, it } from "vitest";

import {
  addFolder,
  baseName,
  isAbsolutePath,
  isChosen,
  isCovered,
  isExcludedPath,
  isFolderBackedUp,
  isInside,
  missingReportedFolders,
  normalizePath,
  pathProblem,
  pathsProblem,
  removeFolder,
  toggleFolder,
  uncoveredDataFolders,
  withDataFolder,
} from "./folders.js";

describe("path rules, the same as the API's", () => {
  it("wants an absolute path: a slash or a drive letter", () => {
    expect(isAbsolutePath("/var/www")).toBe(true);
    expect(isAbsolutePath("C:\\Users")).toBe(true);
    expect(isAbsolutePath("D:/Data")).toBe(true);
    expect(isAbsolutePath("var/www")).toBe(false);
    expect(isAbsolutePath("~/docs")).toBe(false);
    expect(isAbsolutePath("")).toBe(false);
  });

  it("names the first problem of a path", () => {
    expect(pathProblem("")).toBe("empty");
    expect(pathProblem("   ")).toBe("empty");
    expect(pathProblem("relative/dir")).toBe("notAbsolute");
    expect(pathProblem("/a\u0007b")).toBe("controlCharacters");
    expect(pathProblem(`/${"a".repeat(1024)}`)).toBe("tooLong");
    expect(pathProblem(`/${"a".repeat(1023)}`)).toBeNull();
    expect(pathProblem("/etc")).toBeNull();
  });

  it("checks the whole list: at least one, at most 200", () => {
    expect(pathsProblem([])).toEqual({ code: "none" });
    expect(pathsProblem(Array.from({ length: 201 }, (_, index) => `/p${index}`))).toEqual({
      code: "tooMany",
      max: 200,
    });
    expect(pathsProblem(["/etc", "nope"])).toEqual({ code: "notAbsolute", value: "nope" });
    expect(pathsProblem(["/etc", "/var"])).toBeNull();
  });
});

describe("folders cover what is below them", () => {
  it("normalises trailing separators but keeps a root", () => {
    expect(normalizePath("/var/www/")).toBe("/var/www");
    expect(normalizePath("/")).toBe("/");
    expect(normalizePath("C:\\")).toBe("C:\\");
    expect(normalizePath("C:\\Users\\")).toBe("C:\\Users");
  });

  it("knows what is inside what", () => {
    expect(isInside("/var", "/var/www")).toBe(true);
    expect(isInside("/var", "/var")).toBe(true);
    expect(isInside("/var", "/variable")).toBe(false);
    expect(isInside("/", "/etc")).toBe(true);
    expect(isInside("C:\\Users", "C:\\Users\\anna")).toBe(true);
    expect(isCovered(["/etc", "/var"], "/var/log/syslog")).toBe(true);
    expect(isCovered(["/etc"], "/var")).toBe(false);
    expect(isChosen(["/etc/"], "/etc")).toBe(true);
    expect(isChosen(["/etc"], "/etc/ssh")).toBe(false);
  });

  it("adds a folder and takes the ones it covers out of the list", () => {
    expect(addFolder(["/var/www", "/var/log", "/etc"], "/var")).toEqual(["/etc", "/var"]);
  });

  it("adds nothing below a chosen folder and nothing twice", () => {
    expect(addFolder(["/var"], "/var/www")).toEqual(["/var"]);
    expect(addFolder(["/var"], "/var/")).toEqual(["/var"]);
  });

  it("ticks and unticks, and a folder below a chosen one cannot be unticked on its own", () => {
    expect(toggleFolder(["/etc"], "/var")).toEqual(["/etc", "/var"]);
    expect(toggleFolder(["/etc", "/var"], "/var")).toEqual(["/etc"]);
    expect(toggleFolder(["/var"], "/var/www")).toEqual(["/var"]);
    expect(removeFolder(["/var"], "/var/www")).toEqual(["/var"]);
  });

  it("names a folder by its last segment", () => {
    expect(baseName("/var/www/")).toBe("www");
    expect(baseName("C:\\Users\\anna")).toBe("anna");
    expect(baseName("/")).toBe("/");
  });
});

describe("uncoveredDataFolders (#59)", () => {
  it("names the data folders a client-style job leaves out", () => {
    expect(uncoveredDataFolders(["/etc", "/home", "/root", "/srv", "/var/www"])).toEqual([
      "/opt",
      "/usr/local",
      "/var/lib",
      "/var/backups",
    ]);
  });

  it("is empty for the server defaults, a covering parent or the root", () => {
    const server = [
      "/etc",
      "/home",
      "/root",
      "/srv",
      "/var/www",
      "/opt",
      "/usr/local",
      "/var/lib",
      "/var/backups",
    ];
    expect(uncoveredDataFolders(server)).toEqual([]);
    expect(uncoveredDataFolders(["/"])).toEqual([]);
    expect(uncoveredDataFolders(["/home", "/root", "/srv", "/var", "/opt", "/usr"])).toEqual([]);
  });

  it("does not count a subfolder as the whole folder", () => {
    expect(
      uncoveredDataFolders([
        "/opt/paperless",
        "/home",
        "/root",
        "/srv",
        "/var/www",
        "/usr/local",
        "/var/lib",
        "/var/backups",
      ]),
    ).toEqual(["/opt"]);
  });
});

describe("data folders the agents found (#59), the same rules as the server's", () => {
  const client = ["/etc", "/home", "/root", "/srv", "/var/www"];
  const linuxExcludes = ["**/node_modules", "*.tmp", "/var/lib/docker", "/tmp"];

  it("reads restic's exclusions: everything below, the last match decides", () => {
    expect(isExcludedPath(["/var/lib/docker"], "/var/lib/docker/volumes")).toBe(true);
    expect(isExcludedPath(["*.tmp"], "/srv/a.tmp/b")).toBe(true);
    expect(
      isExcludedPath(
        ["/var/lib/docker/*", "!/var/lib/docker/volumes"],
        "/var/lib/docker/volumes/x",
      ),
    ).toBe(false);
  });

  it("does not count the Docker volumes under an excluded /var/lib/docker", () => {
    expect(isFolderBackedUp(["/var/lib"], linuxExcludes, "/var/lib/mysql")).toBe(true);
    expect(isFolderBackedUp(["/var/lib"], linuxExcludes, "/var/lib/docker/volumes")).toBe(false);
  });

  it("names each missing folder with the machines that have it", () => {
    expect(
      missingReportedFolders(
        [
          { name: "paperless", folders: ["/opt", "/srv", "/var/lib/docker/volumes"] },
          { name: "db01", folders: ["/opt", "/var/lib/postgresql"] },
          { name: "old", folders: null },
        ],
        client,
        linuxExcludes,
      ),
    ).toEqual([
      { folder: "/opt", machines: ["paperless", "db01"] },
      { folder: "/var/lib/docker/volumes", machines: ["paperless"] },
      { folder: "/var/lib/postgresql", machines: ["db01"] },
    ]);
  });

  it("adds a folder and narrows the exclusion in its way", () => {
    const next = withDataFolder(
      { paths: client, excludes: linuxExcludes },
      "/var/lib/docker/volumes",
    );
    expect(next.paths).toEqual([...client, "/var/lib/docker/volumes"]);
    expect(next.excludes).toEqual([
      "**/node_modules",
      "*.tmp",
      "/var/lib/docker/*",
      "!/var/lib/docker/volumes",
      "/tmp",
    ]);
    expect(isFolderBackedUp(next.paths, next.excludes, "/var/lib/docker/volumes")).toBe(true);
    expect(withDataFolder({ paths: ["/"], excludes: ["/opt"] }, "/opt")).toEqual({
      paths: ["/"],
      excludes: [],
    });
  });
});
