import { describe, expect, it } from "vitest";

import { isLocalhostOrigin, previewPasskeyReady } from "./passkey-ready";

describe("previewPasskeyReady", () => {
  it("is ready for public mode over https with a matching origin", () => {
    const result = previewPasskeyReady({
      operatingMode: "public",
      publicUrl: "https://restow.example.com/",
      observedOrigin: "https://restow.example.com",
    });
    expect(result).toEqual({
      ready: true,
      reasons: [],
      rpId: "restow.example.com",
      origin: "https://restow.example.com",
    });
  });

  it("names every reason instead of just saying no", () => {
    const result = previewPasskeyReady({
      operatingMode: "local",
      publicUrl: "http://10.0.0.5:8080",
      observedOrigin: "http://localhost:5173",
    });
    expect(result.ready).toBe(false);
    expect(result.reasons).toEqual(["mode_not_public", "not_https", "origin_mismatch"]);
  });

  it("treats an empty or malformed URL as missing", () => {
    expect(
      previewPasskeyReady({ operatingMode: "public", publicUrl: "", observedOrigin: null }).reasons,
    ).toEqual(["no_public_url"]);
    expect(
      previewPasskeyReady({ operatingMode: "public", publicUrl: "restow", observedOrigin: null })
        .reasons,
    ).toEqual(["no_public_url"]);
  });

  it("allows localhost over http only when asked", () => {
    const input = {
      operatingMode: "public" as const,
      publicUrl: "http://localhost:5173",
      observedOrigin: "http://localhost:5173",
    };
    expect(previewPasskeyReady(input).reasons).toEqual(["not_https"]);
    expect(previewPasskeyReady({ ...input, allowLocalhost: true }).ready).toBe(true);
  });
});

describe("isLocalhostOrigin", () => {
  it("recognises the development hosts only", () => {
    expect(isLocalhostOrigin("http://localhost:5173")).toBe(true);
    expect(isLocalhostOrigin("http://127.0.0.1")).toBe(true);
    expect(isLocalhostOrigin("https://restow.example.com")).toBe(false);
    expect(isLocalhostOrigin("garbage")).toBe(false);
    expect(isLocalhostOrigin(null)).toBe(false);
  });
});
