import type * as React from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { render } from "@/components/kit/test-utils";
import { i18n } from "@/i18n";

import { NoAccountsState, NoRestorePointState } from "./empty-states";

/**
 * The explorer's empty states (K-1): an administrator is sent to protect an
 * account; a tenant user, who cannot open those pages, is told to ask their
 * administrators and gets no link into a page that would refuse them.
 */

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    Link: ({ to, children, ...props }: { to: string; children?: React.ReactNode }) => (
      <a href={String(to)} {...props}>
        {children}
      </a>
    ),
  };
});

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

describe("explorer empty states", () => {
  it("sends an administrator to protect an account", () => {
    const html = render(<NoAccountsState canProtect />);
    expect(html).toContain("No protected account yet");
    expect(html).toContain("Go to Protected objects");
    expect(html).toContain("<a ");
  });

  it("tells a tenant user whom to ask, without a link they cannot follow", () => {
    const html = render(<NoAccountsState canProtect={false} />);
    expect(html).toContain("Nothing of yours is backed up yet");
    expect(html).toContain("Ask your organisation");
    expect(html).not.toContain("Go to Protected objects");
    expect(html).not.toContain("<a ");
  });

  it("does the same when the account has no restore point yet", () => {
    expect(render(<NoRestorePointState canProtect />)).toContain("Go to Protected objects");
    const self = render(<NoRestorePointState canProtect={false} />);
    expect(self).toContain("ask your administrators");
    expect(self).not.toContain("<a ");
  });
});
