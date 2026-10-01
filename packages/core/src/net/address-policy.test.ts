import { describe, expect, it } from "vitest";
import {
  BLOCKED_ADDRESS_CODE,
  BlockedAddressError,
  assessHost,
  classifyAddress,
  guardedLookup,
  isAddressAllowed,
  isBlockedAddressError,
  isLocalHostname,
  refuseHostBeforeConnect,
} from "./address-policy.js";

describe("classifyAddress", () => {
  it.each([
    ["93.184.216.34", "public"],
    ["8.8.8.8", "public"],
    ["10.1.2.3", "private"],
    ["172.16.0.1", "private"],
    ["172.31.255.255", "private"],
    ["172.32.0.1", "public"],
    ["192.168.1.10", "private"],
    ["100.64.0.1", "private"],
    ["127.0.0.1", "loopback"],
    ["169.254.169.254", "link_local"],
    ["0.0.0.0", "unspecified"],
    ["224.0.0.1", "multicast"],
    ["255.255.255.255", "reserved"],
    ["198.18.0.1", "reserved"],
    ["2606:4700:4700::1111", "public"],
    ["::1", "loopback"],
    ["::", "unspecified"],
    ["fe80::1%eth0", "link_local"],
    ["fd12:3456::1", "private"],
    ["ff02::1", "multicast"],
    ["2001:db8::1", "reserved"],
    ["2001:0:4136:e378::1", "reserved"],
    ["[::1]", "loopback"],
  ])("classifies %s as %s", (address, kind) => {
    expect(classifyAddress(address)).toBe(kind);
  });

  it("judges IPv4 addresses embedded in IPv6 by the IPv4 host they reach", () => {
    expect(classifyAddress("::ffff:127.0.0.1")).toBe("loopback");
    expect(classifyAddress("::ffff:a9fe:a9fe")).toBe("link_local");
    expect(classifyAddress("64:ff9b::10.0.0.1")).toBe("private");
    expect(classifyAddress("2002:c0a8:0101::1")).toBe("private");
    expect(classifyAddress("::ffff:93.184.216.34")).toBe("public");
  });

  it("treats anything unparseable as reserved", () => {
    expect(classifyAddress("not-an-address")).toBe("reserved");
    expect(classifyAddress("300.1.1.1")).toBe("reserved");
    expect(classifyAddress("1:2:3:4:5:6:7:8:9")).toBe("reserved");
  });
});

describe("isAddressAllowed", () => {
  it("always allows public addresses", () => {
    expect(isAddressAllowed("93.184.216.34", false)).toBe(true);
  });

  it("allows loopback and private networks only with the operator's consent", () => {
    expect(isAddressAllowed("10.0.0.5", false)).toBe(false);
    expect(isAddressAllowed("10.0.0.5", true)).toBe(true);
    expect(isAddressAllowed("127.0.0.1", true)).toBe(true);
  });

  it("never allows link-local, multicast or reserved addresses", () => {
    expect(isAddressAllowed("169.254.169.254", true)).toBe(false);
    expect(isAddressAllowed("224.0.0.1", true)).toBe(false);
    expect(isAddressAllowed("0.0.0.0", true)).toBe(false);
  });
});

describe("isLocalHostname", () => {
  it.each([
    "localhost",
    "postgres",
    "api",
    "nas.local",
    "mail.internal",
    "Router.LAN.",
    "x.home.arpa",
  ])("%s only exists on a local network", (host) => {
    expect(isLocalHostname(host)).toBe(true);
  });

  it.each(["imap.example.com", "outlook.office365.com"])("%s is a public name", (host) => {
    expect(isLocalHostname(host)).toBe(false);
  });
});

describe("assessHost", () => {
  const resolverFor =
    (answers: Record<string, readonly string[]>) =>
    async (host: string): Promise<readonly string[]> => {
      const found = answers[host];
      if (!found) {
        throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
      }
      return found;
    };

  it("judges literal addresses without the resolver", async () => {
    const resolve = async (): Promise<readonly string[]> => {
      throw new Error("must not resolve");
    };
    expect(await assessHost("93.184.216.34", resolve)).toBe("public");
    expect(await assessHost("10.0.0.1", resolve)).toBe("private");
    expect(await assessHost("169.254.169.254", resolve)).toBe("forbidden");
    expect(await assessHost("[::1]", resolve)).toBe("private");
  });

  it("treats local-only names as private without asking the resolver", async () => {
    const resolve = async (): Promise<readonly string[]> => {
      throw new Error("must not resolve");
    };
    expect(await assessHost("postgres", resolve)).toBe("private");
    expect(await assessHost("dovecot.internal", resolve)).toBe("private");
  });

  it("judges a name by every address it resolves to", async () => {
    const resolve = resolverFor({
      "imap.example.com": ["93.184.216.34", "2606:4700::1"],
      "mixed.example.com": ["93.184.216.34", "10.0.0.7"],
      "metadata.example.com": ["169.254.169.254"],
    });
    expect(await assessHost("imap.example.com", resolve)).toBe("public");
    expect(await assessHost("mixed.example.com", resolve)).toBe("private");
    expect(await assessHost("metadata.example.com", resolve)).toBe("forbidden");
    expect(await assessHost("gone.example.com", resolve)).toBe("unresolvable");
  });
});

describe("refuseHostBeforeConnect", () => {
  it("refuses private literals and local names unless private networks are allowed", () => {
    expect(refuseHostBeforeConnect("10.0.0.1", false)).toBeInstanceOf(BlockedAddressError);
    expect(refuseHostBeforeConnect("postgres", false)).toBeInstanceOf(BlockedAddressError);
    expect(refuseHostBeforeConnect("10.0.0.1", true)).toBeNull();
    expect(refuseHostBeforeConnect("postgres", true)).toBeNull();
  });

  it("refuses link-local literals even when private networks are allowed", () => {
    expect(refuseHostBeforeConnect("169.254.169.254", true)).toBeInstanceOf(BlockedAddressError);
  });

  it("leaves public names to the guarded lookup", () => {
    expect(refuseHostBeforeConnect("imap.example.com", false)).toBeNull();
    expect(refuseHostBeforeConnect("93.184.216.34", false)).toBeNull();
  });
});

describe("guardedLookup", () => {
  function lookupOnce(
    allow: boolean,
    host: string,
    all = false,
  ): Promise<{ error: NodeJS.ErrnoException | null; address: unknown }> {
    return new Promise((resolve) => {
      guardedLookup(allow)(host, { all } as never, (error, address) => {
        resolve({ error, address });
      });
    });
  }

  it("refuses loopback names unless private networks are allowed", async () => {
    const refused = await lookupOnce(false, "localhost");
    expect(refused.error?.code).toBe(BLOCKED_ADDRESS_CODE);
    expect(isBlockedAddressError(refused.error)).toBe(true);

    const allowed = await lookupOnce(true, "localhost");
    expect(allowed.error).toBeNull();
    expect(typeof allowed.address).toBe("string");
  });

  it("hands out every address when the caller asks for all of them", async () => {
    const allowed = await lookupOnce(true, "localhost", true);
    expect(allowed.error).toBeNull();
    expect(Array.isArray(allowed.address)).toBe(true);
  });
});

describe("isBlockedAddressError", () => {
  it("finds the refusal inside wrapped errors", () => {
    const wrapped = Object.assign(new Error("Failed to connect"), {
      _err: new BlockedAddressError("10.0.0.1"),
    });
    expect(isBlockedAddressError(wrapped)).toBe(true);
    expect(isBlockedAddressError(new Error("ECONNREFUSED"))).toBe(false);
    expect(isBlockedAddressError(null)).toBe(false);
  });
});
