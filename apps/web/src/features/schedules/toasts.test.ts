import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { i18n } from "@/i18n";
import { ApiError } from "@/lib/api";

import "./i18n.js";
import { toastApplied, toastChanged, toastFailed } from "./toasts.js";

const toast = vi.hoisted(() => ({ success: vi.fn(), info: vi.fn(), error: vi.fn() }));
vi.mock("@/components/ui/sonner", () => ({ toast }));

const t = () => i18n.getFixedT("en", "schedules");

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("schedule toasts", () => {
  it("confirm each change in one sentence", () => {
    toastChanged(t(), "created", "backup");
    toastChanged(t(), "disabled", "verify");
    expect(toast.success).toHaveBeenNthCalledWith(1, "Backup schedule created");
    expect(toast.success).toHaveBeenNthCalledWith(2, "Verification schedule switched off");
  });

  it("count the recommended schedules added, and say so when none were missing", () => {
    toastApplied(t(), 5);
    toastApplied(t(), 1);
    toastApplied(t(), 0);
    expect(toast.success).toHaveBeenNthCalledWith(1, "5 recommended schedules added");
    expect(toast.success).toHaveBeenNthCalledWith(2, "1 recommended schedule added");
    expect(toast.info).toHaveBeenCalledWith("Every recommended schedule already exists.");
  });

  it("report failures with the mapped cause", () => {
    toastFailed(t(), new ApiError(403, null, "forbidden"));
    expect(toast.error).toHaveBeenCalledWith("The change could not be saved", {
      description: "You do not have permission for this action.",
    });
  });
});
