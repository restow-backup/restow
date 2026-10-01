import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { UPDATER_AUTH_SCHEME, UPDATER_SECRET_FILE } from "./protocol.js";

/**
 * The shared secret between the api and the updater. The updater generates it on
 * its first start into the shared volume (`<shared>/secret`, mode 0600); the api
 * mounts that volume read-only and sends it as a bearer token. It is never
 * logged, never returned by any endpoint and never stored anywhere else.
 */

const SECRET_PATTERN = /^[0-9a-f]{64}$/;

/** Load the secret, creating it when missing or unusable. */
export async function loadOrCreateSecret(sharedDir: string): Promise<string> {
  await fs.mkdir(sharedDir, { recursive: true });
  const file = path.join(sharedDir, UPDATER_SECRET_FILE);
  try {
    const existing = (await fs.readFile(file, "utf8")).trim();
    if (SECRET_PATTERN.test(existing)) {
      // Repair the mode if somebody loosened it; the secret itself stays.
      await fs.chmod(file, 0o600).catch(() => undefined);
      return existing;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  const secret = randomBytes(32).toString("hex");
  const temporary = `${file}.${process.pid}.tmp`;
  const handle = await fs.open(temporary, "w", 0o600);
  try {
    await handle.writeFile(`${secret}\n`, "utf8");
    await handle.chmod(0o600);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporary, file);
  return secret;
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/** Constant-time comparison (both sides hashed first, so the length does not leak either). */
export function secretsEqual(expected: string, provided: string): boolean {
  return timingSafeEqual(digest(expected), digest(provided));
}

/** Whether an `Authorization` header carries the secret as `Bearer <secret>`. */
export function isAuthorized(header: string | null | undefined, secret: string): boolean {
  if (!header) {
    return false;
  }
  const prefix = `${UPDATER_AUTH_SCHEME} `;
  if (
    header.length <= prefix.length ||
    header.slice(0, prefix.length).toLowerCase() !== prefix.toLowerCase()
  ) {
    // Still compare something, so the time does not depend on the scheme being right.
    secretsEqual(secret, header);
    return false;
  }
  return secretsEqual(secret, header.slice(prefix.length).trim());
}
