// @vitest-environment happy-dom
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { i18n } from "@/i18n";

import "../i18n";
import { UploadLeaveGuard } from "./upload-leave-guard";

/**
 * Leaving the import wizard by an in-app link while files upload (K-5): the
 * router's blocker is armed only while uploads run, and a blocked navigation
 * asks first; "Stay" keeps the uploads, "Leave" lets the navigation through.
 */

const proceed = vi.fn();
const reset = vi.fn();
let blockerOptions: { disabled?: boolean; enableBeforeUnload?: boolean } | null = null;
let status: "idle" | "blocked" = "idle";

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    useBlocker: (options: { disabled?: boolean; enableBeforeUnload?: boolean }) => {
      blockerOptions = options;
      return status === "blocked" ? { status, proceed, reset } : { status: "idle" };
    },
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

describe("UploadLeaveGuard", () => {
  let container: HTMLDivElement;
  let root: Root;

  function render(busy: boolean) {
    act(() => {
      root.render(
        <I18nextProvider i18n={i18n}>
          <UploadLeaveGuard busy={busy} />
        </I18nextProvider>,
      );
    });
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    status = "idle";
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  const dialog = () => document.body.querySelector('[role="alertdialog"]');
  const buttonIn = (label: string) =>
    [...(dialog()?.querySelectorAll("button") ?? [])].find((candidate) =>
      candidate.textContent?.includes(label),
    );

  it("blocks navigation only while uploads run, and leaves tab closing to the browser prompt", () => {
    render(false);
    expect(blockerOptions).toMatchObject({ disabled: true, enableBeforeUnload: false });
    render(true);
    expect(blockerOptions).toMatchObject({ disabled: false });
    expect(dialog()).toBeNull();
  });

  it("asks before leaving and keeps the uploads when the person stays", () => {
    status = "blocked";
    render(true);
    expect(dialog()?.textContent).toContain("Files are still uploading");
    act(() => buttonIn("Stay on this page")?.click());
    expect(reset).toHaveBeenCalled();
    expect(proceed).not.toHaveBeenCalled();
  });

  it("lets the navigation through when the person confirms", async () => {
    status = "blocked";
    render(true);
    await act(async () => {
      dialog()
        ?.querySelector("form")
        ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(proceed).toHaveBeenCalled();
  });
});
