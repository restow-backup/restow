import type * as React from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { render } from "@/components/kit/test-utils";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { Failure } from "@/features/failures/api";
import { i18n } from "@/i18n";

import "../i18n";
import type { ConnectionVerification, ImapProbeResult, SourceDto } from "../types";
import { PermissionsCard } from "./permissions-card";
import { SourceCard } from "./source-card";
import { SourceProblem } from "./source-problem";

/**
 * A source in error explains itself: the classified cause on the detail page
 * (what happened, why, what to do, docs link) and as one line on the list
 * card. Sources without a classified cause keep their old text exactly.
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

const SOURCE_ID = "7d8e9f00-1111-2222-3333-444455556666";
const DOCS = "https://docs.example.test/troubleshooting";

const consentMissing: Failure = {
  code: "graph.consent_missing",
  category: "microsoft",
  transient: false,
  retryable: true,
  params: {},
  technical: { httpStatus: 401, aadsts: "AADSTS700016" },
  occurredAt: "2026-09-22T10:06:00.000Z",
  step: null,
  retry: null,
  steps: [
    { id: "regrant_consent", target: "source" },
    { id: "check_app_credentials", target: "settings_microsoft" },
  ],
  docsUrl: DOCS,
};

const authFailed: Failure = {
  code: "imap.auth_failed",
  category: "imap",
  transient: false,
  retryable: true,
  params: { host: "imap.example.com" },
  technical: { imapResponse: "AUTHENTICATIONFAILED" },
  occurredAt: "2026-09-22T10:06:00.000Z",
  step: null,
  retry: null,
  steps: [{ id: "check_app_password", target: "source" }],
  docsUrl: DOCS,
};

function source(overrides: Partial<SourceDto> = {}): SourceDto {
  return {
    id: SOURCE_ID,
    tenantId: "0b3f6b2e-9c2d-4c3a-9e7f-1d2c3b4a5f60",
    kind: "m365",
    name: "Contoso",
    status: "error",
    errorMessage: "Token request failed",
    failure: null,
    lastSyncAt: null,
    createdAt: "2026-09-22T09:00:00.000Z",
    updatedAt: "2026-09-22T10:06:00.000Z",
    m365: {
      connectionMode: "consent",
      ownApp: null,
      entraTenantId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      entraTenantHint: null,
      consentGrantedAt: "2026-09-22T10:00:00.000Z",
      consentBy: null,
      consentError: null,
      permissions: null,
      verification: null,
    },
    imap: null,
    ...overrides,
  };
}

function imapSource(probe: ImapProbeResult | null, overrides: Partial<SourceDto> = {}): SourceDto {
  return source({
    kind: "imap",
    name: "Alice",
    m365: null,
    imap: {
      host: "imap.example.com",
      port: 993,
      security: "tls",
      username: "alice",
      hasPassword: true,
      authKind: "password",
      lastProbe: probe,
      imapAuthMode: "shared",
      masterUser: null,
    },
    ...overrides,
  });
}

const failedVerification: ConnectionVerification = {
  checkedAt: "2026-09-22T10:06:00.000Z",
  tokenAcquired: false,
  tokenError: {
    hint: "consent_missing",
    code: "invalid_client",
    aadsts: "AADSTS700016",
    status: 401,
    message: "Application not found",
  },
  permissions: null,
  testCall: null,
  ok: false,
};

function permissionsCard(s: SourceDto): string {
  return render(
    <PermissionsCard
      source={s}
      fresh={null}
      onVerify={() => {}}
      verifying={false}
      verifyError={null}
    />,
  );
}

describe("SourceProblem", () => {
  it("explains a classified cause: what happened, why, what to do, docs link", () => {
    const html = render(<SourceProblem source={source({ failure: consentMissing })} />);
    // The headline of the cause.
    expect(html).toContain("Microsoft 365 admin consent is missing or was withdrawn");
    // The three parts.
    expect(html).toContain("What happened");
    expect(html).toContain("The connection to Contoso is broken");
    expect(html).toContain("Microsoft does not recognise Restow");
    expect(html).toContain("What to do");
    // A step and the docs page; no link back to the page the operator is already on.
    expect(html).toContain("Create a new consent link for this source");
    expect(html).not.toContain(`href="/sources/${SOURCE_ID}"`);
    expect(html).not.toContain("Open the source");
    expect(html).toContain(`href="${DOCS}"`);
    expect(html).toContain("Troubleshooting guide");
    // Technical details stay available for a support case.
    expect(html).toContain("Technical details");
    expect(html).toContain("AADSTS700016");
  });

  it("replaces the plain error message: the recorded text is not shown as a second alert", () => {
    const html = render(<SourceProblem source={source({ failure: consentMissing })} />);
    expect(html).not.toContain("Last sync problem");
    expect(html).not.toContain("The last backup run of this source reported");
    // Only one alert for the source.
    expect(html.split('data-slot="alert"').length - 1).toBe(1);
  });

  it("explains an IMAP login failure the same way", () => {
    const html = render(
      <SourceProblem source={imapSource(null, { failure: authFailed, errorMessage: "auth" })} />,
    );
    expect(html).toContain("The IMAP server refused the login");
    expect(html).toContain("Check the username and the password in the source settings");
    expect(html).toContain("The connection to Alice is broken");
    expect(html).toContain(`href="${DOCS}"`);
  });

  it("speaks German", async () => {
    await i18n.changeLanguage("de");
    const html = render(<SourceProblem source={source({ failure: consentMissing })} />);
    expect(html).toContain("Die Administratorzustimmung für Microsoft 365 fehlt");
    expect(html).toContain("Was passiert ist");
    expect(html).toContain("Die Verbindung zu Contoso ist gestört");
    expect(html).toContain("Was zu tun ist");
    expect(html).toContain("Erstellen Sie für diese Quelle einen neuen Zustimmungslink");
    expect(html).toContain("Anleitung zur Fehlersuche");
    expect(html).not.toContain("What happened");
  });

  it("shows the recorded message of a cause this version cannot classify", () => {
    const html = render(
      <SourceProblem
        source={source({
          failure: { ...consentMissing, code: "from_the_future.something", steps: [] },
          errorMessage: "Something new broke",
        })}
      />,
    );
    expect(html).toContain("The cause could not be identified");
    expect(html).toContain("Something new broke");
  });

  it("keeps the old alert for a source without a classified cause", () => {
    const html = render(<SourceProblem source={source({ failure: null })} />);
    expect(html).toContain("Last sync problem");
    expect(html).toContain("The last backup run of this source reported: Token request failed");
    expect(html).not.toContain("What happened");
    expect(html).not.toContain("Technical details");
  });

  it("keeps the old alert in German", async () => {
    await i18n.changeLanguage("de");
    const html = render(<SourceProblem source={source({ failure: null })} />);
    expect(html).toContain("Token request failed");
    expect(html).not.toContain("Was passiert ist");
  });

  it("renders nothing, not an empty box, when there is nothing to say", () => {
    // Not in error.
    expect(render(<SourceProblem source={source({ status: "active", failure: null })} />)).toBe("");
    // A stale cause on a source that is fine again is not shown.
    expect(
      render(<SourceProblem source={source({ status: "active", failure: consentMissing })} />),
    ).toBe("");
    // In error without a cause or a message.
    expect(render(<SourceProblem source={source({ errorMessage: null })} />)).toBe("");
    // The check panels explain a failed check on their own.
    expect(
      render(
        <SourceProblem
          source={source({
            m365: {
              ...(source().m365 as NonNullable<SourceDto["m365"]>),
              verification: failedVerification,
            },
          })}
        />,
      ),
    ).toBe("");
  });
});

describe("SourceCard", () => {
  function card(s: SourceDto): string {
    return render(
      <TooltipProvider>
        <SourceCard source={s} />
      </TooltipProvider>,
    );
  }

  it("shows the cause of a broken source in one line under the status", () => {
    const html = card(source({ failure: consentMissing }));
    expect(html).toContain('data-cause="graph.consent_missing"');
    expect(html).toContain("Microsoft 365 admin consent is missing or was withdrawn");
    // A line, not a full explanation.
    expect(html).not.toContain("What to do");
  });

  it("shows the cause in German", async () => {
    await i18n.changeLanguage("de");
    const html = card(imapSource(null, { failure: authFailed }));
    expect(html).toContain('data-cause="imap.auth_failed"');
    expect(html).toContain("Der IMAP-Server hat die Anmeldung abgelehnt");
  });

  it("looks as before for a source without a classified cause", () => {
    const html = card(source({ failure: null }));
    expect(html).not.toContain("data-cause");
    expect(html).toContain("Permissions not verified yet");
    expect(html).toContain("Contoso");
  });

  it("does not show a cause on a source that is not in error", () => {
    expect(card(source({ status: "active", failure: consentMissing }))).not.toContain("data-cause");
  });
});

describe("PermissionsCard", () => {
  const withFailedCheck = (failure: Failure | null) =>
    source({
      failure,
      m365: {
        ...(source().m365 as NonNullable<SourceDto["m365"]>),
        verification: failedVerification,
      },
    });

  it("keeps the sign-in hint and code, but as a quiet note when the page explains the cause", () => {
    const html = permissionsCard(withFailedCheck(consentMissing));
    expect(html).toContain("No token could be acquired.");
    expect(html).toContain("The tenant has not consented to the backup app");
    expect(html).toContain("AADSTS700016");
    expect(html).toContain('data-variant="default"');
    expect(html).not.toContain('data-variant="destructive"');
  });

  it("keeps the sign-in hint as the red alert when nothing else explains it", () => {
    const html = permissionsCard(withFailedCheck(null));
    expect(html).toContain("The tenant has not consented to the backup app");
    expect(html).toContain('data-variant="destructive"');
  });
});
