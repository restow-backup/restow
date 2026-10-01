import { describe, expect, it } from "vitest";
import {
  DEFAULT_SOURCE_URL,
  defaultSource,
  isDefaultSourceUrl,
  parseEnvironmentSource,
  parseRepositoryUrl,
  sourceFromSettings,
} from "./source.js";

function ok(input: string) {
  const parsed = parseRepositoryUrl(input);
  if (!parsed.ok) {
    throw new Error(`expected a repository: ${input} (${parsed.problem})`);
  }
  return parsed.source;
}

describe("repository URLs", () => {
  it("knows the public GitHub repository of the project as the default source", () => {
    const source = defaultSource();
    expect(source).toMatchObject({
      provider: "github",
      repository: "restow-backup/restow",
      isDefault: true,
      url: DEFAULT_SOURCE_URL,
    });
    expect(source.releasesUrl).toBe(
      "https://api.github.com/repos/restow-backup/restow/releases?per_page=30",
    );
    expect(source.archiveUrl("v0.2.0")).toBe(
      "https://api.github.com/repos/restow-backup/restow/tarball/v0.2.0",
    );
  });

  it("reads another GitHub repository, ignoring .git and trailing slashes", () => {
    const source = ok("https://github.com/acme/restow-fork.git/");
    expect(source).toMatchObject({ provider: "github", repository: "acme/restow-fork" });
    expect(source.isDefault).toBe(false);
    expect(source.url).toBe("https://github.com/acme/restow-fork");
  });

  it("reads a Forgejo or Gitea repository, also below a path prefix", () => {
    const forgejo = ok("https://git.example.com/acme/restow");
    expect(forgejo).toMatchObject({ provider: "forgejo", repository: "acme/restow" });
    expect(forgejo.releasesUrl).toBe(
      "https://git.example.com/api/v1/repos/acme/restow/releases?limit=30",
    );
    expect(forgejo.archiveUrl("v1.0.0-rc.1")).toBe(
      "https://git.example.com/api/v1/repos/acme/restow/archive/v1.0.0-rc.1.tar.gz",
    );
    const prefixed = ok("https://example.com/forge/acme/restow");
    expect(prefixed.releasesUrl).toBe(
      "https://example.com/forge/api/v1/repos/acme/restow/releases?limit=30",
    );
    expect(prefixed.url).toBe("https://example.com/forge/acme/restow");
  });

  it("accepts a Forgejo API address pasted instead of the repository page", () => {
    const source = ok("https://git.example.com/api/v1/repos/acme/restow/releases");
    expect(source).toMatchObject({ provider: "forgejo", repository: "acme/restow" });
  });

  it("never lets a tag break out of the archive URL", () => {
    expect(ok("https://github.com/acme/restow").archiveUrl("v1/../../x")).toBe(
      "https://api.github.com/repos/acme/restow/tarball/v1%2F..%2F..%2Fx",
    );
  });

  it("refuses everything that could leak a token or is not a repository", () => {
    expect(parseRepositoryUrl("http://github.com/acme/restow")).toEqual({
      ok: false,
      problem: "not_https",
    });
    expect(parseRepositoryUrl("not a url")).toEqual({ ok: false, problem: "invalid_url" });
    expect(parseRepositoryUrl("https://user:secret@git.example.com/a/b")).toEqual({
      ok: false,
      problem: "credentials_in_url",
    });
    expect(parseRepositoryUrl("https://github.com/acme")).toEqual({
      ok: false,
      problem: "not_a_repository",
    });
    expect(parseRepositoryUrl("https://git.example.com/onlyone")).toEqual({
      ok: false,
      problem: "not_a_repository",
    });
    expect(parseRepositoryUrl("https://git.example.com/a b/c")).toEqual({
      ok: false,
      problem: "not_a_repository",
    });
  });

  it("recognises the default source however it is typed", () => {
    expect(isDefaultSourceUrl("https://github.com/restow-backup/restow")).toBe(true);
    expect(isDefaultSourceUrl("https://github.com/Restow-Backup/Restow.git")).toBe(true);
    expect(isDefaultSourceUrl("https://github.com/restow-backup/other")).toBe(false);
    expect(isDefaultSourceUrl("https://git.example.com/restow-backup/restow")).toBe(false);
  });

  it("falls back to the default when the stored URL is missing or no longer valid", () => {
    expect(sourceFromSettings(null).isDefault).toBe(true);
    expect(sourceFromSettings("http://broken").isDefault).toBe(true);
    expect(sourceFromSettings("https://git.example.com/acme/restow").repository).toBe(
      "acme/restow",
    );
  });
});

describe("RESTOW_UPDATE_CHECK_URL", () => {
  it("is ignored unless it is an https address", () => {
    expect(parseEnvironmentSource(undefined)).toBeNull();
    expect(parseEnvironmentSource("  ")).toBeNull();
    expect(parseEnvironmentSource("http://example.com/releases")).toBeNull();
    expect(parseEnvironmentSource("https://u:p@example.com/releases")).toBeNull();
    expect(parseEnvironmentSource("nonsense")).toBeNull();
  });

  it("keeps a GitHub releases endpoint as given and knows the repository behind it", () => {
    const latest = "https://api.github.com/repos/acme/restow/releases/latest";
    const source = parseEnvironmentSource(latest);
    expect(source).toMatchObject({ provider: "github", repository: "acme/restow" });
    expect(source?.releasesUrl).toBe(latest);
  });

  it("keeps a Forgejo releases endpoint as given", () => {
    const url = "https://git.example.com/api/v1/repos/acme/restow/releases?limit=5";
    const source = parseEnvironmentSource(url);
    expect(source).toMatchObject({ provider: "forgejo", repository: "acme/restow" });
    expect(source?.releasesUrl).toBe(url);
  });

  it("treats any other https address as a feed that cannot be built from", () => {
    const source = parseEnvironmentSource("https://example.com/releases.json");
    expect(source).toMatchObject({ provider: "feed", repository: null, isDefault: false });
    expect(source?.archiveUrl("v1.0.0")).toBeNull();
  });
});
