import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  appendUpdate,
  companyOf,
  contractPdf,
  gitConfig,
  invoicePdf,
  meetingNotes,
  planMarkdown,
  proposalPdf,
  readmeMarkdown,
  reportPdf,
  sambaLogEntries,
  slugOf,
  smbConf,
  tickNextTask,
  todoText,
  workLogText,
  zshrc,
} from "./endpoint-content.js";
import { generatedPng } from "./png.js";
import type { Rng } from "./prng.js";
import { chance, mulberry32, pick, randomInt, seedFrom } from "./prng.js";
import { localToUtc, zonedParts } from "./tz.js";

/**
 * The simulated machines of the public demo and what is on their disks, day
 * by day (deploy/demo/README.md, "Simulated machines"): one Linux file server
 * of Example Trading Ltd and one MacBook of Birchwood Consulting Ltd. The seed
 * plays the Restow agent for both (endpoint-history.ts): it writes each
 * machine's files to the paths below, backs them up with real restic and
 * reports to the real agent API, once per simulated day, with files added,
 * changed and removed in between.
 *
 * This module only plans (pure and deterministic for a seed, a clock and a
 * list of screenshots) and writes the planned changes to disk. Nothing here is
 * real: documents, notes, logs and configuration are generated English
 * placeholders on reserved example domains and documentation addresses, and
 * the pictures are screenshots of this demo itself (docs/images/screenshots,
 * fictional data only) or tiny generated charts.
 */

export interface DemoMachine {
  /** The machine's hostname: what it enrolls as and what restic stores in its snapshots. */
  hostname: string;
  displayName: string;
  kind: "server" | "client";
  /** The demo tenant (company.ts slug) the machine belongs to. */
  tenantSlug: string;
  /** What the agent reports: `runtime.GOOS` and `runtime.GOARCH`. */
  os: "linux" | "darwin";
  arch: "amd64" | "arm64";
  osVersion: string;
  /** The folders the agent is configured to back up (absolute paths on the machine). */
  paths: readonly string[];
  /** The zone the machine's schedule is read in (the tenant's, Europe/Berlin by default). */
  timeZone: string;
}

export const DEMO_MACHINES: readonly DemoMachine[] = [
  {
    hostname: "fileserver-01",
    displayName: "Main file server",
    kind: "server",
    tenantSlug: "example-trading",
    os: "linux",
    arch: "amd64",
    osVersion: "Debian GNU/Linux 12 (bookworm), kernel 6.1.0-37-amd64",
    paths: ["/srv/share", "/etc/samba", "/var/log/samba"],
    timeZone: "Europe/Berlin",
  },
  {
    hostname: "laptop-jdoe",
    displayName: "J. Doe's MacBook Pro",
    kind: "client",
    tenantSlug: "birchwood-consulting",
    os: "darwin",
    arch: "arm64",
    osVersion: "macOS 15.6 (24G84)",
    paths: ["/Users/jdoe"],
    timeZone: "Europe/Berlin",
  },
];

export type FileContent = Buffer | { screenshot: string };

export interface PlannedFile {
  /** Absolute path on the simulated machine. */
  path: string;
  content: FileContent;
  mtime: Date;
}

export type FileOp = { op: "put"; file: PlannedFile } | { op: "remove"; path: string };

/** One backup of one machine: the changes since the previous one, then the snapshot at `at`. */
export interface SnapshotStep {
  machine: string;
  /** 0 is the first backup of the machine, which writes its whole tree. */
  index: number;
  /** The simulated moment of the backup (restic's `--time`). */
  at: Date;
  ops: FileOp[];
}

export interface PlanOptions {
  seed: number;
  now: Date;
  /** How many simulated days the history spans (0: one backup, now). */
  days: number;
  /** Names of the PNG files in the screenshot folder. */
  screenshots: readonly string[];
  machines?: readonly DemoMachine[];
}

const HOUR_MS = 3600_000;
const DAY_MS = 24 * HOUR_MS;

/** A machine's path on this computer: the simulated root, then the path. */
export function hostPath(root: string, path: string): string {
  return root === "/" ? path : join(root, path);
}

// ---------------------------------------------------------------------------
// The file tree as it is built up
// ---------------------------------------------------------------------------

class Tree {
  readonly files = new Map<string, { content: FileContent; mtime: Date }>();
  readonly texts = new Map<string, string>();
  private pending: FileOp[] = [];

  put(path: string, content: FileContent, mtime: Date): void {
    this.files.set(path, { content, mtime });
    this.texts.delete(path);
    this.pending.push({ op: "put", file: { path, content, mtime } });
  }

  putText(path: string, text: string, mtime: Date): void {
    this.put(path, Buffer.from(text, "utf8"), mtime);
    this.texts.set(path, text);
  }

  remove(path: string): void {
    if (this.files.delete(path)) {
      this.texts.delete(path);
      this.pending.push({ op: "remove", path });
    }
  }

  has(path: string): boolean {
    return this.files.has(path);
  }

  /** The changes since the last call. */
  flush(): FileOp[] {
    const ops = this.pending;
    this.pending = [];
    return ops;
  }
}

const pad = (value: number, width: number): string => String(value).padStart(width, "0");

/** A moment `minAgo` to `maxAgo` before `at`, never in the future. */
function before(rng: Rng, at: Date, minAgoMs: number, maxAgoMs: number): Date {
  return new Date(at.getTime() - randomInt(rng, minAgoMs, maxAgoMs));
}

/** A moment in working hours (09:00-17:59 local) `daysAgo` days before `at`. */
function workMoment(rng: Rng, at: Date, daysAgo: number, timeZone: string): Date {
  const day = zonedParts(new Date(at.getTime() - daysAgo * DAY_MS), timeZone);
  const start = localToUtc(
    day.year,
    day.month,
    day.day,
    randomInt(rng, 9, 17),
    randomInt(rng, 0, 59),
    timeZone,
  );
  return new Date(start.getTime() + randomInt(rng, 0, 59) * 1000);
}

function pickScreenshot(rng: Rng, screenshots: readonly string[]): FileContent {
  if (screenshots.length > 0 && chance(rng, 0.7)) {
    return { screenshot: pick(rng, screenshots) };
  }
  return generatedPng(rng);
}

/** Monday-to-Friday check on the wall-clock date of `at` in `timeZone`. */
function isWeekday(at: Date, timeZone: string): boolean {
  const p = zonedParts(at, timeZone);
  const day = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
  return day !== 0 && day !== 6;
}

// ---------------------------------------------------------------------------
// When the machines back up
// ---------------------------------------------------------------------------

/**
 * Pure: the moments of a machine's backups, oldest first. A server backs up
 * every night at 22:00 in its zone (the product's default), a laptop on
 * working days in the late afternoon, a day now and then missed because the
 * lid was shut. No moment lies after `now` (minus a few minutes).
 */
export function backupTimes(machine: DemoMachine, options: PlanOptions, rng: Rng): Date[] {
  const latest = options.now.getTime() - 5 * 60_000;
  if (options.days <= 0) {
    return [new Date(latest)];
  }
  const times: Date[] = [];
  for (let ago = options.days - 1; ago >= 0; ago--) {
    const day = zonedParts(new Date(options.now.getTime() - ago * DAY_MS), machine.timeZone);
    let at: Date;
    if (machine.kind === "server") {
      at = localToUtc(day.year, day.month, day.day, 22, 0, machine.timeZone);
      at = new Date(at.getTime() + randomInt(rng, 0, 25) * 60_000 + randomInt(rng, 0, 59) * 1000);
    } else {
      const weekday = new Date(Date.UTC(day.year, day.month - 1, day.day)).getUTCDay();
      const missed = chance(rng, 0.12);
      if (weekday === 0 || weekday === 6 || missed) {
        continue;
      }
      at = localToUtc(
        day.year,
        day.month,
        day.day,
        randomInt(rng, 16, 18),
        randomInt(rng, 0, 59),
        machine.timeZone,
      );
      at = new Date(at.getTime() + randomInt(rng, 0, 59) * 1000);
    }
    if (at.getTime() <= latest) {
      times.push(at);
    }
  }
  return times.length > 0 ? times : [new Date(latest)];
}

// ---------------------------------------------------------------------------
// The file server
// ---------------------------------------------------------------------------

const SERVER_COMPANY = "Example Trading Ltd";
const PROJECTS = ["Warehouse move", "Website relaunch", "Supplier review", "Annual inventory"];
const projectFolder = (project: string) => `/srv/share/Projects/${project.replace(/\s+/g, "-")}`;
const LOG = "/var/log/samba/log.smbd";

interface ServerState {
  invoiceNumber: number;
  logText: string;
  removals: Map<number, string[]>;
  draftNumber: number;
}

function addInvoice(tree: Tree, rng: Rng, state: ServerState, date: Date): void {
  const customer = companyOf(rng);
  const number = `INV-${date.getUTCFullYear()}-${pad(state.invoiceNumber++, 4)}`;
  tree.put(
    `/srv/share/Finance/Invoices/${date.getUTCFullYear()}/${number}-${slugOf(customer)}.pdf`,
    invoicePdf(rng, { seller: SERVER_COMPANY, customer, number, date }),
    date,
  );
}

function addMonthlyReport(tree: Tree, rng: Rng, year: number, month: number, mtime: Date): void {
  tree.put(
    `/srv/share/Finance/Reports/Monthly-report-${year}-${pad(month + 1, 2)}.pdf`,
    reportPdf(rng, { company: SERVER_COMPANY, year, month }),
    mtime,
  );
}

function addContract(tree: Tree, rng: Rng, date: Date): void {
  const partner = companyOf(rng);
  const kind = pick(rng, ["Supply agreement", "Service contract", "Framework agreement"]);
  tree.put(
    `/srv/share/Contracts/${slugOf(kind)}-${slugOf(partner)}-${date.getUTCFullYear()}.pdf`,
    contractPdf(rng, { company: SERVER_COMPANY, partner, date, subject: kind }),
    date,
  );
}

function initialServerTree(
  tree: Tree,
  rng: Rng,
  at: Date,
  state: ServerState,
  screenshots: readonly string[],
  timeZone: string,
): void {
  const old = (minDays: number, maxDays: number) =>
    workMoment(rng, at, randomInt(rng, minDays, maxDays), timeZone);
  tree.putText("/etc/samba/smb.conf", smbConf(0), old(150, 400));
  for (let index = 0; index < 7; index++) {
    addInvoice(tree, rng, state, old(3, 70));
  }
  for (let back = 1; back <= 3; back++) {
    const first = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() - back, 1));
    const written = Date.UTC(
      first.getUTCFullYear(),
      first.getUTCMonth() + 1,
      randomInt(rng, 1, 4),
      9,
    );
    addMonthlyReport(
      tree,
      rng,
      first.getUTCFullYear(),
      first.getUTCMonth(),
      new Date(Math.min(written, at.getTime() - 2 * HOUR_MS)),
    );
  }
  for (let index = 0; index < 3; index++) {
    addContract(tree, rng, old(30, 330));
  }
  for (const project of PROJECTS) {
    const folder = projectFolder(project);
    const noted = old(2, 60);
    tree.putText(`${folder}/meeting-notes.txt`, meetingNotes(rng, project, noted), noted);
    tree.putText(`${folder}/README.md`, readmeMarkdown(project), old(100, 200));
    tree.putText(`${folder}/plan.md`, planMarkdown(rng, project, randomInt(rng, 1, 3)), old(5, 40));
  }
  tree.putText(
    "/srv/share/Admin/IT-usage-policy.md",
    "# IT usage policy\n\n1. Keep files on the share, not on the desktop.\n2. Lock your screen when you leave.\n3. Report anything odd to it@example.org.\n\nSample data for the Restow demo.\n",
    old(120, 300),
  );
  tree.putText(
    "/srv/share/Admin/Price-list-2026.txt",
    "Price list 2026 (sample data)\n\nBinders, 500 pieces: EUR 89.00\nLabel printer XT-200: EUR 149.00\nPacking tape, 24 rolls: EUR 36.50\nThermal paper, 40 rolls: EUR 62.00\n",
    old(20, 90),
  );
  const shots = [...screenshots].sort();
  for (const [index, name] of shots.slice(0, 2).entries()) {
    tree.put(
      `/srv/share/Marketing/Screenshots/restow-${name}`,
      { screenshot: name },
      old(10 + index, 50),
    );
  }
  if (shots.length === 0) {
    tree.put(
      "/srv/share/Marketing/Screenshots/dashboard-overview.png",
      generatedPng(rng),
      old(10, 50),
    );
  }
  state.logText = `${sambaLogEntries(rng, new Date(at.getTime() - 2 * DAY_MS), at, 40).join("\n")}\n`;
  tree.putText(LOG, state.logText, new Date(at.getTime() - 60_000));
}

function evolveServer(
  tree: Tree,
  rng: Rng,
  at: Date,
  previous: Date,
  index: number,
  stepCount: number,
  machine: DemoMachine,
  state: ServerState,
): void {
  const weekday = isWeekday(at, machine.timeZone);
  const work = () => before(rng, at, 4 * HOUR_MS, 11 * HOUR_MS);
  if (weekday) {
    for (let count = randomInt(rng, 1, 3); count > 0; count--) {
      addInvoice(tree, rng, state, work());
    }
  } else if (chance(rng, 0.15)) {
    addInvoice(tree, rng, state, work());
  }
  if (chance(rng, 0.4)) {
    const path = `${projectFolder(pick(rng, PROJECTS))}/meeting-notes.txt`;
    const text = tree.texts.get(path);
    if (text !== undefined) {
      const when = work();
      tree.putText(path, appendUpdate(rng, text, when), when);
    }
  }
  if (chance(rng, 0.3)) {
    const path = `${projectFolder(pick(rng, PROJECTS))}/plan.md`;
    const text = tree.texts.get(path);
    if (text?.includes("- [ ] ")) {
      tree.putText(path, tickNextTask(text), work());
    }
  }
  if (zonedParts(at, machine.timeZone).month !== zonedParts(previous, machine.timeZone).month) {
    const last = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() - 1, 1));
    addMonthlyReport(tree, rng, last.getUTCFullYear(), last.getUTCMonth(), work());
  }
  if (chance(rng, 0.12)) {
    addContract(tree, rng, work());
  }
  if (chance(rng, 0.25)) {
    state.draftNumber += 1;
    const path = `/srv/share/Drafts/offer-draft-${state.draftNumber}.txt`;
    tree.putText(
      path,
      `Draft offer ${state.draftNumber}\n\nTo be finished. Sample data.\n`,
      work(),
    );
    const removeAt = index + randomInt(rng, 2, 5);
    state.removals.set(removeAt, [...(state.removals.get(removeAt) ?? []), path]);
  }
  for (const path of state.removals.get(index) ?? []) {
    tree.remove(path);
  }
  if (index === Math.floor(stepCount * 0.6)) {
    tree.putText("/etc/samba/smb.conf", smbConf(1), work());
  }
  const entries = sambaLogEntries(
    rng,
    previous,
    at,
    weekday ? randomInt(rng, 25, 60) : randomInt(rng, 6, 16),
  );
  if (index % 7 === 0) {
    // Weekly rotation: the old log moves aside, a new one starts.
    tree.putText(`${LOG}.1`, state.logText, new Date(at.getTime() - 90_000));
    state.logText = `${entries.join("\n")}\n`;
  } else {
    state.logText = `${state.logText}${entries.join("\n")}\n`;
  }
  tree.putText(LOG, state.logText, new Date(at.getTime() - 60_000));
}

function planServer(machine: DemoMachine, options: PlanOptions): SnapshotStep[] {
  const rng = mulberry32(seedFrom(`${options.seed}:endpoint:${machine.hostname}`));
  const times = backupTimes(machine, options, rng);
  const tree = new Tree();
  const state: ServerState = {
    invoiceNumber: randomInt(rng, 380, 420),
    logText: "",
    removals: new Map(),
    draftNumber: 0,
  };
  return times.map((at, index) => {
    const previous = times[index - 1];
    if (previous === undefined) {
      initialServerTree(tree, rng, at, state, options.screenshots, machine.timeZone);
    } else {
      evolveServer(tree, rng, at, previous, index, times.length, machine, state);
    }
    return { machine: machine.hostname, index, at, ops: tree.flush() };
  });
}

// ---------------------------------------------------------------------------
// The laptop
// ---------------------------------------------------------------------------

const HOME = "/Users/jdoe";
const LAPTOP_COMPANY = "Birchwood Consulting Ltd";
const CLIENTS = [
  "Harbour Street Supplies Ltd",
  "Riverside Example Co.",
  "Oakfield Placeholder Ltd",
] as const;
const CLIENT_PROJECTS = ["Process review", "Supplier workshop", "Quarterly planning"] as const;

interface ClientState {
  invoiceNumber: number;
  workLog: string;
  desktop: string[];
}

/** macOS names a screenshot after the local date and time it was taken. */
export function screenshotName(taken: Date, timeZone: string): string {
  const p = zonedParts(taken, timeZone);
  return `Screenshot ${p.year}-${pad(p.month, 2)}-${pad(p.day, 2)} at ${pad(p.hour, 2)}.${pad(p.minute, 2)}.${pad(p.second, 2)}.png`;
}

function addDesktopScreenshot(
  tree: Tree,
  rng: Rng,
  state: ClientState,
  taken: Date,
  timeZone: string,
  screenshots: readonly string[],
): void {
  const path = `${HOME}/Desktop/${screenshotName(taken, timeZone)}`;
  tree.put(path, pickScreenshot(rng, screenshots), taken);
  state.desktop.push(path);
}

function addClientDocument(tree: Tree, rng: Rng, state: ClientState, date: Date): void {
  const client = pick(rng, CLIENTS);
  if (chance(rng, 0.5)) {
    const project = pick(rng, CLIENT_PROJECTS);
    tree.put(
      `${HOME}/Documents/Clients/${slugOf(client)}/Proposal-${slugOf(project)}-${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1, 2)}.pdf`,
      proposalPdf(rng, { company: LAPTOP_COMPANY, client, project, date }),
      date,
    );
    return;
  }
  const number = `INV-${date.getUTCFullYear()}-${pad(state.invoiceNumber++, 4)}`;
  tree.put(
    `${HOME}/Documents/Invoices/${number}-${slugOf(client)}.pdf`,
    invoicePdf(rng, { seller: LAPTOP_COMPANY, customer: client, number, date }),
    date,
  );
}

function initialLaptopTree(
  tree: Tree,
  rng: Rng,
  at: Date,
  state: ClientState,
  timeZone: string,
  screenshots: readonly string[],
): void {
  const old = (minDays: number, maxDays: number) =>
    workMoment(rng, at, randomInt(rng, minDays, maxDays), timeZone);
  for (const [index, client] of CLIENTS.entries()) {
    const folder = `${HOME}/Documents/Clients/${slugOf(client)}`;
    const project = CLIENT_PROJECTS[index] as string;
    const date = old(20, 120);
    tree.put(
      `${folder}/Proposal-${slugOf(project)}-${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1, 2)}.pdf`,
      proposalPdf(rng, { company: LAPTOP_COMPANY, client, project, date }),
      date,
    );
    const kickoff = old(10, 90);
    tree.putText(
      `${folder}/Kickoff-notes.md`,
      `# Kickoff: ${client}\n\n${meetingNotes(rng, project, kickoff)}`,
      kickoff,
    );
  }
  for (let count = 0; count < 3; count++) {
    addClientDocument(tree, rng, state, old(3, 60));
  }
  tree.putText(
    `${HOME}/Documents/Notes/ideas.md`,
    "# Ideas\n\n- A one-page checklist for supplier reviews\n- Offer a half-day workshop on planning\n- Write up the lessons of the last project\n\nSample data for the Restow demo.\n",
    old(15, 80),
  );
  tree.putText(
    `${HOME}/Documents/Templates/proposal-outline.md`,
    "# Proposal outline\n\n1. Starting point\n2. Scope and approach\n3. Timeline\n4. Fee and terms\n\nSample data for the Restow demo.\n",
    old(100, 300),
  );
  tree.putText(
    `${HOME}/Documents/Templates/invoice-checklist.txt`,
    "Before sending an invoice\n\n- Customer and address correct\n- Hours match the work log\n- Payment terms set\n",
    old(100, 300),
  );
  tree.putText(
    `${HOME}/Documents/Notes/reading-list.md`,
    "# Reading list\n\n- Project planning for small teams\n- Negotiation basics\n- A short guide to good meetings\n",
    old(30, 120),
  );
  tree.putText(
    `${HOME}/Documents/todo.txt`,
    todoText(rng, at),
    before(rng, at, HOUR_MS, 20 * HOUR_MS),
  );
  state.workLog = workLogText(rng, "", new Date(at.getTime() - 2 * DAY_MS));
  tree.putText(
    `${HOME}/Documents/work-log.txt`,
    state.workLog,
    before(rng, at, HOUR_MS, 6 * HOUR_MS),
  );
  tree.putText(`${HOME}/.gitconfig`, gitConfig(), old(200, 500));
  tree.putText(`${HOME}/.zshrc`, zshrc(false), old(150, 400));
  for (let count = 0; count < 2; count++) {
    addDesktopScreenshot(tree, rng, state, old(1, 12), timeZone, screenshots);
    const taken = old(20, 70);
    tree.put(
      `${HOME}/Pictures/Screenshots/${screenshotName(taken, timeZone)}`,
      pickScreenshot(rng, screenshots),
      taken,
    );
  }
}

function evolveLaptop(
  tree: Tree,
  rng: Rng,
  at: Date,
  index: number,
  stepCount: number,
  machine: DemoMachine,
  state: ClientState,
  screenshots: readonly string[],
): void {
  const sinceMorning = () => before(rng, at, 20 * 60_000, 7 * HOUR_MS);
  if (chance(rng, 0.6)) {
    const when = sinceMorning();
    const client = pick(rng, CLIENTS);
    const project = pick(rng, CLIENT_PROJECTS);
    tree.putText(
      `${HOME}/Documents/Notes/${when.toISOString().slice(0, 10)}-call-${slugOf(client).split("-")[0]?.toLowerCase()}.md`,
      `# Call with ${client}\n\n${meetingNotes(rng, project, when)}`,
      when,
    );
  }
  if (chance(rng, 0.8)) {
    tree.putText(`${HOME}/Documents/todo.txt`, todoText(rng, at), sinceMorning());
  }
  state.workLog = workLogText(rng, state.workLog, at);
  tree.putText(
    `${HOME}/Documents/work-log.txt`,
    state.workLog,
    before(rng, at, 5 * 60_000, 30 * 60_000),
  );
  if (chance(rng, 0.4)) {
    addDesktopScreenshot(tree, rng, state, sinceMorning(), machine.timeZone, screenshots);
  }
  if (chance(rng, 0.25)) {
    addClientDocument(tree, rng, state, sinceMorning());
  }
  if (index % 5 === 0 && state.desktop.length > 2) {
    // Tidying up: the oldest screenshot moves from the desktop to the pictures folder, another one goes.
    const moved = state.desktop.shift() as string;
    const entry = tree.files.get(moved);
    if (entry) {
      tree.remove(moved);
      tree.put(
        `${HOME}/Pictures/Screenshots/${moved.split("/").pop()}`,
        entry.content,
        entry.mtime,
      );
    }
    const dropped = state.desktop.shift();
    if (dropped && chance(rng, 0.6)) {
      tree.remove(dropped);
    } else if (dropped) {
      state.desktop.unshift(dropped);
    }
  }
  if (index === Math.floor(stepCount * 0.5)) {
    tree.putText(`${HOME}/.zshrc`, zshrc(true), sinceMorning());
  }
}

function planLaptop(machine: DemoMachine, options: PlanOptions): SnapshotStep[] {
  const rng = mulberry32(seedFrom(`${options.seed}:endpoint:${machine.hostname}`));
  const times = backupTimes(machine, options, rng);
  const tree = new Tree();
  const state: ClientState = { invoiceNumber: randomInt(rng, 20, 60), workLog: "", desktop: [] };
  return times.map((at, index) => {
    if (index === 0) {
      initialLaptopTree(tree, rng, at, state, machine.timeZone, options.screenshots);
    } else {
      evolveLaptop(tree, rng, at, index, times.length, machine, state, options.screenshots);
    }
    return { machine: machine.hostname, index, at, ops: tree.flush() };
  });
}

// ---------------------------------------------------------------------------
// Public planning and writing
// ---------------------------------------------------------------------------

/** Every backup of every machine, oldest first: deterministic for a seed, a clock and the screenshots. */
export function planEndpointHistory(options: PlanOptions): SnapshotStep[] {
  const steps = (options.machines ?? DEMO_MACHINES).flatMap((machine) =>
    machine.kind === "server" ? planServer(machine, options) : planLaptop(machine, options),
  );
  return steps.sort(
    (a, b) => a.at.getTime() - b.at.getTime() || a.machine.localeCompare(b.machine),
  );
}

/** The PNG screenshots in `dir` (none when the folder is missing), sorted. */
export function screenshotsIn(dir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter((name) => name.endsWith(".png"))
    .sort();
}

/**
 * The folders the simulation writes into must be empty (or missing): the
 * compose file mounts a fresh tmpfs on each, and a seed run by hand against a
 * real directory must never mix its sample files into somebody's data.
 */
export function assertEmptyRoots(root: string, machines: readonly DemoMachine[]): void {
  for (const machine of machines) {
    for (const path of machine.paths) {
      const dir = hostPath(root, path);
      if (existsSync(dir) && readdirSync(dir).length > 0) {
        throw new Error(
          `${dir} is not empty: the demo's simulated machines only write into empty folders (deploy/demo/README.md)`,
        );
      }
    }
  }
}

/** Create `dir` and the folders above it that are missing; returns the ones that were created. */
function makeDirectories(dir: string): string[] {
  const missing: string[] = [];
  for (let current = dir; !existsSync(current); current = dirname(current)) {
    missing.push(current);
  }
  mkdirSync(dir, { recursive: true });
  return missing;
}

/**
 * Apply a step's changes under `root`, with their modification times. The
 * folders a change touches get the time of the change too (a folder's own
 * modification time is the last time something was added to or removed from
 * it), so a browser of the snapshot shows the day of the change and not the
 * moment the seed ran.
 */
export function applyOps(
  root: string,
  ops: readonly FileOp[],
  screenshotDir: string,
  /** The moment of the backup: the time of a removal. */
  at?: Date,
): { written: number; removed: number } {
  let written = 0;
  let removed = 0;
  const folderTimes = new Map<string, number>();
  const touch = (dir: string, time: Date) => {
    folderTimes.set(dir, Math.max(folderTimes.get(dir) ?? 0, time.getTime()));
  };
  for (const op of ops) {
    if (op.op === "remove") {
      const target = hostPath(root, op.path);
      rmSync(target, { force: true });
      removed += 1;
      touch(dirname(target), at ?? new Date());
      continue;
    }
    const target = hostPath(root, op.file.path);
    for (const created of makeDirectories(dirname(target))) {
      touch(dirname(created), op.file.mtime);
      touch(created, op.file.mtime);
    }
    const existed = existsSync(target);
    if (Buffer.isBuffer(op.file.content)) {
      writeFileSync(target, op.file.content);
    } else {
      copyFileSync(join(screenshotDir, op.file.content.screenshot), target);
    }
    utimesSync(target, op.file.mtime, op.file.mtime);
    if (!existed) {
      touch(dirname(target), op.file.mtime);
    }
    written += 1;
  }
  for (const [dir, time] of folderTimes) {
    try {
      utimesSync(dir, new Date(time), new Date(time));
    } catch {
      // A folder the seed does not own (a parent of a mount point) keeps its time.
    }
  }
  return { written, removed };
}
