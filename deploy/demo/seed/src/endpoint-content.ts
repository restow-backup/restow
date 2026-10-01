import { companyOf, productOf } from "./content.js";
import { buildPdf } from "./pdf.js";
import type { Rng } from "./prng.js";
import { chance, pick, randomInt } from "./prng.js";

/**
 * What the demo's simulated machines keep on their disks: invoices, reports,
 * contracts and proposals as PDF (pdf.ts, the generator the demo mail uses
 * too), notes in plain text and Markdown, a Samba configuration and its log,
 * a few dotfiles. Everything is generated from the seeded random source,
 * written in English, ASCII only (the PDF writer uses a standard font), with
 * reserved example domains and documentation addresses (192.0.2.0/24) and
 * made-up names. Nothing refers to a real person, company or document.
 */

const ISO_DAY = (date: Date): string => date.toISOString().slice(0, 10);

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

export function monthName(month: number): string {
  return MONTH_NAMES[month] as string;
}

/** A company name safe to put into a file name. */
export function slugOf(name: string): string {
  return name
    .replace(/&/g, "and")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const money = (value: number): string => value.toFixed(2);

/** `1234567` as `1,234,567` (no locale data involved). */
const grouped = (value: number): string => String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** A seeded Fisher-Yates shuffle of a copy. */
function shuffled<T>(rng: Rng, items: readonly T[]): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index--) {
    const other = randomInt(rng, 0, index);
    [copy[index], copy[other]] = [copy[other] as T, copy[index] as T];
  }
  return copy;
}

// ---------------------------------------------------------------------------
// PDF documents
// ---------------------------------------------------------------------------

export function invoicePdf(
  rng: Rng,
  input: { seller: string; customer: string; number: string; date: Date },
): Buffer {
  const lineCount = randomInt(rng, 1, 4);
  const lines: string[] = [];
  let net = 0;
  for (let index = 0; index < lineCount; index++) {
    const quantity = randomInt(rng, 1, 40);
    const price = randomInt(rng, 450, 18_500) / 100;
    net += quantity * price;
    lines.push(
      `${index + 1}. ${productOf(rng)} - ${quantity} x EUR ${money(price)} = EUR ${money(quantity * price)}`,
    );
  }
  const vat = net * 0.19;
  const due = new Date(input.date.getTime() + 14 * 24 * 3600_000);
  return buildPdf([
    `INVOICE ${input.number}`,
    "",
    `Date: ${ISO_DAY(input.date)}`,
    `Payment due: ${ISO_DAY(due)} (net 14 days)`,
    "",
    `From: ${input.seller}, 1 Sample Street, Placeholder City`,
    `To: ${input.customer}`,
    "",
    ...lines,
    "",
    `Subtotal: EUR ${money(net)}`,
    `VAT 19%: EUR ${money(vat)}`,
    `Total due: EUR ${money(net + vat)}`,
    "",
    "Thank you for your order.",
    "Sample document for the Restow demo. Not a real invoice.",
  ]);
}

export function reportPdf(
  rng: Rng,
  input: { company: string; year: number; month: number },
): Buffer {
  const orders = randomInt(rng, 120, 480);
  const revenue = orders * randomInt(rng, 85, 240);
  const returns = randomInt(rng, 2, 18);
  return buildPdf([
    `Monthly report - ${monthName(input.month)} ${input.year}`,
    input.company,
    "",
    `Orders received: ${orders}`,
    `Revenue: EUR ${grouped(revenue)}`,
    `Returns: ${returns}`,
    `Average order value: EUR ${(revenue / orders).toFixed(2)}`,
    "",
    "Top products",
    `1. ${productOf(rng)}`,
    `2. ${productOf(rng)}`,
    `3. ${productOf(rng)}`,
    "",
    "Comments",
    `Deliveries were on time in ${randomInt(rng, 91, 99)} percent of the cases.`,
    "Stock levels are within the planned range.",
    "",
    "Sample document for the Restow demo. All figures are made up.",
  ]);
}

export function contractPdf(
  rng: Rng,
  input: { company: string; partner: string; date: Date; subject: string },
): Buffer {
  return buildPdf([
    input.subject.toUpperCase(),
    "",
    `Between ${input.company} and ${input.partner}`,
    `Effective date: ${ISO_DAY(input.date)}`,
    "",
    "1. Scope. The supplier delivers the agreed goods and services",
    "   as listed in the annex.",
    `2. Prices. Prices are fixed for ${randomInt(rng, 6, 24)} months and quoted in EUR.`,
    `3. Payment. Invoices are paid within ${pick(rng, [14, 30, 45])} days of receipt.`,
    "4. Liability. Each party is liable for intent and gross negligence.",
    `5. Term. This agreement runs for ${randomInt(rng, 1, 3)} year(s) and renews once.`,
    "6. Law. The law of the place of the buyer applies.",
    "",
    `Signed for ${input.company}: Jane Doe`,
    `Signed for ${input.partner}: John Sample`,
    "",
    "Sample document for the Restow demo. Not a real contract.",
  ]);
}

export function proposalPdf(
  rng: Rng,
  input: { company: string; client: string; project: string; date: Date },
): Buffer {
  const days = randomInt(rng, 6, 40);
  const rate = pick(rng, [720, 780, 840, 900]);
  return buildPdf([
    `PROPOSAL - ${input.project}`,
    "",
    `Prepared for ${input.client} by ${input.company}`,
    `Date: ${ISO_DAY(input.date)}`,
    "",
    "Scope",
    "- Workshop with the project team",
    "- Analysis of the current situation",
    "- Written recommendations and a presentation",
    "",
    "Timeline",
    `${days} consulting days over ${Math.ceil(days / 3)} weeks.`,
    "",
    "Fee",
    `${days} days at EUR ${rate}.00 = EUR ${money(days * rate)} plus VAT.`,
    "",
    "This proposal is valid for 30 days.",
    "Sample document for the Restow demo. Not a real offer.",
  ]);
}

// ---------------------------------------------------------------------------
// Notes and plans
// ---------------------------------------------------------------------------

const TOPICS = [
  "budget",
  "timeline",
  "open questions",
  "next steps",
  "risks",
  "suppliers",
  "staffing",
] as const;
const PEOPLE = ["Jane Doe", "John Sample", "Alex Placeholder", "Sam Template"] as const;

export function meetingNotes(rng: Rng, project: string, date: Date): string {
  const topics = [pick(rng, TOPICS), pick(rng, TOPICS), pick(rng, TOPICS)];
  return [
    `Meeting notes: ${project}`,
    `Date: ${ISO_DAY(date)}`,
    `Attendees: ${PEOPLE.slice(0, randomInt(rng, 2, 4)).join(", ")}`,
    "",
    ...topics.map(
      (topic, index) =>
        `${index + 1}. ${topic}: agreed, ${pick(rng, PEOPLE)} follows up by Friday.`,
    ),
    "",
    "This is sample data for the Restow demo. Nothing here is real.",
    "",
  ].join("\n");
}

/** Notes that grow: the old text, then one more dated section. */
export function appendUpdate(rng: Rng, previous: string, date: Date): string {
  return `${previous.replace(/\n+$/, "")}\n\nUpdate ${ISO_DAY(date)}\n- ${pick(rng, TOPICS)}: ${pick(
    rng,
    ["on track", "needs a decision", "waiting for the supplier", "done"],
  )}.\n`;
}

export function readmeMarkdown(project: string): string {
  return `# ${project}\n\nFolder for everything about "${project}": notes, plans and documents.\n\n- \`meeting-notes.txt\`: what was decided\n- \`plan.md\`: tasks and owners\n\nSample data for the Restow demo, not real.\n`;
}

const TASKS = [
  "Confirm the budget with finance",
  "Book the meeting room",
  "Send the draft to the customer",
  "Collect two more quotes",
  "Update the project plan",
  "Review the contract",
  "Order the equipment",
  "Plan the hand-over",
] as const;

export function planMarkdown(rng: Rng, project: string, done: number): string {
  const tasks = shuffled(rng, TASKS).slice(0, 6);
  return [
    `# Plan: ${project}`,
    "",
    ...tasks.map((task, index) => `- [${index < done ? "x" : " "}] ${task} (${pick(rng, PEOPLE)})`),
    "",
  ].join("\n");
}

/** The plan with the next open task ticked off. */
export function tickNextTask(plan: string): string {
  return plan.replace("- [ ] ", "- [x] ");
}

export function todoText(rng: Rng, date: Date): string {
  const items = shuffled(rng, TASKS).slice(0, randomInt(rng, 3, 5));
  return `To do (${ISO_DAY(date)})\n\n${items.map((item) => `- ${item}`).join("\n")}\n\nSample data for the Restow demo.\n`;
}

export function workLogText(rng: Rng, previous: string, date: Date): string {
  const entry = `${ISO_DAY(date)}  ${pick(rng, [
    "Workshop prep",
    "Customer call",
    "Draft of the recommendations",
    "Travel",
    "Invoice run",
    "Reading and research",
  ])}, ${randomInt(rng, 2, 8)} h`;
  return previous.length === 0
    ? `Work log\n\n${entry}\n`
    : `${previous.replace(/\n+$/, "")}\n${entry}\n`;
}

// ---------------------------------------------------------------------------
// Configuration and logs
// ---------------------------------------------------------------------------

export function smbConf(variant: 0 | 1): string {
  return [
    "# Sample Samba configuration for the Restow demo (not a real service).",
    "[global]",
    "   workgroup = EXAMPLE",
    "   server string = Example Trading file server",
    "   security = user",
    `   max connections = ${variant === 0 ? 40 : 80}`,
    "   log file = /var/log/samba/log.%m",
    "   log level = 1",
    "   hosts allow = 192.0.2.0/24",
    "",
    "[share]",
    "   path = /srv/share",
    "   read only = no",
    "   valid users = @staff",
    "   create mask = 0660",
    ...(variant === 1
      ? [
          "",
          "[archive]",
          "   path = /srv/share/Archive",
          "   read only = yes",
          "   valid users = @staff",
        ]
      : []),
    "",
  ].join("\n");
}

const SMB_USERS = ["jdoe", "asample", "tplaceholder", "scheduler"] as const;
const SMB_FILES = [
  "Finance/Invoices",
  "Contracts",
  "Projects/Warehouse-move",
  "Projects/Website-relaunch",
  "Admin",
] as const;

/** `count` entries (two lines each) of a Samba log between `from` and `to`, in smbd's format. */
export function sambaLogEntries(rng: Rng, from: Date, to: Date, count: number): string[] {
  const span = Math.max(1, to.getTime() - from.getTime());
  const times = Array.from({ length: count }, () => from.getTime() + Math.floor(rng() * span)).sort(
    (a, b) => a - b,
  );
  return times.map((time) => {
    const date = new Date(time);
    const stamp = `${date.getUTCFullYear()}/${String(date.getUTCMonth() + 1).padStart(2, "0")}/${String(date.getUTCDate()).padStart(2, "0")} ${date.toISOString().slice(11, 19)}.${String(randomInt(rng, 0, 999_999)).padStart(6, "0")}`;
    const user = pick(rng, SMB_USERS);
    const host = `192.0.2.${randomInt(rng, 10, 80)}`;
    const pid = randomInt(rng, 1800, 9900);
    if (chance(rng, 0.7)) {
      return `[${stamp},  1] ../../source3/smbd/service.c:${randomInt(rng, 800, 900)}(make_connection_snum)\n  ${user} (ipv4:${host}:${randomInt(rng, 40_000, 60_000)}) connect to service share initially as user ${user} (uid=${randomInt(rng, 1001, 1020)}, gid=${randomInt(rng, 1001, 1020)}) (pid ${pid})`;
    }
    return `[${stamp},  1] ../../source3/smbd/close.c:${randomInt(rng, 400, 700)}(close_normal_file)\n  ${user} closed file ${pick(rng, SMB_FILES)}/ (numopen=${randomInt(rng, 0, 4)}) NT_STATUS_OK`;
  });
}

export function gitConfig(): string {
  return "[user]\n\tname = J. Doe\n\temail = j.doe@example.org\n[core]\n\teditor = nano\n[pull]\n\trebase = false\n";
}

export function zshrc(extraAlias: boolean): string {
  return [
    "# Sample shell configuration for the Restow demo.",
    'export PATH="$HOME/bin:$PATH"',
    "alias ll='ls -lah'",
    ...(extraAlias ? ["alias gs='git status'"] : []),
    "",
  ].join("\n");
}

export { companyOf };
