import type * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it } from "vitest";

import { i18n } from "@/i18n";
import type { PasskeyImpact } from "../api";
import { ImpactSummary, blocksSelf } from "./passkey-loss-dialog";

function render(node: React.ReactNode): string {
  return renderToStaticMarkup(<I18nextProvider i18n={i18n}>{node}</I18nextProvider>);
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

const covered = { hasPasskey: true, hasPassword: true, hasAuthenticator: true, lockedOut: false };

function impact(overrides: Partial<PasskeyImpact>): PasskeyImpact {
  return { accountsWithPasskeys: 0, accountsLockedOut: 0, self: covered, ...overrides };
}

describe("the question before passkeys stop working", () => {
  it("says nobody loses access when no account has a passkey", () => {
    expect(render(<ImpactSummary impact={impact({})} />)).toContain("Nobody loses access");
  });

  it("counts the accounts that keep a way in", () => {
    const html = render(<ImpactSummary impact={impact({ accountsWithPasskeys: 3 })} />);
    expect(html).toContain("3 accounts have a passkey. All of them also have a password");
  });

  it("names the accounts that could not sign in afterwards", () => {
    const html = render(
      <ImpactSummary impact={impact({ accountsWithPasskeys: 4, accountsLockedOut: 2 })} />,
    );
    expect(html).toContain("2 of the 4 accounts with a passkey have no password");
    expect(html).not.toContain("Your own account");
  });

  it("refuses the change while the requester would lock themselves out", () => {
    const self = { hasPasskey: true, hasPassword: false, hasAuthenticator: false, lockedOut: true };
    const locked = impact({ accountsWithPasskeys: 1, accountsLockedOut: 1, self });
    expect(render(<ImpactSummary impact={locked} />)).toContain(
      "Your own account is one of them because it has no password",
    );
    expect(blocksSelf(locked)).toBe(true);
    expect(blocksSelf(impact({ accountsWithPasskeys: 1 }))).toBe(false);
    // Unknown impact (still loading or failed) does not block on its own.
    expect(blocksSelf(undefined)).toBe(false);
  });
});
