import { describe, expect, it } from "vitest";
import { planFirstAdmin } from "./first-admin.js";

const admin = { id: "admin-1", email: "ops@example.com", role: "admin" };
const endUser = { id: "user-1", email: "someone@example.com", role: "user" };

describe("planFirstAdmin", () => {
  it("creates the admin on a fresh installation", () => {
    expect(planFirstAdmin("ops@example.com", [], null)).toEqual({ kind: "create" });
  });

  it("never promotes an account that already exists", () => {
    // e.g. someone signed in with Microsoft before the setup ran.
    expect(planFirstAdmin("someone@example.com", [], endUser)).toEqual({
      kind: "conflict",
      reason: "email_in_use",
    });
  });

  it("continues only with the admin an unfinished setup left behind", () => {
    expect(planFirstAdmin(" OPS@example.com ", [admin], admin)).toEqual({
      kind: "resume",
      userId: "admin-1",
    });
  });

  it("refuses a second admin while one exists", () => {
    expect(planFirstAdmin("attacker@example.com", [admin], null)).toEqual({
      kind: "conflict",
      reason: "administrator_exists",
    });
    expect(planFirstAdmin("someone@example.com", [admin], endUser)).toEqual({
      kind: "conflict",
      reason: "administrator_exists",
    });
  });
});
