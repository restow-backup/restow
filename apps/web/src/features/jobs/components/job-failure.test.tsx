import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import type { Failure } from "@/features/failures";
import type { JobDetail } from "@/features/jobs/api";
import { useJobFormat } from "@/features/jobs/use-format";
import { i18n } from "@/i18n";

import "@/features/jobs/i18n";
import { JobCause } from "./job-cause";
import { FailureGroupsCard, JobFailure } from "./job-failure";

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    Link: ({
      to,
      className,
      children,
    }: { to: string; className?: string; children: React.ReactNode }) => (
      <a href={to} className={className}>
        {children}
      </a>
    ),
  };
});

vi.mock("@/lib/session", () => ({
  useSession: () => ({ status: "authenticated", activeTenant: { id: "t-1", name: "Contoso" } }),
}));

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

function failure(overrides: Partial<Failure> = {}): Failure {
  return {
    code: "graph.access_denied",
    category: "microsoft",
    transient: false,
    retryable: true,
    params: { permission: "Mail.ReadWrite" },
    technical: { httpStatus: 403, requestId: "req-1" },
    occurredAt: new Date(Date.now() - 120_000).toISOString(),
    step: "enumerate",
    retry: null,
    steps: [
      { id: "verify_permissions", target: "source" },
      { id: "exclude_object", target: "directory" },
    ],
    docsUrl: "https://docs.example.test/troubleshooting/",
    ...overrides,
  };
}

function job(overrides: Partial<JobDetail> = {}): JobDetail {
  return {
    id: "job-1",
    queue: "backup",
    status: "failed",
    protectedObjectId: "o-1",
    object: {
      id: "o-1",
      sourceId: "src-9",
      kind: "mailbox",
      displayName: "Alice",
      externalId: "alice@example.test",
      status: "active",
    },
    scheduleId: null,
    full: false,
    createdAt: "2026-09-29T09:00:00.000Z",
    updatedAt: "2026-09-29T09:05:00.000Z",
    startedAt: "2026-09-29T09:00:10.000Z",
    completedAt: "2026-09-29T09:05:00.000Z",
    errorMessage: "GraphError: Graph GET failed with 403 (ErrorAccessDenied)",
    failure: failure(),
    progress: { total: 10, done: 6, failed: 3, bytes: 100, etaSeconds: null, updatedAt: "" },
    phase: null,
    throttle: null,
    cancellable: false,
    retryable: true,
    failures: [],
    failureCount: 0,
    snapshot: null,
    result: null,
    ...overrides,
  };
}

function Formatted({
  children,
}: { children: (format: ReturnType<typeof useJobFormat>) => React.ReactNode }) {
  return <>{children(useJobFormat())}</>;
}

function render(node: React.ReactNode): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <I18nextProvider i18n={i18n}>
        <TooltipProvider>{node}</TooltipProvider>
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

const noop = () => {};

describe("JobFailure", () => {
  const view = (job: JobDetail) =>
    render(
      <Formatted>
        {(format) => <JobFailure job={job} format={format} onRetried={noop} />}
      </Formatted>,
    );

  it("explains a failed job: what happened, why and what to do, with retry and the source link", () => {
    const html = view(job());
    expect(html).toContain("Microsoft denied access to this mailbox or drive");
    expect(html).toContain("Backup for Alice failed 2 minutes ago.");
    expect(html).toContain("3 items were affected.");
    expect(html).toContain("the Restow app lacks the permission Mail.ReadWrite");
    // Steps link to the source of this very mailbox and to the protected objects.
    expect(html).toContain('href="/sources/src-9"');
    expect(html).toContain('href="/protected-objects"');
    expect(html).toContain("Retry now");
    expect(html).toContain("req-1");
  });

  it("shows the earlier attempt of a job that is queued again, without a retry button", () => {
    const html = view(
      job({
        status: "queued",
        completedAt: null,
        retryable: false,
        failure: failure({
          code: "graph.service_unavailable",
          transient: true,
          steps: [{ id: "wait_automatic", target: null }],
          retry: { attempt: 2, limit: 6, nextAttemptAt: "2026-09-29T09:08:00.000Z" },
        }),
      }),
    );
    expect(html).toContain("An attempt of Backup for Alice failed");
    expect(html).toContain("Attempt 2 of 6 failed. Restow tries again around");
    expect(html).not.toContain("Retry now");
  });

  it("still shows a failed job from before causes were kept, with its message", () => {
    const html = view(
      job({ failure: null, docsUrl: "https://docs.example.test/troubleshooting/" }),
    );
    expect(html).toContain("The cause could not be identified");
    expect(html).toContain("GraphError: Graph GET failed with 403 (ErrorAccessDenied)");
    expect(html).toContain("Troubleshooting guide");
    expect(html).toContain("Retry now");
  });

  it("shows nothing for a job that did well, was cancelled or is simply running", () => {
    expect(view(job({ status: "completed", failure: null, errorMessage: null }))).toBe("");
    expect(view(job({ status: "cancelled", failure: null, errorMessage: null }))).toBe("");
    expect(view(job({ status: "active", failure: null, errorMessage: null }))).toBe("");
  });

  it("does not offer a retry the API refuses", () => {
    expect(view(job({ retryable: false }))).not.toContain("Retry now");
  });
});

describe("FailureGroupsCard", () => {
  it("groups the failed items by cause, each explained once", () => {
    const html = render(
      <FailureGroupsCard
        job={job({
          status: "completed",
          failureGroups: [
            {
              count: 12,
              failure: failure({
                code: "graph.item_too_large",
                params: {},
                steps: [{ id: "item_stays_failed", target: null }],
              }),
            },
            {
              count: 1,
              failure: failure({
                code: "graph.item_unreadable",
                steps: [{ id: "open_item_at_source", target: null }],
              }),
            },
          ],
        })}
      />,
    );
    expect(html).toContain("Failed items by cause");
    expect(html).toContain("12 items");
    expect(html).toContain("The item is too large for Microsoft Graph");
    expect(html).toContain("1 item");
    expect(html).toContain("The item is damaged or unreadable at Microsoft");
    expect(html).toContain("Nothing to do for the backup as a whole.");
    // The page already said what happened; the groups only explain.
    expect(html).not.toContain("What happened");
  });

  it("renders nothing without groups (older servers, only unclassified failures)", () => {
    expect(render(<FailureGroupsCard job={job({ failureGroups: [] })} />)).toBe("");
    expect(render(<FailureGroupsCard job={job({ failureGroups: undefined })} />)).toBe("");
  });
});

describe("JobCause", () => {
  it("gives a failed job's cause in one line", () => {
    const html = render(<JobCause job={job()} />);
    expect(html).toContain("Microsoft denied access to this mailbox or drive");
  });

  it("says Restow retries by itself while a failed attempt waits", () => {
    const html = render(
      <JobCause
        job={job({
          status: "queued",
          failure: failure({ retry: { attempt: 1, limit: 6, nextAttemptAt: null } }),
        })}
      />,
    );
    expect(html).toContain("Restow retries automatically");
  });

  it("lists the causes behind the failed items of a finished job", () => {
    const html = render(
      <JobCause
        job={job({
          status: "completed",
          failure: null,
          errorMessage: null,
          itemCauses: [{ code: "graph.item_too_large", count: 12 }],
        })}
      />,
    );
    expect(html).toContain("12 items: The item is too large for Microsoft Graph");
  });

  it("falls back to the recorded message of an old failed row, and is silent otherwise", () => {
    const old = render(<JobCause job={job({ failure: null })} />);
    expect(old).toContain("GraphError: Graph GET failed with 403");
    expect(
      render(<JobCause job={job({ status: "completed", failure: null, errorMessage: null })} />),
    ).toBe("");
  });
});
