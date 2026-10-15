/**
 * The repository password of an endpoint, sealed next to the repository
 * (docs/AGENT.md, "Restore ohne Restow").
 *
 * restic encrypts an endpoint's repository with a random password the server
 * keeps in its secret store (`secrets`, sealed with the tenant's data key).
 * Without the database that password would be gone, and with it every backup
 * of the machine. So the server also stores it in the storage target, sealed
 * under the same tenant data key the mail backups use:
 *
 *   endpoints/<endpoint id>/restow-repository-password.json
 *
 *   {
 *     "format": "restow-endpoint-repository-password-v1",
 *     "tenantId": "<tenant id>",
 *     "endpointId": "<endpoint id>",
 *     "sealed": "<base64: AES-256-GCM, chunk format of crypto.ts>"
 *   }
 *
 * The sealed blob names its key version in its header; its additional data
 * is `restow.endpoint-repository:<tenant id>:<endpoint id>`, so a document
 * copied to another endpoint or tenant does not open. The wrapped tenant keys
 * already lie in the same storage (`tenants/<tid>/keys/<version>`), so the
 * master key (KEK) plus the storage are enough: `restow-restore
 * endpoint-password` opens the document, and plain restic opens the
 * repository with the password.
 *
 * The file sits at the root of the repository folder, outside restic's own
 * folders (`keys/` in particular, where restic would try to read it as a key
 * and fail): restic ignores it, and the restic endpoint of the API cannot
 * address it, so an agent can neither read nor replace it.
 *
 * The same document guards the repository of a file share (docs/FILESHARES.md 5.4): format
 * `restow-file-share-repository-password-v1`, field `fileShareId`, at
 * `file-shares/<share id>/restow-repository-password.json`, additional data
 * `restow.file-share-repository:<tenant id>:<share id>`. Both are the generic document below
 * with their own {@link RepositoryPasswordKind}.
 */
import { type Dek, decryptChunk, encryptChunk } from "../crypto.js";
import { sealedAad } from "../engine/keyring.js";
import type { StorageBackend } from "../storage/backend.js";
import { endpointPrefix } from "./restic-cli.js";

/** What tells the sealed password documents of two kinds of repository apart. */
export interface RepositoryPasswordKind {
  /** The `format` field. */
  readonly format: string;
  /** The field that names the repository's owner (`endpointId`, `fileShareId`). */
  readonly idField: string;
  /** The first part of the additional data. */
  readonly aadLabel: string;
  /** The repository's storage prefix. */
  prefix(id: string): string;
}

export const ENDPOINT_PASSWORD_FORMAT = "restow-endpoint-repository-password-v1";
export const ENDPOINT_PASSWORD_FILE = "restow-repository-password.json";
export const FILE_SHARE_PASSWORD_FORMAT = "restow-file-share-repository-password-v1";

export const ENDPOINT_PASSWORD_KIND: RepositoryPasswordKind = {
  format: ENDPOINT_PASSWORD_FORMAT,
  idField: "endpointId",
  aadLabel: "restow.endpoint-repository",
  prefix: endpointPrefix,
};

export const FILE_SHARE_PASSWORD_KIND: RepositoryPasswordKind = {
  format: FILE_SHARE_PASSWORD_FORMAT,
  idField: "fileShareId",
  aadLabel: "restow.file-share-repository",
  prefix: (id) => `file-shares/${id}/`,
};

/** Storage key of a repository's sealed password. */
export function repositoryPasswordKey(kind: RepositoryPasswordKind, id: string): string {
  return `${kind.prefix(id)}${ENDPOINT_PASSWORD_FILE}`;
}

/** The additional data that binds a sealed password to its tenant and repository owner. */
export function repositoryPasswordAad(
  kind: RepositoryPasswordKind,
  tenantId: string,
  id: string,
): Buffer {
  return Buffer.from(`${kind.aadLabel}:${tenantId}:${id}`, "utf8");
}

/** The document that holds the sealed password, as bytes to store. */
export function sealRepositoryPassword(
  kind: RepositoryPasswordKind,
  input: { tenantId: string; id: string; password: string; dek: Dek },
): Buffer {
  const sealed = encryptChunk(
    input.dek,
    Buffer.from(input.password, "utf8"),
    repositoryPasswordAad(kind, input.tenantId, input.id),
  );
  const document = {
    format: kind.format,
    tenantId: input.tenantId,
    [kind.idField]: input.id,
    sealed: sealed.toString("base64"),
  };
  return Buffer.from(`${JSON.stringify(document, null, 2)}\n`, "utf8");
}

export interface RepositoryPasswordDocument {
  readonly tenantId: string;
  readonly id: string;
  readonly sealed: Buffer;
}

const ID = /^[A-Za-z0-9._-]{1,128}$/;

/** Read a document without opening it (the tenant id says which keys open it). */
export function readRepositoryPasswordDocument(
  kind: RepositoryPasswordKind,
  bytes: Buffer,
): RepositoryPasswordDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("the sealed repository password is not a JSON document");
  }
  const document = parsed as Record<string, unknown> | null;
  const id = document?.[kind.idField];
  if (
    !document ||
    document.format !== kind.format ||
    typeof document.tenantId !== "string" ||
    !ID.test(document.tenantId) ||
    typeof id !== "string" ||
    !ID.test(id) ||
    typeof document.sealed !== "string"
  ) {
    throw new Error(`the sealed repository password is not a ${kind.format} document`);
  }
  return { tenantId: document.tenantId, id, sealed: Buffer.from(document.sealed, "base64") };
}

/**
 * Open a sealed password. `decrypt` opens a sealed blob with whatever keys the caller holds; the
 * blob must be bound to the tenant and owner the document names, and to `expectedId` when given.
 */
export function openRepositoryPassword(
  kind: RepositoryPasswordKind,
  bytes: Buffer,
  decrypt: (sealed: Buffer) => Buffer,
  expectedId?: string,
): { tenantId: string; id: string; password: string } {
  const document = readRepositoryPasswordDocument(kind, bytes);
  if (expectedId !== undefined && document.id !== expectedId) {
    const owner = kind.idField === "endpointId" ? "endpoint" : "file share";
    throw new Error(
      `the sealed repository password belongs to ${owner} ${document.id}, not ${expectedId}`,
    );
  }
  const plaintext = decrypt(document.sealed);
  if (
    !sealedAad(document.sealed).equals(repositoryPasswordAad(kind, document.tenantId, document.id))
  ) {
    const owner = kind.idField === "endpointId" ? "endpoint" : "file share";
    throw new Error(`the sealed repository password is bound to another tenant or ${owner}`);
  }
  return { tenantId: document.tenantId, id: document.id, password: plaintext.toString("utf8") };
}

/**
 * Make sure the storage holds the sealed password of a repository: write it when it is missing,
 * damaged, sealed for something else or holds another password. Idempotent; an intact document
 * is left as it is.
 */
export async function ensureRepositoryPasswordFile(
  kind: RepositoryPasswordKind,
  storage: StorageBackend,
  input: {
    tenantId: string;
    id: string;
    password: string;
    keys: { readonly current: Dek; open(sealed: Buffer): Buffer };
  },
): Promise<"written" | "unchanged"> {
  const key = repositoryPasswordKey(kind, input.id);
  if (await storage.head(key)) {
    try {
      const opened = openRepositoryPassword(
        kind,
        await storage.get(key),
        (sealed) => input.keys.open(sealed),
        input.id,
      );
      if (opened.tenantId === input.tenantId && opened.password === input.password) {
        return "unchanged";
      }
    } catch {
      // Damaged or foreign: written anew below.
    }
  }
  await storage.put(
    key,
    sealRepositoryPassword(kind, {
      tenantId: input.tenantId,
      id: input.id,
      password: input.password,
      dek: input.keys.current,
    }),
  );
  return "written";
}

// ---------------------------------------------------------------------------
// Endpoints (the original API, unchanged)
// ---------------------------------------------------------------------------

/** Storage key of an endpoint's sealed repository password. */
export function endpointPasswordKey(endpointId: string): string {
  return repositoryPasswordKey(ENDPOINT_PASSWORD_KIND, endpointId);
}

/** The additional data that binds a sealed password to its tenant and endpoint. */
export function endpointPasswordAad(tenantId: string, endpointId: string): Buffer {
  return repositoryPasswordAad(ENDPOINT_PASSWORD_KIND, tenantId, endpointId);
}

/** The document that holds the sealed password, as bytes to store. */
export function sealEndpointPassword(input: {
  tenantId: string;
  endpointId: string;
  password: string;
  dek: Dek;
}): Buffer {
  return sealRepositoryPassword(ENDPOINT_PASSWORD_KIND, {
    tenantId: input.tenantId,
    id: input.endpointId,
    password: input.password,
    dek: input.dek,
  });
}

export interface EndpointPasswordDocument {
  readonly tenantId: string;
  readonly endpointId: string;
  readonly sealed: Buffer;
}

/** Read the document without opening it (the tenant id says which keys open it). */
export function readEndpointPasswordDocument(bytes: Buffer): EndpointPasswordDocument {
  const document = readRepositoryPasswordDocument(ENDPOINT_PASSWORD_KIND, bytes);
  return { tenantId: document.tenantId, endpointId: document.id, sealed: document.sealed };
}

/**
 * Open a sealed password. `decrypt` opens a sealed blob with whatever keys the
 * caller holds (the worker's keyring, the standalone restore's); the blob must
 * be bound to the tenant and endpoint the document names, and to
 * `expectedEndpointId` when given.
 */
export function openEndpointPassword(
  bytes: Buffer,
  decrypt: (sealed: Buffer) => Buffer,
  expectedEndpointId?: string,
): { tenantId: string; endpointId: string; password: string } {
  const opened = openRepositoryPassword(ENDPOINT_PASSWORD_KIND, bytes, decrypt, expectedEndpointId);
  return { tenantId: opened.tenantId, endpointId: opened.id, password: opened.password };
}

/**
 * Make sure the storage holds the sealed password of an endpoint: write it
 * when it is missing, damaged, sealed for something else or holds another
 * password. Idempotent; an intact document is left as it is.
 */
export function ensureEndpointPasswordFile(
  storage: StorageBackend,
  input: {
    tenantId: string;
    endpointId: string;
    password: string;
    keys: { readonly current: Dek; open(sealed: Buffer): Buffer };
  },
): Promise<"written" | "unchanged"> {
  return ensureRepositoryPasswordFile(ENDPOINT_PASSWORD_KIND, storage, {
    tenantId: input.tenantId,
    id: input.endpointId,
    password: input.password,
    keys: input.keys,
  });
}

/** Open a blob with a single data key (the API holds the tenant's current key only). */
export function singleKeyring(dek: Dek): { readonly current: Dek; open(sealed: Buffer): Buffer } {
  return { current: dek, open: (sealed) => decryptChunk(dek, sealed) };
}
