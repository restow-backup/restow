import type * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it } from "vitest";

import { i18n } from "@/i18n";

import "../i18n";
import type { ProvisionResult } from "../types";

import { SetPasswordLinkField } from "./set-password-link-field";

/**
 * The raw link is only ever shown and copyable when the server actually
 * handed a token back (accounts/service.ts, revealSetPasswordToken): once
 * mail delivery succeeds, an admin must not be able to read the link back and
 * redeem it themselves for someone else's mailbox (see the account-takeover
 * note in service.ts). Rendered
 * to static markup, the same style as ../../tenants/components/invite-member-
 * dialog.test.tsx.
 */

function render(node: React.ReactNode): string {
  return renderToStaticMarkup(<I18nextProvider i18n={i18n}>{node}</I18nextProvider>);
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

const base: ProvisionResult = {
  userId: "user-1",
  email: "jane.doe@contoso.example",
  name: "Jane Doe",
  role: "tenant_user",
  created: true,
  linkIssued: true,
  linkExpiresAt: "2026-09-27T10:00:00.000Z",
  setPasswordToken: null,
  mailOutcome: "not_configured",
};

const LINK = "https://restow.example.com/accounts/set-password/abc123";

describe("SetPasswordLinkField", () => {
  it("shows nothing to copy once the link was actually mailed to the account itself", () => {
    // The server itself never hands a token back once mail delivery
    // succeeds (accounts/service.ts, revealSetPasswordToken): this fixture
    // mirrors that, not just this component's own rendering choice.
    const html = render(
      <SetPasswordLinkField
        id="test-link"
        result={{ ...base, setPasswordToken: null, mailOutcome: "sent" }}
        link={LINK}
      />,
    );
    expect(html).not.toContain(LINK);
    expect(html).toContain("A message with this link was sent to jane.doe@contoso.example.");
  });

  it("shows the copyable link when mail was never configured", () => {
    const html = render(
      <SetPasswordLinkField
        id="test-link"
        result={{ ...base, setPasswordToken: "raw-token", mailOutcome: "not_configured" }}
        link={LINK}
      />,
    );
    expect(html).toContain(LINK);
  });

  it("puts the username to copy next to a link that is handed over, never next to a mailed one", () => {
    const handedOver = render(
      <SetPasswordLinkField
        id="test-link"
        result={{ ...base, setPasswordToken: "raw-token", mailOutcome: "not_configured" }}
        link={LINK}
      />,
    );
    expect(handedOver).toContain('id="test-link-username"');
    expect(handedOver).toContain('value="jane.doe@contoso.example"');
    expect(handedOver).toContain("Copy username");
    const mailed = render(
      <SetPasswordLinkField
        id="test-link"
        result={{ ...base, setPasswordToken: null, mailOutcome: "sent" }}
        link={LINK}
      />,
    );
    expect(mailed).not.toContain("test-link-username");
  });

  it("shows the copyable link when mail delivery failed", () => {
    const html = render(
      <SetPasswordLinkField
        id="test-link"
        result={{ ...base, setPasswordToken: "raw-token", mailOutcome: "failed" }}
        link={LINK}
      />,
    );
    expect(html).toContain(LINK);
  });
});
