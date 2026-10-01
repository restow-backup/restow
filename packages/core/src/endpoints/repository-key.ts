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
 */
import { type Dek, decryptChunk, encryptChunk } from "../crypto.js";
import { sealedAad } from "../engine/keyring.js";
import type { StorageBackend } from "../storage/backend.js";
import { endpointPrefix } from "./restic-cli.js";

export const ENDPOINT_PASSWORD_FORMAT = "restow-endpoint-repository-password-v1";
export const ENDPOINT_PASSWORD_FILE = "restow-repository-password.json";

/** Storage key of an endpoint's sealed repository password. */
export function endpointPasswordKey(endpointId: string): string {
  return `${endpointPrefix(endpointId)}${ENDPOINT_PASSWORD_FILE}`;
}

/** The additional data that binds a sealed password to its tenant and endpoint. */
export function endpointPasswordAad(tenantId: string, endpointId: string): Buffer {
  return Buffer.from(`restow.endpoint-repository:${tenantId}:${endpointId}`, "utf8");
}

/** The document that holds the sealed password, as bytes to store. */
export function sealEndpointPassword(input: {
  tenantId: string;
  endpointId: string;
  password: string;
  dek: Dek;
}): Buffer {
  const sealed = encryptChunk(
    input.dek,
    Buffer.from(input.password, "utf8"),
    endpointPasswordAad(input.tenantId, input.endpointId),
  );
  const document = {
    format: ENDPOINT_PASSWORD_FORMAT,
    tenantId: input.tenantId,
    endpointId: input.endpointId,
    sealed: sealed.toString("base64"),
  };
  return Buffer.from(`${JSON.stringify(document, null, 2)}\n`, "utf8");
}

export interface EndpointPasswordDocument {
  readonly tenantId: string;
  readonly endpointId: string;
  readonly sealed: Buffer;
}

const ID = /^[A-Za-z0-9._-]{1,128}$/;

/** Read the document without opening it (the tenant id says which keys open it). */
export function readEndpointPasswordDocument(bytes: Buffer): EndpointPasswordDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("the sealed repository password is not a JSON document");
  }
  const document = parsed as Record<string, unknown> | null;
  if (
    !document ||
    document.format !== ENDPOINT_PASSWORD_FORMAT ||
    typeof document.tenantId !== "string" ||
    !ID.test(document.tenantId) ||
    typeof document.endpointId !== "string" ||
    !ID.test(document.endpointId) ||
    typeof document.sealed !== "string"
  ) {
    throw new Error(`the sealed repository password is not a ${ENDPOINT_PASSWORD_FORMAT} document`);
  }
  return {
    tenantId: document.tenantId,
    endpointId: document.endpointId,
    sealed: Buffer.from(document.sealed, "base64"),
  };
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
  const document = readEndpointPasswordDocument(bytes);
  if (expectedEndpointId !== undefined && document.endpointId !== expectedEndpointId) {
    throw new Error(
      `the sealed repository password belongs to endpoint ${document.endpointId}, not ${expectedEndpointId}`,
    );
  }
  const plaintext = decrypt(document.sealed);
  if (
    !sealedAad(document.sealed).equals(endpointPasswordAad(document.tenantId, document.endpointId))
  ) {
    throw new Error("the sealed repository password is bound to another tenant or endpoint");
  }
  return {
    tenantId: document.tenantId,
    endpointId: document.endpointId,
    password: plaintext.toString("utf8"),
  };
}

/**
 * Make sure the storage holds the sealed password of an endpoint: write it
 * when it is missing, damaged, sealed for something else or holds another
 * password. Idempotent; an intact document is left as it is.
 */
export async function ensureEndpointPasswordFile(
  storage: StorageBackend,
  input: {
    tenantId: string;
    endpointId: string;
    password: string;
    keys: { readonly current: Dek; open(sealed: Buffer): Buffer };
  },
): Promise<"written" | "unchanged"> {
  const key = endpointPasswordKey(input.endpointId);
  if (await storage.head(key)) {
    try {
      const opened = openEndpointPassword(
        await storage.get(key),
        (sealed) => input.keys.open(sealed),
        input.endpointId,
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
    sealEndpointPassword({
      tenantId: input.tenantId,
      endpointId: input.endpointId,
      password: input.password,
      dek: input.keys.current,
    }),
  );
  return "written";
}

/** Open a blob with a single data key (the API holds the tenant's current key only). */
export function singleKeyring(dek: Dek): { readonly current: Dek; open(sealed: Buffer): Buffer } {
  return { current: dek, open: (sealed) => decryptChunk(dek, sealed) };
}
