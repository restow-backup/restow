import { describe, expect, it } from "vitest";

import { PASSWORD_MIN_LENGTH, assessPassword } from "./password";

describe("assessPassword", () => {
  it("flags anything under the minimum length", () => {
    const result = assessPassword("short");
    expect(result.strength).toBe("tooShort");
    expect(result.score).toBe(0);
    expect(result.meetsMinimum).toBe(false);
  });

  it("accepts exactly the minimum length", () => {
    expect(assessPassword("a".repeat(PASSWORD_MIN_LENGTH)).meetsMinimum).toBe(true);
  });

  it("rates monotone or common passwords low even when long", () => {
    expect(assessPassword("aaaaaaaaaaaaaaaa").strength).toBe("weak");
    expect(assessPassword("password12345678").strength).toBe("weak");
    expect(assessPassword("Restow-Backup-2026").score).toBeLessThanOrEqual(2);
  });

  it("rewards length and character variety", () => {
    expect(assessPassword("correct horse battery").score).toBeGreaterThanOrEqual(2);
    expect(assessPassword("Tr0ub4dor&3-xylophone!").strength).toBe("veryStrong");
  });

  it("never exceeds the meter range", () => {
    const result = assessPassword("A very long passphrase with Numbers 123 and symbols !?%");
    expect(result.score).toBe(4);
  });
});
