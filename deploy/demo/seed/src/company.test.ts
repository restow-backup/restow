import { describe, expect, it } from "vitest";

import { DEMO_TENANTS, allMailboxes, mailboxesMissingFrom } from "./company.js";

describe("demo companies", () => {
  it("are English, on the reserved example domain", () => {
    expect(DEMO_TENANTS.map((tenant) => tenant.name)).toEqual([
      "Example Trading Ltd",
      "Birchwood Consulting Ltd",
    ]);
    for (const mailbox of allMailboxes()) {
      expect(mailbox.login).toMatch(/@example\.org$/);
    }
  });

  it("names the mailboxes Dovecot was not told to create", () => {
    expect(
      mailboxesMissingFrom("info@example.org, accounting@example.org sales@example.org"),
    ).toEqual([]);
    expect(
      mailboxesMissingFrom("info@example.org,buchhaltung@example.org,vertrieb@example.org"),
    ).toEqual(["accounting@example.org", "sales@example.org"]);
  });
});
