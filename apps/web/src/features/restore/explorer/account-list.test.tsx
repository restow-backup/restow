import { beforeAll, describe, expect, it } from "vitest";

import { render } from "@/components/kit/test-utils";
import { i18n } from "@/i18n";

import type { SnapshotObject } from "../api.js";
import { AccountList } from "./account-list.js";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

const OWN_ID = "3f5c9c2e-7d0f-4c2e-9a4b-1d2f3e4a5b6c";
const OTHER_ID = "9b2f2c6e-3d1a-4a1b-8e3f-0c1d2e3f4a5b";
const ORPHAN_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

const objects: SnapshotObject[] = [
  {
    id: OWN_ID,
    kind: "mailbox",
    externalId: "anna@example.com",
    displayName: "Anna Example",
    status: "active",
    sourceKind: "m365",
    ownerEmail: "anna@example.com",
    own: true,
    snapshotCount: 3,
    latestSnapshotId: "s1",
    latestSnapshotAt: "2026-09-20T10:00:00.000Z",
    readiness: "green",
  },
  {
    id: OTHER_ID,
    kind: "onedrive",
    externalId: "bob@example.com",
    displayName: "Bob's OneDrive",
    status: "active",
    sourceKind: "m365",
    ownerEmail: "bob@example.com",
    own: false,
    snapshotCount: 0,
    latestSnapshotId: null,
    latestSnapshotAt: null,
    readiness: "no_backup",
  },
  {
    id: ORPHAN_ID,
    kind: "imap",
    externalId: "legacy@example.com",
    displayName: null,
    status: "orphaned",
    sourceKind: "imap",
    ownerEmail: null,
    own: false,
    snapshotCount: 2,
    latestSnapshotId: "s2",
    latestSnapshotAt: "2026-09-01T10:00:00.000Z",
    readiness: "yellow",
  },
];

describe("AccountList", () => {
  it("shows display names, never a raw id", () => {
    const html = render(<AccountList objects={objects} value={null} onChange={() => {}} />);
    expect(html).toContain("Anna Example");
    expect(html).toContain("Bob&#x27;s OneDrive");
    // The IMAP account falls back to its external id (no display name), but
    // no account's opaque UUID is ever printed as a label.
    expect(html).toContain("legacy@example.com");
    expect(html).not.toContain(OWN_ID);
    expect(html).not.toContain(OTHER_ID);
    expect(html).not.toContain(ORPHAN_ID);
  });

  it("names the kind and the primary address under each name", () => {
    const html = render(<AccountList objects={objects} value={null} onChange={() => {}} />);
    expect(html).toContain("Mailbox · anna@example.com");
    expect(html).toContain("OneDrive · bob@example.com");
    // The IMAP account's name already is its address: the kind alone.
    expect(html).toMatch(/data-slot="account-address">IMAP account</);
  });

  it("marks the viewer's own account and badges protection status", () => {
    const html = render(<AccountList objects={objects} value={OWN_ID} onChange={() => {}} />);
    expect(html).toContain("Yours");
    expect(html).toContain("Protected");
    expect(html).toContain("Removed from source");
  });

  it("draws Protected in the neutral outline: green is the Ready badge of a passed restore check", () => {
    const html = render(<AccountList objects={objects} value={null} onChange={() => {}} />);
    const badges = html.match(/<span data-slot="badge"[^>]*>[\s\S]*?<\/span>/g) ?? [];
    const protectedBadge = badges.find((badge) => badge.includes(">Protected<"));
    expect(protectedBadge).toBeDefined();
    expect(protectedBadge).toContain('data-tone="neutral"');
    expect(protectedBadge).not.toContain("success");
    // The proof stays green.
    const ready = badges.find((badge) => badge.includes("Ready"));
    expect(ready).toContain('data-tone="success"');
  });

  it("shows 'no restore point yet' for an account with no backup", () => {
    const html = render(<AccountList objects={objects} value={null} onChange={() => {}} />);
    expect(html).toContain("No restore point yet");
  });

  it("badges the readiness of an account's newest backup", () => {
    const html = render(<AccountList objects={objects} value={null} onChange={() => {}} />);
    // Anna (green, has a restore point) shows the readiness badge next to "Last backup".
    expect(html).toContain("Ready");
    // Bob has no restore point yet, so no_backup's readiness badge is redundant with
    // the "No restore point yet" badge already shown and is not rendered again.
    expect(html).not.toContain("No backup yet");
  });

  it("still shows readiness and last backup for an orphaned account (its restore points are still there)", () => {
    const html = render(<AccountList objects={objects} value={null} onChange={() => {}} />);
    expect(html).toContain("Removed from source");
    // "Attention" is the yellow readiness state the orphaned fixture carries
    // above; it must render next to "Removed from source", not instead of it.
    expect(html).toContain("Attention");
  });

  it("gives the search input its own accessible name, not the pane's 'Accounts' heading", () => {
    const html = render(<AccountList objects={objects} value={null} onChange={() => {}} />);
    // cmdk's hidden label (the input's real accessible name, via
    // `aria-labelledby`) must say what the field does, not the pane's own
    // "Accounts" heading.
    expect(html).toMatch(/<label[^>]*id="([^"]+)"[^>]*>Search accounts<\/label>/);
    const [, labelId] = html.match(/<label[^>]*id="([^"]+)"[^>]*>Search accounts<\/label>/) ?? [];
    expect(labelId).toBeTruthy();
    expect(html).toContain(`aria-labelledby="${labelId}"`);
    expect(html).not.toMatch(/<input[^>]*aria-label="Accounts"/);
  });

  it("offers a type filter for mailbox, OneDrive and IMAP", () => {
    const html = render(<AccountList objects={objects} value={null} onChange={() => {}} />);
    // A labelled choice, not a row of bare icons: the trigger names what it
    // filters and shows the current choice in words.
    expect(html).toContain('aria-label="Account type"');
    expect(html).toContain("All accounts");
  });

  it("speaks German", async () => {
    await i18n.changeLanguage("de");
    const html = render(<AccountList objects={objects} value={null} onChange={() => {}} />);
    expect(html).toContain("Noch kein Sicherungsstand");
    expect(html).toContain("Ihr Konto");
    await i18n.changeLanguage("en");
  });
});
