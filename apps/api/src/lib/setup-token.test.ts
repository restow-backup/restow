import { afterEach, describe, expect, it } from "vitest";
import {
  MIN_SETUP_TOKEN_LENGTH,
  currentSetupToken,
  generateSetupToken,
  normalizeSetupToken,
  resetSetupTokenForTests,
  retireSetupToken,
  setupTokenAnnouncement,
  setupTokenConfigProblem,
  setupTokenMatches,
} from "./setup-token.js";

afterEach(() => {
  resetSetupTokenForTests();
});

describe("generateSetupToken", () => {
  it("is four groups of five unambiguous characters, different every time", () => {
    const tokens = new Set(Array.from({ length: 200 }, () => generateSetupToken()));
    expect(tokens.size).toBe(200);
    for (const token of tokens) {
      expect(token).toMatch(/^[A-HJKMNP-TV-Z2-9]{5}(-[A-HJKMNP-TV-Z2-9]{5}){3}$/);
    }
  });
});

describe("normalizeSetupToken", () => {
  it("ignores case, spaces and dashes", () => {
    expect(normalizeSetupToken(" k7pqx 3mzra-T9WHE--2bncv\n")).toBe("K7PQX3MZRAT9WHE2BNCV");
  });
});

describe("setupTokenConfigProblem", () => {
  it("accepts an unset variable and a long enough value", () => {
    expect(setupTokenConfigProblem(undefined)).toBeNull();
    expect(setupTokenConfigProblem("a".repeat(MIN_SETUP_TOKEN_LENGTH))).toBeNull();
  });

  it("refuses a value too short to be a secret, dashes and spaces not counted", () => {
    expect(setupTokenConfigProblem("change-me")).toMatch(/RESTOW_SETUP_TOKEN/);
    expect(setupTokenConfigProblem("abcd-efgh-ijkl-mno")).toMatch(/at least 16/);
  });
});

describe("the token of this process", () => {
  it("is generated once and printed for the log", () => {
    const first = currentSetupToken(undefined);
    expect(first?.source).toBe("log");
    expect(currentSetupToken(undefined)).toBe(first);
    expect(setupTokenMatches(first?.display, undefined)).toBe(true);
    expect(setupTokenMatches(first?.display.toLowerCase(), undefined)).toBe(true);
    expect(setupTokenMatches("AAAAA-BBBBB-CCCCC-DDDDD", undefined)).toBe(false);
    expect(setupTokenMatches("", undefined)).toBe(false);
    expect(setupTokenMatches(undefined, undefined)).toBe(false);
  });

  it("is RESTOW_SETUP_TOKEN when set, and never shown", () => {
    const configured = "4f0c1e9a7d2b4c88a1e0f3b6c5d7e9f1";
    const state = currentSetupToken(configured);
    expect(state?.source).toBe("environment");
    expect(state?.display).toBe("");
    expect(setupTokenMatches(configured.toUpperCase(), configured)).toBe(true);
    expect(setupTokenMatches(`${configured}x`, configured)).toBe(false);
  });

  it("is gone once the setup is complete, even for the right value", () => {
    const state = currentSetupToken(undefined);
    retireSetupToken();
    expect(currentSetupToken(undefined)).toBeNull();
    expect(setupTokenMatches(state?.display, undefined)).toBe(false);
  });
});

describe("setupTokenAnnouncement", () => {
  it("prints a generated token in a block that stands out", () => {
    const lines = setupTokenAnnouncement(
      { display: "K7PQX-3MZRA-T9WHE-2BNCV", source: "log" },
      "Acme",
    );
    expect(lines.join("\n")).toContain("SETUP TOKEN: K7PQX-3MZRA-T9WHE-2BNCV");
    expect(lines[0]).toMatch(/^=+$/);
    expect(lines.at(-1)).toMatch(/^=+$/);
    expect(lines.join("\n")).toContain("Acme is not set up yet");
  });

  it("only points at the variable when the operator set one", () => {
    const text = setupTokenAnnouncement({ display: "", source: "environment" }, "Acme").join("\n");
    expect(text).toContain("RESTOW_SETUP_TOKEN");
    expect(text).not.toContain("SETUP TOKEN:");
  });
});
