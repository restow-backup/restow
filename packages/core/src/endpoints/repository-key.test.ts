import { describe, expect, it } from "vitest";
import type { Dek } from "../crypto.js";
import { Keyring } from "../engine/keyring.js";
import { MemoryStorage } from "../verify/testing.js";
import {
  ENDPOINT_PASSWORD_FORMAT,
  FILE_SHARE_PASSWORD_KIND,
  endpointPasswordKey,
  ensureEndpointPasswordFile,
  ensureRepositoryPasswordFile,
  openEndpointPassword,
  openRepositoryPassword,
  readEndpointPasswordDocument,
  repositoryPasswordKey,
  sealEndpointPassword,
  sealRepositoryPassword,
  singleKeyring,
} from "./repository-key.js";

const TENANT = "0f0e0d0c-0b0a-4908-8706-050403020100";
const OTHER_TENANT = "1f0e0d0c-0b0a-4908-8706-050403020100";
const ENDPOINT = "33333333-3333-4333-8333-333333333333";
const OTHER_ENDPOINT = "44444444-4444-4444-8444-444444444444";
const dek = (version: number, fill: number): Dek => ({
  version,
  material: Buffer.alloc(32, fill),
});

describe("the repository password sealed next to the repository", () => {
  it("lies outside restic's folders, at the root of the repository", () => {
    expect(endpointPasswordKey(ENDPOINT)).toBe(
      `endpoints/${ENDPOINT}/restow-repository-password.json`,
    );
  });

  it("is a readable document that opens only with the tenant's key", () => {
    const sealed = sealEndpointPassword({
      tenantId: TENANT,
      endpointId: ENDPOINT,
      password: "correct horse battery staple",
      dek: dek(1, 0x11),
    });
    expect(JSON.parse(sealed.toString("utf8"))).toMatchObject({
      format: ENDPOINT_PASSWORD_FORMAT,
      tenantId: TENANT,
      endpointId: ENDPOINT,
    });
    expect(sealed.toString("utf8")).not.toContain("correct horse");
    const keyring = new Keyring(TENANT, [dek(1, 0x11)]);
    expect(openEndpointPassword(sealed, (blob) => keyring.open(blob), ENDPOINT)).toEqual({
      tenantId: TENANT,
      endpointId: ENDPOINT,
      password: "correct horse battery staple",
    });
    const wrongKey = new Keyring(TENANT, [dek(1, 0x22)]);
    expect(() => openEndpointPassword(sealed, (blob) => wrongKey.open(blob))).toThrow();
  });

  it("does not open for another endpoint or after its names were changed", () => {
    const sealed = sealEndpointPassword({
      tenantId: TENANT,
      endpointId: ENDPOINT,
      password: "pw",
      dek: dek(1, 0x11),
    });
    const keys = singleKeyring(dek(1, 0x11));
    expect(() => openEndpointPassword(sealed, keys.open, OTHER_ENDPOINT)).toThrow(/belongs to/);
    // A document whose names were edited to another endpoint or tenant fails the bound data.
    for (const change of [{ endpointId: OTHER_ENDPOINT }, { tenantId: OTHER_TENANT }]) {
      const moved = Buffer.from(JSON.stringify({ ...JSON.parse(sealed.toString()), ...change }));
      expect(() => openEndpointPassword(moved, keys.open)).toThrow(/bound to another/);
    }
  });

  it("refuses what is not such a document", () => {
    expect(() => readEndpointPasswordDocument(Buffer.from("nope"))).toThrow(/not a JSON/);
    expect(() =>
      readEndpointPasswordDocument(Buffer.from(JSON.stringify({ format: "other" }))),
    ).toThrow(/is not a/);
    expect(() =>
      readEndpointPasswordDocument(
        Buffer.from(
          JSON.stringify({
            format: ENDPOINT_PASSWORD_FORMAT,
            tenantId: "../x",
            endpointId: ENDPOINT,
            sealed: "",
          }),
        ),
      ),
    ).toThrow(/is not a/);
  });

  it("is written once, kept when intact and rewritten when damaged or stale", async () => {
    const storage = new MemoryStorage();
    const keys = new Keyring(TENANT, [dek(1, 0x11), dek(2, 0x22)]);
    const input = { tenantId: TENANT, endpointId: ENDPOINT, password: "pw-1", keys };
    expect(await ensureEndpointPasswordFile(storage, input)).toBe("written");
    const first = await storage.get(endpointPasswordKey(ENDPOINT));
    expect(await ensureEndpointPasswordFile(storage, input)).toBe("unchanged");
    expect((await storage.get(endpointPasswordKey(ENDPOINT))).equals(first)).toBe(true);
    // Sealed with the newest key version.
    expect(openEndpointPassword(first, (blob) => keys.open(blob), ENDPOINT).password).toBe("pw-1");
    expect(readEndpointPasswordDocument(first).sealed.readUInt32BE(5)).toBe(2);

    await storage.put(endpointPasswordKey(ENDPOINT), Buffer.from("garbage"));
    expect(await ensureEndpointPasswordFile(storage, input)).toBe("written");
    expect(await ensureEndpointPasswordFile(storage, { ...input, password: "pw-2" })).toBe(
      "written",
    );
    expect(
      openEndpointPassword(await storage.get(endpointPasswordKey(ENDPOINT)), (blob) =>
        keys.open(blob),
      ).password,
    ).toBe("pw-2");
  });
});

describe("the same document for a file share's repository (docs/FILESHARES.md 5.4)", () => {
  const SHARE = "55555555-5555-4555-8555-555555555555";

  it("has its own format, location and binding", async () => {
    const keys = singleKeyring(dek(1, 7));
    expect(repositoryPasswordKey(FILE_SHARE_PASSWORD_KIND, SHARE)).toBe(
      `file-shares/${SHARE}/restow-repository-password.json`,
    );
    const sealed = sealRepositoryPassword(FILE_SHARE_PASSWORD_KIND, {
      tenantId: TENANT,
      id: SHARE,
      password: "share-pw",
      dek: keys.current,
    });
    const parsed = JSON.parse(sealed.toString("utf8")) as Record<string, unknown>;
    expect(parsed.format).toBe("restow-file-share-repository-password-v1");
    expect(parsed.fileShareId).toBe(SHARE);
    expect(parsed.endpointId).toBeUndefined();
    expect(openRepositoryPassword(FILE_SHARE_PASSWORD_KIND, sealed, keys.open, SHARE)).toEqual({
      tenantId: TENANT,
      id: SHARE,
      password: "share-pw",
    });
    // An endpoint's reader does not take it, and a copy to another share does not open.
    expect(() => readEndpointPasswordDocument(sealed)).toThrow(/is not a/);
    const moved = Buffer.from(sealed.toString("utf8").replace(SHARE, ENDPOINT));
    expect(() => openRepositoryPassword(FILE_SHARE_PASSWORD_KIND, moved, keys.open)).toThrow(
      /bound to another tenant or file share/,
    );

    const storage = new MemoryStorage();
    const input = { tenantId: TENANT, id: SHARE, password: "share-pw", keys };
    expect(await ensureRepositoryPasswordFile(FILE_SHARE_PASSWORD_KIND, storage, input)).toBe(
      "written",
    );
    expect(await ensureRepositoryPasswordFile(FILE_SHARE_PASSWORD_KIND, storage, input)).toBe(
      "unchanged",
    );
  });
});
