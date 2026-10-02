import type { SupportedLanguage } from "@restow/i18n";
import {
  Building2,
  Fingerprint,
  HardDrive,
  Inbox,
  Languages,
  LogOut,
  type LucideIcon,
  Monitor,
  Moon,
  Palette as PaletteIcon,
  Server,
  Sun,
} from "lucide-react";

import { PALETTES, type Palette, type Theme } from "@/components/theme-provider";
import { directoryPath } from "@/features/directory/search";
import { TENANT_SECTION_META } from "@/features/tenant-page/meta";
import { TENANTS_PATH } from "@/features/tenants/paths";
import { ACCOUNT_PATH } from "@/lib/entry";
import {
  type NavItem,
  type NavLockContext,
  type RoleCheck,
  groupNavItems,
  navGroupLabelKey,
} from "@/lib/navigation";
import type { SessionTenant } from "@/lib/session";
import { canEnterTenant } from "@/lib/tenant";
import { tenantPagePath } from "@/lib/tenant-paths";

/**
 * What the command palette offers, as plain data: every navigation entry the
 * active role may see and no lock holds closed (the sidebar's filter; locked
 * entries are left out here, upcoming "Soon" entries stay in with a hint),
 * the tabs of the tenant setup area, switching the tenant, appearance (mode
 * and colour scheme), language, account security and signing out. The palette component renders
 * the groups and runs the actions; keeping the list pure lets the filters be
 * tested without a browser.
 */

export type PaletteAction =
  | { kind: "navigate"; to: string; search?: Record<string, unknown> }
  | { kind: "tenant"; tenant: Pick<SessionTenant, "id" | "name"> }
  | { kind: "theme"; theme: Theme }
  | { kind: "scheme"; palette: Palette }
  | { kind: "language"; language: SupportedLanguage }
  | { kind: "signOut" };

export interface PaletteCommand {
  /** Unique within the palette; also the cmdk value, so it must stay stable. */
  id: string;
  label: string;
  /** Extra words the search matches (ids, paths, tenant slugs, group names). */
  keywords: string[];
  icon: LucideIcon;
  action: PaletteAction;
  /** The current mode, colour scheme or language; shown with a check. */
  current?: boolean;
  /** Offered but not possible right now; `hint` says why. */
  disabled?: boolean;
  /** A short note next to the label (a tenant's role or status). */
  hint?: string;
}

export interface PaletteGroup {
  id: string;
  heading: string;
  commands: PaletteCommand[];
}

type Translate = (key: string, options?: Record<string, unknown>) => string;

export interface PaletteInput {
  navItems: readonly NavItem[];
  /** Role in the active tenant. */
  role: string | null;
  /** What nav locks decide on (lib/navigation.ts `NavLock`). */
  lockContext: NavLockContext;
  canAccess: RoleCheck;
  tenants: readonly SessionTenant[];
  activeTenantId: string | null;
  isProviderAdmin: boolean;
  theme: Theme;
  palette: Palette;
  language: string;
  languages: readonly SupportedLanguage[];
  t: Translate;
}

const THEME_ICONS: Readonly<Record<Theme, LucideIcon>> = {
  light: Sun,
  dark: Moon,
  system: Monitor,
};

const THEMES: readonly Theme[] = ["light", "dark", "system"];

function navigationGroups(input: PaletteInput): PaletteGroup[] {
  const { t } = input;
  const groups = groupNavItems(input.navItems, input.role, input.canAccess, input.lockContext)
    .map((group) => ({ ...group, items: group.items.filter((item) => !item.locked) }))
    .filter((group) => group.items.length > 0);
  // A label that appears in more than one section ("Jobs" in Mail & SaaS and
  // in Servers & endpoints, "Settings" in Organisation and in Installation)
  // names its section, so a search result says which.
  const labelCount = new Map<string, number>();
  for (const group of groups) {
    for (const item of group.items) {
      const label = t(item.labelKey);
      labelCount.set(label, (labelCount.get(label) ?? 0) + 1);
    }
  }
  return groups.map((group) => {
    const heading = t(navGroupLabelKey(group.id, input.lockContext));
    return {
      id: `nav-${group.id}`,
      heading,
      commands: group.items.map((item): PaletteCommand => {
        const label = t(item.labelKey);
        const unique = (labelCount.get(label) ?? 0) < 2;
        return {
          id: `nav:${item.id}`,
          label: unique ? label : `${label} · ${heading}`,
          keywords: [item.id, item.path, heading],
          icon: item.icon,
          action: {
            kind: "navigate",
            to: item.path,
            ...(item.search ? { search: { ...item.search } } : {}),
          },
          ...(item.soon ? { hint: t("nav.soon.hint") } : {}),
        };
      }),
    };
  });
}

/**
 * The sections of the tenant page of the active tenant (they have no menu
 * entries of their own; the entry "Tenant settings" is a navigation command like
 * any other): Connections, Protection, Jobs & schedules and the rest, as far
 * as the role may open them. Protection keeps the id of its former menu entry,
 * so the object search stays tied to it ({@link OBJECTS_NAV_COMMAND_ID}). The
 * overview is the entry itself and is left out; the audit log is an
 * extension's section and is reached through the page.
 */
function setupGroup(input: PaletteInput): PaletteGroup | null {
  const { t } = input;
  if (input.activeTenantId === null) {
    return null;
  }
  if (!input.canAccess(input.role, ["provider_admin", "tenant_admin"])) {
    return null;
  }
  const managesTenants = input.lockContext.features?.includes("tenants.additional") ?? false;
  const heading = managesTenants
    ? t("nav.items.tenantSettings")
    : t("nav.items.organisationSettings");
  const sections = TENANT_SECTION_META.filter((meta) => meta.id !== "overview");
  return {
    id: "setup",
    heading,
    commands: sections.map((meta) => ({
      id: meta.id === "protection" ? OBJECTS_NAV_COMMAND_ID : `setup:${meta.id}`,
      label: t(meta.labelKey),
      keywords: [meta.id, heading],
      icon: meta.icon,
      action: {
        kind: "navigate" as const,
        to: tenantPagePath(input.activeTenantId as string, meta.id),
      },
    })),
  };
}

/**
 * Every tenant except the active one, found by name, slug or customer number,
 * plus (for a provider admin) a command that opens the tenant creation
 * wizard. Closed tenants stay visible, disabled.
 */
function tenantGroup(input: PaletteInput): PaletteGroup | null {
  const { t } = input;
  const others = input.tenants.filter((tenant) => tenant.id !== input.activeTenantId);
  const switchCommands = others.map<PaletteCommand>((tenant) => {
    const enterable = canEnterTenant(tenant.status, input.isProviderAdmin);
    const role = input.isProviderAdmin ? "provider_admin" : tenant.role;
    return {
      id: `tenant:${tenant.id}`,
      label: t("search.switchTo", { name: tenant.name }),
      keywords: [tenant.name, tenant.slug, tenant.customerNumber ?? "", t("tenant.label")],
      icon: Building2,
      action: { kind: "tenant", tenant: { id: tenant.id, name: tenant.name } },
      disabled: !enterable,
      hint: tenant.status === "active" ? t(`roles.${role}`) : t(`tenant.status.${tenant.status}`),
    };
  });
  // The wizard is a provider-only action (features/tenants/tenants-page.tsx's
  // own creation gate, enabled features and tenant count, decides whether it
  // can actually be completed; the page itself explains a refusal there).
  const createCommand: PaletteCommand[] = input.isProviderAdmin
    ? [
        {
          id: "tenant:create",
          label: t("tenants:actions.create"),
          keywords: ["tenant", "new", TENANTS_PATH],
          icon: Building2,
          action: { kind: "navigate", to: TENANTS_PATH, search: { new: true } },
        },
      ]
    : [];
  const commands = [...createCommand, ...switchCommands];
  if (commands.length === 0) {
    return null;
  }
  return { id: "tenants", heading: t("search.groups.tenants"), commands };
}

function preferenceGroup(input: PaletteInput): PaletteGroup {
  const { t } = input;
  return {
    id: "preferences",
    heading: t("search.groups.preferences"),
    commands: [
      ...THEMES.map<PaletteCommand>((theme) => ({
        id: `theme:${theme}`,
        label: t("search.theme", { theme: t(`theme.${theme}`) }),
        keywords: [t("theme.label"), theme],
        icon: THEME_ICONS[theme],
        action: { kind: "theme", theme },
        current: input.theme === theme,
      })),
      ...PALETTES.map<PaletteCommand>((palette) => ({
        id: `scheme:${palette}`,
        label: t("search.scheme", { scheme: t(`theme.palette.${palette}`) }),
        keywords: [t("theme.palette.label"), t("theme.label"), palette],
        icon: PaletteIcon,
        action: { kind: "scheme", palette },
        current: input.palette === palette,
      })),
      ...input.languages.map<PaletteCommand>((language) => ({
        id: `language:${language}`,
        label: t("search.language", { language: t(`language.${language}`) }),
        keywords: [t("language.label"), language],
        icon: Languages,
        action: { kind: "language", language },
        current: input.language === language,
      })),
    ],
  };
}

function accountGroup(input: PaletteInput): PaletteGroup {
  const { t } = input;
  return {
    id: "account",
    heading: t("search.groups.account"),
    commands: [
      {
        id: "account:security",
        label: t("user.security"),
        keywords: ["passkey", "2fa", "totp", ACCOUNT_PATH],
        icon: Fingerprint,
        action: { kind: "navigate", to: ACCOUNT_PATH },
      },
      {
        id: "account:sign-out",
        label: t("user.signOut"),
        keywords: ["logout"],
        icon: LogOut,
        action: { kind: "signOut" },
      },
    ],
  };
}

/**
 * The text cmdk ranks a command by. The label comes first: cmdk's score drops
 * with every character it skips, so a match in the label must not sit behind
 * the id. The id keeps the value unique.
 */
export function commandValue(command: Pick<PaletteCommand, "id" | "label">): string {
  return `${command.label} ${command.id}`;
}

/** The palette's groups in display order. */
/** The navigation command that must be available before objects are searched. */
export const OBJECTS_NAV_COMMAND_ID = "nav:protected-objects";

/** A protected object as the palette needs it (a row of the protected-objects API). */
export interface PaletteObject {
  id: string;
  kind: "mailbox" | "onedrive" | "imap";
  displayName: string | null;
  email: string | null;
  externalId: string;
  sourceName: string;
}

const OBJECT_ICONS: Readonly<Record<PaletteObject["kind"], LucideIcon>> = {
  mailbox: Inbox,
  onedrive: HardDrive,
  imap: Server,
};

/**
 * Protected objects of the active tenant matching the typed search (the
 * server does the matching). Each opens the protected-objects page filtered
 * to that object. Null when there is nothing to show.
 */
export function objectGroup(
  objects: readonly PaletteObject[] | undefined,
  search: string,
  t: Translate,
): PaletteGroup | null {
  if (!objects || objects.length === 0) {
    return null;
  }
  return {
    id: "objects",
    heading: t("search.groups.objects"),
    commands: objects.map((object) => {
      const name = object.displayName ?? object.email ?? object.externalId;
      return {
        id: `object:${object.id}`,
        label: name,
        // The server already matched the search; keep the typed text as a
        // keyword so the palette's own filter never hides a server hit.
        keywords: [search, object.email ?? "", object.externalId, object.sourceName],
        icon: OBJECT_ICONS[object.kind],
        action: { kind: "navigate", to: directoryPath(), search: { q: object.email ?? name } },
        hint: t(`search.objectKinds.${object.kind}`),
      };
    }),
  };
}

export function buildPaletteGroups(input: PaletteInput): PaletteGroup[] {
  const tenants = tenantGroup(input);
  const setup = setupGroup(input);
  return [
    ...navigationGroups(input),
    ...(setup ? [setup] : []),
    ...(tenants ? [tenants] : []),
    preferenceGroup(input),
    accountGroup(input),
  ];
}
