import type * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import { i18n } from "@/i18n";

import type { Failure } from "./api";
import { CauseLine, ItemCauseLines } from "./cause-line";
import { FailureExplanation, type FailureExplanationProps } from "./failure-explanation";

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    Link: ({
      to,
      search,
      className,
      children,
    }: {
      to: string;
      search?: Record<string, string>;
      className?: string;
      children: React.ReactNode;
    }) => (
      <a
        href={search ? `${to}?${new URLSearchParams(search).toString()}` : to}
        className={className}
      >
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

function render(node: React.ReactNode): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <TooltipProvider>{node}</TooltipProvider>
    </I18nextProvider>,
  );
}

const DOCS = "https://docs.example.test/troubleshooting/";

function failure(overrides: Partial<Failure> = {}): Failure {
  return {
    code: "graph.permission_missing",
    category: "microsoft",
    transient: false,
    retryable: true,
    params: { permission: "Mail.ReadWrite", httpStatus: 403 },
    technical: {
      httpStatus: 403,
      errorCode: "Authorization_RequestDenied",
      requestId: "6d3c1f0e-aaaa-4bbb-8ccc-0123456789ab",
      clientRequestId: "client-1",
      serverDate: "2026-09-29T08:12:01",
      endpoint: "GET /v1.0/users/a@b.de/mailFolders",
      message: "Insufficient privileges to complete the operation.",
    },
    occurredAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    step: "enumerate",
    retry: null,
    steps: [
      { id: "grant_permission", target: "source" },
      { id: "verify_permissions", target: "source" },
    ],
    docsUrl: DOCS,
    ...overrides,
  };
}

function explanation(props: Partial<FailureExplanationProps> = {}): string {
  return render(
    <FailureExplanation
      failure={failure()}
      subject={{ kind: "job", queue: "Backup", object: "Alice" }}
      sourceId="src-1"
      {...props}
    />,
  );
}

describe("FailureExplanation", () => {
  it("answers what happened, why and what to do", () => {
    const html = explanation({ affectedItems: 4 });
    // The headline is the cause.
    expect(html).toContain("The Restow app is missing a Microsoft 365 permission");
    // What happened: the object, the job, when, the step and the number of items.
    expect(html).toContain("What happened");
    expect(html).toContain("Backup for Alice failed 5 minutes ago.");
    expect(html).toContain("It stopped during the step:");
    expect(html).toContain("4 items were affected.");
    // Why, naming the permission.
    expect(html).toContain("The call needs the application permission Mail.ReadWrite");
    // What to do: the concrete steps, linked to the right place, and the docs.
    expect(html).toContain("Add the application permission Mail.ReadWrite to the Restow app");
    expect(html).toContain('href="/sources/src-1"');
    expect(html).toContain("Open the source");
    expect(html).toContain(`href="${DOCS}"`);
    expect(html).toContain("Troubleshooting guide");
  });

  it("keeps the technical details for a support case, redacted values as delivered", () => {
    const html = explanation();
    expect(html).toContain("<details");
    expect(html).toContain("Technical details");
    expect(html).toContain("Request ID");
    expect(html).toContain("6d3c1f0e-aaaa-4bbb-8ccc-0123456789ab");
    expect(html).toContain("Client request ID");
    expect(html).toContain("Time reported by the server");
    expect(html).toContain("GET /v1.0/users/a@b.de/mailFolders");
    expect(html).toContain("graph.permission_missing");
    expect(html).toContain("Copy details for support");
  });

  it("sends steps to Settings > Microsoft 365 with the right section", () => {
    const html = explanation({
      failure: failure({
        code: "graph.app_credentials_invalid",
        params: { reason: "secret_expired" },
        steps: [{ id: "check_app_credentials", target: "settings_microsoft" }],
      }),
    });
    expect(html).toContain('href="/settings?section=microsoft365"');
    expect(html).toContain("The client secret of the Restow app registration has expired.");
  });

  it("says Restow retries by itself, with attempt and time, and offers no retry button", () => {
    const html = explanation({
      retrying: true,
      onRetry: () => {},
      failure: failure({
        code: "graph.throttled",
        transient: true,
        params: { retryAfterSeconds: 32 },
        retry: { attempt: 2, limit: 6, nextAttemptAt: "2026-09-29T10:03:00.000Z" },
        steps: [{ id: "wait_throttled", target: null }],
        technical: { httpStatus: 429 },
      }),
    });
    expect(html).toContain("An attempt of Backup for Alice failed");
    expect(html).toContain("Attempt 2 of 6 failed. Restow tries again around");
    expect(html).toContain("asked Restow to wait 32 seconds");
    expect(html).toContain("Nothing to do. Restow waits as long as Microsoft asks");
    expect(html).not.toContain("Retry now");
    // A failure Restow is retrying itself is a warning, not an error.
    expect(html).toContain('data-variant="warning"');
  });

  it("offers Retry now where a retry makes sense", () => {
    expect(explanation({ onRetry: () => {} })).toContain("Retry now");
    expect(explanation({ onRetry: null })).not.toContain("Retry now");
    expect(
      explanation({ onRetry: () => {}, failure: failure({ retryable: false }) }),
    ).not.toContain("Retry now");
    expect(explanation({ onRetry: () => {} })).toContain('data-variant="destructive"');
  });

  it("falls back to the recorded message for a row from before causes were kept", () => {
    const html = explanation({
      failure: null,
      message: "GraphError: Graph GET failed with 403 (ErrorAccessDenied)",
      docsUrl: DOCS,
      at: new Date(Date.now() - 3_600_000).toISOString(),
      onRetry: () => {},
    });
    expect(html).toContain("The cause could not be identified");
    expect(html).toContain("before Restow kept structured causes");
    expect(html).toContain("GraphError: Graph GET failed with 403 (ErrorAccessDenied)");
    expect(html).toContain("Backup for Alice failed 1 hour ago.");
    expect(html).toContain(`href="${DOCS}"`);
    expect(html).toContain("Retry now");
  });

  it("shows an unclassified error's message right away and its details, never nothing", () => {
    const html = explanation({
      failure: failure({
        code: "unknown",
        params: {},
        technical: { errorName: "RangeError", message: "something odd happened" },
        steps: [{ id: "read_technical_details", target: null }],
      }),
      message: "RangeError: something odd happened",
    });
    expect(html).toContain("The cause could not be identified");
    expect(html).toContain("RangeError: something odd happened");
    expect(html).toContain("Error type");
    expect(html).toContain("The technical details below show the exact answer.");
  });

  it("copes with a code from a newer server: generic text, its details, no steps", () => {
    const html = explanation({
      failure: failure({
        code: "future.thing",
        category: null,
        params: {},
        steps: [],
        technical: { message: "from the future", futureField: "x" },
      }),
    });
    expect(html).toContain("The cause could not be identified");
    expect(html).toContain("future.thing");
    expect(html).toContain("from the future");
    expect(html).toContain("futureField");
  });

  it("hides the what-happened sentence when the page already says it", () => {
    const html = explanation({ hideWhat: true });
    expect(html).not.toContain("What happened");
    expect(html).toContain("Why");
  });

  it("speaks German", async () => {
    await i18n.changeLanguage("de");
    const html = explanation({ onRetry: () => {}, affectedItems: 1 });
    expect(html).toContain("Der App von Restow fehlt eine Microsoft-365-Berechtigung");
    expect(html).toContain("Was passiert ist");
    expect(html).toContain("Backup für Alice ist vor 5 Minuten fehlgeschlagen.");
    expect(html).toContain("1 Element war betroffen.");
    expect(html).toContain("Was zu tun ist");
    expect(html).toContain("Quelle öffnen");
    expect(html).toContain("Jetzt erneut versuchen");
    expect(html).toContain("Technische Details");
    expect(html).toContain("Anleitung zur Fehlersuche");
  });

  it("names a source, a sync and a login test in their own words", () => {
    const at = { failure: failure({ code: "imap.auth_failed", params: {}, steps: [] }) };
    expect(explanation({ ...at, subject: { kind: "source", name: "Mail server" } })).toContain(
      "The connection to Mail server is broken",
    );
    expect(explanation({ ...at, subject: { kind: "sync", name: "Contoso" } })).toContain(
      "The last directory sync of Contoso failed",
    );
    expect(
      explanation({ ...at, subject: { kind: "credential", name: "anna@example.test" } }),
    ).toContain("The login test for anna@example.test failed");
    expect(explanation({ ...at, subject: { kind: "item", item: "mail/Inbox/1.eml" } })).toContain(
      "The item mail/Inbox/1.eml could not be processed",
    );
  });
});

describe("CauseLine and ItemCauseLines", () => {
  it("states the headline of the cause with the explanation as a tooltip", () => {
    const html = render(<CauseLine failure={failure({ code: "graph.item_too_large" })} />);
    expect(html).toContain("The item is too large for Microsoft Graph");
    expect(html).toContain('data-cause="graph.item_too_large"');
  });

  it("reads an unknown code as unidentified rather than showing the code", () => {
    const html = render(<CauseLine failure={failure({ code: "future.thing" })} />);
    expect(html).toContain("The cause could not be identified");
  });

  it("lists how many items share each cause", () => {
    const html = render(
      <ItemCauseLines
        causes={[
          { code: "graph.item_too_large", count: 12 },
          { code: "graph.item_unreadable", count: 1 },
        ]}
      />,
    );
    expect(html).toContain("12 items: The item is too large for Microsoft Graph");
    expect(html).toContain("1 item: The item is damaged or unreadable at Microsoft");
    expect(render(<ItemCauseLines causes={[]} />)).toBe("");
  });
});
