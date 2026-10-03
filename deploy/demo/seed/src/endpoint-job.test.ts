import { describe, expect, it } from "vitest";
import { DEMO_MACHINES } from "./endpoint-files.js";
import {
  DEMO_MACHINE_JOB_NAME,
  DEMO_MACHINE_JOB_SCHEDULE,
  createJobRequest,
  jobMember,
  putMachineInJob,
} from "./endpoint-job.js";
import type { ApiClient } from "./http-client.js";

const [fileserver, laptop] = DEMO_MACHINES;

interface Call {
  path: string;
  body: unknown;
  options: { tenantId?: string; seed?: boolean };
}

function fakeClient(calls: Call[]): ApiClient {
  return {
    post: async (path: string, body: unknown, options: Call["options"]) => {
      calls.push({ path, body, options });
      return { id: "job-1" };
    },
  } as unknown as ApiClient;
}

describe("the machine job of the demo seed", () => {
  it("gives each machine its own folders under the simulated root", () => {
    expect(jobMember("/", fileserver, "e1")).toEqual({
      id: "e1",
      overrides: { paths: ["/srv/share", "/etc/samba", "/var/log/samba"] },
    });
    expect(jobMember("/sim", laptop, "e2").overrides.paths).toEqual(["/sim/Users/jdoe"]);
  });

  it("creates a daily endpoint job with the machine as its only member", () => {
    const request = createJobRequest("/", fileserver, "e1");
    expect(request.kind).toBe("endpoint");
    expect(request.name).toBe(DEMO_MACHINE_JOB_NAME);
    expect(request.schedule).toEqual(DEMO_MACHINE_JOB_SCHEDULE);
    expect(request.schedule.kind).toBe("daily");
    expect(request.scope.mode).toBe("selected");
    expect(request.scope.members).toHaveLength(1);
    expect(request.settings.paths).toEqual(["/srv/share", "/etc/samba", "/var/log/samba"]);
  });

  it("creates the job once per tenant and adds later machines to it, always with the seed token", async () => {
    const calls: Call[] = [];
    const client = fakeClient(calls);
    const jobs = new Map<string, string>();
    await putMachineInJob(client, jobs, {
      tenantId: "t1",
      root: "/",
      machine: fileserver,
      endpointId: "e1",
    });
    await putMachineInJob(client, jobs, {
      tenantId: "t1",
      root: "/",
      machine: laptop,
      endpointId: "e2",
    });
    await putMachineInJob(client, jobs, {
      tenantId: "t2",
      root: "/",
      machine: laptop,
      endpointId: "e3",
    });
    expect(calls.map((call) => call.path)).toEqual([
      "/api/v1/backup-jobs",
      "/api/v1/backup-jobs/job-1/members",
      "/api/v1/backup-jobs",
    ]);
    expect(calls.map((call) => call.options)).toEqual([
      { tenantId: "t1", seed: true },
      { tenantId: "t1", seed: true },
      { tenantId: "t2", seed: true },
    ]);
    expect(calls[1]?.body).toEqual({ members: [jobMember("/", laptop, "e2")] });
  });
});
