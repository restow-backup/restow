import { describe, expect, it } from "vitest";
import { browserOrigin } from "./origin.js";

function headers(values: Record<string, string>) {
  return (name: string) => values[name];
}

const internalUrl = "http://api:3000/api/v1/settings";

describe("browserOrigin", () => {
  it("prefers the Origin header", () => {
    expect(
      browserOrigin(
        headers({ origin: "https://restow.example.com", referer: "https://other.example.com/" }),
        internalUrl,
      ),
    ).toBe("https://restow.example.com");
  });

  it("uses the Referer on same-origin GET requests without Origin", () => {
    expect(
      browserOrigin(
        headers({ referer: "https://restow.example.com/settings?section=mail" }),
        internalUrl,
      ),
    ).toBe("https://restow.example.com");
  });

  it("ignores an opaque `null` origin", () => {
    expect(
      browserOrigin(
        headers({ origin: "null", referer: "https://restow.example.com/" }),
        internalUrl,
      ),
    ).toBe("https://restow.example.com");
  });

  it("falls back to the proxy's forwarded headers, then the request URL", () => {
    expect(
      browserOrigin(
        headers({ "x-forwarded-proto": "https", "x-forwarded-host": "restow.example.com, api" }),
        internalUrl,
      ),
    ).toBe("https://restow.example.com");
    expect(browserOrigin(headers({}), internalUrl)).toBe("http://api:3000");
  });

  it("returns null when nothing is usable", () => {
    expect(browserOrigin(headers({ origin: "garbage" }), "not a url")).toBeNull();
  });
});
