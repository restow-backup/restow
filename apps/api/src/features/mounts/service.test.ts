import type { AuditEvent } from "@restow/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type MountSpec, mountSpecSchema } from "../../mounter/protocol.js";
import { ProblemError } from "../../problem.js";
import {
  MounterRejectedError,
  MounterUnavailableError,
  createMounterClient,
} from "./mounter-client.js";
import { MOUNT_PROBLEMS, type MountUser, MountsService, liesOn } from "./service.js";

const ACTOR = { id: "u1", email: "owner@example.com", ip: "192.0.2.1" };
const SHARE: MountSpec = mountSpecSchema.parse({
  protocol: "nfs",
  name: "nas",
  server: "10.0.0.5",
  export: "/srv/backup",
});

const STATE = {
  mounterVersion: "0.3.0",
  mounts: [],
  operation: null,
  history: [],
  capabilities: {
    ready: true,
    blockers: [],
    runner: "helper",
    composeFile: "docker-compose.yml",
    overrideFile: "docker-compose.override.yml",
    protocols: ["nfs"],
    checkedAt: "2026-10-01T10:00:00.000Z",
  },
  serverTime: "2026-10-01T10:00:00.000Z",
} as const;

const client = {
  enabled: true,
  state: vi.fn(),
  failure: vi.fn(),
  add: vi.fn(),
  remove: vi.fn(),
  test: vi.fn(),
};
let work = { jobs: 0, endpointRuns: 0 };
let users: MountUser[] = [];
let audits: AuditEvent[] = [];

function service(demo = false) {
  return new MountsService({
    client,
    activeWork: async () => work,
    usersOf: async () => users,
    audit: async (event) => {
      audits.push(event);
    },
    demo,
  });
}

async function problemOf(promise: Promise<unknown>): Promise<ProblemError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ProblemError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected a problem");
}

beforeEach(() => {
  vi.clearAllMocks();
  client.state.mockResolvedValue(STATE);
  client.failure.mockReturnValue(null);
  client.add.mockResolvedValue(STATE);
  client.remove.mockResolvedValue(STATE);
  client.test.mockResolvedValue({ ok: true, code: null, detail: null, wrote: true, durationMs: 3 });
  work = { jobs: 0, endpointRuns: 0 };
  users = [];
  audits = [];
});

describe("MountsService", () => {
  it("shows how to start the mounter when it does not answer", async () => {
    client.state.mockResolvedValue(null);
    client.failure.mockReturnValue("unreachable");
    const view = await service().view();
    expect(view).toMatchObject({
      available: false,
      unavailableReason: "unreachable",
      enableCommand: "docker compose --profile mounts up -d mounter",
      mountRoot: "/mnt/restow",
      state: null,
    });
  });

  it("adds a share and audits it with the actor", async () => {
    await service().add({ mount: SHARE }, ACTOR);
    expect(client.add).toHaveBeenCalledWith({
      mount: SHARE,
      requestedBy: { userId: "u1", label: "owner@example.com", ip: "192.0.2.1" },
    });
    expect(audits).toEqual([
      expect.objectContaining({
        tenantId: null,
        actor: "owner@example.com",
        actorUserId: "u1",
        action: "mount.add_requested",
        target: "nas",
        targetType: "mount",
        details: expect.objectContaining({ server: "10.0.0.5", path: "/mnt/restow/nas" }),
      }),
    ]);
  });

  it("refuses changes while jobs or endpoint runs are running", async () => {
    work = { jobs: 2, endpointRuns: 0 };
    let problem = await problemOf(service().add({ mount: SHARE }, ACTOR));
    expect(problem.status).toBe(409);
    expect(problem.type).toBe(MOUNT_PROBLEMS.jobsRunning);
    work = { jobs: 0, endpointRuns: 1 };
    problem = await problemOf(service().remove("nas", ACTOR));
    expect(problem.type).toBe(MOUNT_PROBLEMS.jobsRunning);
    expect(client.add).not.toHaveBeenCalled();
    expect(client.remove).not.toHaveBeenCalled();
    expect(audits).toEqual([]);
  });

  it("refuses to remove a share a storage location uses", async () => {
    users = [
      { kind: "target", tenantId: "t1", tenantName: "Acme", name: "NAS", path: "/mnt/restow/nas" },
    ];
    const problem = await problemOf(service().remove("nas", ACTOR));
    expect(problem.status).toBe(409);
    expect(problem.type).toBe(MOUNT_PROBLEMS.inUse);
    expect(problem.extensions?.users).toEqual(users);
    expect(client.remove).not.toHaveBeenCalled();
  });

  it("removes a share nobody uses", async () => {
    await service().remove("nas", ACTOR);
    expect(client.remove).toHaveBeenCalledWith("nas", {
      requestedBy: { userId: "u1", label: "owner@example.com", ip: "192.0.2.1" },
    });
    expect(audits[0]?.action).toBe("mount.remove_requested");
  });

  it("turns an absent mounter into 503 with the command, and refusals into problems", async () => {
    client.add.mockRejectedValueOnce(new MounterUnavailableError("unreachable"));
    let problem = await problemOf(service().add({ mount: SHARE }, ACTOR));
    expect(problem.status).toBe(503);
    expect(problem.type).toBe(MOUNT_PROBLEMS.unavailable);
    expect(problem.extensions?.command).toBe("docker compose --profile mounts up -d mounter");
    client.add.mockRejectedValueOnce(
      new MounterRejectedError(409, "exists", "A share named nas exists already."),
    );
    problem = await problemOf(service().add({ mount: SHARE }, ACTOR));
    expect(problem.status).toBe(409);
    expect(problem.extensions?.code).toBe("exists");
    expect(problem.detail).toContain("exists already");
    expect(audits).toEqual([]);
  });

  it("tests and audits the test", async () => {
    const result = await service().test({ mount: SHARE }, ACTOR);
    expect(result.ok).toBe(true);
    expect(audits[0]).toMatchObject({ action: "mount.tested", target: "nas" });
  });

  it("changes nothing in the demo", async () => {
    const demo = service(true);
    expect((await demo.view()).available).toBe(false);
    expect((await problemOf(demo.add({ mount: SHARE }, ACTOR))).status).toBe(403);
    expect((await problemOf(demo.test({ name: "nas" }, ACTOR))).status).toBe(403);
    expect(client.state).not.toHaveBeenCalled();
  });

  it("knows which paths lie on a share", () => {
    expect(liesOn("/mnt/restow/nas", "/mnt/restow/nas")).toBe(true);
    expect(liesOn("/mnt/restow/nas/", "/mnt/restow/nas")).toBe(true);
    expect(liesOn("/mnt/restow/nas/tenant-a", "/mnt/restow/nas")).toBe(true);
    expect(liesOn("/mnt/restow/nas2", "/mnt/restow/nas")).toBe(false);
  });
});

describe("createMounterClient", () => {
  const SECRET = "c".repeat(64);

  it("sends the shared secret and reads the state", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(STATE), { status: 200 }));
    const mounter = createMounterClient({
      url: "http://mounter:8091/",
      secretFile: "/s",
      readFile: async () => `${SECRET}\n`,
      fetch: fetcher as never,
    });
    expect(await mounter.state()).toMatchObject({ mounterVersion: "0.3.0" });
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://mounter:8091/v1/state");
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${SECRET}`);
  });

  it("answers null with the reason when nothing usable answers", async () => {
    const down = createMounterClient({
      url: "http://mounter:8091",
      secretFile: "/s",
      readFile: async () => SECRET,
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as never,
    });
    expect(await down.state()).toBeNull();
    expect(down.failure()).toBe("unreachable");

    const noSecret = createMounterClient({
      url: "http://mounter:8091",
      secretFile: "/s",
      readFile: async () => {
        throw new Error("ENOENT");
      },
    });
    expect(await noSecret.state()).toBeNull();
    expect(noSecret.failure()).toBe("no_secret");

    const other = createMounterClient({
      url: "http://mounter:8091",
      secretFile: "/s",
      readFile: async () => SECRET,
      fetch: (async () => new Response(JSON.stringify({ hello: 1 }))) as never,
    });
    expect(await other.state()).toBeNull();
    expect(other.failure()).toBe("incompatible");
  });

  it("passes the mounter's refusal on", async () => {
    const mounter = createMounterClient({
      url: "http://mounter:8091",
      secretFile: "/s",
      readFile: async () => SECRET,
      fetch: (async () =>
        new Response(JSON.stringify({ code: "busy", message: "Another change runs." }), {
          status: 409,
        })) as never,
    });
    await expect(
      mounter.add({ mount: SHARE, requestedBy: { userId: null, label: "x", ip: null } }),
    ).rejects.toMatchObject({ status: 409, code: "busy", detail: "Another change runs." });
  });
});
