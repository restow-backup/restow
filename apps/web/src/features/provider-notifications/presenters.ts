import type { DeliveryMode, DeliveryModes, ReportEvent } from "@/features/reports/api";

import type {
  ProviderRecipient,
  ProviderRecipientInput,
  ProviderRecipientsView,
  SummaryEntry,
} from "./api";
import { SUMMARY_ENTRIES } from "./api";

/**
 * Pure logic of Installation › Notifications (0.5.0): the provider's recipients as a draft the
 * page edits (rows of the list, columns of the matrix), who is on the floor and which cells that
 * locks, the checks before saving, and the request the draft becomes.
 */

export const IMMEDIATE: DeliveryModes = {
  error: "immediate",
  warning: "immediate",
  info: "immediate",
};

export interface RecipientDraft {
  /** A stable key for React and the matrix (the id, or a local one for a new row). */
  key: string;
  id: string | null;
  email: string;
  name: string;
  kind: "owner" | "member";
  mandatory: boolean;
  language: "de" | "en" | null;
  events: string[];
  delivery: DeliveryModes;
  failure: ProviderRecipient["failure"];
}

export function draftsFrom(view: Pick<ProviderRecipientsView, "recipients">): RecipientDraft[] {
  return view.recipients.map((recipient) => ({
    key: recipient.id,
    id: recipient.id,
    email: recipient.email,
    name: recipient.name ?? "",
    kind: recipient.kind,
    mandatory: recipient.mandatory,
    language: recipient.language,
    events: [...recipient.events],
    delivery: { ...IMMEDIATE, ...recipient.delivery },
    failure: recipient.failure,
  }));
}

let counter = 0;

/** A new recipient: errors at once, the rest by choice. */
export function newDraft(): RecipientDraft {
  counter += 1;
  return {
    key: `new-${counter}`,
    id: null,
    email: "",
    name: "",
    kind: "member",
    mandatory: false,
    language: null,
    events: [],
    delivery: { ...IMMEDIATE },
    failure: null,
  };
}

/** On the floor: an owner of the provider team, or marked mandatory by one. */
export function isFloor(draft: Pick<RecipientDraft, "kind" | "mandatory">): boolean {
  return draft.kind === "owner" || draft.mandatory;
}

/** The cells of a column it cannot switch off: the floor's events, for a floor recipient. */
export function lockedEventsOf(
  draft: Pick<RecipientDraft, "kind" | "mandatory">,
  floorEvents: readonly ReportEvent[],
): readonly ReportEvent[] {
  return isFloor(draft) ? floorEvents : [];
}

/** Whether a cell is ticked: chosen, or locked on. */
export function receives(
  draft: RecipientDraft,
  entry: string,
  floorEvents: readonly ReportEvent[],
): boolean {
  return (
    draft.events.includes(entry) ||
    (lockedEventsOf(draft, floorEvents) as readonly string[]).includes(entry)
  );
}

/** Switch one cell; a locked one stays on. */
export function toggleEntry(
  draft: RecipientDraft,
  entry: string,
  on: boolean,
  floorEvents: readonly ReportEvent[],
): RecipientDraft {
  if (!on && (lockedEventsOf(draft, floorEvents) as readonly string[]).includes(entry)) {
    return draft;
  }
  const events = on
    ? [...draft.events.filter((event) => event !== entry), entry]
    : draft.events.filter((event) => event !== entry);
  return { ...draft, events };
}

export function setDelivery(
  draft: RecipientDraft,
  level: keyof DeliveryModes,
  mode: DeliveryMode,
): RecipientDraft {
  return { ...draft, delivery: { ...draft.delivery, [level]: mode } };
}

export function isSummaryEntry(value: string): value is SummaryEntry {
  return (SUMMARY_ENTRIES as readonly string[]).includes(value);
}

const EMAIL = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]+$/;

/** The problems of the list by row key, as `settings` keys; empty when it can be saved. */
export function validateDrafts(drafts: readonly RecipientDraft[]): Record<string, string> {
  const errors: Record<string, string> = {};
  const seen = new Map<string, string>();
  for (const draft of drafts) {
    const email = draft.email.trim().toLowerCase();
    if (!email) {
      errors[draft.key] = "providerRecipients.errors.required";
      continue;
    }
    if (!EMAIL.test(email) || email.length > 254) {
      errors[draft.key] = "providerRecipients.errors.email";
      continue;
    }
    if (seen.has(email)) {
      errors[draft.key] = "providerRecipients.errors.duplicate";
      continue;
    }
    seen.set(email, draft.key);
  }
  return errors;
}

/**
 * The PUT body. `mandatory` goes along only for an owner (the server refuses a change by anyone
 * else); the owners' addresses are theirs and stay as they are.
 */
export function toRecipientInputs(
  drafts: readonly RecipientDraft[],
  canEditMandatory: boolean,
): ProviderRecipientInput[] {
  return drafts.map((draft) => ({
    ...(draft.id ? { id: draft.id } : {}),
    email: draft.email.trim().toLowerCase(),
    name: draft.name.trim() || null,
    ...(canEditMandatory && draft.kind === "member" ? { mandatory: draft.mandatory } : {}),
    events: [...draft.events],
    delivery: { ...draft.delivery },
    language: draft.language,
  }));
}

/** Whether the draft differs from what the server holds. */
export function draftsChanged(
  drafts: readonly RecipientDraft[],
  view: Pick<ProviderRecipientsView, "recipients">,
): boolean {
  const strip = (list: readonly RecipientDraft[]) =>
    JSON.stringify(
      list.map(({ key: _key, failure: _failure, ...rest }) => ({
        ...rest,
        email: rest.email.trim().toLowerCase(),
        name: rest.name.trim(),
        events: [...rest.events].sort(),
      })),
    );
  return strip(drafts) !== strip(draftsFrom(view));
}
