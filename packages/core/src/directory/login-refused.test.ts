import { describe, expect, it } from "vitest";
import {
  isLoginRefusalCause,
  isSourceWideLoginFailure,
  LOGIN_ARCHIVE_FAILURE_MIN_SPACING_HOURS,
  LOGIN_FAILURE_MIN_SPACING_HOURS,
  LOGIN_QUESTION_MIN_RUNS,
  type LoginFailureState,
  loginQuestionState,
  nextLoginFailureState,
  shouldAskLoginQuestion,
} from "./login-refused.js";

const T0 = new Date("2026-10-01T02:00:00Z");
const hours = (base: Date, h: number) => new Date(base.getTime() + h * 3_600_000);
const clean: LoginFailureState = { runs: 0, since: null, lastAt: null };

describe("isLoginRefusalCause", () => {
  it("is true only for imap.auth_failed", () => {
    expect(isLoginRefusalCause({ code: "imap.auth_failed" })).toBe(true);
    for (const code of [
      "imap.server_limit",
      "imap.oauth_failed",
      "imap.credential_missing",
      "imap.starttls_unavailable",
      "imap.address_blocked",
      "imap.connection_lost",
      "network.unreachable",
      "network.dns",
      "network.timeout",
      "network.tls",
      "config.invalid",
    ]) {
      expect(isLoginRefusalCause({ code })).toBe(false);
    }
    expect(isLoginRefusalCause(null)).toBe(false);
    expect(isLoginRefusalCause({})).toBe(false);
  });
});

describe("nextLoginFailureState", () => {
  it("starts a streak with the first failure", () => {
    const next = nextLoginFailureState(clean, T0);
    expect(next).toEqual({ runs: 1, since: T0, lastAt: T0, counted: true });
  });

  it("folds failures closer than the spacing into the last counted one", () => {
    const first = nextLoginFailureState(clean, T0);
    const retry = nextLoginFailureState(first, hours(T0, LOGIN_FAILURE_MIN_SPACING_HOURS - 0.01));
    expect(retry.counted).toBe(false);
    expect(retry.runs).toBe(1);
    expect(retry.lastAt).toEqual(T0);
    const next = nextLoginFailureState(first, hours(T0, LOGIN_FAILURE_MIN_SPACING_HOURS));
    expect(next.counted).toBe(true);
    expect(next.runs).toBe(2);
    expect(next.since).toEqual(T0);
  });

  it("spaces archive passes wider, so passes every few hours do not outrun the nightly backup", () => {
    let state: LoginFailureState = clean;
    let counted = 0;
    // A pass every 4 hours for two days: one counted run per ~day, not one per 6 h.
    for (let h = 0; h <= 48; h += 4) {
      const next = nextLoginFailureState(
        state,
        hours(T0, h),
        LOGIN_ARCHIVE_FAILURE_MIN_SPACING_HOURS,
      );
      if (next.counted) {
        counted++;
      }
      state = next;
    }
    expect(counted).toBe(3);
    expect(state.runs).toBe(3);
    const tooSoon = nextLoginFailureState(
      { runs: 1, since: T0, lastAt: T0 },
      hours(T0, LOGIN_ARCHIVE_FAILURE_MIN_SPACING_HOURS - 0.01),
      LOGIN_ARCHIVE_FAILURE_MIN_SPACING_HOURS,
    );
    expect(tooSoon.counted).toBe(false);
  });

  it("restarts the streak when the counter is zero but a stale since is left", () => {
    const next = nextLoginFailureState({ runs: 0, since: T0, lastAt: T0 }, hours(T0, 100));
    expect(next.since).toEqual(hours(T0, 100));
  });
});

describe("shouldAskLoginQuestion", () => {
  const three = (since: Date): LoginFailureState => ({
    runs: LOGIN_QUESTION_MIN_RUNS,
    since,
    lastAt: hours(since, 48),
  });

  it("needs three counted failures", () => {
    expect(shouldAskLoginQuestion({ runs: 2, since: T0, lastAt: T0 }, null, hours(T0, 72))).toBe(
      false,
    );
    expect(shouldAskLoginQuestion(three(T0), null, hours(T0, 72))).toBe(true);
  });

  it("needs 24 hours between the first failure and now", () => {
    expect(shouldAskLoginQuestion(three(T0), null, hours(T0, 23.9))).toBe(false);
    expect(shouldAskLoginQuestion(three(T0), null, hours(T0, 24))).toBe(true);
  });

  it("is not asked again within 90 days of a No, and is after", () => {
    const now = hours(T0, 24 * 100);
    expect(shouldAskLoginQuestion(three(T0), hours(now, -24 * 89), now)).toBe(false);
    expect(shouldAskLoginQuestion(three(T0), hours(now, -24 * 91), now)).toBe(true);
  });

  it("a streak without a start never asks", () => {
    expect(shouldAskLoginQuestion({ runs: 5, since: null, lastAt: null }, null, T0)).toBe(false);
  });
});

describe("loginQuestionState", () => {
  it("is open, dismissed or null", () => {
    expect(loginQuestionState({ status: "active", loginQuestionAt: T0 })).toBe("open");
    expect(
      loginQuestionState({
        status: "active",
        loginQuestionAt: T0,
        loginQuestionDismissedAt: T0,
      }),
    ).toBe("dismissed");
    expect(loginQuestionState({ status: "active", loginQuestionAt: null })).toBeNull();
    expect(loginQuestionState({ status: "orphaned", loginQuestionAt: T0 })).toBeNull();
    expect(loginQuestionState({ status: "excluded", loginQuestionAt: T0 })).toBeNull();
  });
});

describe("isSourceWideLoginFailure", () => {
  it("needs two failing accounts and half of the active ones", () => {
    expect(isSourceWideLoginFailure(1, 1)).toBe(false);
    expect(isSourceWideLoginFailure(2, 3)).toBe(true);
    expect(isSourceWideLoginFailure(2, 4)).toBe(true);
    expect(isSourceWideLoginFailure(2, 5)).toBe(false);
    expect(isSourceWideLoginFailure(5, 0)).toBe(false);
  });
});
