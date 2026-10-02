// @vitest-environment happy-dom
import type * as React from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { i18n } from "@/i18n";

import type { CreatedToken, EnrollmentToken } from "../api.js";
import { type Mounted, mount } from "../dom-harness.js";
import "../i18n.js";
import { EnrollDialog, defaultOs, enrollStatusOf, isSelectableOs } from "./enroll-dialog.js";

vi.mock("@/lib/session", () => ({
  useSession: () => ({ status: "authenticated", activeTenant: { id: "t-1", name: "Contoso" } }),
}));
// Dialogs render in place, and links are plain anchors, so no router or portal target is needed.
vi.mock("radix-ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("radix-ui")>();
  const InPlacePortal = ({ children }: { children?: unknown }) => children;
  return { ...actual, Dialog: { ...actual.Dialog, Portal: InPlacePortal } };
});
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    Link: ({
      to,
      className,
      children,
      ...props
    }: { to: string; className?: string; children: React.ReactNode }) => (
      <a href={String(to)} className={className} {...props}>
        {children}
      </a>
    ),
  };
});

const createToken = vi.fn();
const fetchTokens = vi.fn();
vi.mock("../api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api.js")>();
  return {
    ...actual,
    createToken: (...args: unknown[]) => createToken(...args),
    fetchTokens: (...args: unknown[]) => fetchTokens(...args),
  };
});

const SECRET = "rset_TOPSECRETVALUE";
const INSTALL = "curl -fsSL 'https://restow.example/install/linux.sh' | sudo sh";
const UNATTENDED =
  "curl -fsSL 'https://restow.example/install/linux.sh' | sudo RESTOW_TOKEN_FILE=/root/restow-enrollment.token sh";

function created(over: Partial<CreatedToken> = {}): CreatedToken {
  return {
    id: "tok-1",
    profile: "server",
    displayName: null,
    createdAt: "2026-09-30T10:00:00.000Z",
    expiresAt: "2026-10-01T10:00:00.000Z",
    state: "valid",
    usedByEndpointId: null,
    token: SECRET,
    os: "linux",
    instanceUrl: "https://restow.example",
    commands: {
      install: INSTALL,
      installUnattended: UNATTENDED,
      tokenFile: "/root/restow-enrollment.token",
      uninstallScript:
        "curl -fsSL 'https://restow.example/install/linux.sh' | sudo sh -s -- --uninstall",
      uninstallAgent: "sudo '/opt/restow-agent/bin/restow-agent' uninstall",
      hooksScripts: "sudo '/opt/restow-agent/bin/restow-agent' hooks scripts",
      hooksAny: "sudo '/opt/restow-agent/bin/restow-agent' hooks any",
    },
    warnings: [],
    ...over,
  };
}

function token(over: Partial<EnrollmentToken> = {}): EnrollmentToken {
  return {
    id: "tok-1",
    profile: "server",
    displayName: null,
    createdAt: "2026-09-30T10:00:00.000Z",
    expiresAt: "2026-10-01T10:00:00.000Z",
    state: "valid",
    usedByEndpointId: null,
    ...over,
  };
}

/** Everything a storage holds, as one string; empty when the environment offers none. */
function storedValues(storage: unknown): string {
  try {
    const area = storage as Storage;
    let all = "";
    for (let index = 0; index < area.length; index += 1) {
      const key = area.key(index);
      all += `${key}=${key === null ? "" : area.getItem(key)};`;
    }
    return all;
  } catch {
    return "";
  }
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

describe("the wizard's rules", () => {
  it("offers Linux and macOS and keeps Windows planned", () => {
    expect(isSelectableOs("linux")).toBe(true);
    expect(isSelectableOs("darwin")).toBe(true);
    expect(isSelectableOs("windows")).toBe(false);
  });

  it("proposes the system a new machine of each kind most likely runs", () => {
    expect(defaultOs("server")).toBe("linux");
    expect(defaultOs("client")).toBe("darwin");
  });

  it("reads a token's state as waiting, connected, expired or revoked", () => {
    expect(enrollStatusOf("valid")).toBe("waiting");
    expect(enrollStatusOf("used")).toBe("connected");
    expect(enrollStatusOf("expired")).toBe("expired");
    expect(enrollStatusOf("revoked")).toBe("revoked");
  });
});

describe("EnrollDialog", () => {
  let page: Mounted;

  beforeEach(() => {
    createToken.mockReset();
    fetchTokens.mockReset();
    fetchTokens.mockResolvedValue([]);
  });
  afterEach(() => {
    page?.unmount();
  });

  async function open(profile: "server" | "client" = "server") {
    page = mount();
    await page.render(<EnrollDialog open onOpenChange={() => {}} profile={profile} />);
    await page.settle();
  }

  async function create() {
    await page.click(page.byText("button", "Create install command"));
    await page.settle();
  }

  it("asks for the system first, with Windows disabled and labelled as planned", async () => {
    await open();
    const radios = [...document.querySelectorAll<HTMLButtonElement>('button[role="radio"]')];
    expect(radios).toHaveLength(3);
    const byValue = Object.fromEntries(radios.map((radio) => [radio.value, radio]));
    expect(byValue.linux?.disabled).toBe(false);
    expect(byValue.darwin?.disabled).toBe(false);
    expect(byValue.windows?.disabled).toBe(true);
    expect(page.text()).toContain("Planned");
    expect(page.text()).toContain("Windows is on the roadmap");
    expect(page.text()).toContain("does not create disk images");
    // Nothing was created yet.
    expect(createToken).not.toHaveBeenCalled();
  });

  it("does not let a click on the planned system choose it", async () => {
    await open();
    const windows = document.querySelector<HTMLButtonElement>(
      'button[role="radio"][value="windows"]',
    );
    await page.click(windows as HTMLButtonElement);
    expect(windows?.getAttribute("aria-checked")).toBe("false");
    expect(
      document.querySelector('button[role="radio"][value="linux"]')?.getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("creates the token for the chosen system and optional name, then shows the command once", async () => {
    createToken.mockResolvedValue(created({ displayName: "Mail", os: "darwin" }));
    await open();
    await page.click(document.querySelector('button[role="radio"][value="darwin"]') as HTMLElement);
    await page.type(document.getElementById("enroll-label") as HTMLInputElement, "  Mail  ");
    await create();
    expect(createToken).toHaveBeenCalledTimes(1);
    expect(createToken).toHaveBeenCalledWith({
      profile: "server",
      os: "darwin",
      displayName: "Mail",
    });
    expect(page.text()).toContain(INSTALL);
    expect(page.text()).toContain("Valid for 24 hours and single use.");
    expect(page.text()).toContain("shown only now");
    expect(page.text()).toContain("Waiting for the machine to connect");
  });

  it("sends no name when none was typed", async () => {
    createToken.mockResolvedValue(created());
    await open("client");
    await create();
    expect(createToken).toHaveBeenCalledWith({ profile: "client", os: "darwin" });
  });

  it("puts the command in a monospace box with a copy button", async () => {
    createToken.mockResolvedValue(created());
    await open();
    await create();
    const box = document.querySelector('[data-slot="command-box"]');
    expect(box?.querySelector("code")?.textContent).toBe(INSTALL);
    expect(box?.querySelector("code")?.className).toContain("font-mono");
    expect(box?.querySelector('button[aria-label="Copy the install command"]')).not.toBeNull();
  });

  it("shows the token apart from the command, which the installer asks for", async () => {
    createToken.mockResolvedValue(created());
    await open();
    await create();
    expect(INSTALL).not.toContain(SECRET);
    const token = document.querySelector('[data-slot="enroll-token"]');
    expect(token?.querySelector("code")?.textContent).toBe(SECRET);
    expect(token?.querySelector('button[aria-label="Copy the enrollment token"]')).not.toBeNull();
    expect(page.text()).toContain("When the installer asks for the enrollment token");
    expect(page.text()).toContain("neither in the shell history nor in the process list");
    expect(page.text()).toContain("--hooks=scripts");
    await page.click(page.byText("button", "Unattended installation (RMM, scripts)"));
    expect(page.text()).toContain(UNATTENDED);
    expect(page.text()).toContain("Delete the token file");
  });

  it("shows the uninstall commands and what the script does", async () => {
    createToken.mockResolvedValue(created());
    await open();
    await create();
    await page.click(page.byText("button", "Remove the agent later"));
    expect(page.text()).toContain("sudo '/opt/restow-agent/bin/restow-agent' uninstall");
    expect(page.text()).toContain("--uninstall");
    expect(page.text()).toContain("SHA-256");
    expect(page.text()).toContain("signature");
    expect(page.text()).toContain("systemd unit restow-agent");
    expect(page.text()).toContain("Running the command again repairs the installation");
  });

  it("warns about plain http and about an address that comes from the browser", async () => {
    createToken.mockResolvedValue(
      created({
        instanceUrl: "http://10.0.0.5:3000",
        warnings: ["insecure_transport", "instance_url_not_configured"],
      }),
    );
    await open();
    await create();
    const insecure = document.querySelector('[data-warning="insecure_transport"]');
    expect(insecure?.textContent).toContain("http://10.0.0.5:3000");
    expect(insecure?.textContent).toContain("unencrypted");
    const notConfigured = document.querySelector('[data-warning="instance_url_not_configured"]');
    expect(notConfigured?.textContent).toContain("taken from this browser");
    expect(notConfigured?.querySelector('a[href="/installation/server"]')).not.toBeNull();
  });

  it("shows no warning for a clean address", async () => {
    createToken.mockResolvedValue(created());
    await open();
    await create();
    expect(document.querySelector("[data-warning]")).toBeNull();
  });

  it("says Connected, with a link to the machine, when the token has been used", async () => {
    createToken.mockResolvedValue(created());
    fetchTokens.mockResolvedValue([token()]);
    await open();
    await create();
    expect(document.querySelector('[data-connection="waiting"]')).not.toBeNull();

    fetchTokens.mockResolvedValue([
      token({ state: "used", usedByEndpointId: "22222222-2222-4222-8222-222222222222" }),
    ]);
    await page.queryClient.invalidateQueries();
    await page.settle();
    const connected = document.querySelector('[data-connection="connected"]');
    expect(connected?.textContent).toContain("Connected");
    expect(
      connected?.querySelector('a[href="/inventory/22222222-2222-4222-8222-222222222222"]'),
    ).not.toBeNull();
    expect(document.querySelector('[data-connection="waiting"]')).toBeNull();
  });

  it("links a connected client to its page in the inventory", async () => {
    createToken.mockResolvedValue(created({ profile: "client" }));
    fetchTokens.mockResolvedValue([
      token({
        profile: "client",
        state: "used",
        usedByEndpointId: "33333333-3333-4333-8333-333333333333",
      }),
    ]);
    await open("client");
    await create();
    await page.settle();
    expect(
      document.querySelector('a[href="/inventory/33333333-3333-4333-8333-333333333333"]'),
    ).not.toBeNull();
  });

  it("says when the command expired unused and offers a new one", async () => {
    createToken.mockResolvedValue(created());
    fetchTokens.mockResolvedValue([token({ state: "expired" })]);
    await open();
    await create();
    await page.settle();
    const expired = document.querySelector('[data-connection="expired"]');
    expect(expired?.textContent).toContain("The command has expired");
    await page.click(page.byText("button", "Create a new command"));
    expect(page.text()).toContain("Create install command");
    expect(page.text()).not.toContain(INSTALL);
  });

  it("shows why a token could not be created", async () => {
    const { ApiError } = await import("@/lib/api");
    createToken.mockRejectedValue(
      new ApiError(
        422,
        {
          type: "urn:restow:problem:unsupported-os",
          title: "Operating system not supported",
          status: 422,
        },
        "x",
      ),
    );
    await open();
    await create();
    expect(page.text()).toContain("This operating system is not supported yet");
    expect(page.text()).toContain("Create install command");
  });

  it("drops the command when the dialog closes, and keeps the secret out of the URL and storage", async () => {
    createToken.mockResolvedValue(created());
    await open();
    await create();
    expect(page.text()).toContain(SECRET);
    expect(window.location.href).not.toContain(SECRET);
    expect(storedValues(localStorage)).not.toContain(SECRET);
    expect(storedValues(sessionStorage)).not.toContain(SECRET);

    await page.render(<EnrollDialog open={false} onOpenChange={() => {}} profile="server" />);
    await page.settle();
    expect(page.text()).not.toContain(SECRET);
    await page.render(<EnrollDialog open onOpenChange={() => {}} profile="server" />);
    await page.settle();
    expect(page.text()).not.toContain(SECRET);
    expect(page.text()).toContain("Create install command");
  });

  it("speaks German", async () => {
    await i18n.changeLanguage("de");
    try {
      await open();
      expect(page.text()).toContain("Geplant");
      expect(page.text()).toContain("Installationsbefehl erstellen");
    } finally {
      await i18n.changeLanguage("en");
    }
  });
});
