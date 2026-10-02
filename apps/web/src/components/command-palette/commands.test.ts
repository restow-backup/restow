import { defaultFilter } from "cmdk";
import { Building2, LayoutDashboard, ListChecks, Settings } from "lucide-react";
import { describe, expect, it } from "vitest";

import type { NavItem, NavLock } from "@/lib/navigation";
import { canAccess } from "@/lib/session";
import type { SessionTenant } from "@/lib/session";

import {
  type PaletteCommand,
  type PaletteGroup,
  type PaletteInput,
  buildPaletteGroups,
  commandValue,
  objectGroup,
} from "./commands.js";
import { ariaShortcut, isApplePlatform, isModifierShortcut, shortcutKeys } from "./shortcut.js";

/** Keys come back as-is, with interpolated values appended, so tests can read them. */
const t = (key: string, options?: Record<string, unknown>) =>
  options ? `${key}(${Object.values(options).join(",")})` : key;

/** A lock as an extension supplies it: closed unless the profile carries `unlocked: true`. */
const tenantsLock: NavLock = {
  isLocked: (context) => context.extensions?.unlocked !== true,
  to: "/settings",
  search: { section: "about" },
  hintKey: "x:locked",
};

const navItems: NavItem[] = [
  {
    id: "dashboard",
    path: "/",
    labelKey: "dashboard:nav",
    icon: LayoutDashboard,
    exact: true,
    group: "daily",
  },
  {
    id: "history",
    path: "/history",
    labelKey: "backup:nav.history",
    icon: ListChecks,
    roles: ["provider_admin", "tenant_admin"],
    group: "daily",
  },
  { id: "restore", path: "/restore", labelKey: "restore:nav", icon: ListChecks, group: "mail" },
  {
    id: "tenants",
    path: "/tenants",
    labelKey: "tenants:nav",
    icon: Building2,
    roles: ["provider_admin"],
    lock: tenantsLock,
    group: "tenants",
  },
  {
    id: "settings",
    path: "/settings",
    labelKey: "settings:nav",
    icon: Settings,
    roles: ["provider_admin"],
    group: "installation",
  },
];

const tenants: SessionTenant[] = [
  {
    id: "contoso",
    name: "Contoso",
    slug: "contoso",
    kind: "customer",
    customerNumber: null,
    role: "tenant_admin",
    status: "active",
  },
  {
    id: "fabrikam",
    name: "Fabrikam",
    slug: "fabrikam",
    kind: "customer",
    customerNumber: null,
    role: "tenant_user",
    status: "active",
  },
  {
    id: "northwind",
    name: "Northwind",
    slug: "northwind",
    kind: "customer",
    customerNumber: null,
    role: "tenant_user",
    status: "suspended",
  },
];

function input(overrides: Partial<PaletteInput> = {}): PaletteInput {
  return {
    navItems,
    role: "tenant_user",
    lockContext: { features: [], extensions: { unlocked: true } },
    canAccess,
    tenants,
    activeTenantId: "fabrikam",
    isProviderAdmin: false,
    theme: "system",
    palette: "restow",
    language: "en",
    languages: ["de", "en"],
    t,
    ...overrides,
  };
}

function commands(groups: PaletteGroup[]): PaletteCommand[] {
  return groups.flatMap((group) => group.commands);
}

/** Targets of the menu entries (the sidebar's sections; the setup tabs are their own group). */
function navTargets(groups: PaletteGroup[]): string[] {
  return commands(groups.filter((group) => group.id.startsWith("nav-"))).flatMap((command) =>
    command.action.kind === "navigate" && command.id.startsWith("nav:") ? [command.action.to] : [],
  );
}

/** What cmdk would rank for `search`, best first, as the palette passes value and keywords. */
function search(groups: PaletteGroup[], query: string): string[] {
  return commands(groups)
    .map((command) => ({
      id: command.id,
      score: defaultFilter(commandValue(command), query, command.keywords),
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.id);
}

describe("palette navigation", () => {
  it("offers exactly the entries the role in the active tenant may open", () => {
    expect(navTargets(buildPaletteGroups(input({ role: "tenant_user" })))).toEqual([
      "/",
      "/restore",
    ]);
    expect(navTargets(buildPaletteGroups(input({ role: "tenant_admin" })))).toEqual([
      "/",
      "/history",
      "/restore",
    ]);
  });

  it("leaves out entries a lock holds closed, and offers them once it opens", () => {
    const provider = { role: "provider_admin", isProviderAdmin: true } as const;
    const lockedContext = { features: [], extensions: {} };
    expect(
      navTargets(buildPaletteGroups(input({ ...provider, lockContext: lockedContext }))),
    ).toEqual(["/", "/history", "/restore", "/settings"]);
    // While the profile loads the lock reports locked: nothing appears that might vanish.
    expect(
      navTargets(
        buildPaletteGroups(
          input({ ...provider, lockContext: { features: null, extensions: null } }),
        ),
      ),
    ).not.toContain("/tenants");
    expect(navTargets(buildPaletteGroups(input(provider)))).toContain("/tenants");
  });

  it("offers every entry when no extension supplies a lock", () => {
    const provider = { role: "provider_admin", isProviderAdmin: true } as const;
    const unlockedItems = navItems.map(({ lock: _lock, ...item }) => item);
    expect(
      navTargets(
        buildPaletteGroups(
          input({
            ...provider,
            navItems: unlockedItems,
            lockContext: { features: [], extensions: {} },
          }),
        ),
      ),
    ).toEqual(["/", "/history", "/restore", "/tenants", "/settings"]);
  });

  it("groups entries under the sidebar sections", () => {
    const headings = buildPaletteGroups(input()).map((group) => group.heading);
    expect(headings.slice(0, 2)).toEqual(["nav.groups.daily", "nav.groups.mail"]);
  });

  it("offers upcoming entries with a hint, naming the section where a label repeats", () => {
    const soon: NavItem[] = [
      ...navItems,
      {
        id: "mail-jobs",
        path: "/jobs",
        search: { type: "mail" },
        labelKey: "nav.items.jobs",
        icon: ListChecks,
        group: "mail",
        soon: "0.2.0",
      },
      {
        id: "endpoint-jobs",
        path: "/jobs",
        search: { type: "endpoint" },
        labelKey: "nav.items.jobs",
        icon: ListChecks,
        group: "endpoints",
        soon: "0.2.0",
      },
    ];
    const all = commands(buildPaletteGroups(input({ navItems: soon, role: "tenant_admin" })));
    const mailJobs = all.find((command) => command.id === "nav:mail-jobs");
    expect(mailJobs).toMatchObject({
      label: "nav.items.jobs · nav.groups.mail",
      hint: "nav.soon.hint",
      action: { kind: "navigate", to: "/jobs", search: { type: "mail" } },
    });
    expect(all.find((command) => command.id === "nav:endpoint-jobs")?.label).toBe(
      "nav.items.jobs · nav.groups.endpoints",
    );
    // A label that appears once stays as it is.
    expect(all.find((command) => command.id === "nav:restore")?.label).toBe("restore:nav");
  });

  it("offers the sections of the tenant page of the active tenant to the roles that may open it", () => {
    const admin = buildPaletteGroups(input({ role: "tenant_admin", activeTenantId: "contoso" }));
    const setup = admin.find((group) => group.id === "setup");
    // One organisation: its settings.
    expect(setup?.heading).toBe("nav.items.organisationSettings");
    expect(setup?.commands.map((command) => [command.id, command.action])).toEqual([
      ["setup:connections", { kind: "navigate", to: "/tenants/contoso/connections" }],
      // Protection keeps the id of its former menu entry: the object search is tied to it.
      ["nav:protected-objects", { kind: "navigate", to: "/tenants/contoso/protection" }],
      ["setup:jobs", { kind: "navigate", to: "/tenants/contoso/jobs" }],
      ["setup:retention", { kind: "navigate", to: "/tenants/contoso/retention" }],
      ["setup:storage", { kind: "navigate", to: "/tenants/contoso/storage" }],
      ["setup:agents", { kind: "navigate", to: "/tenants/contoso/agents" }],
      ["setup:archive", { kind: "navigate", to: "/tenants/contoso/archive" }],
      ["setup:notifications", { kind: "navigate", to: "/tenants/contoso/notifications" }],
      ["setup:integrations", { kind: "navigate", to: "/tenants/contoso/integrations" }],
      ["setup:members", { kind: "navigate", to: "/tenants/contoso/members" }],
      ["setup:master-data", { kind: "navigate", to: "/tenants/contoso/master-data" }],
    ]);
    // Where tenants are managed they are the tenant's settings; an end user has no tenant page.
    const provider = buildPaletteGroups(
      input({
        role: "provider_admin",
        isProviderAdmin: true,
        lockContext: { features: ["tenants.additional"], extensions: {} },
      }),
    );
    expect(provider.find((group) => group.id === "setup")?.heading).toBe(
      "nav.items.tenantSettings",
    );
    const user = buildPaletteGroups(input({ role: "tenant_user" }));
    expect(user.find((group) => group.id === "setup")).toBeUndefined();
  });

  it("always offers account security, sign-out, appearance (mode and colour scheme) and language", () => {
    const ids = commands(buildPaletteGroups(input({ role: null, tenants: [] }))).map(
      (command) => command.id,
    );
    expect(ids).toEqual(
      expect.arrayContaining([
        "account:security",
        "account:sign-out",
        "theme:light",
        "theme:dark",
        "theme:system",
        "scheme:restow",
        "scheme:neutral",
        "language:de",
        "language:en",
      ]),
    );
  });

  it("marks the current mode, colour scheme and language", () => {
    const current = commands(buildPaletteGroups(input({ theme: "dark", language: "de" })))
      .filter((command) => command.current)
      .map((command) => command.id);
    expect(current).toEqual(["theme:dark", "scheme:restow", "language:de"]);
    const neutral = commands(buildPaletteGroups(input({ palette: "neutral" })))
      .filter((command) => command.current)
      .map((command) => command.id);
    expect(neutral).toEqual(["theme:system", "scheme:neutral", "language:en"]);
  });

  it("offers one colour scheme command per scheme, independent of the mode commands", () => {
    const schemes = commands(buildPaletteGroups(input())).filter((command) =>
      command.id.startsWith("scheme:"),
    );
    expect(schemes.map((command) => command.action)).toEqual([
      { kind: "scheme", palette: "restow" },
      { kind: "scheme", palette: "neutral" },
    ]);
    // Found by the words a person would type: colour scheme, appearance, the scheme's own name.
    expect(schemes[1]?.keywords).toEqual(
      expect.arrayContaining(["theme.palette.label", "theme.label", "neutral"]),
    );
  });
});

describe("palette tenant switching", () => {
  it("offers every other tenant with the role there", () => {
    const tenantCommands = buildPaletteGroups(input()).find((group) => group.id === "tenants");
    expect(tenantCommands?.commands.map((command) => command.action)).toEqual([
      { kind: "tenant", tenant: { id: "contoso", name: "Contoso" } },
      { kind: "tenant", tenant: { id: "northwind", name: "Northwind" } },
    ]);
    expect(tenantCommands?.commands[0]?.hint).toBe("roles.tenant_admin");
  });

  it("keeps a suspended tenant visible but closed to members, open to provider admins", () => {
    const member = commands(buildPaletteGroups(input())).find(
      (command) => command.id === "tenant:northwind",
    );
    expect(member).toMatchObject({ disabled: true, hint: "tenant.status.suspended" });

    const provider = commands(
      buildPaletteGroups(input({ role: "provider_admin", isProviderAdmin: true })),
    ).find((command) => command.id === "tenant:northwind");
    expect(provider?.disabled).toBe(false);
  });

  it("finds a tenant by name or slug", () => {
    const groups = buildPaletteGroups(input());
    expect(search(groups, "contoso")[0]).toBe("tenant:contoso");
    expect(search(groups, "northw")[0]).toBe("tenant:northwind");
    expect(search(groups, "contoso")).not.toContain("nav:dashboard");
  });

  it("offers a provider admin a 'new tenant' command that opens the wizard", () => {
    const provider = commands(
      buildPaletteGroups(input({ role: "provider_admin", isProviderAdmin: true })),
    ).find((command) => command.id === "tenant:create");
    expect(provider?.action).toEqual({
      kind: "navigate",
      to: "/tenants",
      search: { new: true },
    });

    const member = commands(buildPaletteGroups(input())).find(
      (command) => command.id === "tenant:create",
    );
    expect(member).toBeUndefined();
  });

  it("keeps the tenant group for a provider admin with no other tenant to switch to", () => {
    const groups = buildPaletteGroups(
      input({
        role: "provider_admin",
        isProviderAdmin: true,
        tenants: [tenants[1] as SessionTenant],
      }),
    );
    const tenantCommands = groups.find((group) => group.id === "tenants");
    expect(tenantCommands?.commands.map((command) => command.id)).toEqual(["tenant:create"]);
  });

  it("ranks a tenant name above a fuzzy hit in a page id", () => {
    // Real labels and a real tenant id: "verify" holds an f, "Wiederherstellbarkeit" the rest.
    const german = (key: string, options?: Record<string, unknown>) =>
      key === "search.switchTo"
        ? `Zu ${String(options?.name)} wechseln`
        : key === "verify:nav"
          ? "Wiederherstellbarkeit"
          : key;
    const groups = buildPaletteGroups(
      input({
        t: german,
        navItems: [
          ...navItems,
          { id: "verify", path: "/verify", labelKey: "verify:nav", icon: ListChecks },
        ],
        tenants: [
          ...tenants,
          {
            id: "22222222-2222-4222-8222-222222222222",
            name: "Fabrikam GmbH",
            slug: "fabrikam-gmbh",
            kind: "customer",
            customerNumber: null,
            role: "tenant_user",
            status: "active",
          },
        ],
      }),
    );
    expect(search(groups, "fabri")[0]).toBe("tenant:22222222-2222-4222-8222-222222222222");
  });

  it("has no tenant group when there is nothing to switch to", () => {
    const single = buildPaletteGroups(input({ tenants: [tenants[1] as SessionTenant] }));
    expect(single.find((group) => group.id === "tenants")).toBeUndefined();
  });
});

describe("shortcuts", () => {
  it("shows ⌘ on Apple platforms and the translated Ctrl elsewhere", () => {
    expect(isApplePlatform({ platform: "MacIntel" })).toBe(true);
    expect(isApplePlatform({ userAgentData: { platform: "Windows" }, platform: "Win32" })).toBe(
      false,
    );
    expect(shortcutKeys("k", true, "Strg")).toEqual(["⌘", "K"]);
    expect(shortcutKeys("k", false, "Strg")).toEqual(["Strg", "K"]);
    expect(ariaShortcut("k")).toBe("Control+K Meta+K");
  });

  it("accepts Ctrl or Cmd with the key and nothing else", () => {
    const event = { key: "k", metaKey: false, ctrlKey: true, altKey: false, shiftKey: false };
    expect(isModifierShortcut(event, "k")).toBe(true);
    expect(isModifierShortcut({ ...event, ctrlKey: false, metaKey: true, key: "K" }, "k")).toBe(
      true,
    );
    expect(isModifierShortcut({ ...event, shiftKey: true }, "k")).toBe(false);
    expect(isModifierShortcut({ ...event, ctrlKey: false }, "k")).toBe(false);
  });
});

describe("objectGroup", () => {
  const t = (key: string) => key;
  it("offers nothing without hits and opens the protected-objects page filtered to a hit", () => {
    expect(objectGroup(undefined, "anna", t)).toBeNull();
    expect(objectGroup([], "anna", t)).toBeNull();
    const group = objectGroup(
      [
        {
          id: "o1",
          kind: "mailbox",
          displayName: "Anna Muster",
          email: "anna@example.com",
          externalId: "x1",
          sourceName: "Contoso",
        },
        {
          id: "o2",
          kind: "imap",
          displayName: null,
          email: null,
          externalId: "info@example.org",
          sourceName: "IMAP",
        },
      ],
      "anna",
      t,
    );
    expect(group?.commands.map((command) => command.label)).toEqual([
      "Anna Muster",
      "info@example.org",
    ]);
    expect(group?.commands[0]?.action).toEqual({
      kind: "navigate",
      to: "/protected-objects",
      search: { q: "anna@example.com" },
    });
    // The typed text stays a keyword, so the client filter keeps server hits.
    expect(group?.commands[0]?.keywords).toContain("anna");
  });
});

describe("palette and the menu of 0.2.0", () => {
  const SETTINGS_ROLES = ["provider_admin", "tenant_admin"];
  const many = { features: ["tenants.additional" as const], extensions: { unlocked: true } };
  const one = { features: [], extensions: { unlocked: true } };
  const menuItems: NavItem[] = [
    {
      id: "dashboard",
      path: "/",
      labelKey: "dashboard:nav",
      icon: LayoutDashboard,
      exact: true,
      group: "daily",
    },
    { id: "restore", path: "/restore", labelKey: "restore:nav", icon: ListChecks, group: "mail" },
    {
      id: "archive",
      path: "/archive",
      labelKey: "archive:nav",
      icon: ListChecks,
      roles: SETTINGS_ROLES,
      group: "mail",
    },
    {
      id: "tenant-settings",
      path: "/protected-objects",
      labelKey: "nav.items.tenantSettings",
      icon: Settings,
      roles: SETTINGS_ROLES,
      group: "tenants",
      visible: (context) => (context.features ?? []).includes("tenants.additional"),
    },
    {
      id: "organisation-settings",
      path: "/protected-objects",
      labelKey: "nav.items.organisationSettings",
      icon: Settings,
      roles: SETTINGS_ROLES,
      group: "tenants",
      visible: (context) => !(context.features ?? []).includes("tenants.additional"),
    },
    {
      id: "tenants",
      path: "/tenants",
      labelKey: "tenants:nav",
      icon: Building2,
      roles: ["provider_admin"],
      group: "tenants",
    },
    {
      id: "settings",
      path: "/settings",
      labelKey: "settings:nav",
      icon: Settings,
      roles: ["provider_admin"],
      group: "installation",
    },
  ];
  const provider = { role: "provider_admin", isProviderAdmin: true, navItems: menuItems } as const;

  const navHeadings = (groups: PaletteGroup[]) =>
    groups.filter((group) => group.id.startsWith("nav-")).map((group) => group.heading);

  it("groups the entries under the sections of the sidebar, in its order", () => {
    expect(navHeadings(buildPaletteGroups(input({ ...provider, lockContext: many })))).toEqual([
      "nav.groups.daily",
      "nav.groups.mail",
      "nav.groups.tenants",
      "nav.groups.installation",
    ]);
  });

  it("calls the tenants section Organisation where the installation has one organisation", () => {
    expect(navHeadings(buildPaletteGroups(input({ ...provider, lockContext: one })))).toEqual([
      "nav.groups.daily",
      "nav.groups.mail",
      "nav.groups.organisation",
      "nav.groups.installation",
    ]);
  });

  it("reaches the settings of the active tenant as a command, in either wording", () => {
    const settingsCommand = (lockContext: typeof one | typeof many, role: string) =>
      commands(buildPaletteGroups(input({ ...provider, role, lockContext }))).filter(
        (command) =>
          command.id === "nav:tenant-settings" || command.id === "nav:organisation-settings",
      );
    expect(settingsCommand(many, "provider_admin").map((c) => c.id)).toEqual([
      "nav:tenant-settings",
    ]);
    expect(settingsCommand(one, "provider_admin").map((c) => c.id)).toEqual([
      "nav:organisation-settings",
    ]);
    // A tenant admin of a Service Provider installation has it too.
    expect(settingsCommand(many, "tenant_admin").map((c) => c.id)).toEqual(["nav:tenant-settings"]);
    // An end user has neither.
    expect(settingsCommand(many, "tenant_user")).toEqual([]);
  });

  it("names the section where a label repeats, so 'Settings' says which one", () => {
    const withSameLabel = menuItems.map((item) =>
      item.id === "tenant-settings" || item.id === "organisation-settings"
        ? { ...item, labelKey: "settings:nav" }
        : item,
    );
    const all = commands(
      buildPaletteGroups(input({ ...provider, navItems: withSameLabel, lockContext: one })),
    );
    expect(all.find((command) => command.id === "nav:organisation-settings")?.label).toBe(
      "settings:nav · nav.groups.organisation",
    );
    expect(all.find((command) => command.id === "nav:settings")?.label).toBe(
      "settings:nav · nav.groups.installation",
    );
  });

  it("switches to a tenant found by its customer number", () => {
    const numbered: SessionTenant[] = [
      { ...(tenants[0] as SessionTenant), customerNumber: "KD-10234" },
      { ...(tenants[1] as SessionTenant), customerNumber: "KD-20456" },
    ];
    const groups = buildPaletteGroups(
      input({ ...provider, tenants: numbered, activeTenantId: "fabrikam" }),
    );
    expect(search(groups, "KD-10234")[0]).toBe("tenant:contoso");
    expect(search(groups, "kd-10234")).not.toContain("nav:dashboard");
  });
});
