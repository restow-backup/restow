import { describe, expect, it } from "vitest";
import { ProblemError } from "../problem.js";
import {
  arrivalOrigin,
  assertSameOriginRequest,
  declaresBody,
  fetchSiteAllowed,
  isJsonContentType,
  isOctetStreamContentType,
  isSafeMethod,
  originOf,
} from "./browser-request.js";

/** A header reader over a plain object (names in lower case, as Hono reads them). */
function headers(values: Record<string, string>) {
  return (name: string) => values[name.toLowerCase()];
}

describe("isSafeMethod", () => {
  it("treats only reads as safe", () => {
    for (const method of ["GET", "head", "OPTIONS"]) {
      expect(isSafeMethod(method)).toBe(true);
    }
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(isSafeMethod(method)).toBe(false);
    }
  });
});

describe("originOf", () => {
  it("reduces a URL to its origin and rejects opaque or broken values", () => {
    expect(originOf("https://restow.example.com/sources?x=1")).toBe("https://restow.example.com");
    expect(originOf("HTTPS://Restow.Example.com:443")).toBe("https://restow.example.com");
    expect(originOf("null")).toBeNull();
    expect(originOf("not a url")).toBeNull();
    expect(originOf(undefined)).toBeNull();
  });
});

describe("arrivalOrigin", () => {
  it("prefers the host and scheme the edge forwards", () => {
    expect(
      arrivalOrigin(
        headers({ "x-forwarded-proto": "https", "x-forwarded-host": "restow.example.com" }),
        "http://api:3000/api/v1/sources",
      ),
    ).toBe("https://restow.example.com");
  });

  it("takes the first hop of a forwarded list", () => {
    expect(
      arrivalOrigin(
        headers({ "x-forwarded-proto": "https, http", "x-forwarded-host": "a.example, b.example" }),
        "http://api:3000/",
      ),
    ).toBe("https://a.example");
  });

  it("falls back to the request URL", () => {
    expect(arrivalOrigin(headers({}), "http://localhost:3000/api/v1/tenants")).toBe(
      "http://localhost:3000",
    );
  });
});

describe("fetchSiteAllowed", () => {
  it("allows the web app's own requests, user navigations and non-browser clients", () => {
    expect(fetchSiteAllowed("same-origin")).toBe(true);
    expect(fetchSiteAllowed("none")).toBe(true);
    expect(fetchSiteAllowed(undefined)).toBe(true);
  });

  it("refuses requests from other sites and from sibling hosts", () => {
    expect(fetchSiteAllowed("cross-site")).toBe(false);
    expect(fetchSiteAllowed("same-site")).toBe(false);
    expect(fetchSiteAllowed("")).toBe(false);
  });
});

describe("isJsonContentType", () => {
  it("accepts JSON with parameters and +json types", () => {
    expect(isJsonContentType("application/json")).toBe(true);
    expect(isJsonContentType("Application/JSON; charset=utf-8")).toBe(true);
    expect(isJsonContentType("application/merge-patch+json")).toBe(true);
  });

  it("refuses what a form or a simple request can send", () => {
    expect(isJsonContentType("text/plain;charset=UTF-8")).toBe(false);
    expect(isJsonContentType("application/x-www-form-urlencoded")).toBe(false);
    expect(isJsonContentType("multipart/form-data; boundary=x")).toBe(false);
    expect(isJsonContentType("text/json")).toBe(false);
    expect(isJsonContentType(undefined)).toBe(false);
  });
});

describe("declaresBody", () => {
  it("reads the length headers first", () => {
    expect(declaresBody(headers({ "content-length": "12" }))).toBe(true);
    expect(declaresBody(headers({ "content-length": "0", "content-type": "text/plain" }))).toBe(
      false,
    );
    expect(declaresBody(headers({ "transfer-encoding": "chunked" }))).toBe(true);
  });

  it("counts a declared content type without a length as a body", () => {
    expect(declaresBody(headers({ "content-type": "text/plain" }))).toBe(true);
    expect(declaresBody(headers({}))).toBe(false);
  });
});

describe("assertSameOriginRequest", () => {
  const request = (
    method: string,
    values: Record<string, string>,
    publicOrigins: readonly string[] = [],
  ) => ({
    method,
    header: headers(values),
    url: "http://api:3000/api/v1/tenants",
    publicOrigins: async () => publicOrigins,
  });

  async function statusOf(input: ReturnType<typeof request>): Promise<number | null> {
    try {
      await assertSameOriginRequest(input);
      return null;
    } catch (error) {
      return error instanceof ProblemError ? error.status : -1;
    }
  }

  it("checks the site before the body", async () => {
    expect(
      await statusOf(
        request("POST", { "sec-fetch-site": "cross-site", "content-type": "text/plain" }),
      ),
    ).toBe(403);
  });

  it("does not consult the configured origins when the origin is the arrival origin", async () => {
    let consulted = false;
    await assertSameOriginRequest({
      ...request("PATCH", { origin: "http://api:3000", "content-type": "application/json" }),
      publicOrigins: async () => {
        consulted = true;
        return [];
      },
    });
    expect(consulted).toBe(false);
  });

  it("lets Sec-Fetch-Site decide when the browser sends it", async () => {
    let consulted = false;
    await assertSameOriginRequest({
      ...request("POST", {
        "sec-fetch-site": "same-origin",
        origin: "http://localhost:5173",
        "content-type": "application/json",
      }),
      publicOrigins: async () => {
        consulted = true;
        return [];
      },
    });
    expect(consulted).toBe(false);
  });

  it("falls back to Origin for browsers without Sec-Fetch-Site", async () => {
    expect(await statusOf(request("POST", { origin: "https://attacker.example" }))).toBe(403);
    expect(await statusOf(request("DELETE", { origin: "null" }))).toBe(403);
  });

  it("accepts a configured public origin", async () => {
    const input = request("POST", { origin: "https://restow.example.com" }, [
      "https://restow.example.com",
    ]);
    expect(await statusOf(input)).toBeNull();
  });

  it("never judges a read", async () => {
    expect(
      await statusOf(
        request("GET", { "sec-fetch-site": "cross-site", "content-type": "text/plain" }),
      ),
    ).toBeNull();
  });
});

describe("isOctetStreamContentType", () => {
  it("matches raw bytes only, whatever the parameters or case", () => {
    expect(isOctetStreamContentType("application/octet-stream")).toBe(true);
    expect(isOctetStreamContentType("Application/Octet-Stream; charset=binary")).toBe(true);
    expect(isOctetStreamContentType("application/json")).toBe(false);
    expect(isOctetStreamContentType("text/plain")).toBe(false);
    expect(isOctetStreamContentType("multipart/form-data; boundary=x")).toBe(false);
    expect(isOctetStreamContentType(undefined)).toBe(false);
  });
});

describe("assertSameOriginRequest with raw bodies allowed (file chunks)", () => {
  const raw = (values: Record<string, string>) => ({
    method: "PUT",
    header: headers({ "content-length": "5", ...values }),
    url: "http://api:3000/api/v1/imports/uploads/x/segments/0",
    publicOrigins: async () => [],
  });

  async function statusOf(
    values: Record<string, string>,
    policy: { allowOctetStream?: boolean },
  ): Promise<number | null> {
    try {
      await assertSameOriginRequest(raw(values), policy);
      return null;
    } catch (error) {
      return error instanceof ProblemError ? error.status : -1;
    }
  }

  it("refuses raw bytes by default and accepts them when the route allows it", async () => {
    const values = { "sec-fetch-site": "same-origin", "content-type": "application/octet-stream" };
    expect(await statusOf(values, {})).toBe(415);
    expect(await statusOf(values, { allowOctetStream: true })).toBeNull();
  });

  it("still refuses the content types a cross-site form can send", async () => {
    for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data"]) {
      expect(
        await statusOf(
          { "sec-fetch-site": "same-origin", "content-type": type },
          { allowOctetStream: true },
        ),
      ).toBe(415);
    }
  });

  it("still refuses a request from another site", async () => {
    expect(
      await statusOf(
        { "sec-fetch-site": "cross-site", "content-type": "application/octet-stream" },
        { allowOctetStream: true },
      ),
    ).toBe(403);
  });
});
