import { describe, expect, it } from "vitest";
import {
  canonicalHost,
  formatAllowEntry,
  isSourceAllowed,
  isSourceHostListed,
  parseSourceAllowlist,
  sourceTargetOf,
} from "./source-policy.js";

describe("parseSourceAllowlist", () => {
  it("is empty when the variable is unset or blank: source mode is off", () => {
    expect(parseSourceAllowlist(undefined)).toEqual({ entries: [], problems: [] });
    expect(parseSourceAllowlist("")).toEqual({ entries: [], problems: [] });
    expect(parseSourceAllowlist(" , ,")).toEqual({ entries: [], problems: [] });
  });

  it("reads hosts and repositories, without case, GitHub under one name", () => {
    expect(
      parseSourceAllowlist(
        " Git.Example.com , github.com/Acme/Restow.git, api.github.com/acme/other/ ",
      ),
    ).toEqual({
      entries: [
        { host: "git.example.com", repository: null },
        { host: "github.com", repository: "acme/restow" },
        { host: "github.com", repository: "acme/other" },
      ],
      problems: [],
    });
  });

  it.each([
    "https://git.example.com",
    "git.example.com/acme",
    "git.example.com/a/b/c",
    "bad host",
    "git.example.com:3000",
    "*.example.com",
    "-x.example.com",
  ])("reports %s as a problem", (value) => {
    const parsed = parseSourceAllowlist(value);
    expect(parsed.entries).toEqual([]);
    expect(parsed.problems).toHaveLength(1);
  });

  it("formats entries the way the operator writes them", () => {
    expect(
      parseSourceAllowlist("git.example.com,github.com/a/b").entries.map(formatAllowEntry),
    ).toEqual(["git.example.com", "github.com/a/b"]);
  });
});

describe("sourceTargetOf", () => {
  it("names host and repository of GitHub and Forgejo archive and release URLs", () => {
    expect(sourceTargetOf("https://api.github.com/repos/Acme/Restow/tarball/v1.0.0")).toEqual({
      host: "github.com",
      repository: "acme/restow",
    });
    expect(
      sourceTargetOf("https://git.example.com/forge/api/v1/repos/acme/restow/archive/v1.tar.gz"),
    ).toEqual({ host: "git.example.com", repository: "acme/restow" });
    expect(sourceTargetOf("https://feeds.example.com/restow.json")).toEqual({
      host: "feeds.example.com",
      repository: null,
    });
    expect(sourceTargetOf("not a url")).toBeNull();
  });
});

describe("isSourceAllowed", () => {
  const { entries } = parseSourceAllowlist("git.example.com, github.com/acme/restow");

  it("allows a listed host for every repository, a listed repository only by itself", () => {
    expect(isSourceAllowed(entries, { host: "git.example.com", repository: "x/y" })).toBe(true);
    expect(isSourceAllowed(entries, { host: "git.example.com", repository: null })).toBe(true);
    expect(isSourceAllowed(entries, { host: "github.com", repository: "acme/restow" })).toBe(true);
    expect(isSourceAllowed(entries, { host: "github.com", repository: "acme/other" })).toBe(false);
    expect(isSourceAllowed(entries, { host: "github.com", repository: null })).toBe(false);
    expect(isSourceAllowed(entries, { host: "evil.example.com", repository: "x/y" })).toBe(false);
    expect(isSourceAllowed(entries, { host: "git.example.com.evil.test", repository: "x/y" })).toBe(
      false,
    );
  });

  it("allows nothing without entries", () => {
    expect(isSourceAllowed([], { host: "git.example.com", repository: "x/y" })).toBe(false);
  });

  it("tells whether a host is listed at all", () => {
    expect(isSourceHostListed(entries, "API.GitHub.com")).toBe(true);
    expect(isSourceHostListed(entries, "git.example.com")).toBe(true);
    expect(isSourceHostListed(entries, "other.example.com")).toBe(false);
    expect(canonicalHost("www.github.com.")).toBe("github.com");
  });
});
