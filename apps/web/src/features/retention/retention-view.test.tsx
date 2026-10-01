import { beforeAll, describe, expect, it } from "vitest";

import { render } from "@/components/kit/test-utils";
import { i18n } from "@/i18n";
import { ApiError } from "@/lib/api";

import type { RetentionPolicy, RetentionPolicyList } from "./api.js";
import "./i18n.js";
import { RetentionView, type RetentionViewProps } from "./retention-view.js";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

function policy(overrides: Partial<RetentionPolicy> = {}): RetentionPolicy {
  return {
    id: crypto.randomUUID(),
    name: "Standard",
    preset: "default",
    tiers: [
      { fromDays: 0, toDays: 30, keepEveryDays: 0 },
      { fromDays: 30, toDays: 90, keepEveryDays: 1 },
      { fromDays: 90, toDays: 365, keepEveryDays: 7 },
    ],
    cutoffDays: 365,
    isDefault: true,
    protectedObjects: [],
    createdAt: "2026-02-01T00:00:00.000Z",
    updatedAt: "2026-02-01T00:00:00.000Z",
    ...overrides,
  };
}

const list: RetentionPolicyList = {
  items: [
    policy(),
    policy({
      id: "override-1",
      name: "Bo — keep everything",
      preset: "keep_all",
      cutoffDays: null,
      isDefault: false,
      protectedObjects: [{ id: "obj-1", name: "Bo Nilsson", kind: "mailbox" }],
    }),
  ],
  recommendedPreset: "default",
};

function view(props: Partial<RetentionViewProps> = {}): string {
  const noop = () => {};
  return render(
    <RetentionView
      hasTenant
      canManage
      list={list}
      loading={false}
      fetching={false}
      error={null}
      onRetry={noop}
      onCreate={noop}
      onEdit={noop}
      onDelete={noop}
      {...props}
    />,
  );
}

describe("RetentionView", () => {
  it("asks a provider admin to pick a tenant first", () => {
    const html = view({ hasTenant: false });
    expect(html).toContain("No tenant selected");
    expect(html).not.toContain("<table");
  });

  it("explains that retention is administrators only, instead of a generic error, for a tenant user", () => {
    const html = view({ canManage: false, list: undefined });
    expect(html).toContain("Administrators only");
    expect(html).not.toContain("<table");
    expect(html).not.toContain("New policy");
    expect(html).not.toContain("could not be loaded");
  });

  it("shows skeleton rows while the first load runs", () => {
    const html = view({ list: undefined, loading: true });
    expect(html).toContain('data-slot="skeleton"');
    expect(html).toContain('aria-busy="true"');
  });

  it("offers to create a policy when the tenant has none yet, showing the recommended default plainly", () => {
    const html = view({ list: { items: [], recommendedPreset: "default" } });
    expect(html).toContain('data-slot="empty-state"');
    expect(html).toContain("No retention policy yet");
    expect(html).toContain(
      "Recommended: 30 days, then daily up to 90 days, then weekly up to 1 year.",
    );
    expect(html).not.toContain("Recommended: Recommended");
    expect(html).not.toContain("<table");
  });

  it("shows the cause and a retry when loading failed", () => {
    const html = view({ list: undefined, error: new ApiError(500, null, "boom") });
    expect(html).toContain("Retention policies could not be loaded");
    expect(html).toContain("Retry");
  });

  it("lists policies with their scope and how long they keep restore points", () => {
    const html = view();
    expect(html).toContain("Standard");
    expect(html).toContain("Tenant default");
    expect(html).toContain("Up to 365 days");
    expect(html).toContain("Bo — keep everything");
    expect(html).toContain("Bo Nilsson");
    expect(html).toContain("Kept without an age limit");
    expect(html).toContain("New policy");
  });
});
