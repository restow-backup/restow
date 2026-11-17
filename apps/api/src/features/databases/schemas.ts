import {
  DB_AUTH_METHODS,
  DB_EXECUTOR_KINDS,
  DB_MAX_INTERVAL_MINUTES,
  DB_MIN_INTERVAL_MINUTES,
  DB_MODES,
} from "@restow/core";
import { z } from "zod";
import { isValidTimeZone } from "../tenants/schemas.js";

/**
 * Request bodies of /api/v1/databases (docs/DATABASES.md 9). A password is accepted, never
 * returned; it is at most 1024 characters and never trimmed (a leading space is part of it).
 */

const uuid = z.string().uuid();
const user = z.string().trim().min(1).max(128);
const password = z.string().max(1024);
const databaseName = z.string().trim().min(1).max(128);

export const executorSchema = z
  .object({
    kind: z.enum(DB_EXECUTOR_KINDS),
    endpointId: uuid.nullish(),
  })
  .strict()
  .refine((value) => (value.kind === "agent" ? Boolean(value.endpointId) : !value.endpointId), {
    message: "An agent executor names its machine; the server names none.",
    path: ["endpointId"],
  });

export const testConnectionSchema = z
  .object({
    address: z.string().max(1024),
    user: user.nullish(),
    password: password.nullish(),
    authMethod: z.enum(DB_AUTH_METHODS).default("password"),
    executor: executorSchema,
    allowUnencrypted: z.boolean().default(false),
  })
  .strict();
export type TestConnectionInput = z.infer<typeof testConnectionSchema>;

export const selectionSchema = z
  .object({
    mode: z.enum(["all", "selected"]),
    names: z.array(databaseName).max(1000).default([]),
    exclude: z.array(databaseName).max(1000).default([]),
  })
  .strict();

export const scheduleSchema = z
  .object({
    intervalMinutes: z.number().int().min(DB_MIN_INTERVAL_MINUTES).max(DB_MAX_INTERVAL_MINUTES),
    timeZone: z.string().trim().max(64).refine(isValidTimeZone, "Unknown time zone.").nullish(),
  })
  .strict();

export const createConnectionSchema = z
  .object({
    /** The test whose facts the connection takes (engine, address, executor, identity, certificate). */
    probeId: uuid,
    name: z.string().trim().min(1).max(120).nullish(),
    user: user.nullish(),
    password: password.nullish(),
    allowUnencrypted: z.boolean().default(false),
    mode: z.enum(DB_MODES).default("backup"),
    schedule: scheduleSchema.nullish(),
    selection: selectionSchema.nullish(),
  })
  .strict();
export type CreateConnectionInput = z.infer<typeof createConnectionSchema>;

export const updateConnectionSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    /** New credentials replace the stored ones (both or the password alone). */
    user: user.optional(),
    password: password.optional(),
    executor: executorSchema.optional(),
    allowUnencrypted: z.boolean().optional(),
    mode: z.enum(DB_MODES).optional(),
    schedule: scheduleSchema.optional(),
    selection: selectionSchema.optional(),
    enabled: z.boolean().optional(),
    /**
     * Accept what a test of this connection found: its new TLS certificate or its new instance
     * (3.2, 3.3). Audited; the history of the old instance stays separate.
     */
    confirm: z
      .object({
        probeId: uuid,
        tls: z.boolean().default(false),
        instance: z.boolean().default(false),
      })
      .strict()
      .optional(),
  })
  .strict();
export type UpdateConnectionInput = z.infer<typeof updateConnectionSchema>;

export const idParamSchema = z.object({ id: uuid });
export const probeParamSchema = z.object({ probeId: uuid });
