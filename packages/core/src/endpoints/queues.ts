/**
 * The pg-boss queues of the endpoint jobs (docs/AGENT.md). They are their own
 * queues next to the tenant queues of `job_queue`, like the audit anchor and
 * the webhook dispatcher: they do not run on protected objects, so they need
 * no `jobs` row. apps/scheduler mirrors the names (it has no dependency on
 * this package); keep both in step.
 */
export const ENDPOINT_QUEUES = {
  /** `restic forget --prune` with the endpoint's retention. */
  retention: "endpoint-retention",
  /** `restic check --read-data-subset`. */
  check: "endpoint-check",
  /** The restore test: read the stored samples back and compare their hashes. */
  verify: "endpoint-verify",
  /** Silent endpoints, failed runs and tasks nobody picked up: raises the alerts. */
  monitor: "endpoint-monitor",
} as const;

export type EndpointQueue = (typeof ENDPOINT_QUEUES)[keyof typeof ENDPOINT_QUEUES];

/** How pg-boss runs an endpoint queue; the worker and the scheduler create the queues from this. */
export interface EndpointQueueSettings {
  readonly name: EndpointQueue;
  readonly policy: "stately";
  readonly retryLimit: number;
  readonly retryDelay: number;
  readonly retryBackoff: boolean;
  readonly expireInHours: number;
  readonly retentionDays: number;
}

export const ENDPOINT_QUEUE_SETTINGS: Readonly<Record<EndpointQueue, EndpointQueueSettings>> = {
  [ENDPOINT_QUEUES.retention]: {
    name: ENDPOINT_QUEUES.retention,
    policy: "stately",
    retryLimit: 3,
    retryDelay: 300,
    retryBackoff: true,
    expireInHours: 12,
    retentionDays: 14,
  },
  [ENDPOINT_QUEUES.check]: {
    name: ENDPOINT_QUEUES.check,
    policy: "stately",
    retryLimit: 3,
    retryDelay: 300,
    retryBackoff: true,
    expireInHours: 12,
    retentionDays: 14,
  },
  [ENDPOINT_QUEUES.verify]: {
    name: ENDPOINT_QUEUES.verify,
    policy: "stately",
    retryLimit: 3,
    retryDelay: 120,
    retryBackoff: true,
    expireInHours: 4,
    retentionDays: 14,
  },
  [ENDPOINT_QUEUES.monitor]: {
    name: ENDPOINT_QUEUES.monitor,
    policy: "stately",
    retryLimit: 1,
    retryDelay: 60,
    retryBackoff: false,
    expireInHours: 1,
    retentionDays: 3,
  },
};

export interface EndpointJobPayload {
  tenantId: string;
  endpointId: string;
  /** For `endpoint-check`: the share of the pack files to read, in percent. */
  subsetPercent?: number;
  /** For `endpoint-verify`: test again although this snapshot was tested before. */
  force?: boolean;
}

/** pg-boss singleton key: one queued and one active job per endpoint and kind. */
export function endpointSingletonKey(queue: EndpointQueue, endpointId: string): string {
  return `${queue}:${endpointId}`;
}

/** How often each job is due. */
export const ENDPOINT_JOB_INTERVALS_MS = {
  retention: 24 * 60 * 60 * 1000,
  check: 7 * 24 * 60 * 60 * 1000,
  monitor: 5 * 60 * 1000,
} as const;

/** Default share of the repository the weekly check reads back. */
export const DEFAULT_CHECK_SUBSET_PERCENT = 5;
