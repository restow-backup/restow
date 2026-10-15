// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { i18n } from "@/i18n";

import { DumpsList } from "./components/dumps-list";
import {
  buttonByText,
  click,
  enableActEnvironment,
  flush,
  json,
  type Mounted,
  mount,
  problem,
  routedFetch,
} from "./testing";

/**
 * The database backups in the Updates tab: the owner downloads one (after a warning that it
 * holds the whole database, through a one-time link) or deletes one; nobody else sees the
 * buttons.
 */

vi.mock("@/lib/auth-client", () => ({
  authClient: {
    passkey: { listUserPasskeys: async () => ({ data: [], error: null }) },
    signIn: { passkey: async () => ({ error: null }) },
  },
  browserSupportsPasskeys: () => false,
  needsSecondFactor: () => false,
}));

enableActEnvironment();

const FILE = "restow-20260930-100000-0.3.6-to-0.4.0.dump";
const DUMPS = [{ file: FILE, bytes: 1024 ** 3, createdAt: "2026-09-30T10:00:00.000Z" }];
let mounted: Mounted | null = null;

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

function text(scope: ParentNode | null | undefined = document.body): string {
  return (scope?.textContent ?? "").replace(/\s+/g, " ").trim();
}

describe("the database backups", () => {
  it("download through a one-time link after the warning", async () => {
    const { mock, requests } = routedFetch({
      [`POST /updates/dumps/${FILE}/download`]: () =>
        json({
          url: `/api/v1/updates/dumps/${FILE}?ticket=t`,
          expiresAt: "2026-10-02T10:01:00.000Z",
        }),
    });
    vi.stubGlobal("fetch", mock);
    const clicked: string[] = [];
    const original = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      clicked.push(this.getAttribute("href") ?? "");
    };
    try {
      mounted = mount(<DumpsList dumps={DUMPS} canChange />);
      await flush(4);
      await click(buttonByText(document.body, `Download ${FILE}`));
      await flush(4);
      const dialog = document.querySelector('[role="alertdialog"]') as HTMLElement;
      expect(text(dialog)).toContain("holds the whole database");
      await click(buttonByText(dialog, "Download"));
      await flush(8);
      expect(requests.map((request) => `${request.method} ${request.path}`)).toEqual([
        `POST /updates/dumps/${FILE}/download`,
      ]);
      expect(clicked).toEqual([`/api/v1/updates/dumps/${FILE}?ticket=t`]);
    } finally {
      HTMLAnchorElement.prototype.click = original;
    }
  });

  it("delete one, and say when the last update still needs it", async () => {
    const { mock, requests } = routedFetch({
      [`DELETE /updates/dumps/${FILE}`]: () =>
        problem("urn:restow:problem:dump-protected", 409, { detail: "needed" }),
    });
    vi.stubGlobal("fetch", mock);
    mounted = mount(<DumpsList dumps={DUMPS} canChange />);
    await flush(4);
    await click(buttonByText(document.body, `Delete ${FILE}`));
    await flush(4);
    const dialog = document.querySelector('[role="alertdialog"]') as HTMLElement;
    await click(buttonByText(dialog, "Delete"));
    await flush(8);
    expect(requests.some((request) => request.method === "DELETE")).toBe(true);
    expect(text()).toContain("This backup is needed to repair the last update");
  });

  it("show no buttons to anyone but the owner", async () => {
    mounted = mount(<DumpsList dumps={DUMPS} />);
    await flush(4);
    expect(buttonByText(document.body, `Download ${FILE}`)).toBeNull();
    expect(buttonByText(document.body, `Delete ${FILE}`)).toBeNull();
  });
});
