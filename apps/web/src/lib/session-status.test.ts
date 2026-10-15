import { describe, expect, it } from "vitest";

import { ApiError, errorMessageKey, type Me } from "@/lib/api";

import { deriveStatus } from "./session";

const me = { id: "u-1" } as unknown as Me;
const signedIn = { data: { user: { id: "u-1" } }, isPending: false, error: null };
const profile = { data: me, isPending: false, error: null };
const serverError = { status: 500, statusText: "Internal Server Error", message: "boom" };

describe("deriveStatus", () => {
  it("keeps the shell up when a background refetch of the session fails but the session is known", () => {
    expect(deriveStatus({ ...signedIn, error: serverError }, profile)).toBe("authenticated");
    expect(deriveStatus({ ...signedIn, error: { status: 503 } }, profile)).toBe("authenticated");
    expect(deriveStatus({ ...signedIn, isPending: true }, profile)).toBe("authenticated");
  });

  it("keeps the shell up when a refetch of the profile fails but the profile is known", () => {
    expect(deriveStatus(signedIn, { ...profile, error: new ApiError(500, null, "Server") })).toBe(
      "authenticated",
    );
  });

  it("shows the error page only when the first load fails", () => {
    expect(deriveStatus({ data: null, isPending: false, error: serverError }, profile)).toBe(
      "error",
    );
    expect(
      deriveStatus(signedIn, {
        data: undefined,
        isPending: false,
        error: new ApiError(500, null, "x"),
      }),
    ).toBe("error");
  });

  it("signs out on a 401, from the session or from the profile, data or not", () => {
    expect(deriveStatus({ ...signedIn, error: { status: 401 } }, profile)).toBe("unauthenticated");
    expect(
      deriveStatus(signedIn, { ...profile, error: new ApiError(401, null, "Unauthorized") }),
    ).toBe("unauthenticated");
    expect(deriveStatus({ data: null, isPending: false, error: null }, profile)).toBe(
      "unauthenticated",
    );
  });

  it("loads while nothing is known yet", () => {
    expect(deriveStatus({ data: null, isPending: true, error: null }, profile)).toBe("loading");
    expect(deriveStatus(signedIn, { data: undefined, isPending: true, error: null })).toBe(
      "loading",
    );
  });
});

describe("errorMessageKey for the auth client's errors", () => {
  it("names a server error and an unreachable server instead of the generic text", () => {
    expect(errorMessageKey(serverError)).toBe("errors.server");
    expect(errorMessageKey({ status: 503 })).toBe("errors.network");
    expect(errorMessageKey({ status: 502, message: "Bad Gateway" })).toBe("errors.network");
    expect(errorMessageKey(new Error("something else"))).toBe("errors.generic");
  });
});
