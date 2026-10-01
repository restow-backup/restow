import { z } from "zod";

/**
 * Request schemas for the storage feature (same style as apps/api/src/schemas.ts).
 *
 * These check the shape of a request. Whether an address is usable (absolute
 * path outside the system directories, a valid bucket name, an endpoint without
 * a path) is decided by `validateStorageLocation` in @restow/core, which the
 * worker applies to the same rows, so both sides agree on what a valid target is.
 */

export const storageKindSchema = z.enum(["local", "s3"]);
export const storageRoleSchema = z.enum(["primary", "copy"]);

/**
 * How a new primary target takes over from the tenant's current one, when the
 * tenant already has data (docs/STORAGE.md, "Replace the primary"): `move`
 * copies every existing backup across in a background migration, verifies it
 * by hash, then switches atomically. `keep` switches immediately, in the same
 * request, and leaves the old target attached read-only: `service.ts`'s
 * `startReplacePrimaryTx` probes the new target first (`verifyKeepTarget`),
 * refuses with 409 while the tenant has a queued or active backup, archive,
 * retention, scrub or storage_migration job (`hasActiveWriteJob`, so nothing
 * already running keeps writing to the target about to become read-only),
 * then swaps it in; the retired target becomes a `previous` row that the
 * worker's backup, restore and verify queues and the API's download path
 * still read from (never written to again). Ignored (the target is simply
 * created) unless the tenant actually has a primary to replace.
 */
export const storageMigrationModeSchema = z.enum(["move", "keep"]);
export type StorageMigrationModeInput = z.infer<typeof storageMigrationModeSchema>;

const nameSchema = z.string().trim().min(1).max(200);

/** No whitespace anywhere: pasted keys often carry a trailing newline. */
function withoutWhitespace(value: string): boolean {
  return !/\s/.test(value);
}

/**
 * S3 access key pair. Secret: accepted here, handed to the encrypted secret
 * store and never returned or logged.
 */
export const s3CredentialsSchema = z.object({
  accessKeyId: z
    .string()
    .trim()
    .min(3)
    .max(128)
    .refine(withoutWhitespace, "The access key id must not contain spaces."),
  secretAccessKey: z
    .string()
    .min(8)
    .max(256)
    .refine(withoutWhitespace, "The secret access key must not contain spaces."),
});
export type S3CredentialsInput = z.infer<typeof s3CredentialsSchema>;

export const localConfigSchema = z.object({
  basePath: z.string().max(2048),
});

export const s3ConfigSchema = z.object({
  bucket: z.string().max(255),
  prefix: z.string().max(1024).nullish(),
  /** Service origin for non-AWS providers, e.g. https://fsn1.your-objectstorage.com. */
  endpoint: z.string().max(2048).nullish(),
  region: z.string().max(128).nullish(),
  forcePathStyle: z.boolean().optional(),
});

/** The addressing schema of a target kind. */
export function configSchemaFor(kind: z.infer<typeof storageKindSchema>) {
  return kind === "local" ? localConfigSchema : s3ConfigSchema;
}

export const createStorageTargetSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("local"),
    name: nameSchema,
    role: storageRoleSchema,
    config: localConfigSchema,
    /** Only meaningful with `role: "primary"`; see {@link storageMigrationModeSchema}. */
    migrationMode: storageMigrationModeSchema.optional(),
  }),
  z.object({
    kind: z.literal("s3"),
    name: nameSchema,
    role: storageRoleSchema,
    config: s3ConfigSchema,
    credentials: s3CredentialsSchema,
    migrationMode: storageMigrationModeSchema.optional(),
  }),
]);
export type CreateStorageTargetInput = z.infer<typeof createStorageTargetSchema>;

/**
 * A change to a target. `config` replaces the addressing as a whole (the kind
 * of a target never changes); `credentials` replaces the stored key pair.
 */
export const updateStorageTargetSchema = z
  .object({
    name: nameSchema.optional(),
    /** Checked against the schema of the target's kind (see {@link configSchemaFor}). */
    config: z.record(z.string(), z.unknown()).optional(),
    credentials: s3CredentialsSchema.optional(),
  })
  .refine(
    (patch) =>
      patch.name !== undefined || patch.config !== undefined || patch.credentials !== undefined,
    "Send at least one of name, config or credentials.",
  );
export type UpdateStorageTargetInput = z.infer<typeof updateStorageTargetSchema>;

/**
 * Probe settings from the add/edit form without saving anything. When editing
 * an S3 target, `targetId` lets the probe use the stored credentials instead of
 * asking for the secret again.
 */
export const probeStorageSchema = z
  .discriminatedUnion("kind", [
    z.object({
      kind: z.literal("local"),
      config: localConfigSchema,
    }),
    z.object({
      kind: z.literal("s3"),
      config: s3ConfigSchema,
      credentials: s3CredentialsSchema.optional(),
      targetId: z.string().uuid().optional(),
    }),
  ])
  .superRefine((input, ctx) => {
    if (input.kind === "s3" && input.credentials === undefined && input.targetId === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Credentials are required unless an existing target is named.",
        path: ["credentials"],
      });
    }
  });
export type ProbeStorageInput = z.infer<typeof probeStorageSchema>;

export const targetIdParamSchema = z.object({ id: z.string().uuid() });
export const migrationIdParamSchema = z.object({ id: z.string().uuid() });
