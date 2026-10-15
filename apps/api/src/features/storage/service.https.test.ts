import type { Database } from "@restow/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTarget, probeSettings } from "./service.js";

/**
 * Plain HTTP to an S3 endpoint (docs/STORAGE.md, "Encrypted transport"): a new
 * location is refused before anything touches the database or the network, even
 * for a provider admin; the S3_ALLOW_INSECURE opt-in of test setups lifts it.
 */

const TENANT = "1f2e3d4c-5b6a-4978-8695-a4b3c2d1e0f9";
const PROVIDER_ADMIN = { id: "u1", email: "admin@example.test", ip: null, isProviderAdmin: true };
// Never reached: validation refuses first.
const db = {} as Database;

const config = (endpoint: string) => ({
  bucket: "acme-restow",
  endpoint,
  region: "garage",
  forcePathStyle: true,
});

let previous: string | undefined;
beforeEach(() => {
  previous = process.env.S3_ALLOW_INSECURE;
  delete process.env.S3_ALLOW_INSECURE;
});
afterEach(() => {
  if (previous === undefined) {
    delete process.env.S3_ALLOW_INSECURE;
  } else {
    process.env.S3_ALLOW_INSECURE = previous;
  }
});

describe("S3 endpoints over plain HTTP", () => {
  it("refuses a new target on http:// to another host, naming the field", async () => {
    await expect(
      createTarget(
        db,
        TENANT,
        {
          kind: "s3",
          role: "copy",
          name: "Garage",
          config: config("http://garage:3900"),
          credentials: { accessKeyId: "id", secretAccessKey: "secret" },
        } as Parameters<typeof createTarget>[2],
        PROVIDER_ADMIN,
      ),
    ).rejects.toMatchObject({
      status: 422,
      extensions: { field: "endpoint", reason: "endpoint_insecure" },
    });
  });

  it("refuses to test such settings from the form", async () => {
    await expect(
      probeSettings(
        db,
        TENANT,
        {
          kind: "s3",
          config: config("http://192.168.1.10:9000"),
          credentials: { accessKeyId: "id", secretAccessKey: "secret" },
        } as Parameters<typeof probeSettings>[2],
        PROVIDER_ADMIN,
      ),
    ).rejects.toMatchObject({ extensions: { reason: "endpoint_insecure" } });
  });

  it("gets past validation with S3_ALLOW_INSECURE, as the smoke stack sets it", async () => {
    process.env.S3_ALLOW_INSECURE = "true";
    const attempt = probeSettings(
      db,
      TENANT,
      {
        kind: "s3",
        config: config("http://garage:3900"),
        targetId: "8a7b6c5d-4e3f-4a1b-9c8d-7e6f5a4b3c2d",
      } as Parameters<typeof probeSettings>[2],
      PROVIDER_ADMIN,
    );
    // It goes on to read the stored key pair, which this stand-in database cannot do.
    await expect(attempt).rejects.not.toMatchObject({
      extensions: { reason: "endpoint_insecure" },
    });
  });
});
