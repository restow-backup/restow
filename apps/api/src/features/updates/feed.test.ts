import http from "node:http";
import type { AddressInfo } from "node:net";
import type { StoredUpdateRelease } from "@restow/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_NOTES_LENGTH,
  MAX_RELEASES,
  classifyStatus,
  digestsOf,
  fetchReleases,
  guardedFetch,
  parseReleases,
  releasesForChannel,
  retryAtOf,
  toRelease,
} from "./feed.js";

const D1 = `sha256:${"a".repeat(64)}`;
const D2 = `sha256:${"b".repeat(64)}`;

describe("release feeds", () => {
  it("reads a GitHub release", () => {
    expect(
      toRelease({
        tag_name: "v0.2.0",
        name: "Restow 0.2.0",
        body: "## Added\r\n- Updates tab",
        draft: false,
        prerelease: false,
        html_url: "https://github.com/restow-backup/restow/releases/tag/v0.2.0",
        published_at: "2026-10-01T08:00:00Z",
        created_at: "2026-09-30T08:00:00Z",
      }),
    ).toEqual({
      version: "0.2.0",
      tag: "v0.2.0",
      name: "Restow 0.2.0",
      publishedAt: "2026-10-01T08:00:00.000Z",
      url: "https://github.com/restow-backup/restow/releases/tag/v0.2.0",
      prerelease: false,
      notes: "## Added\n- Updates tab",
      notesTruncated: false,
      digests: {},
    });
  });

  it("reads a Forgejo or Gitea release, which nulls what it does not have", () => {
    expect(
      toRelease({
        id: 7,
        tag_name: "1.0.0-rc.1",
        name: "",
        body: "",
        draft: false,
        prerelease: true,
        html_url: "https://git.example.com/acme/restow/releases/tag/1.0.0-rc.1",
        published_at: null,
        created_at: "2026-09-29T10:00:00+02:00",
        assets: [],
      }),
    ).toMatchObject({
      version: "1.0.0-rc.1",
      tag: "1.0.0-rc.1",
      name: null,
      notes: null,
      prerelease: true,
      publishedAt: "2026-09-29T08:00:00.000Z",
    });
  });

  it("ignores drafts and tags that are not versions", () => {
    expect(toRelease({ tag_name: "v1.0.0", draft: true })).toBeNull();
    expect(toRelease({ tag_name: "nightly" })).toBeNull();
    expect(toRelease({ tag_name: "v1.2" })).toBeNull();
    expect(toRelease({ unrelated: true })).toBeNull();
    expect(toRelease("v1.0.0")).toBeNull();
  });

  it("marks a semantic pre-release tag as pre-release even when the host does not", () => {
    expect(toRelease({ tag_name: "v1.0.0-beta.2", prerelease: false })?.prerelease).toBe(true);
  });

  it("only links https release pages", () => {
    expect(toRelease({ tag_name: "v1.0.0", html_url: "javascript:alert(1)" })?.url).toBeNull();
    expect(toRelease({ tag_name: "v1.0.0", html_url: "http://example.com/r" })?.url).toBeNull();
  });

  it("cuts very long release notes and says so", () => {
    const release = toRelease({ tag_name: "v1.0.0", body: "x".repeat(MAX_NOTES_LENGTH + 500) });
    expect(release?.notes).toHaveLength(MAX_NOTES_LENGTH);
    expect(release?.notesTruncated).toBe(true);
  });

  it("takes a list or a single object", () => {
    expect(parseReleases([{ tag_name: "v1.0.0" }, { tag_name: "v1.1.0" }])).toHaveLength(2);
    expect(parseReleases({ tag_name: "v1.0.0" })).toHaveLength(1);
    expect(parseReleases({ message: "Not Found" })).toEqual([]);
    expect(parseReleases(null)).toEqual([]);
  });
});

describe("published image digests", () => {
  it("reads one digest per image, however the line is decorated", () => {
    const notes = [
      "## Images",
      `restow: ${D1}`,
      `- \`restow-web\`: \`${D2}\``,
      "some other text",
    ].join("\n");
    expect(digestsOf(notes)).toEqual({ app: D1, web: D2 });
  });

  it("ignores digests that are not on a labelled line or are malformed", () => {
    expect(digestsOf(`see ${D1} for details`)).toEqual({});
    expect(digestsOf("restow: sha256:abc")).toEqual({});
    expect(digestsOf(null)).toEqual({});
  });

  it("keeps the first digest when a name repeats", () => {
    expect(digestsOf(`restow: ${D1}\nrestow: ${D2}`)).toEqual({ app: D1 });
  });

  it("ends up on the release", () => {
    expect(toRelease({ tag_name: "v1.0.0", body: `restow: ${D1}` })?.digests).toEqual({ app: D1 });
  });

  describe("the two builds", () => {
    const D3 = `sha256:${"c".repeat(64)}`;
    const D4 = `sha256:${"d".repeat(64)}`;
    const notes = [
      "### Images",
      "",
      "```",
      `restow: ${D1}`,
      `restow-web: ${D2}`,
      `restow-community: ${D3}`,
      `restow-web-community: ${D4}`,
      "```",
    ].join("\n");

    it("gives the full build its own two lines, whatever else the notes list", () => {
      expect(digestsOf(notes)).toEqual({ app: D1, web: D2 });
      expect(digestsOf(notes, "full")).toEqual({ app: D1, web: D2 });
    });

    it("gives the Community build the -community lines and never the full images' digests", () => {
      expect(digestsOf(notes, "community")).toEqual({ app: D3, web: D4 });
      expect(digestsOf(`restow: ${D1}\nrestow-web: ${D2}`, "community")).toEqual({});
    });

    it("does not take a Community line for the full build when the full one is missing", () => {
      expect(digestsOf(`restow-community: ${D3}\nrestow-web-community: ${D4}`)).toEqual({});
      expect(digestsOf(`restow-web-community: ${D4}\nrestow: ${D1}`)).toEqual({ app: D1 });
    });

    it("parses the Community digests onto the release and through the feed", async () => {
      const entry = { tag_name: "v0.2.0", body: notes };
      expect(toRelease(entry, "community")?.digests).toEqual({ app: D3, web: D4 });
      expect(parseReleases([entry], "community")[0]?.digests).toEqual({ app: D3, web: D4 });
      const result = await fetchReleases({
        releasesUrl: "https://api.github.com/repos/restow-backup/restow/releases",
        token: null,
        imageVariant: "community",
        fetch: async () => Response.json([entry]),
      });
      expect(result.ok && result.releases[0]?.digests).toEqual({ app: D3, web: D4 });
    });
  });
});

function release(version: string, prerelease = false): StoredUpdateRelease {
  return {
    version,
    tag: `v${version}`,
    name: null,
    publishedAt: null,
    url: null,
    prerelease,
    notes: null,
    notesTruncated: false,
    digests: {},
  };
}

describe("channels", () => {
  const all = [
    release("0.3.0-rc.1", true),
    release("0.2.0"),
    release("0.2.1"),
    release("0.3.0-beta.2", true),
    release("0.3.0-beta.10", true),
    release("0.10.0"),
    release("0.2.0"),
  ];

  it("offers only stable releases on the stable channel, newest first", () => {
    expect(releasesForChannel(all, "stable").map((entry) => entry.version)).toEqual([
      "0.10.0",
      "0.2.1",
      "0.2.0",
    ]);
  });

  it("offers pre-releases as well on the beta channel, in semantic order", () => {
    expect(releasesForChannel(all, "beta").map((entry) => entry.version)).toEqual([
      "0.10.0",
      "0.3.0-rc.1",
      "0.3.0-beta.10",
      "0.3.0-beta.2",
      "0.2.1",
      "0.2.0",
    ]);
  });

  it("keeps the newest few", () => {
    const many = Array.from({ length: 25 }, (_, index) => release(`1.${index}.0`));
    const kept = releasesForChannel(many, "stable");
    expect(kept).toHaveLength(MAX_RELEASES);
    expect(kept[0]?.version).toBe("1.24.0");
  });
});

describe("reasons a source cannot be read", () => {
  const now = Date.parse("2026-10-01T10:00:00Z");
  const headers = (entries: Record<string, string>) => new Headers(entries);

  it("names a rate limit with the time it lifts", () => {
    const resetAt = Math.floor(Date.parse("2026-10-01T11:00:00Z") / 1000);
    expect(
      classifyStatus(
        {
          status: 403,
          headers: headers({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(resetAt) }),
        },
        now,
      ),
    ).toEqual({
      ok: false,
      error: {
        code: "rate_limited",
        status: 403,
        retryAt: "2026-10-01T11:00:00.000Z",
        detail: null,
      },
    });
    expect(
      classifyStatus({ status: 429, headers: headers({ "retry-after": "120" }) }, now),
    ).toMatchObject({
      error: { code: "rate_limited", retryAt: "2026-10-01T10:02:00.000Z" },
    });
  });

  it("tells a refused token from a missing repository from a forbidden one", () => {
    expect(classifyStatus({ status: 401, headers: headers({}) }, now)).toMatchObject({
      error: { code: "unauthorized", status: 401 },
    });
    expect(classifyStatus({ status: 404, headers: headers({}) }, now)).toMatchObject({
      error: { code: "not_found" },
    });
    expect(classifyStatus({ status: 403, headers: headers({}) }, now)).toMatchObject({
      error: { code: "forbidden" },
    });
    expect(classifyStatus({ status: 503, headers: headers({}) }, now)).toMatchObject({
      error: { code: "server_error", status: 503 },
    });
    expect(classifyStatus({ status: 418, headers: headers({}) }, now)).toMatchObject({
      error: { code: "invalid_response" },
    });
  });

  it("understands Retry-After as a date too", () => {
    expect(retryAtOf(headers({ "retry-after": "Thu, 01 Oct 2026 12:00:00 GMT" }), now)).toBe(
      "2026-10-01T12:00:00.000Z",
    );
    expect(retryAtOf(headers({}), now)).toBeNull();
  });
});

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("fetchReleases", () => {
  const url = "https://api.github.com/repos/acme/restow/releases?per_page=30";

  it("reads only the release list: a GET without a body, and no token unless there is one", async () => {
    const fetcher = vi.fn(async () => json([{ tag_name: "v1.0.0" }]));
    const result = await fetchReleases({ releasesUrl: url, token: null, fetch: fetcher });
    expect(result).toMatchObject({ ok: true });
    const [calledUrl, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(calledUrl).toBe(url);
    expect(init.method).toBeUndefined();
    expect(init.body).toBeUndefined();
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it("sends the access token as a header, never in the URL", async () => {
    const fetcher = vi.fn(async () => json([{ tag_name: "v1.0.0" }]));
    await fetchReleases({ releasesUrl: url, token: "s3cret-token", fetch: fetcher });
    const [calledUrl, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(calledUrl).not.toContain("s3cret-token");
    expect((init.headers as Record<string, string>).authorization).toBe("token s3cret-token");
  });

  it("reports the reason for a failed answer, keeping the token out of it", async () => {
    const fetcher = vi.fn(async () => new Response("no", { status: 401 }));
    const result = await fetchReleases({ releasesUrl: url, token: "s3cret-token", fetch: fetcher });
    expect(result).toEqual({
      ok: false,
      error: { code: "unauthorized", status: 401, retryAt: null, detail: null },
    });
    expect(JSON.stringify(result)).not.toContain("s3cret-token");
  });

  it("reads every failed connection the same, names only certificate problems, and timeouts", async () => {
    // A name that does not resolve, a refused connection and an address the policy refuses
    // must not be told apart: that would map the network behind the server.
    for (const cause of [
      { code: "ENOTFOUND" },
      { code: "ECONNREFUSED" },
      { code: "BLOCKED_ADDRESS" },
    ]) {
      const error = Object.assign(new TypeError("fetch failed"), { cause });
      expect(
        await fetchReleases({
          releasesUrl: url,
          token: null,
          fetch: async () => Promise.reject(error),
        }),
      ).toEqual({
        ok: false,
        error: { code: "network", status: null, retryAt: null, detail: null },
      });
    }
    const expired = Object.assign(new TypeError("fetch failed"), {
      cause: { code: "CERT_HAS_EXPIRED" },
    });
    expect(
      await fetchReleases({
        releasesUrl: url,
        token: null,
        fetch: async () => Promise.reject(expired),
      }),
    ).toMatchObject({ ok: false, error: { code: "network", detail: "CERT_HAS_EXPIRED" } });
    const timeout = Object.assign(new Error("aborted"), { name: "TimeoutError" });
    expect(
      await fetchReleases({
        releasesUrl: url,
        token: null,
        fetch: async () => Promise.reject(timeout),
      }),
    ).toMatchObject({ ok: false, error: { code: "timeout" } });
  });

  it("rejects an answer that is not a release list", async () => {
    expect(
      await fetchReleases({
        releasesUrl: url,
        token: null,
        fetch: async () => new Response("<html>"),
      }),
    ).toMatchObject({ ok: false, error: { code: "invalid_response", detail: "not_json" } });
    expect(
      await fetchReleases({ releasesUrl: url, token: null, fetch: async () => json([]) }),
    ).toMatchObject({ ok: false, error: { code: "no_release" } });
    expect(
      await fetchReleases({
        releasesUrl: url,
        token: null,
        fetch: async () => json({ message: "Not Found" }),
      }),
    ).toMatchObject({ ok: false, error: { code: "no_release" } });
  });

  it("follows a redirect within the same origin and keeps the token there", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 301,
          headers: { location: "https://api.github.com/repositories/42/releases" },
        }),
      )
      .mockResolvedValueOnce(json([{ tag_name: "v1.0.0" }]));
    const result = await fetchReleases({ releasesUrl: url, token: "tok", fetch: fetcher });
    expect(result).toMatchObject({ ok: true });
    const second = fetcher.mock.calls[1] as unknown as [string, RequestInit];
    expect(second[0]).toBe("https://api.github.com/repositories/42/releases");
    expect((second[1].headers as Record<string, string>).authorization).toBe("token tok");
  });

  it("never follows a redirect to another origin, so the token cannot travel there", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://evil.example.com/steal" },
        }),
    );
    const result = await fetchReleases({ releasesUrl: url, token: "tok", fetch: fetcher });
    expect(result).toMatchObject({ ok: false, error: { code: "redirect", status: 302 } });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("gives up on a redirect loop", async () => {
    const fetcher = vi.fn(
      async () => new Response(null, { status: 302, headers: { location: url } }),
    );
    expect(await fetchReleases({ releasesUrl: url, token: null, fetch: fetcher })).toMatchObject({
      ok: false,
      error: { code: "redirect" },
    });
    expect(fetcher.mock.calls.length).toBeLessThanOrEqual(4);
  });
});

describe("the guarded transport", () => {
  const servers: http.Server[] = [];
  afterEach(async () => {
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  async function listen(handler: http.RequestListener): Promise<{ port: number; hits: number[] }> {
    const hits: number[] = [];
    const server = http.createServer((request, response) => {
      hits.push(1);
      handler(request, response);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return { port: (server.address() as AddressInfo).port, hits };
  }

  it("never connects to loopback, private, link-local or local-only names", async () => {
    const { port, hits } = await listen((_request, response) => {
      response.writeHead(401).end();
    });
    for (const target of [
      `https://127.0.0.1:${port}/repos/a/b/releases`,
      "https://10.0.0.5/api/v1/repos/a/b/releases",
      "https://169.254.169.254/latest/meta-data",
      "https://[::1]/x",
      "https://localhost/x",
      "https://postgres/x",
      "https://nas.local/x",
    ]) {
      expect(await fetchReleases({ releasesUrl: target, token: "t" }), target).toEqual({
        ok: false,
        error: { code: "network", status: null, retryAt: null, detail: null },
      });
    }
    // Plain http to the same server, with private networks refused, is refused too.
    const refused = guardedFetch({ allowPrivateNetworks: false, allowInsecureHttp: true });
    expect(
      await fetchReleases({
        releasesUrl: `http://127.0.0.1:${port}/x`,
        token: null,
        fetch: refused,
      }),
    ).toMatchObject({ ok: false, error: { code: "network", detail: null } });
    expect(hits).toEqual([]);
  });

  it("reaches a private address the operator allowed, and reads the answer", async () => {
    const { port } = await listen((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify([{ tag_name: "v1.2.3" }]));
    });
    const allowed = guardedFetch({ allowPrivateNetworks: true, allowInsecureHttp: true });
    const result = await fetchReleases({
      releasesUrl: `http://127.0.0.1:${port}/api/v1/repos/a/b/releases`,
      token: null,
      fetch: allowed,
    });
    expect(result.ok && result.releases.map((release) => release.version)).toEqual(["1.2.3"]);
  });

  it("gives up on a body past 8 MiB even when no length was declared", async () => {
    const { port } = await listen((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      const chunk = Buffer.alloc(1024 * 1024, 0x20);
      let sent = 0;
      const pump = () => {
        while (sent < 12) {
          sent += 1;
          if (!response.write(chunk)) {
            response.once("drain", pump);
            return;
          }
        }
        response.end("[]");
      };
      pump();
    });
    const allowed = guardedFetch({ allowPrivateNetworks: true, allowInsecureHttp: true });
    expect(
      await fetchReleases({
        releasesUrl: `http://127.0.0.1:${port}/x`,
        token: null,
        fetch: allowed,
      }),
    ).toMatchObject({ ok: false, error: { code: "invalid_response", detail: "too_large" } });
  });

  it("refuses anything but https outside tests", async () => {
    await expect(
      guardedFetch({ allowPrivateNetworks: true })("http://example.com/x"),
    ).rejects.toThrow(/https/);
  });
});
