import type { AuditActionCount, ChainBreak, ChainReport, ChainStatus } from "./api";

/**
 * Pure presentation helpers for the audit page: grouping, ordering and the
 * translation keys for codes the API returns. Components turn the keys into
 * text; unknown codes are shown as they are rather than guessed at.
 */

/** Translation key of an action's label, e.g. `events.restore.requested`. */
export function actionLabelKey(action: string): string {
  return `events.${action}`;
}

/** The first dotted segment: `tenant.member.added` -> `tenant`. */
export function actionCategory(action: string): string {
  const dot = action.indexOf(".");
  return dot === -1 ? action : action.slice(0, dot);
}

export interface ActionGroup {
  category: string;
  /** Every action of the category, alphabetically. */
  actions: AuditActionCount[];
  /** Entries across the whole category. */
  total: number;
}

/** Group the action facet by category, both levels sorted alphabetically. */
export function groupActions(actions: readonly AuditActionCount[]): ActionGroup[] {
  const groups = new Map<string, ActionGroup>();
  for (const item of actions) {
    const category = actionCategory(item.action);
    const group = groups.get(category) ?? { category, actions: [], total: 0 };
    group.actions.push(item);
    group.total += item.count;
    groups.set(category, group);
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      actions: [...group.actions].sort((a, b) => a.action.localeCompare(b.action)),
    }))
    .sort((a, b) => a.category.localeCompare(b.category));
}

/** One row of the action filter: a whole category or a single action. */
export interface ActionChoice {
  /** The `action` filter value: a category (dotted prefix) or an exact action code. */
  value: string;
  label: string;
  /** What typing finds the row by: labels in the UI language. */
  keywords: string[];
}

export interface ActionChoiceGroup {
  /** The category row; choosing it filters by every action of the category. */
  category: ActionChoice;
  /** The category's actions; empty when the category is one action of the same code. */
  actions: ActionChoice[];
}

/**
 * The action filter's rows: categories and their actions, both sorted by
 * their label in the UI language. A category row also answers to the labels
 * of its actions, so a search for an action keeps its category in view.
 */
export function actionChoices(
  groups: readonly ActionGroup[],
  labels: { category: (category: string) => string; action: (action: string) => string | null },
  language: string,
): ActionChoiceGroup[] {
  const collator = new Intl.Collator(language, { sensitivity: "base", numeric: true });
  const byLabel = (a: ActionChoice, b: ActionChoice) => collator.compare(a.label, b.label);
  return groups
    .map((group) => {
      const category = labels.category(group.category);
      const standalone = group.actions.length === 1 && group.actions[0]?.action === group.category;
      const actions = standalone
        ? []
        : group.actions
            .map((item) => {
              const label = labels.action(item.action) ?? item.action;
              return { value: item.action, label, keywords: [label, category] };
            })
            .sort(byLabel);
      return {
        category: {
          value: group.category,
          label: category,
          keywords: [category, ...actions.map((action) => action.label)],
        },
        actions,
      };
    })
    .sort((a, b) => byLabel(a.category, b.category));
}

/** Lower case without accents, so "prufung" finds "Prüfung". */
function foldForSearch(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase();
}

/** Whether a filter row matches what was typed: every typed word occurs in its keywords. */
export function matchesActionSearch(keywords: readonly string[], search: string): boolean {
  const words = foldForSearch(search).split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return true;
  }
  const haystack = keywords.map(foldForSearch).join("\n");
  return words.every((word) => haystack.includes(word));
}

/** How an actor label is presented. */
export type ActorView =
  | { kind: "system" }
  | { kind: "apiKey"; id: string }
  | { kind: "user"; id: string }
  | { kind: "adminConsent" }
  | { kind: "label"; label: string };

/** Recognize the actor labels the API writes (`system`, `api-key:<id>`, `user:<id>`, ...). */
export function describeActor(actor: string): ActorView {
  if (actor === "system") {
    return { kind: "system" };
  }
  if (actor === "entra:admin-consent") {
    return { kind: "adminConsent" };
  }
  if (actor.startsWith("api-key:") && actor.length > "api-key:".length) {
    return { kind: "apiKey", id: actor.slice("api-key:".length) };
  }
  if (actor.startsWith("user:") && actor.length > "user:".length) {
    return { kind: "user", id: actor.slice("user:".length) };
  }
  return { kind: "label", label: actor };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether a target is an opaque id (a UUID) rather than something a person can read. */
export function isOpaqueId(value: string): boolean {
  return UUID.test(value);
}

/** A hash shortened for tables and messages: `3f9a1c2e…b7d0`. */
export function shortHash(hash: string): string {
  return hash.length <= 16 ? hash : `${hash.slice(0, 8)}…${hash.slice(-4)}`;
}

const STATUS_ORDER: Record<ChainStatus, number> = { broken: 0, intact: 1, empty: 2 };

/**
 * Chains for the verification dialog: broken ones first, the installation
 * chain ahead of tenants, then by tenant name.
 */
export function sortChainReports(chains: readonly ChainReport[]): ChainReport[] {
  return [...chains].sort((a, b) => {
    const byStatus = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
    if (byStatus !== 0) {
      return byStatus;
    }
    if ((a.tenantId === null) !== (b.tenantId === null)) {
      return a.tenantId === null ? -1 : 1;
    }
    return (a.tenantName ?? "").localeCompare(b.tenantName ?? "");
  });
}

/** The entry a break points at, when it points at one. */
export function breakEntryId(value: ChainBreak): string | null {
  return value.reason === "anchor_mismatch" ? null : value.entryId;
}

/** Pretty-printed entry details for the drawer. */
export function formatDetails(details: Record<string, unknown> | null): string | null {
  if (!details || Object.keys(details).length === 0) {
    return null;
  }
  return JSON.stringify(details, null, 2);
}

/** A verification duration in the UI language (`840 ms`, `3.2 s`). */
export function formatDuration(milliseconds: number, language: string): string {
  const safe = Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds : 0;
  if (safe < 1000) {
    return new Intl.NumberFormat(language, {
      style: "unit",
      unit: "millisecond",
      unitDisplay: "short",
      maximumFractionDigits: 0,
    }).format(safe);
  }
  return new Intl.NumberFormat(language, {
    style: "unit",
    unit: "second",
    unitDisplay: "short",
    maximumFractionDigits: 1,
  }).format(safe / 1000);
}

/** A calendar day from the API (`YYYY-MM-DD`, UTC) in the UI language. */
export function formatAnchorDate(day: string, language: string): string {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  return new Intl.DateTimeFormat(language, { dateStyle: "medium", timeZone: "UTC" }).format(
    new Date(Date.UTC(year, month - 1, date)),
  );
}
