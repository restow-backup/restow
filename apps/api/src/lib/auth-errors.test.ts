import { APIError } from "better-auth/api";
import { describe, expect, it } from "vitest";
import { ProblemError } from "../problem.js";
import { authCall, toProblem } from "./auth-errors.js";

describe("toProblem", () => {
  it("maps a better-auth duplicate error onto a 409 problem with its code", () => {
    const error = new APIError("BAD_REQUEST", {
      message: "Organization already exists",
      code: "ORGANIZATION_ALREADY_EXISTS",
    });
    const problem = toProblem(error) as ProblemError;
    expect(problem).toBeInstanceOf(ProblemError);
    expect(problem.status).toBe(409);
    expect(problem.detail).toBe("Organization already exists");
    expect(problem.extensions).toEqual({ code: "ORGANIZATION_ALREADY_EXISTS" });
    expect(problem.type).toBe("urn:restow:problem:auth:organization_already_exists");
  });

  it("keeps the better-auth status for other failures", () => {
    const problem = toProblem(new APIError("UNAUTHORIZED", { message: "nope" })) as ProblemError;
    expect(problem.status).toBe(401);
    expect(problem.type).toBe("about:blank");
  });

  it("passes unrelated errors through untouched", () => {
    const plain = new Error("boom");
    expect(toProblem(plain)).toBe(plain);
  });
});

describe("authCall", () => {
  it("returns the value on success and rethrows problems on failure", async () => {
    await expect(authCall(async () => 1)).resolves.toBe(1);
    await expect(
      authCall(async () => {
        throw new APIError("NOT_FOUND", { message: "missing", code: "USER_NOT_FOUND" });
      }),
    ).rejects.toMatchObject({ status: 404 });
  });
});
