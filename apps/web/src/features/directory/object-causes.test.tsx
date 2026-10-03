import type * as React from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { render } from "@/components/kit/test-utils";
import type { Failure } from "@/features/failures/api";
import { i18n } from "@/i18n";

import "./i18n";
import { CauseDetails, CredentialFailureExplanation } from "./object-causes";
import type { ProtectedObject } from "./types";

/**
 * The full explanation behind a failed login test (the popover content is
 * mounted on demand, so it is rendered directly here).
 */

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    Link: ({
      to,
      className,
      children,
    }: { to: string; className?: string; children: React.ReactNode }) => (
      <a href={String(to)} className={className}>
        {children}
      </a>
    ),
  };
});

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(async () => {
  await i18n.changeLanguage("en");
});

const DOCS = "https://docs.example.test/troubleshooting";

const authFailed: Failure = {
  code: "imap.auth_failed",
  category: "imap",
  transient: false,
  retryable: true,
  params: { host: "imap.example.com" },
  technical: { imapResponse: "AUTHENTICATIONFAILED", host: "imap.example.com" },
  occurredAt: "2026-09-28T04:00:00.000Z",
  step: null,
  retry: null,
  steps: [
    { id: "check_app_password", target: "source" },
    { id: "set_object_password", target: "directory" },
  ],
  docsUrl: DOCS,
};

const mailbox: ProtectedObject = {
  id: "o-1",
  sourceId: "s-9",
  sourceName: "Hoster",
  sourceKind: "imap",
  kind: "imap",
  origin: "manual",
  status: "active",
  externalId: "alice@hoster.example",
  displayName: "Alice",
  userId: null,
  email: "alice@hoster.example",
  upn: null,
  sharedOrBlocked: false,
  override: null,
  notSelected: false,
  lastBackupAt: null,
  snapshotCount: 0,
  legalHold: false,
  latestBackupJob: null,
  readiness: null,
  credential: {
    authMode: "per_mailbox",
    hasPassword: true,
    status: "failed",
    checkedAt: "2026-09-28T04:00:00.000Z",
    error: "Authentication failed for alice",
    errorReason: "auth",
    failure: authFailed,
  },
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};

describe("CredentialFailureExplanation", () => {
  it("explains the failed login: what happened, why, what to do, docs link", () => {
    const html = render(<CredentialFailureExplanation object={mailbox} failure={authFailed} />);
    expect(html).toContain("The IMAP server refused the login");
    expect(html).toContain("What happened");
    expect(html).toContain("The login test for Alice failed");
    expect(html).toContain("for imap.example.com");
    expect(html).toContain("What to do");
    expect(html).toContain("Check the username and the password in the source settings");
    expect(html).toContain('href="/sources/s-9"');
    expect(html).toContain("Set or correct the password of this account");
    expect(html).toContain(`href="${DOCS}"`);
  });

  it("keeps the recorded server text among the technical details", () => {
    const html = render(<CredentialFailureExplanation object={mailbox} failure={authFailed} />);
    expect(html).toContain("Technical details");
    expect(html).toContain("AUTHENTICATIONFAILED");
    expect(html).toContain("Authentication failed for alice");
  });

  it("speaks German", async () => {
    await i18n.changeLanguage("de");
    const html = render(<CredentialFailureExplanation object={mailbox} failure={authFailed} />);
    expect(html).toContain("Der IMAP-Server hat die Anmeldung abgelehnt");
    expect(html).toContain("Der Anmeldetest für Alice ist");
    expect(html).toContain("Was zu tun ist");
    expect(html).toContain("Prüfen Sie Benutzername und Passwort in den Quelleneinstellungen");
    expect(html).not.toContain("What happened");
  });
});

describe("CauseDetails", () => {
  it("is a button that names the cause and opens the explanation", () => {
    const html = render(
      <CauseDetails failure={authFailed}>
        <p>explanation</p>
      </CauseDetails>,
    );
    expect(html).toContain("<button");
    expect(html).toContain('data-cause="imap.auth_failed"');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("The IMAP server refused the login");
    // Closed: the explanation is not mounted yet.
    expect(html).not.toContain("explanation");
  });

  it("names the cause in German", async () => {
    await i18n.changeLanguage("de");
    const html = render(
      <CauseDetails failure={authFailed}>
        <p>explanation</p>
      </CauseDetails>,
    );
    expect(html).toContain("Der IMAP-Server hat die Anmeldung abgelehnt");
  });
});
