import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Redactor } from "./redact.js";
import { parseSourceAllowlist } from "./source-policy.js";
import {
  ArchiveSourceProvider,
  MAX_REDIRECTS,
  SourceError,
  assertArchiveUrl,
  buildImages,
  buildSpecs,
  describeUrl,
  downloadArchive,
  extractArchive,
  sourceImageTags,
} from "./source.js";

const TOKEN = "ghp_secretTOKEN0123456789";
const policy = { allowInsecureHttp: true };
/** The fake archive servers listen on 127.0.0.1; the operator's allowlist names it. */
const LOCAL = parseSourceAllowlist("127.0.0.1").entries;

interface Seen {
  url: string;
  authorization: string | undefined;
}

let dir: string;
const servers: http.Server[] = [];
const redactor = new Redactor();

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "restow-updater-source-"));
});

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await fs.rm(dir, { recursive: true, force: true });
});

async function listen(
  handler: (request: http.IncomingMessage, response: http.ServerResponse, seen: Seen[]) => void,
): Promise<{ origin: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = http.createServer((request, response) => {
    seen.push({ url: request.url ?? "", authorization: request.headers.authorization });
    handler(request, response, seen);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

/** A real .tar.gz whose single top-level directory holds a Dockerfile. */
async function makeArchive(
  files: Record<string, string> = { Dockerfile: "FROM scratch\n", "app/index.js": "1\n" },
): Promise<Buffer> {
  const source = path.join(dir, "make");
  const top = path.join(source, "restow-v0.2.0");
  for (const [name, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(top, name)), { recursive: true });
    await fs.writeFile(path.join(top, name), content);
  }
  const archive = path.join(dir, "made.tar.gz");
  execFileSync("tar", ["-czf", archive, "-C", source, "restow-v0.2.0"]);
  await fs.rm(source, { recursive: true, force: true });
  return await fs.readFile(archive);
}

describe("assertArchiveUrl", () => {
  it("accepts plain https", () => {
    expect(assertArchiveUrl("https://github.com/acme/restow/archive/v0.2.0.tar.gz").hostname).toBe(
      "github.com",
    );
  });

  it.each([
    ["http://github.com/x.tar.gz"],
    ["ftp://github.com/x.tar.gz"],
    ["file:///etc/passwd"],
    ["https://user:pass@github.com/x.tar.gz"],
    ["https://token@github.com/x.tar.gz"],
    ["not a url"],
    [""],
    ["//github.com/x"],
    ["javascript:alert(1)"],
  ])("refuses %s", (value) => {
    expect(() => assertArchiveUrl(value)).toThrow(SourceError);
  });

  it("accepts http only when the test policy allows it", () => {
    expect(() => assertArchiveUrl("http://127.0.0.1:1/x", policy)).not.toThrow();
    expect(() => assertArchiveUrl("http://127.0.0.1:1/x", {})).toThrow(SourceError);
  });

  it("describes a URL without its query string or credentials", () => {
    expect(
      describeUrl(new URL("https://codeload.github.com/acme/restow/tar.gz/v1?token=SIGNED&x=1")),
    ).toBe("https://codeload.github.com/acme/restow/tar.gz/v1");
  });
});

describe("downloadArchive", () => {
  it("sends the token as an Authorization header only when there is one", async () => {
    const { origin, seen } = await listen((_request, response) => {
      response.writeHead(200, { "Content-Length": "5" }).end("hello");
    });
    await downloadArchive({
      url: `${origin}/a.tgz`,
      token: TOKEN,
      destination: path.join(dir, "a"),
      policy,
    });
    await downloadArchive({
      url: `${origin}/a.tgz`,
      token: null,
      destination: path.join(dir, "b"),
      policy,
    });
    expect(seen.map((entry) => entry.authorization)).toEqual([`token ${TOKEN}`, undefined]);
    expect(await fs.readFile(path.join(dir, "a"), "utf8")).toBe("hello");
    expect((await fs.stat(path.join(dir, "a"))).mode & 0o777).toBe(0o600);
  });

  it("keeps the header on a same-origin redirect", async () => {
    const { origin, seen } = await listen((request, response) => {
      if (request.url === "/start") {
        response.writeHead(302, { Location: "/final" }).end();
      } else {
        response.writeHead(200).end("ok");
      }
    });
    await downloadArchive({
      url: `${origin}/start`,
      token: TOKEN,
      destination: path.join(dir, "a"),
      policy,
    });
    expect(seen.map((entry) => [entry.url, entry.authorization])).toEqual([
      ["/start", `token ${TOKEN}`],
      ["/final", `token ${TOKEN}`],
    ]);
  });

  it("follows a redirect to another origin without the header, and never sends it there", async () => {
    const other = await listen((_request, response) => {
      response.writeHead(200).end("from the other origin");
    });
    const first = await listen((_request, response) => {
      response.writeHead(302, { Location: `${other.origin}/signed?token=SIGNED` }).end();
    });
    await downloadArchive({
      url: `${first.origin}/a`,
      token: TOKEN,
      destination: path.join(dir, "a"),
      policy,
    });
    expect(first.seen[0]?.authorization).toBe(`token ${TOKEN}`);
    expect(other.seen).toHaveLength(1);
    expect(other.seen[0]?.authorization).toBeUndefined();
    expect(await fs.readFile(path.join(dir, "a"), "utf8")).toBe("from the other origin");
  });

  it("does not send the header back to the first origin after it left it", async () => {
    const later = { origin: "" };
    const first = await listen((request, response) => {
      response
        .writeHead(
          request.url === "/one" ? 302 : 200,
          request.url === "/one" ? { Location: `${later.origin}/two` } : {},
        )
        .end("done");
    });
    const second = await listen((_request, response) => {
      response.writeHead(302, { Location: `${first.origin}/three` }).end();
    });
    later.origin = second.origin;
    await downloadArchive({
      url: `${first.origin}/one`,
      token: TOKEN,
      destination: path.join(dir, "a"),
      policy,
    });
    expect(first.seen.map((entry) => [entry.url, entry.authorization])).toEqual([
      ["/one", `token ${TOKEN}`],
      ["/three", undefined],
    ]);
  });

  it(`follows at most ${MAX_REDIRECTS} redirects`, async () => {
    const { origin, seen } = await listen((request, response) => {
      const hop = Number(request.url?.slice(1) ?? "0");
      response.writeHead(302, { Location: `/${hop + 1}` }).end();
    });
    await expect(
      downloadArchive({
        url: `${origin}/0`,
        token: null,
        destination: path.join(dir, "a"),
        policy,
      }),
    ).rejects.toThrow(/redirected more than 3 times/);
    expect(seen).toHaveLength(MAX_REDIRECTS + 1);
    const ok = await listen((request, response) => {
      const hop = Number(request.url?.slice(1) ?? "0");
      if (hop < MAX_REDIRECTS) {
        response.writeHead(302, { Location: `/${hop + 1}` }).end();
      } else {
        response.writeHead(200).end("ok");
      }
    });
    await downloadArchive({
      url: `${ok.origin}/0`,
      token: null,
      destination: path.join(dir, "b"),
      policy,
    });
  });

  it("refuses a redirect to a scheme that is not https (without the test policy)", async () => {
    const { origin } = await listen((_request, response) => {
      response.writeHead(302, { Location: "http://insecure.example.com/x" }).end();
    });
    await expect(
      downloadArchive({
        url: `${origin}/a`,
        token: TOKEN,
        destination: path.join(dir, "a"),
        policy: { allowInsecureHttp: false },
      }),
    ).rejects.toThrow(/https/);
    // Without the test policy even the first URL is refused, before any request.
    await expect(
      downloadArchive({ url: `${origin}/a`, token: TOKEN, destination: path.join(dir, "a") }),
    ).rejects.toThrow(/https/);
  });

  it("refuses a redirect without a location and a non-redirect error status", async () => {
    const noLocation = await listen((_request, response) => {
      response.writeHead(302).end();
    });
    await expect(
      downloadArchive({
        url: `${noLocation.origin}/a`,
        token: null,
        destination: path.join(dir, "a"),
        policy,
      }),
    ).rejects.toThrow(/without a location/);
    const notFound = await listen((_request, response) => {
      response.writeHead(404).end("nope");
    });
    await expect(
      downloadArchive({
        url: `${notFound.origin}/x/y?secret=1`,
        token: TOKEN,
        destination: path.join(dir, "a"),
        policy,
      }),
    ).rejects.toThrow(/HTTP 404/);
  });

  it("enforces the size cap from Content-Length and while streaming, leaving no file", async () => {
    const declared = await listen((_request, response) => {
      response.writeHead(200, { "Content-Length": "5000" }).end(Buffer.alloc(5000));
    });
    await expect(
      downloadArchive({
        url: `${declared.origin}/a`,
        token: null,
        destination: path.join(dir, "a"),
        policy,
        maxBytes: 1000,
      }),
    ).rejects.toThrow(/larger than the allowed size/);
    await expect(fs.access(path.join(dir, "a"))).rejects.toThrow();

    const streamed = await listen((_request, response) => {
      response.writeHead(200, { "Transfer-Encoding": "chunked" });
      response.write(Buffer.alloc(600));
      setTimeout(() => response.end(Buffer.alloc(600)), 20);
    });
    await expect(
      downloadArchive({
        url: `${streamed.origin}/a`,
        token: null,
        destination: path.join(dir, "b"),
        policy,
        maxBytes: 1000,
      }),
    ).rejects.toThrow(/larger than the allowed size/);
    await expect(fs.access(path.join(dir, "b"))).rejects.toThrow();
  });

  it("never puts the token or a query string into an error", async () => {
    const failing = await listen((_request, response) => {
      response.writeHead(500).end(`internal error mentioning ${TOKEN}`);
    });
    const error = await downloadArchive({
      url: `${failing.origin}/archive?sig=abc`,
      token: TOKEN,
      destination: path.join(dir, "a"),
      policy,
    }).catch((caught: Error) => caught);
    expect(error).toBeInstanceOf(SourceError);
    expect((error as Error).message).not.toContain(TOKEN);
    expect((error as Error).message).not.toContain("sig=abc");
    const unreachable = await downloadArchive({
      url: "http://127.0.0.1:1/a",
      token: TOKEN,
      destination: path.join(dir, "b"),
      policy,
    }).catch((caught: Error) => caught);
    expect((unreachable as Error).message).not.toContain(TOKEN);
  });
});

describe("extractArchive", () => {
  it("unpacks without the top-level directory", async () => {
    const archive = path.join(dir, "a.tar.gz");
    await fs.writeFile(archive, await makeArchive());
    const target = path.join(dir, "tree");
    await extractArchive(archive, target, redactor);
    expect(await fs.readFile(path.join(target, "Dockerfile"), "utf8")).toBe("FROM scratch\n");
    expect(await fs.readFile(path.join(target, "app/index.js"), "utf8")).toBe("1\n");
  });

  it("fails for a corrupt archive and for one without a Dockerfile", async () => {
    const corrupt = path.join(dir, "bad.tar.gz");
    await fs.writeFile(corrupt, "this is not an archive");
    await expect(extractArchive(corrupt, path.join(dir, "t1"), redactor)).rejects.toThrow(
      /Unpacking the archive failed/,
    );
    const noDockerfile = path.join(dir, "nod.tar.gz");
    await fs.writeFile(noDockerfile, await makeArchive({ "readme.md": "x" }));
    await expect(extractArchive(noDockerfile, path.join(dir, "t2"), redactor)).rejects.toThrow(
      /no Dockerfile/,
    );
  });

  it("does not use a shell for the archive path", async () => {
    const weird = path.join(dir, "a b;touch pwned.tar.gz");
    await fs.writeFile(weird, await makeArchive());
    await extractArchive(weird, path.join(dir, "tree"), redactor);
    await expect(fs.access(path.join(dir, "pwned.tar.gz"))).rejects.toThrow();
    await expect(fs.access(path.join(dir, "pwned"))).rejects.toThrow();
  });
});

describe("ArchiveSourceProvider", () => {
  it("downloads, unpacks and cleans up; the token only reaches the request", async () => {
    const archive = await makeArchive();
    const { origin, seen } = await listen((_request, response) => {
      response.writeHead(200, { "Content-Length": String(archive.length) }).end(archive);
    });
    const provider = new ArchiveSourceProvider({
      stateDir: dir,
      redactor,
      policy,
      allowlist: LOCAL,
    });
    const stages: string[] = [];
    const source = await provider.fetch({
      version: "0.2.0",
      archiveUrl: `${origin}/v0.2.0.tar.gz`,
      token: TOKEN,
      onStage: (stage) => {
        stages.push(stage);
      },
    });
    expect(stages).toEqual(["downloading", "extracting"]);
    expect(source.contextDir).toBe(path.join(dir, "src", "0.2.0"));
    expect(await fs.readFile(path.join(source.contextDir, "Dockerfile"), "utf8")).toBe(
      "FROM scratch\n",
    );
    expect(await fs.readdir(path.join(dir, "src"))).toEqual(["0.2.0"]);
    expect(seen[0]?.authorization).toBe(`token ${TOKEN}`);
    await source.cleanup();
    await source.cleanup();
    expect(await fs.readdir(path.join(dir, "src"))).toEqual([]);
  });

  it("removes everything when the download or the unpacking fails", async () => {
    const bad = await listen((_request, response) => {
      response.writeHead(200).end("not a tarball");
    });
    const provider = new ArchiveSourceProvider({
      stateDir: dir,
      redactor,
      policy,
      allowlist: LOCAL,
    });
    await expect(
      provider.fetch({ version: "0.2.0", archiveUrl: `${bad.origin}/a`, token: null }),
    ).rejects.toThrow(SourceError);
    expect(await fs.readdir(path.join(dir, "src"))).toEqual([]);
    const missing = await listen((_request, response) => {
      response.writeHead(404).end();
    });
    await expect(
      provider.fetch({ version: "0.2.0", archiveUrl: `${missing.origin}/a`, token: null }),
    ).rejects.toThrow(/HTTP 404/);
    expect(await fs.readdir(path.join(dir, "src"))).toEqual([]);
  });

  it("applies the allowlist and refuses odd versions", async () => {
    const provider = new ArchiveSourceProvider({
      stateDir: dir,
      redactor,
      allowlist: parseSourceAllowlist("github.com/acme/restow, git.example.com").entries,
    });
    expect(() =>
      provider.validate("https://api.github.com/repos/acme/restow/tarball/v1.0.0"),
    ).not.toThrow();
    expect(() =>
      provider.validate("https://git.example.com/api/v1/repos/anyone/anything/archive/v1.tar.gz"),
    ).not.toThrow();
    for (const refused of [
      "https://api.github.com/repos/acme/other/tarball/v1.0.0",
      "https://api.github.com/repos/attacker/restow/tarball/v1.0.0",
      "https://evil.example.com/x.tar.gz",
      "https://git.example.com.evil.test/api/v1/repos/acme/restow/archive/v1.tar.gz",
    ]) {
      let caught: unknown = null;
      try {
        provider.validate(refused);
      } catch (error) {
        caught = error;
      }
      expect(caught, refused).toBeInstanceOf(SourceError);
      expect((caught as SourceError).notAllowed).toBe(true);
      expect((caught as SourceError).message).toMatch(/RESTOW_UPDATER_SOURCE_HOSTS/);
    }
    expect(() => provider.validate("http://git.example.com/x")).toThrow(/https/);
    await expect(
      provider.fetch({
        version: "../../etc",
        archiveUrl: "https://git.example.com/api/v1/repos/a/b/archive/x.tar.gz",
        token: null,
      }),
    ).rejects.toThrow(/file name/);
  });

  it("refuses every source when no allowlist is configured (source mode is off by default)", async () => {
    const off = new ArchiveSourceProvider({ stateDir: dir, redactor });
    let caught: unknown = null;
    try {
      off.validate("https://api.github.com/repos/restow-backup/restow/tarball/v1.0.0");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SourceError);
    expect((caught as SourceError).notAllowed).toBe(true);
    expect((caught as SourceError).message).toMatch(/turned off/);
    const empty = new ArchiveSourceProvider({ stateDir: dir, redactor, allowlist: [] });
    expect(() => empty.validate("https://git.example.com/x.tar.gz")).toThrow(/turned off/);
    // Nothing is fetched for a refused source.
    await expect(
      off.fetch({ version: "0.2.0", archiveUrl: "https://git.example.com/a", token: "t" }),
    ).rejects.toThrow(/turned off/);
    await expect(fs.readdir(path.join(dir, "src"))).rejects.toThrow();
  });

  it("purge removes leftovers of an interrupted run", async () => {
    await fs.mkdir(path.join(dir, "src", "0.1.0"), { recursive: true });
    await fs.writeFile(path.join(dir, "src", "0.1.0.tar.gz"), "x");
    const provider = new ArchiveSourceProvider({ stateDir: dir, redactor });
    await provider.purge();
    await expect(fs.access(path.join(dir, "src"))).rejects.toThrow();
  });
});

describe("building", () => {
  it("builds the Community targets under the Community names for a Community installation", async () => {
    expect(sourceImageTags("0.2.0", "community")).toEqual({
      app: "restow-community:0.2.0",
      web: "restow-web-community:0.2.0",
    });
    expect(buildSpecs("/state/src/0.2.0", "0.2.0", "community")).toEqual({
      app: {
        contextDir: "/state/src/0.2.0",
        target: "runtime-community",
        tag: "restow-community:0.2.0",
        buildArgs: { RESTOW_VERSION: "0.2.0" },
      },
      web: {
        contextDir: "/state/src/0.2.0",
        target: "web-community",
        tag: "restow-web-community:0.2.0",
        buildArgs: {},
      },
    });
    const built: string[] = [];
    const tags = await buildImages(
      {
        build: async (spec) => {
          built.push(`${spec.target} ${spec.tag}`);
        },
      },
      "/state/src/0.2.0",
      "0.2.0",
      {},
      "community",
    );
    expect(built).toEqual([
      "runtime-community restow-community:0.2.0",
      "web-community restow-web-community:0.2.0",
    ]);
    expect(tags).toEqual({ app: "restow-community:0.2.0", web: "restow-web-community:0.2.0" });
  });

  it("builds exactly as before for the full build, named or not", () => {
    expect(buildSpecs("/s", "0.2.0", "full")).toEqual(buildSpecs("/s", "0.2.0"));
    expect(sourceImageTags("0.2.0", "full")).toEqual(sourceImageTags("0.2.0"));
  });

  it("names the local images and builds both targets with the version", async () => {
    expect(sourceImageTags("0.2.0")).toEqual({ app: "restow:0.2.0", web: "restow-web:0.2.0" });
    expect(buildSpecs("/state/src/0.2.0", "0.2.0")).toEqual({
      app: {
        contextDir: "/state/src/0.2.0",
        target: "runtime",
        tag: "restow:0.2.0",
        buildArgs: { RESTOW_VERSION: "0.2.0" },
      },
      web: {
        contextDir: "/state/src/0.2.0",
        target: "web",
        tag: "restow-web:0.2.0",
        buildArgs: {},
      },
    });
    const built: string[] = [];
    const tags = await buildImages(
      {
        build: async (spec) => {
          built.push(`${spec.target}:${spec.tag}`);
        },
      },
      "/x",
      "0.2.0",
    );
    expect(tags).toEqual({ app: "restow:0.2.0", web: "restow-web:0.2.0" });
    expect(built).toEqual(["runtime:restow:0.2.0", "web:restow-web:0.2.0"]);
  });
});
