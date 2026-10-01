import { describe, expect, it } from "vitest";
import { checkEndpointShape, checkTenantEndpoint, isBlockedAddress } from "./endpoint-policy.js";

describe("isBlockedAddress", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.20.0.5",
    "192.168.178.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "::1",
    "::",
    "fd00::1",
    "fe80::1",
    "::ffff:10.0.0.1",
    "not-an-ip",
  ])("blocks %s", (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each(["88.198.1.1", "2a01:4f8::1", "52.219.170.1"])("allows %s", (address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });
});

describe("checkEndpointShape", () => {
  it.each([
    ["http://s3.example.com", "https_required"],
    ["https://127.0.0.1:9000", "private_address"],
    ["https://[::1]:9000", "private_address"],
    ["https://localhost:3900", "local_hostname"],
    ["https://garage:3900", "local_hostname"],
    ["https://nas.local", "local_hostname"],
    ["https://minio.internal", "local_hostname"],
    ["https://storage.home.arpa", "local_hostname"],
  ])("%s -> %s", (endpoint, violation) => {
    expect(checkEndpointShape(endpoint)).toBe(violation);
  });

  it("accepts public HTTPS services", () => {
    expect(checkEndpointShape("https://fsn1.your-objectstorage.com")).toBeNull();
    expect(checkEndpointShape("https://88.198.1.1")).toBeNull();
  });
});

describe("checkTenantEndpoint", () => {
  const resolvesTo =
    (...addresses: string[]) =>
    async () =>
      addresses;

  it("allows a name that resolves to public addresses only", async () => {
    expect(
      await checkTenantEndpoint("https://s3.example.com", resolvesTo("88.198.1.1", "2a01:4f8::1")),
    ).toBeNull();
  });

  it("refuses a public name pointing into a private network", async () => {
    expect(
      await checkTenantEndpoint("https://s3.example.com", resolvesTo("88.198.1.1", "10.0.0.7")),
    ).toBe("private_address");
  });

  it("refuses names that do not resolve", async () => {
    expect(
      await checkTenantEndpoint("https://s3.example.com", async () => {
        throw new Error("ENOTFOUND");
      }),
    ).toBe("unresolvable");
    expect(await checkTenantEndpoint("https://s3.example.com", resolvesTo())).toBe("unresolvable");
  });

  it("does not resolve when the shape already fails", async () => {
    let called = false;
    const result = await checkTenantEndpoint("http://s3.example.com", async () => {
      called = true;
      return [];
    });
    expect(result).toBe("https_required");
    expect(called).toBe(false);
  });
});
