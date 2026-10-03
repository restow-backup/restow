import type { DemoMachine } from "./endpoint-files.js";
import { hostPath } from "./endpoint-files.js";
import type { ApiClient } from "./http-client.js";

/**
 * Since release 0.2.1 a newly enrolled machine has the schedule `none` and no
 * folders until it belongs to a backup job (docs/AGENT.md, "Rechner ohne Job").
 * What an administrator does in the UI after enrolling, the seed does over the
 * real API: one machine job per demo tenant, the tenant's simulated machines as
 * members, each with its own folders, backing up daily. The server then writes
 * the schedule and the folders into the machine's configuration and queues an
 * `update_config` task; the simulated agent fetches the configuration before
 * its first backup (endpoint-history.ts). Every call carries the seed's bypass
 * token (`seed: true`) for the demo guard.
 */

/** The job of a tenant's simulated machines. */
export const DEMO_MACHINE_JOB_NAME = "Machines";

/** Daily at 02:00 Berlin time, the demo's own time zone (deploy/demo/README.md, "Reset"). */
export const DEMO_MACHINE_JOB_SCHEDULE = {
  kind: "daily",
  timeOfDay: "02:00",
  timeZone: "Europe/Berlin",
} as const;

export interface JobMember {
  id: string;
  overrides: { paths: string[] };
}

/** A machine as a job member: its folders on this computer, as the agent is configured with them. */
export function jobMember(root: string, machine: DemoMachine, endpointId: string): JobMember {
  return {
    id: endpointId,
    overrides: { paths: machine.paths.map((path) => hostPath(root, path)) },
  };
}

/** The request that creates a tenant's machine job around its first machine. */
export function createJobRequest(root: string, machine: DemoMachine, endpointId: string) {
  const member = jobMember(root, machine, endpointId);
  return {
    kind: "endpoint" as const,
    name: DEMO_MACHINE_JOB_NAME,
    schedule: DEMO_MACHINE_JOB_SCHEDULE,
    // The job needs folders of its own; each member overrides them with its own.
    settings: { paths: member.overrides.paths },
    scope: { mode: "selected" as const, members: [member] },
  };
}

/**
 * Put a machine into its tenant's job: create the job with the first machine,
 * add every further one. `jobs` remembers the job of each tenant for the phase.
 */
export async function putMachineInJob(
  client: ApiClient,
  jobs: Map<string, string>,
  input: { tenantId: string; root: string; machine: DemoMachine; endpointId: string },
): Promise<string> {
  const { tenantId, root, machine, endpointId } = input;
  const existing = jobs.get(tenantId);
  if (existing) {
    await client.post(
      `/api/v1/backup-jobs/${existing}/members`,
      { members: [jobMember(root, machine, endpointId)] },
      { tenantId, seed: true },
    );
    return existing;
  }
  const job = await client.post<{ id: string }>(
    "/api/v1/backup-jobs",
    createJobRequest(root, machine, endpointId),
    { tenantId, seed: true },
  );
  jobs.set(tenantId, job.id);
  return job.id;
}
