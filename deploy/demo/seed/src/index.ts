import { seedInstallation } from "./api-seed.js";
import { seedArchive } from "./archive-seed.js";
import { type RunWindow, backdateRuns, databaseNow, simulatedTargets } from "./backdate.js";
import { DEMO_TENANTS, allMailboxes, mailboxesMissingFrom } from "./company.js";
import { runEndpointPhase } from "./endpoint-history.js";
import { generateDemoMail, planWave, writeMessages } from "./generate-mail.js";
import { runRound } from "./history.js";

/**
 * CLI entrypoint of the demo seed (deploy/demo/README.md, deploy/demo/reset.sh):
 *
 *   1. generate the synthetic mail corpus straight into the Dovecot mail
 *      volume (generate-mail.ts, maildir.ts) — no IMAP connection needed;
 *   2. bootstrap the installation over the real API (api-seed.ts): setup,
 *      the demo tenants, their IMAP sources and protected mailboxes, the
 *      recommended schedules, and the first backup + verification;
 *   3. the history (history.ts, backdate.ts): one round per simulated day —
 *      that day's new mail, a real backup of every mailbox, verification,
 *      now and then a download restore — then every round is moved back to
 *      its day, so the charts show weeks of history
 *      (`RESTOW_DEMO_HISTORY_DAYS`, 0 switches it off);
 *   4. the simulated machines (endpoint-history.ts): the seed plays the
 *      Restow agent for a Linux file server and a MacBook, backs their files
 *      up with real restic through the real agent API, once per simulated day,
 *      has the server prove every backup restorable and moves the history back
 *      to its days (`RESTOW_DEMO_ENDPOINT_ROOT` switches it on);
 *   5. the mail archive (archive-seed.ts): one mailbox per tenant is imported
 *      with archiving, a legal hold is placed on one of them.
 *
 * Run inside the demo compose only (`deploy/demo/docker-compose.yml`), never
 * against a production installation: every write it makes needs the demo
 * guard's seed-bypass token, which a normal installation never sets.
 */

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required for the demo seed`);
  }
  return value;
}

function optionalEnv(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : fallback;
}

function log(message: string): void {
  console.log(`[demo-seed] ${message}`);
}

async function main(): Promise<void> {
  const apiBaseUrl = requireEnv("RESTOW_API_URL");
  const publicUrl = requireEnv("RESTOW_PUBLIC_URL");
  const adminEmail = requireEnv("RESTOW_DEMO_EMAIL");
  const adminPassword = requireEnv("RESTOW_DEMO_PASSWORD");
  const seedToken = requireEnv("RESTOW_DEMO_SEED_TOKEN");
  const imapPassword = requireEnv("RESTOW_DEMO_IMAP_PASSWORD");
  const imapHost = optionalEnv("RESTOW_DEMO_IMAP_HOST", "dovecot");
  const imapPort = Number.parseInt(optionalEnv("RESTOW_DEMO_IMAP_PORT", "143"), 10);
  const mailRoot = optionalEnv("RESTOW_DEMO_MAIL_ROOT", "/var/mail/vhosts");
  const mailSeed = Number.parseInt(optionalEnv("RESTOW_DEMO_MAIL_SEED", "20260101"), 10);
  const messagesPerMailbox = Number.parseInt(
    optionalEnv("RESTOW_DEMO_MESSAGES_PER_MAILBOX", "100"),
    10,
  );
  const jobTimeoutMs = Number.parseInt(optionalEnv("RESTOW_DEMO_JOB_TIMEOUT_MS", "300000"), 10);
  const historyDays = Math.max(
    0,
    Number.parseInt(optionalEnv("RESTOW_DEMO_HISTORY_DAYS", "30"), 10) || 0,
  );
  const missing = mailboxesMissingFrom(requireEnv("RESTOW_DEMO_MAILBOXES"));
  if (missing.length > 0) {
    throw new Error(
      `RESTOW_DEMO_MAILBOXES does not list ${missing.join(", ")}; set it to ${allMailboxes()
        .map((mailbox) => mailbox.login)
        .join(",")} in deploy/demo/.env and restart the dovecot container`,
    );
  }
  // Only the history needs the database (backdate.ts): the installation
  // role, which may update every tenant's rows.
  const databaseUrl = historyDays > 0 ? requireEnv("DATABASE_PROVIDER_URL") : "";

  // The simulated machines (endpoint-history.ts): only where the demo compose project
  // gives the seed their folders (an empty tmpfs on each) and a restic binary.
  const endpointRoot = process.env.RESTOW_DEMO_ENDPOINT_ROOT?.trim();
  const startedAt = new Date();

  log("generating the synthetic mail corpus...");
  const generated = generateDemoMail(mailRoot, {
    seed: mailSeed,
    messagesPerMailbox,
    historyDays,
    now: startedAt,
  });
  log(`wrote ${generated.messages} messages across ${generated.mailboxes} mailboxes`);

  const windows: Array<Omit<RunWindow, "target">> = [];
  let windowStart = historyDays > 0 ? await databaseNow(databaseUrl) : new Date();

  log("seeding the installation over the api...");
  const result = await seedInstallation(
    {
      apiBaseUrl,
      publicUrl,
      adminName: "Demo Administrator",
      adminEmail,
      adminPassword,
      seedToken,
      imapHost,
      imapPort,
      imapPassword,
      jobTimeoutMs,
    },
    log,
  );

  log(`tenants: ${result.tenants.map((tenant) => tenant.name).join(", ")}`);
  log(`backups: ${result.backupsCompleted} completed, ${result.backupsFailed} failed`);
  log(
    `verification: ${result.verificationsCompleted} completed, ${result.verificationsFailed} failed`,
  );

  if (result.backupsFailed > 0 || result.verificationsFailed > 0) {
    throw new Error("one or more demo backups or verifications did not complete successfully");
  }

  if (historyDays > 0) {
    let windowEnd = await databaseNow(databaseUrl);
    windows.push({ start: windowStart, end: windowEnd });
    // Each round's mail arrives between the previous round's simulated
    // backup and its own; the simulated days end at the last round, which
    // stays where it really ran.
    const planned = simulatedTargets(new Date(), historyDays + 1);
    let failures = 0;
    for (let round = 1; round <= historyDays; round++) {
      windowStart = windowEnd;
      const wave = planWave({
        seed: mailSeed,
        wave: round,
        from: planned[round - 1] as Date,
        to: planned[round] as Date,
      });
      writeMessages(mailRoot, wave, `demo-w${round}-`);
      log(`history day ${round}/${historyDays}: ${wave.length} new messages, backing up...`);
      const outcome = await runRound(result.client, result.tenants, round, jobTimeoutMs, log);
      failures += outcome.backupsFailed + outcome.verificationsFailed + outcome.restoresFailed;
      windowEnd = await databaseNow(databaseUrl);
      windows.push({ start: windowStart, end: windowEnd });
    }
    if (failures > 0) {
      throw new Error(`${failures} job(s) of the demo history did not complete successfully`);
    }
    // The newest round stays where it ran; every earlier one moves back by
    // whole days from there.
    const last = windows[windows.length - 1] as Omit<RunWindow, "target">;
    const targets = simulatedTargets(last.start, windows.length);
    await backdateRuns(
      databaseUrl,
      windows.map((w, i) => ({ ...w, target: targets[i] as Date })),
      log,
    );
  }

  const tenantIds = new Map(
    DEMO_TENANTS.map((tenant) => [
      tenant.slug,
      result.tenants.find((created) => created.name === tenant.name)?.id as string,
    ]),
  );

  if (endpointRoot) {
    log("backing up the simulated machines with the agent protocol and real restic...");
    const phaseStart = Date.now();
    const machines = await runEndpointPhase({
      client: result.client,
      tenants: tenantIds,
      apiBaseUrl,
      seedToken,
      root: endpointRoot,
      seed: mailSeed,
      now: new Date(),
      days: historyDays,
      screenshotDir: optionalEnv("RESTOW_DEMO_SCREENSHOT_DIR", "docs/images/screenshots"),
      resticBin: optionalEnv("RESTIC_BINARY", "restic"),
      workDir: optionalEnv("RESTOW_DEMO_AGENT_WORKDIR", "/tmp/restow-demo-agent"),
      statePath: process.env.RESTOW_DEMO_AGENT_STATE?.trim() || undefined,
      databaseUrl: historyDays > 0 ? databaseUrl : undefined,
      log,
    });
    for (const machine of machines.machines) {
      log(`${machine.hostname}: ${machine.snapshots} snapshots, readiness ${machine.state}`);
    }
    log(`simulated machines done in ${Math.round((Date.now() - phaseStart) / 1000)} s`);
    const notProven = machines.machines.filter((machine) => machine.state !== "green");
    if (notProven.length > 0) {
      throw new Error(
        `the simulated machines are not proven restorable: ${notProven
          .map((machine) => `${machine.hostname} (${machine.state})`)
          .join(", ")}`,
      );
    }
  }

  if (optionalEnv("RESTOW_DEMO_ARCHIVE", "true") !== "false") {
    log("filling the mail archive through the mail import...");
    const archive = await seedArchive({
      client: result.client,
      tenants: tenantIds,
      seed: mailSeed,
      historyDays,
      messagesPerMailbox,
      now: startedAt,
      jobTimeoutMs,
      log,
    });
    if (archive.failures > 0) {
      throw new Error("the mail archive import did not complete successfully");
    }
  }
  log("demo seed complete");
}

main().catch((error: unknown) => {
  console.error(`[demo-seed] failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
