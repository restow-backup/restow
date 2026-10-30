import { describe, expect, it } from "vitest";

import {
  type DeviceEnvironment,
  isPhone,
  isPhoneOpenPath,
  linkForComputer,
  PHONE_INPUT_QUERY,
  phoneGateFor,
} from "./device";

/** A browser with a touch screen (or not) of the given size, as `isPhone` reads it. */
function device(
  input: "touch" | "mouse",
  screen: { width: number; height: number },
  userAgent = "",
): DeviceEnvironment {
  return {
    matchMedia: (query) => ({ matches: query === PHONE_INPUT_QUERY && input === "touch" }),
    screen,
    userAgent,
  };
}

const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const ANDROID_PHONE_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36";
const ANDROID_TABLET_UA =
  "Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

describe("isPhone", () => {
  it("recognises an iPhone in portrait and in landscape", () => {
    expect(isPhone(device("touch", { width: 390, height: 844 }, IPHONE_UA))).toBe(true);
    expect(isPhone(device("touch", { width: 844, height: 390 }, IPHONE_UA))).toBe(true);
  });

  it("recognises an Android phone, also a large one", () => {
    expect(isPhone(device("touch", { width: 412, height: 915 }, ANDROID_PHONE_UA))).toBe(true);
    expect(isPhone(device("touch", { width: 932, height: 430 }, ANDROID_PHONE_UA))).toBe(true);
  });

  it("does not block an iPad, in either orientation", () => {
    expect(isPhone(device("touch", { width: 744, height: 1133 }))).toBe(false);
    expect(isPhone(device("touch", { width: 1180, height: 820 }))).toBe(false);
  });

  it("does not block an Android tablet, also the smallest ones", () => {
    expect(isPhone(device("touch", { width: 800, height: 1280 }, ANDROID_TABLET_UA))).toBe(false);
    expect(isPhone(device("touch", { width: 600, height: 960 }, ANDROID_TABLET_UA))).toBe(false);
  });

  it("does not block a desktop, however narrow its window is", () => {
    // The screen, not the window, decides: a 320 px wide window on a 1080p monitor.
    expect(isPhone(device("mouse", { width: 1920, height: 1080 }))).toBe(false);
    // Even a small screen with a mouse or trackpad is no phone.
    expect(isPhone(device("mouse", { width: 360, height: 640 }))).toBe(false);
  });

  it("does not trust the user agent when the browser can answer", () => {
    // "Request desktop site" on a phone keeps the touch input but cannot hide the screen;
    // a desktop that spoofs a phone user agent has a mouse.
    expect(isPhone(device("mouse", { width: 1920, height: 1080 }, IPHONE_UA))).toBe(false);
    expect(isPhone(device("touch", { width: 820, height: 1180 }, IPHONE_UA))).toBe(false);
  });

  it("falls back to the user agent without matchMedia", () => {
    expect(isPhone({ screen: { width: 390, height: 844 }, userAgent: IPHONE_UA })).toBe(true);
    expect(isPhone({ matchMedia: null, userAgent: ANDROID_PHONE_UA })).toBe(true);
    expect(isPhone({ userAgent: ANDROID_TABLET_UA })).toBe(false);
    expect(isPhone({ userAgent: "Mozilla/5.0 (X11; Linux x86_64) Firefox/128.0" })).toBe(false);
  });

  it("falls back to the user agent without a usable screen", () => {
    const matchMedia = () => ({ matches: false });
    expect(isPhone({ matchMedia, userAgent: IPHONE_UA })).toBe(true);
    expect(isPhone({ matchMedia, screen: null, userAgent: IPHONE_UA })).toBe(true);
    expect(isPhone({ matchMedia, screen: { width: 0, height: 0 }, userAgent: IPHONE_UA })).toBe(
      true,
    );
    expect(isPhone({ matchMedia, screen: { width: 1280, height: 720 }, userAgent: "Chrome" })).toBe(
      false,
    );
  });

  it("is no phone when nothing is known", () => {
    expect(isPhone({})).toBe(false);
    expect(isPhone({ matchMedia: null, screen: null, userAgent: null })).toBe(false);
  });
});

describe("isPhoneOpenPath", () => {
  it("leaves the pages open that people reach from a mail", () => {
    expect(isPhoneOpenPath("/reset-password")).toBe(true);
    expect(isPhoneOpenPath("/reset-password/")).toBe(true);
    expect(isPhoneOpenPath("/accounts/set-password/abc123")).toBe(true);
    expect(isPhoneOpenPath("/Accounts/Set-Password/abc123/")).toBe(true);
  });

  it("closes everything else", () => {
    for (const path of [
      "/",
      "/login",
      "/setup",
      "/authenticator-setup",
      "/invitations/inv_1",
      "/accounts",
      "/accounts/set-password",
      "/accounts/set-password/",
      "/reset-password-now",
      "/tenants/abc/accounts/set-password/x",
    ]) {
      expect(isPhoneOpenPath(path), path).toBe(false);
    }
  });
});

describe("phoneGateFor", () => {
  const phone = { phone: true, demo: false } as const;

  it("blocks the sign-in, the setup, the enrolment and the app on a phone", () => {
    for (const pathname of ["/login", "/setup", "/authenticator-setup", "/", "/backup-jobs"]) {
      expect(phoneGateFor({ pathname, ...phone }), pathname).toBe("blocked");
    }
  });

  it("lets the mail links through on a phone", () => {
    expect(phoneGateFor({ pathname: "/reset-password", ...phone })).toBeNull();
    expect(phoneGateFor({ pathname: "/accounts/set-password/tok", ...phone })).toBeNull();
  });

  it("gives an invitation its own text, also when the sign-in page took it over", () => {
    expect(phoneGateFor({ pathname: "/invitations/inv_1", ...phone })).toBe("invitation");
    expect(phoneGateFor({ pathname: "/login", redirect: "/invitations/inv_1", ...phone })).toBe(
      "invitation",
    );
    expect(phoneGateFor({ pathname: "/login", redirect: "/invitations/inv_1?x=1", ...phone })).toBe(
      "invitation",
    );
    expect(phoneGateFor({ pathname: "/login", redirect: "/tenants", ...phone })).toBe("blocked");
    expect(phoneGateFor({ pathname: "/login", redirect: "//evil.test", ...phone })).toBe("blocked");
    expect(phoneGateFor({ pathname: "/login", redirect: null, ...phone })).toBe("blocked");
    // The redirect only counts on the sign-in page.
    expect(phoneGateFor({ pathname: "/setup", redirect: "/invitations/inv_1", ...phone })).toBe(
      "blocked",
    );
  });

  it("blocks nothing off a phone", () => {
    for (const pathname of ["/login", "/", "/invitations/inv_1", "/reset-password"]) {
      expect(phoneGateFor({ pathname, phone: false, demo: false }), pathname).toBeNull();
    }
  });

  it("exempts the public demo", () => {
    for (const pathname of ["/login", "/", "/invitations/inv_1"]) {
      expect(phoneGateFor({ pathname, phone: true, demo: true }), pathname).toBeNull();
    }
  });
});

describe("linkForComputer", () => {
  const origin = "https://restow.example.test";

  it("hands over the address that was opened", () => {
    expect(linkForComputer("/tenants?tab=jobs", origin)).toBe(`${origin}/tenants?tab=jobs`);
    expect(linkForComputer("/login", origin)).toBe(`${origin}/login`);
  });

  it("hands over the invitation itself when the sign-in page took it over", () => {
    expect(linkForComputer("/login?redirect=%2Finvitations%2Finv_1", origin)).toBe(
      `${origin}/invitations/inv_1`,
    );
    // Other redirects stay on the sign-in page, which sends on after the sign-in.
    expect(linkForComputer("/login?redirect=%2Ftenants", origin)).toBe(
      `${origin}/login?redirect=%2Ftenants`,
    );
  });
});
