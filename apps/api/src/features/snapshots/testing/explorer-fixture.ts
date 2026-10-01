/**
 * A small but realistic tenant for the Postgres-backed explorer and restore
 * tests: two mailboxes, a OneDrive and an IMAP account, with snapshots whose
 * manifest rows cover the cases the explorer must get right (folders that
 * exist only through their contents, attachments of JSON-format messages,
 * OneDrive's own versions, deleted items, an unfinished snapshot).
 *
 * The suites run when RESTOW_TEST_DATABASE_URL points at a Postgres server;
 * each one recreates its own scratch database there and drops it afterwards.
 */
import { randomUUID } from "node:crypto";
import {
  type Database,
  type NewManifestObjectRow,
  createDb,
  manifestObjects,
  protectedObjects,
  providers,
  snapshots,
  sources,
  tenants,
  user,
  users,
} from "@restow/db";
import { runMigrations } from "@restow/db/migrate";
import type { Viewer } from "../access.js";

export const testDatabaseAdminUrl = process.env.RESTOW_TEST_DATABASE_URL;

function withDatabase(base: string, name: string): string {
  const url = new URL(base);
  url.pathname = `/${name}`;
  return url.toString();
}

/** Drop and recreate `name` on the server of `base`, migrate it, return its URL. */
export async function recreateDatabase(base: string, name: string): Promise<string> {
  const admin = createDb(base);
  try {
    await admin.$client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.$client.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.$client.end();
  }
  const url = withDatabase(base, name);
  await runMigrations(url);
  return url;
}

/** How long a drop waits for the suite's own connections to finish closing. */
const DISCONNECT_WAIT_MS = 5_000;
const DISCONNECT_POLL_MS = 25;

/**
 * Wait until no session is connected to `name` any more, or the time is up.
 *
 * A pool's `end()` resolves before its connections have closed. A forced drop
 * in that moment terminates them, and each one answers with a FATAL
 * "terminating connection due to administrator command" that its ended pool
 * reports as an unhandled error, failing the run after every test passed.
 */
async function waitForDisconnect(admin: Database, name: string): Promise<void> {
  const deadline = Date.now() + DISCONNECT_WAIT_MS;
  while (Date.now() < deadline) {
    const { rows } = await admin.$client.query<{ sessions: number }>(
      "SELECT count(*)::int AS sessions FROM pg_stat_activity WHERE datname = $1",
      [name],
    );
    if ((rows[0]?.sessions ?? 0) === 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, DISCONNECT_POLL_MS));
  }
}

/**
 * Drop the suite's database once its pools are ended. FORCE only ends the
 * sessions still open after the wait, i.e. connections a suite leaked.
 */
export async function dropDatabase(base: string, name: string): Promise<void> {
  const admin = createDb(base);
  try {
    await waitForDisconnect(admin, name);
    await admin.$client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  } finally {
    await admin.$client.end();
  }
}

export interface ExplorerFixture {
  tenantId: string;
  admin: Viewer;
  anna: Viewer;
  bob: Viewer;
  annaMailbox: string;
  bobMailbox: string;
  annaDrive: string;
  imapAccount: string;
  /** Anna's mailbox: sequence 1 and 2 completed, 3 still running. */
  mailbox: { first: string; second: string; running: string };
  drive: string;
  imap: string;
  bobSnapshot: string;
}

function one<T>(rows: readonly T[]): T {
  const [first] = rows;
  if (first === undefined) {
    throw new Error("insert returned no row");
  }
  return first;
}

const day = (n: number) => new Date(Date.UTC(2026, 0, n, 8, 0, 0));

function row(
  base: Pick<NewManifestObjectRow, "tenantId" | "snapshotId" | "protectedObjectId">,
  path: string,
  kind: NewManifestObjectRow["kind"],
  extra: Partial<NewManifestObjectRow> = {},
): NewManifestObjectRow {
  const slash = path.lastIndexOf("/");
  return {
    ...base,
    kind,
    path,
    name: slash < 0 ? path : path.slice(slash + 1),
    parentPath: slash < 0 ? "" : path.slice(0, slash),
    size: kind === "folder" ? 0 : 100,
    chunkRefs: kind === "folder" ? null : [`chunk-${path}`],
    ...extra,
  };
}

async function signedInUser(db: Database, email: string, name: string): Promise<string> {
  const id = randomUUID();
  await db.insert(user).values({ id, name, email, emailVerified: true });
  return id;
}

export async function createExplorerFixture(db: Database): Promise<ExplorerFixture> {
  const provider = one(await db.insert(providers).values({ name: "Provider" }).returning());
  const tenant = one(
    await db
      .insert(tenants)
      .values({
        providerId: provider.id,
        name: "Contoso",
        slug: `contoso-${randomUUID().slice(0, 8)}`,
      })
      .returning(),
  );
  const tenantId = tenant.id;

  const m365 = one(
    await db
      .insert(sources)
      .values({ tenantId, kind: "m365", name: "Contoso M365", status: "active" })
      .returning(),
  );
  const imapSource = one(
    await db
      .insert(sources)
      .values({
        tenantId,
        kind: "imap",
        name: "Mail host",
        status: "active",
        host: "imap.example.test",
        port: 993,
        security: "tls",
      })
      .returning(),
  );

  const annaDir = one(
    await db
      .insert(users)
      .values({ tenantId, email: "anna@contoso.test", displayName: "Anna" })
      .returning(),
  );

  const object = async (
    values: Pick<typeof protectedObjects.$inferInsert, "sourceId" | "kind" | "externalId"> &
      Partial<typeof protectedObjects.$inferInsert>,
  ) => {
    return one(
      await db
        .insert(protectedObjects)
        .values({ tenantId, ...values })
        .returning(),
    ).id;
  };
  const annaMailbox = await object({
    sourceId: m365.id,
    kind: "mailbox",
    externalId: "anna@contoso.test",
    displayName: "Anna",
    userId: annaDir.id,
  });
  const bobMailbox = await object({
    sourceId: m365.id,
    kind: "mailbox",
    externalId: "bob@contoso.test",
    displayName: "Bob",
  });
  const annaDrive = await object({
    sourceId: m365.id,
    kind: "onedrive",
    externalId: "b!drive-anna",
    displayName: "Anna's OneDrive",
    userId: annaDir.id,
  });
  const imapAccount = await object({
    sourceId: imapSource.id,
    kind: "imap",
    externalId: "info@contoso.test",
    displayName: "Info",
  });

  const snapshot = async (protectedObjectId: string, sequence: number, completed: boolean) => {
    const created = one(
      await db
        .insert(snapshots)
        .values({
          tenantId,
          protectedObjectId,
          sequence,
          startedAt: day(sequence),
          completedAt: completed ? day(sequence) : null,
          manifestPath: completed ? `tenants/${tenantId}/manifests/${randomUUID()}` : null,
          itemCount: 10,
          byteSize: 1000,
        })
        .returning(),
    );
    return created.id;
  };
  const first = await snapshot(annaMailbox, 1, true);
  const second = await snapshot(annaMailbox, 2, true);
  const running = await snapshot(annaMailbox, 3, false);
  const drive = await snapshot(annaDrive, 1, true);
  const imap = await snapshot(imapAccount, 1, true);
  const bobSnapshot = await snapshot(bobMailbox, 1, true);

  const mailbox = (snapshotId: string) => ({
    tenantId,
    snapshotId,
    protectedObjectId: annaMailbox,
  });
  const mailboxRows = (snapshotId: string, sequence: number): NewManifestObjectRow[] => [
    // No row for the area roots `mail` and `calendar`, nor for `calendar/Calendar`.
    row(mailbox(snapshotId), "mail/Inbox", "folder", { itemId: "folder-inbox" }),
    row(mailbox(snapshotId), "mail/Inbox/Projects", "folder", { itemId: "folder-projects" }),
    row(mailbox(snapshotId), "mail/Inbox/Quarterly.aaaa.eml", "mail", {
      itemId: "msg-quarterly",
      mtime: day(3),
      metadata: { subject: "Quarterly report", receivedDateTime: day(3).toISOString() },
    }),
    row(mailbox(snapshotId), "mail/Inbox/Lunch.bbbb.eml", "mail", {
      itemId: "msg-lunch",
      mtime: day(5),
      metadata: { subject: "Lunch on Friday" },
      // The lunch mail was deleted at the source before the second backup.
      deleted: sequence === 2,
    }),
    row(mailbox(snapshotId), "mail/Inbox/Big.cccc.json", "mail", {
      itemId: "msg-big",
      mtime: day(1),
      metadata: { subject: "Big attachment", format: "json" },
    }),
    row(mailbox(snapshotId), "mail/Inbox/Big.cccc.attachments/plan.pdf.dddd", "file", {
      itemId: "att-plan",
      metadata: { messagePath: "mail/Inbox/Big.cccc.json" },
    }),
    row(mailbox(snapshotId), "mail/Inbox/Projects/Kickoff.eeee.eml", "mail", {
      itemId: "msg-kickoff",
      mtime: day(2),
      metadata: { subject: "Kickoff" },
      // Changed content between the two backups (a new version).
      chunkRefs: [`kickoff-v${sequence}`],
    }),
    row(mailbox(snapshotId), "calendar/Calendar/Standup.ffff.json", "event", {
      itemId: "event-standup",
    }),
  ];
  await db.insert(manifestObjects).values([...mailboxRows(first, 1), ...mailboxRows(second, 2)]);

  const driveBase = { tenantId, snapshotId: drive, protectedObjectId: annaDrive };
  await db.insert(manifestObjects).values([
    row(driveBase, "Documents", "folder"),
    row(driveBase, "Documents/report.docx", "file", {
      itemId: "drive-report",
      metadata: { contentType: "application/vnd.openxmlformats-officedocument" },
    }),
    row(driveBase, "Documents/report.docx:versions/1.0", "file", {
      itemId: "drive-report#1.0",
      mtime: day(1),
      metadata: { versionId: "1.0", lastModifiedBy: "Anna" },
    }),
    row(driveBase, "Documents/report.docx:versions/2.0", "file", {
      itemId: "drive-report#2.0",
      mtime: day(2),
      metadata: { versionId: "2.0", lastModifiedBy: "Bob" },
    }),
  ]);
  await db
    .insert(manifestObjects)
    .values([
      row({ tenantId, snapshotId: imap, protectedObjectId: imapAccount }, "mail/INBOX", "folder"),
      row(
        { tenantId, snapshotId: imap, protectedObjectId: imapAccount },
        "mail/INBOX/1.eml",
        "mail",
      ),
      row(
        { tenantId, snapshotId: bobSnapshot, protectedObjectId: bobMailbox },
        "mail/Inbox",
        "folder",
      ),
      row(
        { tenantId, snapshotId: bobSnapshot, protectedObjectId: bobMailbox },
        "mail/Inbox/Salary.gggg.eml",
        "mail",
        { metadata: { subject: "Quarterly salary review" } },
      ),
    ]);

  const adminId = await signedInUser(db, "admin@provider.test", "Admin");
  const annaId = await signedInUser(db, "anna@contoso.test", "Anna");
  const bobId = await signedInUser(db, "bob@contoso.test", "Bob");

  return {
    tenantId,
    admin: { role: "tenant_admin", userId: adminId, email: "admin@provider.test" },
    anna: { role: "tenant_user", userId: annaId, email: "Anna@Contoso.test" },
    bob: { role: "tenant_user", userId: bobId, email: "bob@contoso.test" },
    annaMailbox,
    bobMailbox,
    annaDrive,
    imapAccount,
    mailbox: { first, second, running },
    drive,
    imap,
    bobSnapshot,
  };
}
