import { describe, expect, it } from "vitest";
import { computePasskeyReady } from "./passkeyReady.js";

describe("computePasskeyReady", () => {
  it("is ready for a public HTTPS url with a matching origin", () => {
    const result = computePasskeyReady(
      { operatingMode: "public", publicUrl: "https://restow.example.com" },
      { observedOrigin: "https://restow.example.com" },
    );
    expect(result.ready).toBe(true);
    expect(result.reasons).toEqual([]);
    expect(result.rpId).toBe("restow.example.com");
    expect(result.origin).toBe("https://restow.example.com");
  });

  it("is not ready in local mode over plain HTTP", () => {
    const result = computePasskeyReady({
      operatingMode: "local",
      publicUrl: "http://192.168.0.10",
    });
    expect(result.ready).toBe(false);
    expect(result.reasons).toContain("mode_not_public");
    expect(result.reasons).toContain("not_https");
  });

  it("flags an origin mismatch", () => {
    const result = computePasskeyReady(
      { operatingMode: "public", publicUrl: "https://restow.example.com" },
      { observedOrigin: "https://evil.example.com" },
    );
    expect(result.ready).toBe(false);
    expect(result.reasons).toContain("origin_mismatch");
  });

  it("reports a missing public url", () => {
    const result = computePasskeyReady({ operatingMode: "public", publicUrl: null });
    expect(result.ready).toBe(false);
    expect(result.reasons).toContain("no_public_url");
    expect(result.rpId).toBeNull();
  });

  it("allows localhost only as an explicit development exception", () => {
    const withException = computePasskeyReady(
      { operatingMode: "public", publicUrl: "http://localhost:5173" },
      { allowLocalhost: true, observedOrigin: "http://localhost:5173" },
    );
    expect(withException.ready).toBe(true);

    const withoutException = computePasskeyReady({
      operatingMode: "public",
      publicUrl: "http://localhost:5173",
    });
    expect(withoutException.ready).toBe(false);
    expect(withoutException.reasons).toContain("not_https");
  });
});
