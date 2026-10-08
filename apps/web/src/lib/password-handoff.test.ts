import { afterEach, describe, expect, it } from "vitest";

import {
  PASSWORD_HANDOFF_TTL_MS,
  clearPasswordHandoff,
  holdPasswordForEnrolment,
  peekPasswordForEnrolment,
  takePasswordForEnrolment,
} from "./password-handoff";

afterEach(() => clearPasswordHandoff());

describe("password handoff to the authenticator enrolment", () => {
  it("hands the password over once", () => {
    holdPasswordForEnrolment("secret-1", 1000);
    expect(peekPasswordForEnrolment(1001)).toBe("secret-1");
    expect(takePasswordForEnrolment(1002)).toBe("secret-1");
    expect(takePasswordForEnrolment(1003)).toBeNull();
  });

  it("forgets it after the time limit and on clear", () => {
    holdPasswordForEnrolment("secret-1", 0);
    expect(peekPasswordForEnrolment(PASSWORD_HANDOFF_TTL_MS + 1)).toBeNull();
    expect(takePasswordForEnrolment(PASSWORD_HANDOFF_TTL_MS + 1)).toBeNull();
    holdPasswordForEnrolment("secret-2", 0);
    clearPasswordHandoff();
    expect(takePasswordForEnrolment(1)).toBeNull();
  });

  it("holds nothing for an empty password", () => {
    holdPasswordForEnrolment("", 0);
    expect(peekPasswordForEnrolment(1)).toBeNull();
  });
});
