// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { Dialog, DialogContent } from "@/components/ui/dialog";
import { i18n } from "@/i18n";
import { type SetupState, queryKeys, setupStateQueryOptions } from "@/lib/api";

import type { Invitation, TeamMember } from "./api";
import { IssuedLinkResult, MemberDialog } from "./member-dialog";

/**
 * The member dialog of the Members page: the tenant scope offered only where
 * the installation enables `providerTeam.tenantScope` (locked otherwise, and
 * a limit from before kept as it is), and a link to hand over shown with the
 * username and on the installation's public URL, never the browser's address.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  apiFetch: vi.fn().mockResolvedValue([]),
}));

let features: string[] = [];
vi.mock("@/lib/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/session")>()),
  useSession: () => ({
    status: "authenticated",
    isProviderAdmin: true,
    providerRole: "owner",
    providerAllTenants: true,
    features,
    extensions: {},
  }),
}));

// Dialogs render in place, so no portal target is needed.
vi.mock("radix-ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("radix-ui")>();
  const InPlacePortal = ({ children }: { children?: unknown }) => children;
  return { ...actual, Dialog: { ...actual.Dialog, Portal: InPlacePortal } };
});

const TENANTS = [
  { id: "t-1", name: "Contoso", slug: "contoso" },
  { id: "t-2", name: "Fabrikam", slug: "fabrikam" },
];

let root: Root | null = null;
let host: HTMLElement | null = null;

async function render(node: ReactNode, publicUrl: string | null = null): Promise<void> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  });
  client.setQueryData(queryKeys.tenants, TENANTS);
  client.setQueryData(setupStateQueryOptions.queryKey, { publicUrl } as unknown as SetupState);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <I18nextProvider i18n={i18n}>
        <QueryClientProvider client={client}>{node}</QueryClientProvider>
      </I18nextProvider>,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  document.body.innerHTML = "";
});

const selectedOption = () =>
  document.getElementById("team-scope-selected") as HTMLButtonElement | null;

const limited: TeamMember = {
  userId: "u-2",
  name: "Tom Tech",
  email: "tom@provider.example",
  role: "technician",
  allTenants: false,
  tenantIds: ["t-1"],
  status: "active",
  isYou: false,
  addedAt: "2026-09-29T10:00:00.000Z",
};

describe("MemberDialog, the tenant scope", () => {
  it("offers chosen tenants where the installation enables them", async () => {
    features = ["providerTeam.tenantScope"];
    await render(<MemberDialog member={null} open onOpenChange={() => undefined} />);
    expect(selectedOption()?.disabled).toBe(false);
    expect(document.body.textContent).not.toContain("Every member has every tenant");
  });

  it("shows the choice locked elsewhere: every member has every tenant", async () => {
    features = [];
    await render(<MemberDialog member={null} open onOpenChange={() => undefined} />);
    expect(selectedOption()?.disabled).toBe(true);
    // No extension registered here: the core's own neutral note.
    expect(document.body.textContent).toContain(
      "Every member has every tenant in this installation.",
    );
  });

  it("keeps a limit from before as it is, without letting it be changed", async () => {
    features = [];
    await render(<MemberDialog member={limited} open onOpenChange={() => undefined} />);
    expect(selectedOption()?.disabled).toBe(false);
    expect(document.body.textContent).toContain("stays limited to the tenants chosen before");
    const contoso = document.getElementById("team-tenant-t-1") as HTMLButtonElement | null;
    expect(contoso?.getAttribute("data-state")).toBe("checked");
    expect(contoso?.disabled).toBe(true);
  });
});

describe("IssuedLinkResult", () => {
  const invitation: Invitation = {
    member: { ...limited, status: "invited" },
    setPasswordToken: "raw-token",
    linkExpiresAt: "2026-10-06T10:00:00.000Z",
    mailOutcome: "not_configured",
  };

  async function renderResult(publicUrl: string | null, result: Invitation = invitation) {
    await render(
      <Dialog open>
        <DialogContent>
          <IssuedLinkResult invitation={result} kind="reset" onDone={() => undefined} />
        </DialogContent>
      </Dialog>,
      publicUrl,
    );
  }

  it("builds the link on the installation's public URL and shows the username to copy", async () => {
    await renderResult("https://backup.example.com");
    const inputs = [...document.querySelectorAll("input")].map((input) => input.value);
    expect(inputs).toContain("tom@provider.example");
    expect(inputs).toContain("https://backup.example.com/accounts/set-password/raw-token");
    expect(document.body.textContent).toContain("Access reset");
    expect(document.body.textContent).toContain("Username");
  });

  it("shows nothing to copy once the link went out by email", async () => {
    await renderResult("https://backup.example.com", {
      ...invitation,
      setPasswordToken: null,
      mailOutcome: "sent",
    });
    expect(document.querySelectorAll("input")).toHaveLength(0);
    expect(document.body.textContent).toContain("tom@provider.example");
  });
});
