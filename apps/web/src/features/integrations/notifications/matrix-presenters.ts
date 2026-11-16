import type {
  DeliveryModes,
  EventGroup,
  EventLevel,
  MatrixChannel,
  MatrixUpdate,
  NotificationMatrix,
  ReportEvent,
} from "@/features/reports/api";

/**
 * Pure logic of the notification matrix (Integrations › Notifications): the events as rows,
 * grouped and marked by severity, the tenant's channels as columns, and what a change of the
 * cells sends to the server. The component stays thin; everything here is unit-tested.
 */

/** The groups in the order the matrix shows them. */
export const MATRIX_GROUPS: readonly EventGroup[] = ["jobs", "recoverability", "storage", "system"];

export type MatrixRow = NotificationMatrix["events"][number];

/** The rows by group, in catalog order; empty groups are left out. */
export function groupedRows(
  events: readonly MatrixRow[],
): { group: EventGroup; rows: MatrixRow[] }[] {
  return MATRIX_GROUPS.map((group) => ({
    group,
    rows: events.filter((event) => event.group === group),
  })).filter((entry) => entry.rows.length > 0);
}

/** The quick choices of a column. */
export const CHANNEL_PRESETS = ["errors", "warnings", "all"] as const;
export type ChannelPreset = (typeof CHANNEL_PRESETS)[number];

const PRESET_LEVELS: Record<ChannelPreset, readonly EventLevel[]> = {
  errors: ["error"],
  warnings: ["error", "warning"],
  all: ["error", "warning", "info"],
};

/** The events of `preset` among the rows. */
export function presetEvents(preset: ChannelPreset, rows: readonly MatrixRow[]): ReportEvent[] {
  return rows.filter((row) => PRESET_LEVELS[preset].includes(row.level)).map((row) => row.name);
}

/** The preset a column matches exactly, or null when it is a choice of its own. */
export function presetOf(
  events: readonly ReportEvent[],
  rows: readonly MatrixRow[],
): ChannelPreset | null {
  return CHANNEL_PRESETS.find((preset) => sameEvents(presetEvents(preset, rows), events)) ?? null;
}

/** The key of a column in the draft. */
export function channelKey(channel: Pick<MatrixChannel, "kind" | "id">): string {
  return channel.kind === "bell" ? "bell" : `${channel.kind}:${channel.id}`;
}

export type MatrixDraft = Readonly<Record<string, readonly ReportEvent[]>>;

/** The columns as the server holds them. */
export function draftFrom(matrix: NotificationMatrix): MatrixDraft {
  return Object.fromEntries(
    matrix.channels.map((channel) => [channelKey(channel), [...channel.events]]),
  );
}

function sameEvents(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((event) => b.includes(event));
}

/** Switch one cell; the column keeps the catalog order of the rows. */
export function toggleCell(
  draft: MatrixDraft,
  key: string,
  event: ReportEvent,
  on: boolean,
  rows: readonly MatrixRow[],
): MatrixDraft {
  const current = new Set(draft[key] ?? []);
  if (on) current.add(event);
  else current.delete(event);
  return { ...draft, [key]: rows.map((row) => row.name).filter((name) => current.has(name)) };
}

/** Set a column to a preset; the column's locked events stay on. */
export function applyPreset(
  draft: MatrixDraft,
  key: string,
  preset: ChannelPreset,
  rows: readonly MatrixRow[],
  locked: readonly ReportEvent[] = [],
): MatrixDraft {
  const chosen = new Set([...presetEvents(preset, rows), ...locked]);
  return { ...draft, [key]: rows.map((row) => row.name).filter((name) => chosen.has(name)) };
}

/**
 * The events a column cannot switch off (0.5.0): the bell always shows the critical events and
 * failed deliveries. Other columns have none.
 */
export function lockedEventsOf(channel: MatrixChannel): readonly ReportEvent[] {
  return channel.kind === "bell" ? (channel.locked ?? []) : [];
}

/**
 * The digest modes of an e-mail column that are not "at once", for the chip under its title
 * (0.5.0): `[["warning", "daily"], ["info", "hourly"]]`. Empty for every other column, and for a
 * recipient who gets everything at once.
 */
export function digestModesOf(
  channel: MatrixChannel,
): [keyof DeliveryModes, Exclude<DeliveryModes[keyof DeliveryModes], "immediate">][] {
  if (channel.kind !== "email" || !channel.delivery) return [];
  const modes = channel.delivery;
  return (["error", "warning", "info"] as const).flatMap((level) => {
    const mode = modes[level];
    return mode === "hourly" || mode === "daily" ? [[level, mode] as const] : [];
  }) as [keyof DeliveryModes, Exclude<DeliveryModes[keyof DeliveryModes], "immediate">][];
}

/** Why a column's deliveries fail right now (0.5.0), or null while they get through. */
export function channelFailure(
  channel: MatrixChannel,
): { since: string; reason: string; attempts: number | null } | null {
  if (channel.kind === "webhook" && channel.health?.status === "failing") {
    return {
      since: channel.health.failingSince ?? "",
      reason: channel.health.lastError ?? "",
      attempts: channel.health.consecutiveFailures,
    };
  }
  if (channel.kind === "email" && channel.failure) {
    return { since: channel.failure.since, reason: channel.failure.reason, attempts: null };
  }
  return null;
}

/** The columns that differ from the server's, as the update to send. */
export function changedChannels(
  matrix: NotificationMatrix,
  draft: MatrixDraft,
): MatrixUpdate["channels"] {
  const changed: MatrixUpdate["channels"] = [];
  for (const channel of matrix.channels) {
    const events = draft[channelKey(channel)];
    if (!events || sameEvents(events, channel.events)) {
      continue;
    }
    changed.push(
      channel.kind === "bell"
        ? { kind: "bell", events: [...events] }
        : { kind: channel.kind, id: channel.id, events: [...events] },
    );
  }
  return changed;
}

/** What a column is called: the webhook's name or host, the recipient's name or address. */
export function channelTitle(
  channel: MatrixChannel,
  t: (key: string, values?: Record<string, unknown>) => string,
): string {
  if (channel.kind === "bell") return t("matrix.bell");
  if (channel.kind === "webhook") return channel.name ?? channel.host;
  return channel.name ?? channel.email;
}

/** The line under a column's title: the webhook's format, the recipient's address. */
export function channelSubtitle(
  channel: MatrixChannel,
  t: (key: string, values?: Record<string, unknown>) => string,
): string {
  if (channel.kind === "bell") return t("matrix.bellHint");
  if (channel.kind === "webhook") return t(`formats.${channel.format}.label`);
  return channel.name ? channel.email : t("matrix.recipient");
}

/** The badge of a severity (never the success tone: green is proof of a restore check). */
export const LEVEL_VARIANT: Record<EventLevel, "destructive" | "warning" | "info"> = {
  error: "destructive",
  warning: "warning",
  info: "info",
};
