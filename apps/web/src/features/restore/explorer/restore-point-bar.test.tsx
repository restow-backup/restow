import { beforeAll, describe, expect, it } from "vitest";

import { render } from "@/components/kit/test-utils";
import { i18n } from "@/i18n";

import type { ListedSnapshot } from "../api.js";
import { RestorePointBar } from "./restore-point-bar.js";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

const points: ListedSnapshot[] = [
  {
    id: "p1",
    objectId: "o1",
    sequence: 1,
    itemCount: 5,
    byteSize: 512,
    startedAt: "2026-09-10T10:00:00.000Z",
    completedAt: "2026-09-10T10:05:00.000Z",
    createdAt: "2026-09-10T10:00:00.000Z",
    verification: { state: "green", checkedAt: "2026-09-11T00:00:00.000Z", reportId: "r1" },
  },
];

describe("RestorePointBar", () => {
  it("labels the timeline and shows it once there are restore points", () => {
    const html = render(
      <RestorePointBar
        restorePoints={points}
        loading={false}
        failed={false}
        value="p1"
        onChange={() => {}}
      />,
    );
    expect(html).toContain('aria-label="Restore point"');
    expect(html).toContain('<ul aria-label="Restore points"');
    expect(html).not.toContain("No restore point yet");
  });

  it("says in words that the account has no restore point yet", () => {
    const html = render(
      <RestorePointBar
        restorePoints={[]}
        loading={false}
        failed={false}
        value={null}
        onChange={() => {}}
      />,
    );
    expect(html).toContain("No restore point yet");
    expect(html).not.toContain("<ul");
  });

  it("says in words that loading the restore points failed", () => {
    const html = render(
      <RestorePointBar
        restorePoints={undefined}
        loading={false}
        failed
        value={null}
        onChange={() => {}}
      />,
    );
    expect(html).toContain("The restore points of this mailbox or drive could not be loaded.");
    expect(html).not.toContain("No restore point yet");
  });

  it("shows placeholders instead of a message while the restore points load", () => {
    const html = render(
      <RestorePointBar
        restorePoints={undefined}
        loading
        failed={false}
        value={null}
        onChange={() => {}}
      />,
    );
    expect(html).toContain('data-slot="skeleton"');
    expect(html).not.toContain("No restore point yet");
    expect(html).not.toContain("could not be loaded");
  });
});
