import { z } from "zod";
import type { EndpointSummaryDto } from "../../features/endpoints/dto.js";
import { listEndpoints } from "../../features/endpoints/service.js";
import { type IntegrationApi, READ_ERRORS, type V1Deps } from "./api.js";
import { V1_AUDIT_ACTIONS, readRecorder } from "./audit.js";
import { component } from "./components.js";
import { readinessStateSchema, timestampSchema, uuidSchema } from "./schemas.js";

/**
 * GET /endpoints: the servers and clients that the Restow agent backs up
 * (docs/AGENT.md), for the RMM's asset list and per-machine billing. The
 * readiness of an endpoint follows the same rule as a mailbox's: it is green
 * only after a restore test of its newest backup matched every sampled hash.
 * A failed endpoint run also raises the `job.failed` webhook.
 */

export const endpointSchema = component(
  "Endpoint",
  z.object({
    id: uuidSchema,
    hostname: z.string(),
    displayName: z.string().nullable(),
    profile: z.enum(["server", "client"]),
    os: z.enum(["linux", "windows", "darwin"]),
    arch: z.enum(["amd64", "arm64"]),
    agentVersion: z.string().nullable(),
    status: z.enum(["active", "revoked"]),
    connection: z
      .enum(["online", "offline", "never"])
      .describe("`online` when the agent was heard from within 15 minutes."),
    lastSeenAt: timestampSchema.nullable(),
    lastBackupAt: timestampSchema
      .nullable()
      .describe("End of the last backup run, whatever its outcome."),
    lastSuccessAt: timestampSchema
      .nullable()
      .describe("End of the last backup that produced a snapshot."),
    readiness: z.object({
      state: readinessStateSchema,
      checkedAt: timestampSchema.nullable(),
      overdue: z.boolean(),
    }),
    attention: z
      .array(
        z.enum([
          "silent",
          "backup_overdue",
          "last_backup_failed",
          "restore_test_failed",
          "repository_damaged",
          "never_seen",
          "no_job",
        ]),
      )
      .describe(
        "Why the machine needs attention: a server that stopped reporting, a client without a good backup for days, a failed backup, a failed restore test, a damaged repository, an agent that never reported, or a machine in no backup job (nothing backs it up).",
      ),
    createdAt: timestampSchema,
  }),
);
export type EndpointDto = z.infer<typeof endpointSchema>;

export const endpointsPageSchema = component(
  "EndpointList",
  z.object({
    items: z.array(endpointSchema),
    total: z.number().int(),
  }),
);
export type EndpointsPageDto = z.infer<typeof endpointsPageSchema>;

export const endpointsQuerySchema = z.object({
  profile: z.enum(["server", "client"]).optional().describe("Only servers or only clients."),
});

export const endpointCountsSchema = component(
  "EndpointCounts",
  z.object({
    total: z.number().int().describe("Endpoints that are not revoked."),
    servers: z.number().int(),
    clients: z.number().int(),
    revoked: z.number().int(),
    needingAttention: z
      .number()
      .int()
      .describe("Endpoints with at least one reason in `attention`."),
    lastSuccessAt: timestampSchema.nullable().describe("Newest good endpoint backup."),
  }),
);
export type EndpointCountsDto = z.infer<typeof endpointCountsSchema>;

export function toEndpointDto(summary: EndpointSummaryDto): EndpointDto {
  return {
    id: summary.id,
    hostname: summary.hostname,
    displayName: summary.displayName,
    profile: summary.profile,
    os: summary.os,
    arch: summary.arch,
    agentVersion: summary.agentVersion,
    status: summary.status,
    connection: summary.connection,
    lastSeenAt: summary.lastSeenAt,
    lastBackupAt: summary.lastBackupAt,
    lastSuccessAt: summary.lastSuccessAt,
    readiness: {
      state: summary.readiness.state,
      checkedAt: summary.readiness.checkedAt,
      overdue: summary.readiness.overdue,
    },
    attention: summary.attention,
    createdAt: summary.createdAt,
  };
}

export function countEndpoints(items: readonly EndpointSummaryDto[]): EndpointCountsDto {
  const active = items.filter((item) => item.status === "active");
  const newest = active
    .map((item) => item.lastSuccessAt)
    .filter((at): at is string => at !== null)
    .sort()
    .at(-1);
  return {
    total: active.length,
    servers: active.filter((item) => item.profile === "server").length,
    clients: active.filter((item) => item.profile === "client").length,
    revoked: items.length - active.length,
    needingAttention: active.filter((item) => item.attention.length > 0).length,
    lastSuccessAt: newest ?? null,
  };
}

/** The counts `/status` shows: how many servers and clients, and how many need attention. */
export async function loadEndpointCounts(
  db: V1Deps["db"],
  tenantId: string,
  now: Date,
): Promise<EndpointCountsDto> {
  return countEndpoints((await listEndpoints(db, tenantId, {}, now)).items);
}

export function registerEndpointRoutes(api: IntegrationApi, deps: V1Deps): void {
  const { db } = deps;
  const recordRead = readRecorder(deps);

  api.tenant(
    {
      method: "get",
      path: "/endpoints",
      operationId: "listEndpoints",
      summary: "Servers and clients backed up by the agent, with status and readiness",
      description:
        "Every enrolled machine of the tenant with its connection state, last backup and recovery readiness. Not paged: a tenant has far fewer machines than mailboxes.",
      tag: "Endpoints",
      scope: "status:read",
      audited: true,
      query: endpointsQuerySchema,
      errors: READ_ERRORS,
      response: {
        status: 200,
        description: "The tenant's endpoints.",
        schema: endpointsPageSchema,
      },
    },
    async ({ tenant, actor, input: { query } }) => {
      const { items } = await listEndpoints(db, tenant.id, { profile: query.profile }, deps.now());
      await recordRead(tenant.id, actor, {
        action: V1_AUDIT_ACTIONS.endpointsRead,
        target: tenant.id,
        targetType: "tenant",
        details: {
          count: items.length,
          ...(query.profile ? { filters: { profile: query.profile } } : {}),
        },
      });
      return { items: items.map(toEndpointDto), total: items.length };
    },
  );
}
