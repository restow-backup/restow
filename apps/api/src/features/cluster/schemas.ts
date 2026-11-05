import { z } from "zod";

/** Request documents of Installation > Cluster (routes.ts) and of the join (join-routes.ts). */

/** A node name: what the heartbeat reports as its host name (no dots, no IP address). */
export const NODE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export const JOIN_TOKEN_MIN_MINUTES = 15;
export const JOIN_TOKEN_MAX_MINUTES = 24 * 60;
export const JOIN_TOKEN_DEFAULT_MINUTES = 60;

export const createJoinTokenSchema = z
  .object({
    nodeName: z.string().trim().toLowerCase().regex(NODE_NAME),
    /** Only a request from this address may redeem the token (recommended). */
    expectedAddress: z.union([z.ipv4(), z.ipv6()]).nullable().optional(),
    ttlMinutes: z
      .number()
      .int()
      .min(JOIN_TOKEN_MIN_MINUTES)
      .max(JOIN_TOKEN_MAX_MINUTES)
      .default(JOIN_TOKEN_DEFAULT_MINUTES),
    standbyScheduler: z.boolean().default(false),
  })
  .strict();
export type CreateJoinTokenInput = z.infer<typeof createJoinTokenSchema>;

export const joinRequestSchema = z
  .object({
    nodeName: z.string().trim().toLowerCase().regex(NODE_NAME),
    hostname: z.string().trim().max(253).nullable().optional(),
    /** The release the node runs (its image's version). */
    version: z.string().trim().min(1).max(64),
  })
  .strict();
export type JoinRequest = z.infer<typeof joinRequestSchema>;
