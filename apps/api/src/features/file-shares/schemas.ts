import {
  MAX_SHARE_QUOTA_GIB,
  SHARE_NFS_VERSIONS,
  SMB_VERSIONS,
  isValidDomain,
  isValidShareName,
  isValidSharePassword,
  isValidSubfolder,
  isValidUsername,
  normalizeShareExport,
  normalizeShareServer,
} from "@restow/core";
import { z } from "zod";

/**
 * Request schemas of /api/v1/file-shares (docs/FILESHARES.md 9.1). The connection fields follow
 * the mounter's rules (3.2; @restow/core file-shares/validate.ts mirrors them), so a share the
 * api saves is one the mounter accepts. Every refusal names its field (`issues[0].path`), so the
 * add dialog shows it where it belongs.
 */

const uuid = z.string().uuid();

export const shareNameSchema = z.string().trim().min(1).max(120);

const serverSchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .refine((value) => normalizeShareServer(value) !== null, {
    message: "Enter a host name or an IP address (no protocol, port or path).",
  })
  .transform((value) => normalizeShareServer(value) as string);

/** An SMB share name, without the server or slashes. */
const smbShareSchema = z.string().trim().refine(isValidShareName, {
  message: 'Up to 80 characters, without \\ / : * ? " < > | and not "." or "..".',
});

const exportSchema = z
  .string()
  .trim()
  .refine((value) => normalizeShareExport(value) !== null, {
    message: "An absolute export path such as /srv/data.",
  })
  .transform((value) => normalizeShareExport(value) as string);

/** A folder below the share root ("" for the root); leading and trailing slashes are dropped. */
const subfolderSchema = z
  .string()
  .max(1100)
  .transform((value) =>
    value
      .replace(/\\/g, "/")
      .split("/")
      .filter((segment) => segment.length > 0)
      .join("/"),
  )
  .refine(isValidSubfolder, {
    message: "Folder names separated by /, without . or .. and at most 1024 characters.",
  });

/** The account: a plain name, `user@domain`, or `DOMAIN\user` (split by the service). */
const accountSchema = z
  .string()
  .trim()
  .min(1)
  .max(360)
  .refine(
    (value) => {
      const backslash = value.indexOf("\\");
      if (backslash > 0 && backslash === value.lastIndexOf("\\")) {
        return (
          isValidDomain(value.slice(0, backslash)) && isValidUsername(value.slice(backslash + 1))
        );
      }
      return isValidUsername(value);
    },
    { message: "A user name, user@domain or DOMAIN\\user, without , = / and control characters." },
  );

const domainSchema = z
  .string()
  .trim()
  .max(255)
  .refine((value) => value === "" || isValidDomain(value), {
    message: "A NetBIOS or DNS domain name.",
  })
  .transform((value) => (value === "" ? null : value));

const passwordSchema = z.string().refine(isValidSharePassword, {
  message:
    "1 to 256 bytes without control characters; a part between commas may not be a mount flag such as ro or rw.",
});

export const smbVersionSchema = z.enum(SMB_VERSIONS);
export const nfsVersionSchema = z.enum(SHARE_NFS_VERSIONS);
export const permissionsModeSchema = z.enum(["auto", "off"]);

const smbConnection = {
  protocol: z.literal("smb"),
  server: serverSchema,
  share: smbShareSchema,
  subfolder: subfolderSchema.default(""),
  account: accountSchema,
  domain: domainSchema.nullable().optional(),
  smbVersion: smbVersionSchema.default("3.1.1"),
  seal: z.boolean().default(false),
};

const nfsConnection = {
  protocol: z.literal("nfs"),
  server: serverSchema,
  export: exportSchema,
  subfolder: subfolderSchema.default(""),
  nfsVersion: nfsVersionSchema.default("4.1"),
};

function sealNeedsSmb3<T extends { protocol: string; smbVersion?: string; seal?: boolean }>(
  value: T,
  ctx: z.RefinementCtx,
): void {
  if (value.protocol === "smb" && value.seal && value.smbVersion === "2.1") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["seal"],
      message: "Encryption needs SMB 3.0 or newer.",
    });
  }
}

/** A connection to test before it is saved: the password is part of it (SMB). */
export const testConnectionSchema = z
  .discriminatedUnion("protocol", [
    z.object({ ...smbConnection, password: passwordSchema }).strict(),
    z.object(nfsConnection).strict(),
  ])
  .superRefine(sealNeedsSmb3);
export type TestConnectionInput = z.infer<typeof testConnectionSchema>;

const shareOptions = {
  name: shareNameSchema,
  allowRestore: z.boolean().default(false),
  permissionsMode: permissionsModeSchema.default("auto"),
  rereadPermissions: z.boolean().default(false),
};

export const createShareSchema = z
  .discriminatedUnion("protocol", [
    z.object({ ...smbConnection, password: passwordSchema, ...shareOptions }).strict(),
    z.object({ ...nfsConnection, ...shareOptions }).strict(),
  ])
  .superRefine(sealNeedsSmb3);
export type CreateShareInput = z.infer<typeof createShareSchema>;

/**
 * A change: any field; `password` replaces the stored one (no re-adding). Changing where the
 * share is (server, share, export, subfolder) of a share with restore points needs
 * `confirmNewLocation` (the next backup reads everything again).
 */
export const updateShareSchema = z
  .object({
    name: shareNameSchema.optional(),
    server: serverSchema.optional(),
    share: smbShareSchema.optional(),
    export: exportSchema.optional(),
    subfolder: subfolderSchema.optional(),
    account: accountSchema.optional(),
    domain: domainSchema.nullable().optional(),
    password: passwordSchema.optional(),
    smbVersion: smbVersionSchema.optional(),
    seal: z.boolean().optional(),
    nfsVersion: nfsVersionSchema.optional(),
    allowRestore: z.boolean().optional(),
    permissionsMode: permissionsModeSchema.optional(),
    rereadPermissions: z.boolean().optional(),
    confirmNewLocation: z.boolean().optional(),
  })
  .strict()
  .refine(
    (patch) =>
      Object.entries(patch).some(
        ([key, value]) => key !== "confirmNewLocation" && value !== undefined,
      ),
    {
      message: "Nothing to update.",
    },
  );
export type UpdateShareInput = z.infer<typeof updateShareSchema>;

export const idParamSchema = z.object({ id: uuid });
export const runParamSchema = z.object({ id: uuid, runId: uuid });
export const downloadParamSchema = z.object({ id: uuid, downloadId: uuid });

export const listQuerySchema = z.object({
  retired: z.enum(["include", "only", "exclude"]).default("exclude"),
});

export const sourceQuerySchema = z.object({
  path: z
    .string()
    .max(1100)
    .default("")
    .transform((value) =>
      value
        .split("/")
        .filter((segment) => segment.length > 0)
        .join("/"),
    )
    .refine(isValidSubfolder, { message: "Not a folder below the share root." }),
  limit: z.coerce.number().int().min(1).max(2000).default(500),
});

export const backupNowSchema = z
  .object({
    /** "Back up the empty share once" (4.3): the next backup may find the share empty. */
    allowEmptyOnce: z.boolean().default(false),
  })
  .strict()
  .default({ allowEmptyOnce: false });

export const deleteShareSchema = z.object({ confirmName: z.string().max(200) }).strict();

export const runsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(30),
  kind: z.enum(["backup", "restore"]).optional(),
});

export const runItemsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
  code: z
    .string()
    .regex(/^[a-z_]{1,40}$/)
    .optional(),
});

/** A path inside the share, as the browser shows it: absolute below the share root (`/a/b`). */
export const sharePathSchema = z
  .string()
  .max(4096)
  .refine((value) => value.startsWith("/"), { message: "An absolute path below the share root." })
  .refine(
    (value) =>
      value === "/" ||
      value
        .slice(1)
        .replace(/\/$/, "")
        .split("/")
        .every((segment) => segment !== "" && segment !== "." && segment !== ".."),
    { message: "A plain path without . or .. segments." },
  )
  .transform((value) => (value.length > 1 ? value.replace(/\/+$/, "") : value));

export const browseQuerySchema = z.object({
  snapshot: uuid,
  path: sharePathSchema.default("/"),
  limit: z.coerce.number().int().min(1).max(2000).default(500),
  cursor: z.string().max(8192).optional(),
});

export const searchQuerySchema = z.object({
  q: z.string().trim().min(2).max(200),
  snapshot: uuid.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export const versionsQuerySchema = z.object({ path: sharePathSchema });

/** The most paths one download or restore names. */
export const MAX_SELECTION_PATHS = 1000;
export const MAX_DOWNLOAD_BODY_BYTES = 4 * 1024 * 1024;

export const createDownloadSchema = z
  .object({
    snapshotId: uuid,
    paths: z.array(sharePathSchema).min(1).max(MAX_SELECTION_PATHS),
  })
  .strict();
export type CreateDownloadInput = z.infer<typeof createDownloadSchema>;

/** The folder of a restore into another share (relative to its root; empty: Restow-Restore-<time>). */
const restoreFolderSchema = subfolderSchema;

export const restoreSchema = z
  .object({
    snapshotId: uuid,
    /** Files and folders below the share root; empty: everything. */
    paths: z.array(sharePathSchema).max(MAX_SELECTION_PATHS).default([]),
    destination: z.enum(["original", "new_folder", "other_share"]),
    targetShareId: uuid.optional(),
    folder: restoreFolderSchema.optional(),
    conflict: z.enum(["overwrite", "keep_both", "skip"]).optional(),
    restorePermissions: z.boolean().optional(),
    verify: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.destination === "other_share" && !value.targetShareId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["targetShareId"],
        message: "Choose the file share to restore into.",
      });
    }
    if (value.destination === "original" && !value.conflict) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["conflict"],
        message: "Choose what happens when a file exists.",
      });
    }
  });
export type RestoreInput = z.infer<typeof restoreSchema>;

export const quotaSchema = z
  .object({ quotaGib: z.number().int().min(1).max(MAX_SHARE_QUOTA_GIB).nullable() })
  .strict();

export const approvalSchema = z.object({ approved: z.boolean() }).strict();

/** The installation settings (7.4) a provider admin changes; every field optional. */
export const installationSettingsSchema = z
  .object({
    maxConcurrentRunners: z.number().int().min(1).max(64).optional(),
    runnerMemoryMiB: z.number().int().min(512).max(1_048_576).optional(),
    goMemLimitPercent: z.number().int().min(50).max(90).optional(),
    maxRunHours: z.number().int().min(1).max(336).optional(),
    defaultReadConcurrency: z.number().int().min(1).max(16).optional(),
    tenantsMayUsePrivateNetworks: z.boolean().optional(),
    defaultShareQuotaGib: z.number().int().min(0).max(MAX_SHARE_QUOTA_GIB).optional(),
    tenantShareQuotaGib: z.number().int().min(0).max(MAX_SHARE_QUOTA_GIB).optional(),
    /** A tenant's own budget for all its shares; null removes it (the installation's applies). */
    tenantShareQuotaGibByTenant: z
      .record(uuid, z.number().int().min(0).max(MAX_SHARE_QUOTA_GIB).nullable())
      .optional(),
    catalog: z
      .object({
        enabled: z.boolean().optional(),
        maxEntriesPerShare: z.number().int().min(1000).max(1_000_000_000).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((patch) => Object.values(patch).some((value) => value !== undefined), {
    message: "Nothing to update.",
  });
export type InstallationSettingsInput = z.infer<typeof installationSettingsSchema>;
