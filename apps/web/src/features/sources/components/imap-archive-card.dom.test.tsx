// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { i18n } from "@/i18n";

import "../i18n";
import type { SourceDto } from "../types";
import { ImapArchiveCard } from "./imap-archive-card";

/**
 * The archive setting of an IMAP source (docs/IMAP.md "Archivierung"): IMAP IDLE (`auto`) or
 * checks at intervals (`off`), saved at once with PATCH `archiveIdle`; locked without the
 * edition that archives from the mailbox.
 */

let features: string[] = ["archive.mailboxCapture"];
vi.mock("@/lib/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/session")>()),
  useSession: () => ({
    status: "authenticated",
    activeTenant: { id: "t-1", role: "tenant_admin" },
    isProviderAdmin: false,
    features,
  }),
}));

const apiFetch = vi.fn();
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, apiFetch: (path: string, init?: unknown) => apiFetch(path, init) };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function source(archiveIdle?: "auto" | "off"): SourceDto {
  return {
    id: "s-1",
    tenantId: "t-1",
    kind: "imap",
    name: "Mail host",
    status: "active",
    errorMessage: null,
    failure: null,
    lastSyncAt: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    m365: null,
    imap: {
      host: "imap.example.net",
      port: 993,
      security: "tls",
      username: "backup@example.net",
      hasPassword: true,
      authKind: "password",
      lastProbe: null,
      imapAuthMode: "shared",
      masterUser: null,
      ...(archiveIdle ? { archiveIdle } : {}),
    },
  } as SourceDto;
}

let container: HTMLDivElement;
let root: Root;

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  features = ["archive.mailboxCapture"];
  apiFetch.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(dto: SourceDto) {
  act(() => {
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <I18nextProvider i18n={i18n}>
          <ImapArchiveCard source={dto} />
        </I18nextProvider>
      </QueryClientProvider>,
    );
  });
}

const radio = (value: string) =>
  container.querySelector<HTMLButtonElement>(`[data-slot="archive-idle-${value}"] button`);

describe("ImapArchiveCard", () => {
  it("shows IDLE as the default and saves the switch to checks at intervals", async () => {
    apiFetch.mockResolvedValue(source("off"));
    render(source());
    expect(container.textContent).toContain("Automatic (IMAP IDLE)");
    expect(radio("auto")?.getAttribute("aria-checked")).toBe("true");
    expect(radio("off")?.getAttribute("aria-checked")).toBe("false");

    await act(async () => {
      radio("off")?.click();
    });
    expect(apiFetch).toHaveBeenCalledWith("/sources/s-1", {
      method: "PATCH",
      body: { archiveIdle: "off" },
    });
  });

  it("shows a stored choice and sends nothing when it is chosen again", async () => {
    render(source("off"));
    expect(radio("off")?.getAttribute("aria-checked")).toBe("true");
    await act(async () => {
      radio("off")?.click();
    });
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("is locked with the edition hint without archiving from the mailbox", async () => {
    features = [];
    render(source());
    expect(container.querySelector('[data-slot="archive-idle-edition"]')?.textContent).toContain(
      "Business",
    );
    expect(radio("off")?.disabled).toBe(true);
    await act(async () => {
      radio("off")?.click();
    });
    expect(apiFetch).not.toHaveBeenCalled();
  });
});
