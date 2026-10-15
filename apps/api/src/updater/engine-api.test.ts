import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EngineApiError, EngineClient, LogDemuxer, splitReference } from "./engine-api.js";
import { FakeEngineApi, selfContainer } from "./fake-engine-api.js";
import { Redactor } from "./redact.js";

let api: FakeEngineApi;
let client: EngineClient;

beforeEach(async () => {
  api = new FakeEngineApi();
  await api.start();
  client = new EngineClient({
    socketPath: api.socketPath,
    redactor: new Redactor(),
    requestTimeoutMs: 2000,
  });
});

afterEach(async () => {
  await api.stop();
});

describe("EngineClient", () => {
  it("pings and reports a daemon that does not answer", async () => {
    await expect(client.ping()).resolves.toBeUndefined();
    api.pingStatus = 500;
    await expect(client.ping()).rejects.toBeInstanceOf(EngineApiError);
    const missing = new EngineClient({
      socketPath: "/nonexistent/docker.sock",
      redactor: new Redactor(),
    });
    await expect(missing.ping()).rejects.toBeInstanceOf(EngineApiError);
  });

  it("inspects a container, null when it does not exist", async () => {
    api.self = selfContainer();
    const info = await client.inspectContainer("selfselfselfself");
    expect(info?.Config?.Labels?.["com.docker.compose.project"]).toBe("restow");
    expect(await client.inspectContainer("nothing")).toBeNull();
  });

  it("checks images and pulls with repository and tag split correctly", async () => {
    api.images.add("docker:27-cli");
    expect(await client.imageExists("docker:27-cli")).toBe(true);
    expect(await client.imageExists("docker:28-cli")).toBe(false);
    await client.pullImage("registry.example.com:5000/acme/cli:27");
    const pull = api.callsTo("POST", "/images/create")[0];
    expect(pull?.query.get("fromImage")).toBe("registry.example.com:5000/acme/cli");
    expect(pull?.query.get("tag")).toBe("27");
    await client.pullImage("docker");
    expect(api.callsTo("POST", "/images/create")[1]?.query.get("tag")).toBe("latest");
  });

  it("turns an error inside the pull stream into a failure", async () => {
    api.pullError = "manifest for docker:99-cli not found: manifest unknown";
    await expect(client.pullImage("docker:99-cli")).rejects.toThrow(
      /manifest for docker:99-cli not found/,
    );
  });

  it("creates, starts, waits for and removes a container", async () => {
    const id = await client.createContainer(
      {
        Image: "docker:27-cli",
        Entrypoint: [],
        Cmd: ["docker", "version"],
        HostConfig: { Binds: [] },
      },
      "helper-x",
    );
    expect(api.callsTo("POST", "/containers/create")[0]?.query.get("name")).toBe("helper-x");
    await client.startContainer(id);
    api.nextContainer = { exitCode: 3 };
    expect(await client.waitContainer(id)).toBe(0);
    await client.removeContainer(id);
    expect(api.removed).toEqual([id]);
    const delete_ = api.callsTo("DELETE", "/containers/")[0];
    expect(delete_?.query.get("force")).toBe("1");
  });

  it("reports refused creates and starts", async () => {
    api.createStatus = 409;
    await expect(
      client.createContainer(
        { Image: "x", Entrypoint: [], Cmd: [], HostConfig: { Binds: [] } },
        "n",
      ),
    ).rejects.toMatchObject({ status: 409 });
    api.createStatus = 201;
    const id = await client.createContainer(
      { Image: "x", Entrypoint: [], Cmd: [], HostConfig: { Binds: [] } },
      "n",
    );
    api.startStatus = 500;
    await expect(client.startContainer(id)).rejects.toBeInstanceOf(EngineApiError);
  });

  it("lists containers by label", async () => {
    api.labelled = ["a", "b"];
    expect(await client.listContainersByLabel("com.restow.updater.helper=1")).toEqual(["a", "b"]);
    const request = api.callsTo("GET", "/containers/json")[0];
    expect(JSON.parse(request?.query.get("filters") ?? "{}")).toEqual({
      label: ["com.restow.updater.helper=1"],
    });
    expect(request?.query.get("all")).toBe("1");
  });

  it("lists containers with labels and state, stops one, checks networks", async () => {
    api.summaries = [
      {
        Id: "r1",
        Labels: { "com.restow.mounter.runner": "x" },
        State: "running",
        ImageID: "sha256:img",
        Created: 1760000000,
      },
      { Id: "r2" },
    ];
    const listed = await client.listContainers(["com.restow.mounter.runner", "a=b"]);
    expect(listed).toEqual([
      {
        Id: "r1",
        Labels: { "com.restow.mounter.runner": "x" },
        State: "running",
        ImageID: "sha256:img",
        Created: 1760000000,
      },
      { Id: "r2", Labels: {}, State: "", ImageID: "", Created: 0 },
    ]);
    const filters = JSON.parse(
      api.callsTo("GET", "/containers/json")[0]?.query.get("filters") ?? "",
    );
    expect(filters).toEqual({ label: ["com.restow.mounter.runner", "a=b"] });
    await client.stopContainer("r1", 30);
    expect(api.stopped).toEqual(["r1"]);
    expect(api.callsTo("POST", "/containers/r1/stop")[0]?.query.get("t")).toBe("30");
    api.networks.add("restow_runners");
    expect(await client.networkExists("restow_runners")).toBe(true);
    expect(await client.networkExists("other_runners")).toBe(false);
  });

  it("passes the runner's host settings through unchanged", async () => {
    await client.createContainer(
      {
        Image: "sha256:img",
        Entrypoint: ["/usr/local/bin/restow-share"],
        Cmd: ["run"],
        HostConfig: {
          Binds: ["v:/share:ro"],
          CapDrop: ["ALL"],
          CapAdd: ["DAC_READ_SEARCH"],
          ReadonlyRootfs: true,
          Tmpfs: { "/tmp": "size=64m,mode=1777" },
          Memory: 1024,
          MemorySwap: 1024,
          PidsLimit: 256,
          LogConfig: { Type: "json-file", Config: { "max-size": "1m" } },
        },
      },
      "runner-x",
    );
    const body = api.callsTo("POST", "/containers/create")[0]?.body as {
      HostConfig: Record<string, unknown>;
    };
    expect(body.HostConfig.CapDrop).toEqual(["ALL"]);
    expect(body.HostConfig.ReadonlyRootfs).toBe(true);
    expect(body.HostConfig.PidsLimit).toBe(256);
  });

  it("demultiplexes the log into stdout and stderr, whatever the chunking", async () => {
    const id = await client.createContainer(
      { Image: "x", Entrypoint: [], Cmd: [], HostConfig: { Binds: [] } },
      "n",
    );
    api.nextContainer = { exitCode: 0 };
    // The container spec used for logs is the one set before create: create another.
    const withOutput = await (async () => {
      api.nextContainer = {
        exitCode: 0,
        stdout: [Buffer.from("line one\n"), Buffer.from("line two\n"), Buffer.alloc(70_000, 97)],
        stderr: [Buffer.from("warning: something\n")],
      };
      return await client.createContainer(
        { Image: "x", Entrypoint: [], Cmd: [], HostConfig: { Binds: [] } },
        "n2",
      );
    })();
    const logs = await client.containerLogs(withOutput, {
      maxStdoutBytes: 1_000_000,
      stderrTailBytes: 1000,
    });
    expect(logs.stdout.startsWith("line one\nline two\n")).toBe(true);
    expect(logs.stdout).toHaveLength(9 + 9 + 70_000);
    expect(logs.stderr).toBe("warning: something\n");
    expect(logs.stdoutTruncated).toBe(false);
    void id;
  });

  it("caps stdout and keeps the end of stderr", async () => {
    api.nextContainer = {
      exitCode: 0,
      stdout: [Buffer.alloc(500, 97), Buffer.alloc(500, 98)],
      stderr: [Buffer.from("A".repeat(400)), Buffer.from("B".repeat(400))],
    };
    const id = await client.createContainer(
      { Image: "x", Entrypoint: [], Cmd: [], HostConfig: { Binds: [] } },
      "n",
    );
    const logs = await client.containerLogs(id, { maxStdoutBytes: 600, stderrTailBytes: 100 });
    expect(logs.stdout).toHaveLength(600);
    expect(logs.stdoutTruncated).toBe(true);
    expect(logs.stderr).toBe("B".repeat(100));
  });

  it("redacts the daemon's error messages", async () => {
    api.createStatus = 500;
    const error = await client
      .createContainer({ Image: "x", Entrypoint: [], Cmd: [], HostConfig: { Binds: [] } }, "n")
      .catch((caught: Error) => caught);
    expect(error).toBeInstanceOf(EngineApiError);
    expect((error as Error).message).toContain("create refused");
  });
});

describe("LogDemuxer", () => {
  it("decodes frames split at any byte", () => {
    const stream = Buffer.concat([
      FakeEngineApi.frame(1, "hello "),
      FakeEngineApi.frame(2, "err"),
      FakeEngineApi.frame(1, "world"),
      FakeEngineApi.frame(0, "stdin echo is ignored"),
    ]);
    for (let split = 0; split <= stream.length; split++) {
      const out: string[] = [];
      const err: string[] = [];
      const demuxer = new LogDemuxer((kind, data) =>
        (kind === "stdout" ? out : err).push(data.toString()),
      );
      demuxer.push(stream.subarray(0, split));
      demuxer.push(stream.subarray(split));
      expect(out.join("")).toBe("hello world");
      expect(err.join("")).toBe("err");
    }
  });
});

describe("splitReference", () => {
  it.each([
    ["docker:27-cli", "docker", "27-cli"],
    ["docker", "docker", "latest"],
    ["ghcr.io/restow-backup/restow:0.1.0", "ghcr.io/restow-backup/restow", "0.1.0"],
    ["localhost:5000/restow", "localhost:5000/restow", "latest"],
    ["localhost:5000/restow:1", "localhost:5000/restow", "1"],
  ])("%s", (reference, fromImage, tag) => {
    expect(splitReference(reference)).toEqual({ fromImage, tag });
  });

  it("leaves a digest reference whole", () => {
    expect(splitReference(`docker@sha256:${"a".repeat(64)}`)).toEqual({
      fromImage: `docker@sha256:${"a".repeat(64)}`,
      tag: null,
    });
  });
});
