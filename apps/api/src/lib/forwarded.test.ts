import { describe, expect, it } from "vitest";
import {
  DEFAULT_TRUSTED_PROXIES,
  PRIVATE_RANGES,
  clientFromForwardedFor,
  createProxyMatcher,
  hopAddress,
  trustedProxyEntries,
} from "./forwarded.js";

describe("trustedProxyEntries", () => {
  it("is Caddy's default (loopback only) when unset or empty", () => {
    expect(trustedProxyEntries(undefined)).toEqual(DEFAULT_TRUSTED_PROXIES);
    expect(trustedProxyEntries("   ")).toEqual(DEFAULT_TRUSTED_PROXIES);
  });

  it("splits on spaces and commas and expands private_ranges like Caddy", () => {
    expect(trustedProxyEntries("203.0.113.0/24, 2001:db8::/32 private_ranges")).toEqual([
      "203.0.113.0/24",
      "2001:db8::/32",
      ...PRIVATE_RANGES,
    ]);
  });

  it("replaces the default instead of adding to it, as the edge does", () => {
    expect(trustedProxyEntries("198.51.100.7")).toEqual(["198.51.100.7"]);
  });
});

describe("createProxyMatcher", () => {
  const matcher = createProxyMatcher(trustedProxyEntries("private_ranges 198.51.100.7"));

  it("matches addresses inside the ranges, IPv4-mapped IPv6 included", () => {
    expect(matcher.matches("10.1.2.3")).toBe(true);
    expect(matcher.matches("::ffff:10.1.2.3")).toBe(true);
    expect(matcher.matches("172.20.0.5")).toBe(true);
    expect(matcher.matches("fd12:3456::1")).toBe(true);
    expect(matcher.matches("::1")).toBe(true);
    expect(matcher.matches("198.51.100.7")).toBe(true);
  });

  it("does not match public addresses or anything that is not an address", () => {
    expect(matcher.matches("198.51.100.8")).toBe(false);
    expect(matcher.matches("203.0.113.5")).toBe(false);
    expect(matcher.matches("2001:db8::1")).toBe(false);
    expect(matcher.matches("unknown")).toBe(false);
  });

  it("reports entries that do not parse and lets them trust nothing", () => {
    const broken = createProxyMatcher(["10.0.0.0/33", "example.com", "10.0.0.0/8/1", "::1/x"]);
    expect(broken.invalid).toEqual(["10.0.0.0/33", "example.com", "10.0.0.0/8/1", "::1/x"]);
    expect(broken.matches("10.0.0.1")).toBe(false);
  });
});

describe("hopAddress", () => {
  it("accepts bare addresses and strips ports", () => {
    expect(hopAddress(" 203.0.113.5 ")).toBe("203.0.113.5");
    expect(hopAddress("203.0.113.5:4711")).toBe("203.0.113.5");
    expect(hopAddress("[2001:db8::1]:443")).toBe("2001:db8::1");
    expect(hopAddress("2001:db8::1")).toBe("2001:db8::1");
    expect(hopAddress("::ffff:192.0.2.1")).toBe("::ffff:192.0.2.1");
  });

  it("refuses everything else", () => {
    expect(hopAddress("unknown")).toBeNull();
    expect(hopAddress("[2001:db8::1")).toBeNull();
    expect(hopAddress("_hidden")).toBeNull();
  });
});

describe("clientFromForwardedFor", () => {
  const trusted = createProxyMatcher(["10.0.0.0/8"]).matches;

  it("takes the right-most hop that is not a trusted proxy", () => {
    // A client behind a trusted front proxy that forged a hop of its own.
    expect(clientFromForwardedFor("1.2.3.4, 203.0.113.5, 10.0.0.2", trusted)).toBe("203.0.113.5");
    expect(clientFromForwardedFor("203.0.113.5, 10.0.0.2, 10.0.0.3", trusted)).toBe("203.0.113.5");
  });

  it("never believes the left-most hop when the peer itself is not trusted", () => {
    // The edge appends its untrusted peer: that peer is the client.
    expect(clientFromForwardedFor("1.2.3.4, 198.51.100.9", trusted)).toBe("198.51.100.9");
    expect(clientFromForwardedFor("198.51.100.9", trusted)).toBe("198.51.100.9");
  });

  it("takes the left-most hop when every hop is trusted", () => {
    expect(clientFromForwardedFor("10.0.0.9, 10.0.0.2", trusted)).toBe("10.0.0.9");
  });

  it("is null when a hop on the way is not an address, or nothing is there", () => {
    expect(clientFromForwardedFor("203.0.113.5, unknown, 10.0.0.2", trusted)).toBeNull();
    expect(clientFromForwardedFor(" , ", trusted)).toBeNull();
  });

  it("does not look past an untrusted hop, whatever stands to its left", () => {
    expect(clientFromForwardedFor("unknown, 203.0.113.5, 10.0.0.2", trusted)).toBe("203.0.113.5");
  });
});
