import { join } from "node:path";
import { DEMO_DOMAIN, type DemoMailbox, allMailboxes } from "./company.js";
import {
  type Correspondent,
  type GeneratedMessage,
  type Language,
  type MailKind,
  correspondentOf,
  generalMessage,
  invoiceMessage,
  meetingMessage,
  newsletterMessage,
  orderMessage,
} from "./content.js";
import { buildIcs } from "./ics.js";
import { writeMaildirMessage } from "./maildir.js";
import { type Attachment, buildEmlMessage } from "./mime.js";
import { buildPdf } from "./pdf.js";
import { type Rng, chance, mulberry32, randomInt, seedFrom } from "./prng.js";

/**
 * The synthetic mail generator (deploy/demo/README.md): a deterministic
 * corpus of realistic-but-fictional business mail — invoices, orders,
 * newsletters, calendar invites, everyday correspondence — spread over the
 * last ten years, across the demo mailboxes' INBOX, Sent and Archive
 * folders, some with a PDF, text or .ics attachment. Given the same seed it
 * always plans the exact same messages (generate-mail.test.ts), so a demo
 * reset (deploy/demo/reset.sh) produces an identical-looking demo every time.
 */

const YEARS_SPAN = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

const KIND_WEIGHTS: ReadonlyArray<readonly [MailKind, number]> = [
  ["invoice", 0.25],
  ["order", 0.2],
  ["newsletter", 0.15],
  ["meeting", 0.1],
  ["general", 0.3],
];

function pickKind(rng: Rng): MailKind {
  const roll = rng();
  let cumulative = 0;
  for (const [kind, weight] of KIND_WEIGHTS) {
    cumulative += weight;
    if (roll < cumulative) {
      return kind;
    }
  }
  return "general";
}

/** Which folder a message lands in; `null` means INBOX. */
function pickFolder(rng: Rng, folders: readonly string[]): string | null {
  const roll = rng();
  if (roll < 0.6) {
    return null;
  }
  if (roll < 0.85 && folders.includes("Sent")) {
    return "Sent";
  }
  return folders.includes("Archive") ? "Archive" : null;
}

function pickLanguage(rng: Rng): Language {
  // English only: the public demo is for visitors from anywhere. The draw
  // stays, so the rest of the generated corpus is unchanged by this choice.
  chance(rng, 0.3);
  return "en";
}

/** A random instant in the last `years` before `now`, no later than `latest`. */
function randomDateWithinYears(rng: Rng, now: Date, years: number, latest: Date = now): Date {
  const earliest = new Date(now.getTime());
  earliest.setUTCFullYear(earliest.getUTCFullYear() - years);
  return new Date(
    randomInt(rng, earliest.getTime(), Math.max(earliest.getTime(), latest.getTime())),
  );
}

function messageOf(
  rng: Rng,
  kind: MailKind,
  date: Date,
  language: Language,
  correspondent: Correspondent,
): GeneratedMessage {
  switch (kind) {
    case "invoice":
      return invoiceMessage(rng, date, language);
    case "order":
      return orderMessage(rng, date, language);
    case "newsletter":
      return newsletterMessage(rng, date, language);
    case "meeting":
      return meetingMessage(rng, date, language);
    default:
      return generalMessage(rng, correspondent, language);
  }
}

function meetingAttachment(
  rng: Rng,
  subject: string,
  date: Date,
  messageId: string,
  organizer: Correspondent,
  attendee: Correspondent,
): Attachment {
  const start = new Date(date.getTime());
  start.setUTCHours(10, 0, 0, 0);
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  return {
    filename: "termin.ics",
    contentType: 'text/calendar; method=REQUEST; charset="utf-8"',
    content: buildIcs(
      {
        uid: `${messageId}@restow-demo.${DEMO_DOMAIN}`,
        summary: subject.replace(/^(Einladung|Invitation): /, ""),
        start,
        end,
        organizer,
        attendee,
        location: chance(rng, 0.5) ? "Meeting room 1" : undefined,
      },
      date,
    ),
  };
}

function attachmentsFor(
  rng: Rng,
  kind: MailKind,
  subject: string,
  date: Date,
  messageId: string,
  from: Correspondent,
  to: Correspondent,
): Attachment[] {
  if (kind === "meeting") {
    return [meetingAttachment(rng, subject, date, messageId, from, to)];
  }
  if (kind === "invoice" && chance(rng, 0.7)) {
    return [
      {
        filename: "rechnung.pdf",
        contentType: "application/pdf",
        content: buildPdf([subject, `Date: ${date.toISOString().slice(0, 10)}`]),
      },
    ];
  }
  if (chance(rng, 0.08)) {
    return [
      {
        filename: "notiz.txt",
        contentType: 'text/plain; charset="utf-8"',
        content: "Siehe Anhang. / See attached.",
      },
    ];
  }
  return [];
}

export interface GeneratedMessagePlan {
  /** The mailbox's IMAP login / email address. */
  mailboxLogin: string;
  /** `null` for INBOX. */
  folder: string | null;
  date: Date;
  seen: boolean;
  eml: string;
}

/** Plan one message for `mailbox`; pure, deterministic given `rng`'s state. */
function planMessage(
  rng: Rng,
  mailbox: DemoMailbox,
  dateOf: (rng: Rng) => Date,
  index: number | string,
): GeneratedMessagePlan {
  const kind = pickKind(rng);
  const language = pickLanguage(rng);
  const date = dateOf(rng);
  const folder = pickFolder(rng, mailbox.folders);
  const correspondent = correspondentOf(rng);
  const mailboxPerson: Correspondent = { name: mailbox.displayName, email: mailbox.login };

  const generated = messageOf(rng, kind, date, language, correspondent);
  const outbound = folder === "Sent";
  const from = outbound ? mailboxPerson : correspondent;
  const to = outbound ? correspondent : mailboxPerson;

  const messageId = seedFrom(`${mailbox.login}-${index}-${date.toISOString()}`).toString(16);
  const attachments = attachmentsFor(rng, kind, generated.subject, date, messageId, from, to);

  const eml = buildEmlMessage({
    from,
    to,
    subject: generated.subject,
    date,
    textBody: generated.body,
    messageId: `${messageId}@restow-demo.${DEMO_DOMAIN}`,
    attachments,
  });

  // Sent and Archive read as already handled; INBOX is mostly read with a
  // few messages left looking unread, like a mailbox that is actually used.
  const seen = folder !== null || chance(rng, 0.85);

  return { mailboxLogin: mailbox.login, folder, date, seen, eml };
}

export interface GenerateOptions {
  /** Numeric seed; the same seed always plans the same corpus. */
  seed?: number;
  messagesPerMailbox?: number;
  now?: Date;
  mailboxes?: readonly DemoMailbox[];
  /**
   * Keep the base corpus older than this many days: the most recent days
   * arrive later, one wave per simulated day (planWave), so the demo's
   * history of backups has new mail to pick up each day. 0 (the default)
   * spreads the base corpus right up to `now`.
   */
  historyDays?: number;
}

const DEFAULT_MESSAGES_PER_MAILBOX = 100;

/** Plan the full corpus (pure, no filesystem access) — see generate-mail.test.ts. */
export function planMessages(options: GenerateOptions = {}): GeneratedMessagePlan[] {
  const now = options.now ?? new Date();
  const mailboxes = options.mailboxes ?? allMailboxes();
  const perMailbox = options.messagesPerMailbox ?? DEFAULT_MESSAGES_PER_MAILBOX;
  const latest = new Date(now.getTime() - (options.historyDays ?? 0) * DAY_MS);
  const plans: GeneratedMessagePlan[] = [];
  for (const mailbox of mailboxes) {
    const rng = mulberry32(seedFrom(`${options.seed ?? 0}:${mailbox.login}`));
    for (let index = 0; index < perMailbox; index++) {
      plans.push(
        planMessage(rng, mailbox, (r) => randomDateWithinYears(r, now, YEARS_SPAN, latest), index),
      );
    }
  }
  return plans;
}

export interface WaveOptions {
  /** Numeric seed, as for planMessages. */
  seed?: number;
  /** Which simulated day this is; part of every message's identity. */
  wave: number;
  /** The previous backup of the simulated history. */
  from: Date;
  /** The backup this wave's mail arrives before. */
  to: Date;
  mailboxes?: readonly DemoMailbox[];
}

/**
 * Pure: how many messages a mailbox receives between two backups — a few on
 * a working day, at most one at the weekend — and when. Mail arrives during
 * office hours (06:00–18:00 UTC) of the day `from` falls on, whenever that
 * window lies between the two backups; otherwise anywhere between them.
 */
export function waveWindow(from: Date, to: Date): { start: number; end: number; weekend: boolean } {
  const day = new Date(from.getTime());
  day.setUTCHours(0, 0, 0, 0);
  const office = { start: day.getTime() + 6 * 3600_000, end: day.getTime() + 18 * 3600_000 };
  const start = Math.max(from.getTime() + 60_000, office.start);
  const end = Math.min(to.getTime() - 60_000, office.end);
  const weekday = day.getUTCDay();
  const weekend = weekday === 0 || weekday === 6;
  return end > start
    ? { start, end, weekend }
    : {
        start: from.getTime() + 60_000,
        end: Math.max(from.getTime() + 60_000, to.getTime() - 60_000),
        weekend,
      };
}

/** Plan the mail that arrives between two backups of the simulated history (pure). */
export function planWave(options: WaveOptions): GeneratedMessagePlan[] {
  const mailboxes = options.mailboxes ?? allMailboxes();
  const { start, end, weekend } = waveWindow(options.from, options.to);
  const plans: GeneratedMessagePlan[] = [];
  for (const mailbox of mailboxes) {
    const rng = mulberry32(seedFrom(`${options.seed ?? 0}:${mailbox.login}:wave:${options.wave}`));
    const count = weekend ? randomInt(rng, 0, 1) : randomInt(rng, 2, 6);
    for (let index = 0; index < count; index++) {
      const plan = planMessage(
        rng,
        mailbox,
        (r) => new Date(randomInt(r, start, end)),
        `w${options.wave}-${index}`,
      );
      plans.push(plan);
    }
  }
  return plans.sort((a, b) => a.date.getTime() - b.date.getTime());
}

/** The mailbox's Maildir root under `root` (mail volume), e.g. `<root>/example.org/info`. */
export function mailboxRoot(root: string, login: string): string {
  const [local, domain] = login.split("@");
  return join(root, domain ?? DEMO_DOMAIN, local ?? login);
}

/** Write a planned corpus to disk as Maildir messages (maildir.ts). */
export function writeMessages(
  root: string,
  plans: readonly GeneratedMessagePlan[],
  uniquePrefix = "demo",
): void {
  plans.forEach((plan, index) => {
    writeMaildirMessage(
      { root: mailboxRoot(root, plan.mailboxLogin), folder: plan.folder ?? undefined },
      plan.eml,
      { date: plan.date, seen: plan.seen, unique: `${uniquePrefix}${index}` },
    );
  });
}

/** Plan and write the corpus in one call; returns how many messages landed where. */
export function generateDemoMail(
  root: string,
  options: GenerateOptions = {},
): { messages: number; mailboxes: number } {
  const plans = planMessages(options);
  writeMessages(root, plans);
  const mailboxes = new Set(plans.map((plan) => plan.mailboxLogin)).size;
  return { messages: plans.length, mailboxes };
}
