import {
  INVITATIONS_BASE_PATH,
  LOGIN_PATH,
  RESET_PASSWORD_PATH,
  SET_PASSWORD_BASE_PATH,
  safeRedirectTarget,
} from "./entry";

/**
 * Phones are not a supported surface: the app is too sensitive to administer
 * from one, so the root layout shows a block page instead of the route. That
 * is a design decision, not an access control (the API does not look at the
 * device). This module holds the pure parts, with the browser injectable so
 * they can be tested: whether a device is a phone, and which paths the block
 * leaves alone.
 */

/** The primary input is a finger and nothing hovers: a touch device, not a laptop with a touch screen. */
export const PHONE_INPUT_QUERY = "(pointer: coarse) and (hover: none)";

/**
 * The smaller side of the screen in CSS pixels below which a touch device is
 * a phone. Phones stay under it in either orientation (a large one is about
 * 430), tablets start above it (a small Android tablet is 600, an iPad mini
 * 744). The screen, not the window, so a landscape phone still counts.
 */
export const PHONE_MAX_SHORT_SIDE = 600;

/** Only for browsers without `matchMedia` or `screen`; never the sole test where the others exist. */
const PHONE_USER_AGENT = /iPhone|Android.*Mobile/;

/** The parts of the browser the detection reads. Everything may be missing. */
export interface DeviceEnvironment {
  matchMedia?: ((query: string) => Pick<MediaQueryList, "matches">) | null;
  screen?: Pick<Screen, "width" | "height"> | null;
  userAgent?: string | null;
}

function browserEnvironment(): DeviceEnvironment {
  return {
    // Called through `window`: a detached `matchMedia` throws "Illegal invocation".
    matchMedia:
      typeof window !== "undefined" && typeof window.matchMedia === "function"
        ? (query) => window.matchMedia(query)
        : null,
    screen: typeof screen === "undefined" ? null : screen,
    userAgent: typeof navigator === "undefined" ? null : navigator.userAgent,
  };
}

function shortSideOf(env: DeviceEnvironment): number | null {
  const width = env.screen?.width;
  const height = env.screen?.height;
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    return null;
  }
  const side = Math.min(width as number, height as number);
  // A screen of 0 px is what a headless or locked-down browser reports, not a device.
  return side > 0 ? side : null;
}

/**
 * Whether this is a smartphone: a touch device (`pointer: coarse`, no hover)
 * whose smaller screen side is under 600 CSS pixels. Tablets and narrow
 * desktop windows are not phones. The user agent decides only when the
 * browser offers no `matchMedia` or no usable `screen`.
 */
export function isPhone(env: DeviceEnvironment = browserEnvironment()): boolean {
  const shortSide = shortSideOf(env);
  if (typeof env.matchMedia === "function" && shortSide !== null) {
    return env.matchMedia(PHONE_INPUT_QUERY).matches && shortSide < PHONE_MAX_SHORT_SIDE;
  }
  return PHONE_USER_AGENT.test(env.userAgent ?? "");
}

/** What the block page says: the general one, or the one for an invitation link. */
export type PhoneGate = "blocked" | "invitation";

function normalize(pathname: string): string {
  return pathname.replace(/\/+$/, "").toLowerCase() || "/";
}

function isUnder(path: string, base: string): boolean {
  return path.startsWith(`${base}/`) && path.length > base.length + 1;
}

/**
 * The pages people open from a mail, which therefore must work wherever the
 * mail was read: choosing a password after a reset or an invitation.
 */
export function isPhoneOpenPath(pathname: string): boolean {
  const path = normalize(pathname);
  return path === RESET_PASSWORD_PATH || isUnder(path, SET_PASSWORD_BASE_PATH);
}

/** An invitation needs a sign-in, which a phone does not get. */
function isInvitationPath(pathname: string): boolean {
  return isUnder(normalize(pathname), INVITATIONS_BASE_PATH);
}

export interface PhoneGateInput {
  pathname: string;
  /**
   * The `?redirect=` of the login page. An invitation opened without a
   * session lands on `/login?redirect=/invitations/<id>`, and the block
   * must still say that it is the invitation.
   */
  redirect?: string | null;
  phone: boolean;
  /** The public demo shows synthetic data and is a marketing surface: no block. */
  demo: boolean;
}

/**
 * Which block page replaces the route, or null when the route renders. Every
 * path is blocked on a phone (login, setup, the app) except the mail links
 * of `isPhoneOpenPath` and the demo.
 */
export function phoneGateFor({
  pathname,
  redirect,
  phone,
  demo,
}: PhoneGateInput): PhoneGate | null {
  if (!phone || demo || isPhoneOpenPath(pathname)) {
    return null;
  }
  if (isInvitationPath(pathname)) {
    return "invitation";
  }
  const target = normalize(pathname) === LOGIN_PATH ? safeRedirectTarget(redirect) : null;
  return target !== null && isInvitationPath(target.split("?")[0] ?? "") ? "invitation" : "blocked";
}

/**
 * The address to hand to a computer: the page that was asked for. For an
 * invitation that was sent to the login page, the invitation itself, so the
 * computer opens it straight after the sign-in.
 */
export function linkForComputer(href: string, origin: string): string {
  const url = new URL(href, origin);
  if (normalize(url.pathname) === LOGIN_PATH) {
    const target = safeRedirectTarget(url.searchParams.get("redirect"));
    if (target !== null && isInvitationPath(target.split("?")[0] ?? "")) {
      return new URL(target, origin).toString();
    }
  }
  return url.toString();
}
