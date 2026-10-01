import type * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it } from "vitest";

import { i18n } from "@/i18n";

import "@/features/accounts/i18n";
import "../i18n";
import type { ProvisionResult } from "@/features/accounts/types";

import { Dialog } from "@/components/ui/dialog";

import { InviteDialogHeader, InvitedStep } from "./invite-member-dialog";

/**
 * The invite dialog's "provisioned" step never says the person cannot sign
 * in: everyone leaves it able to sign in, whether that took a fresh link or
 * they already had a way in. Rendered to static markup with the link passed
 * in directly, so it needs no query client or router (same style as
 * ../components.test.tsx).
 */

function render(node: React.ReactNode): string {
  return renderToStaticMarkup(<I18nextProvider i18n={i18n}>{node}</I18nextProvider>);
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

const newAccount: ProvisionResult = {
  userId: "user-1",
  email: "jane.doe@contoso.example",
  name: "Jane Doe",
  role: "tenant_user",
  created: true,
  linkIssued: true,
  linkExpiresAt: "2026-09-27T10:00:00.000Z",
  // Mail delivery failed, not "sent": the server only ever hands the token
  // back (accounts/service.ts, revealSetPasswordToken) when it could not
  // also mail it, and this fixture's tests below rely on the field being
  // shown.
  setPasswordToken: "does-not-matter-here",
  mailOutcome: "failed",
};

const reusedAccount: ProvisionResult = {
  ...newAccount,
  created: false,
  mailOutcome: "not_configured",
};

/** Already had a way to sign in: no link is issued, only the membership changes. */
const alreadySignedInAccount: ProvisionResult = {
  ...newAccount,
  created: false,
  linkIssued: false,
  linkExpiresAt: null,
  setPasswordToken: null,
  mailOutcome: "not_configured",
};

const FORBIDDEN_PHRASES = [
  "cannot sign in",
  "can't sign in",
  "no way to sign in",
  "nicht anmelden",
];

function assertNeverSaysCannotSignIn(html: string) {
  const lower = html.toLowerCase();
  for (const phrase of FORBIDDEN_PHRASES) {
    expect(lower, phrase).not.toContain(phrase);
  }
}

describe("InvitedStep", () => {
  it("never says the person cannot sign in, for a new account", () => {
    const html = render(
      <InvitedStep
        result={newAccount}
        link="https://restow.example.com/accounts/set-password/abc123"
        microsoftSignIn={false}
        onAnother={() => {}}
        onDone={() => {}}
      />,
    );
    assertNeverSaysCannotSignIn(html);
    expect(html).toContain("https://restow.example.com/accounts/set-password/abc123");
  });

  it("never says the person cannot sign in, for a reused account, and mentions the mail was not sent", () => {
    const html = render(
      <InvitedStep
        result={reusedAccount}
        link="https://restow.example.com/accounts/set-password/def456"
        microsoftSignIn={false}
        onAnother={() => {}}
        onDone={() => {}}
      />,
    );
    assertNeverSaysCannotSignIn(html);
    expect(html).toContain("https://restow.example.com/accounts/set-password/def456");
    expect(html).toContain(
      "No mail transport is configured, so the link was not emailed. Copy it and pass it on yourself.",
    );
  });

  it("never says the person cannot sign in when they already had a way in, and shows no link", () => {
    const html = render(
      <InvitedStep
        result={alreadySignedInAccount}
        link=""
        microsoftSignIn={false}
        onAnother={() => {}}
        onDone={() => {}}
      />,
    );
    assertNeverSaysCannotSignIn(html);
    expect(html).not.toContain("set-password");
  });

  it("mentions Microsoft sign-in as an extra only when this installation offers it", () => {
    const withMicrosoft = render(
      <InvitedStep
        result={newAccount}
        link="https://restow.example.com/accounts/set-password/abc123"
        microsoftSignIn={true}
        onAnother={() => {}}
        onDone={() => {}}
      />,
    );
    const withoutMicrosoft = render(
      <InvitedStep
        result={newAccount}
        link="https://restow.example.com/accounts/set-password/abc123"
        microsoftSignIn={false}
        onAnother={() => {}}
        onDone={() => {}}
      />,
    );
    expect(withMicrosoft).toContain("Microsoft");
    expect(withoutMicrosoft).not.toContain("Microsoft");
    assertNeverSaysCannotSignIn(withMicrosoft);
  });
});

/**
 * The dialog header must never claim a link is ready when nothing was
 * issued: it switches on `result.linkIssued`, not on whether a result exists
 * at all.
 */
describe("InviteDialogHeader", () => {
  // DialogTitle/DialogDescription are Radix primitives that need a Dialog
  // root's context, unlike the plain-div DialogFooter InvitedStep renders.
  function renderHeader(node: React.ReactNode): string {
    return render(<Dialog open>{node}</Dialog>);
  }

  it("shows the tenant's own invite title before anything is submitted", () => {
    const html = renderHeader(<InviteDialogHeader provisioned={null} tenantName="Contoso" />);
    expect(html).toContain("Contoso");
    expect(html).not.toContain("Sign-in link ready");
    expect(html).not.toContain("Added to this tenant");
  });

  it("says the link is ready when one was actually issued", () => {
    const html = renderHeader(<InviteDialogHeader provisioned={newAccount} tenantName="Contoso" />);
    expect(html).toContain("Sign-in link ready");
    expect(html).not.toContain("Added to this tenant");
  });

  it("never claims a link is ready when none was issued", () => {
    const html = renderHeader(
      <InviteDialogHeader provisioned={alreadySignedInAccount} tenantName="Contoso" />,
    );
    expect(html).toContain("Added to this tenant");
    expect(html).not.toContain("Sign-in link ready");
  });
});
