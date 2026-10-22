/**
 * Test support: one mailbox and one OneDrive the size of a large real tenant's,
 * written straight into the manifest index with `generate_series` (the way the
 * worker leaves it, see @restow/db manifest-versions.ts: one version row per
 * object state, ranges over a chain of daily snapshots), so the explorer's
 * queries can be measured and their plans checked without a backup run.
 *
 * The mailbox: ~200 mail folders (three levels, no rows of their own for the
 * area roots `mail`, `calendar` and `contacts`, as the Graph engine writes
 * it), `messages` messages, 40 % of them in the Inbox, every fifth changed
 * once (a read flag), every 25th deleted at the source, every 200th an
 * oversized JSON message with an attachments folder and two attachments,
 * plus a calendar and contacts. The OneDrive: ~20k nested folders, `files`
 * files over them, every fifth with three versions the source kept
 * (`<file>:versions/<id>`), every tenth changed once.
 */
import { randomUUID } from "node:crypto";
import {
  type Database,
  protectedObjects,
  providers,
  snapshots,
  sources,
  tenants,
} from "@restow/db";
import { sql } from "drizzle-orm";

export interface LargeFixtureOptions {
  /** Messages in the mailbox (default 120 000). */
  messages?: number;
  /** Files in the OneDrive (default 200 000); 0 leaves the OneDrive out. */
  files?: number;
  /** Daily snapshots of each object (default 30). */
  snapshots?: number;
}

export interface LargeFixture {
  tenantId: string;
  mailbox: string;
  drive: string;
  /** Snapshot ids by sequence (index 0 = sequence 1), oldest first. */
  mailboxSnapshots: string[];
  driveSnapshots: string[];
  /** A drive folder four levels deep, and a file in it that has kept versions. */
  deepFolder: string;
  versionedFile: string;
}

const OPEN = 2147483647;

function one<T>(rows: readonly T[]): T {
  const [first] = rows;
  if (first === undefined) {
    throw new Error("insert returned no row");
  }
  return first;
}

/** A bounded, positive integer for inlining into generated SQL. */
function count(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 10_000_000) {
    throw new RangeError(`not a fixture size: ${value}`);
  }
  return value;
}

export async function createLargeFixture(
  db: Database,
  options: LargeFixtureOptions = {},
): Promise<LargeFixture> {
  const messages = count(options.messages ?? 120_000);
  const files = count(options.files ?? 200_000);
  const chain = count(options.snapshots ?? 30);

  const provider = one(await db.insert(providers).values({ name: "Provider" }).returning());
  const tenant = one(
    await db
      .insert(tenants)
      .values({ providerId: provider.id, name: "Large", slug: `large-${randomUUID().slice(0, 8)}` })
      .returning(),
  );
  const tenantId = tenant.id;
  const source = one(
    await db
      .insert(sources)
      .values({ tenantId, kind: "m365", name: "Large M365", status: "active" })
      .returning(),
  );
  const object = async (kind: "mailbox" | "onedrive", externalId: string) =>
    one(
      await db
        .insert(protectedObjects)
        .values({ tenantId, sourceId: source.id, kind, externalId, displayName: externalId })
        .returning(),
    ).id;
  const mailbox = await object("mailbox", "big@large.test");
  const drive = await object("onedrive", "b!big-drive");

  const chainOf = async (protectedObjectId: string) => {
    const rows = await db
      .insert(snapshots)
      .values(
        Array.from({ length: chain }, (_, index) => {
          const at = new Date(Date.UTC(2026, 0, 1 + index, 2, 0, 0));
          return {
            tenantId,
            protectedObjectId,
            sequence: index + 1,
            startedAt: at,
            completedAt: at,
            manifestPath: `tenants/${tenantId}/manifests/${randomUUID()}`,
            itemCount: messages,
            byteSize: messages * 40_000,
          };
        }),
      )
      .returning();
    return rows.sort((a, b) => a.sequence - b.sequence).map((row) => row.id);
  };
  const mailboxSnapshots = await chainOf(mailbox);
  const driveSnapshots = await chainOf(drive);

  // Every statement below inlines only validated integers and uuids from this function.
  const insert = `INSERT INTO manifest_versions (tenant_id, protected_object_id, first_sequence,
      last_sequence, content_hash, kind, path, name, parent_path, size, mtime, item_id, message_id,
      chunk_refs, metadata, deleted)`;
  const hash = (seed: string) => `decode(md5(${seed}), 'hex')`;
  const chunk = (seed: string) => `ARRAY[decode(md5(${seed}) || md5(${seed} || 'x'), 'hex')]`;

  // Temp tables live as long as their transaction: everything is written in one.
  await db.transaction(async (tx) => {
    await tx.execute(
      sql.raw(`
      CREATE TEMP TABLE fixture_mail_folders ON COMMIT DROP AS
      WITH tops AS (
        SELECT t, CASE t WHEN 1 THEN 'Inbox' WHEN 2 THEN 'Sent Items' WHEN 3 THEN 'Deleted Items'
                         WHEN 4 THEN 'Archive' ELSE 'Folder ' || lpad(t::text, 2, '0') END AS name
        FROM generate_series(1, 20) t
      ),
      paths AS (
        SELECT 'mail/' || name AS path FROM tops
        UNION ALL
        SELECT 'mail/' || name || '/Sub ' || s FROM tops, generate_series(1, 8) s
        UNION ALL
        SELECT 'mail/Inbox/Sub 1/Deep ' || d FROM generate_series(1, 20) d
      )
      SELECT row_number() OVER (ORDER BY path = 'mail/Inbox' DESC, path) AS no, path,
             regexp_replace(path, '^.*/', '') AS name, regexp_replace(path, '/[^/]*$', '') AS parent
      FROM paths`),
    );
    await tx.execute(
      sql.raw(`
      ${insert}
      SELECT '${tenantId}'::uuid, '${mailbox}'::uuid, 1, ${OPEN}, ${hash("f.path")}, 'folder', f.path, f.name,
             f.parent, 0, NULL, 'folder-' || f.no, NULL, NULL,
             jsonb_build_object('folderKind', 'mail', 'displayName', f.name, 'isHidden', 'false',
                                'folderPath', substr(f.path, 6)),
             false
      FROM fixture_mail_folders f`),
    );
    // One message per i; its versions follow from i (see the file comment).
    await tx.execute(
      sql.raw(`
      CREATE TEMP TABLE fixture_messages ON COMMIT DROP AS
      SELECT i, f.path AS folder, substr(f.path, 6) AS folder_path,
             1 + (i % ${chain}) AS arrival,
             timestamptz '2025-01-01' + (i * interval '7 minutes') AS received,
             CASE WHEN i % 200 = 0 THEN 'json' ELSE 'eml' END AS format
      FROM generate_series(1, ${messages}) i
      JOIN fixture_mail_folders f
        ON f.no = CASE WHEN i % 10 < 4 THEN 1 ELSE 1 + ((i::bigint * 7919) % 200) END`),
    );
    const recipients = `'"Mustermann, Erika" <erika.mustermann@large.test>, Max Beispiel <max.beispiel@large.test>, "Schmidt, Jana" <jana.schmidt@large.test>, Team Vertrieb <vertrieb@large.test>, Lukas Weber <lukas.weber@large.test>'`;
    const message = (isRead: string, first: string, last: string, deleted: string) => `
      ${insert}
      SELECT '${tenantId}'::uuid, '${mailbox}'::uuid, ${first}, ${last},
             ${hash(`m.i::text || ${isRead}::text || ${deleted}::text`)}, 'mail',
             m.folder || '/Subject ' || m.i || '.' || to_hex(m.i) || '.' || m.format,
             'Subject ' || m.i || '.' || to_hex(m.i) || '.' || m.format, m.folder,
             20000 + (m.i % 50000), m.received, 'AAMkAG' || md5(m.i::text), '<' || md5(m.i::text) || '@large.test>',
             ${chunk("m.i::text")},
             jsonb_build_object(
               'subject', 'Subject number ' || m.i || ' about the quarterly planning',
               'receivedDateTime', to_char(m.received AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
               'lastModifiedDateTime', to_char(m.received AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
               'isRead', ${isRead}::text, 'isDraft', 'false', 'flagStatus', 'notFlagged',
               'categories', '[]', 'hasAttachments', (m.format = 'json')::text,
               'to', ${recipients}, 'toCount', '5', 'cc', 'Lukas Weber <lukas.weber@large.test>',
               'ccCount', '1', 'from', 'Erika Mustermann <erika.mustermann@large.test>',
               'importance', 'normal', 'messageId', '<' || md5(m.i::text) || '@large.test>',
               'folderPath', m.folder_path, 'format', CASE WHEN m.format = 'json' THEN 'json' ELSE 'mime' END,
               'contentType', CASE WHEN m.format = 'json' THEN 'application/json' ELSE 'message/rfc822' END),
             ${deleted}
      FROM fixture_messages m`;
    // Changed once: unread until `c - 1`, read from `c` on.
    const changeAt = `(m.arrival + 1 + (m.i / 5) % (${chain} - m.arrival))`;
    const deleteAt = `(m.arrival + 1 + (m.i / 25) % (${chain} - m.arrival))`;
    await tx.execute(
      sql.raw(
        `${message("false", "m.arrival", `${changeAt} - 1`, "false")} WHERE m.i % 5 = 0 AND m.arrival < ${chain}`,
      ),
    );
    await tx.execute(
      sql.raw(
        `${message("true", changeAt, `${OPEN}`, "false")} WHERE m.i % 5 = 0 AND m.arrival < ${chain}`,
      ),
    );
    await tx.execute(
      sql.raw(
        `${message("false", "m.arrival", `${deleteAt} - 1`, "false")} WHERE m.i % 25 = 1 AND m.arrival < ${chain}`,
      ),
    );
    await tx.execute(
      sql.raw(
        `${message("false", deleteAt, `${OPEN}`, "true")} WHERE m.i % 25 = 1 AND m.arrival < ${chain}`,
      ),
    );
    await tx.execute(
      sql.raw(
        `${message("false", "m.arrival", `${OPEN}`, "false")} WHERE NOT ((m.i % 5 = 0 OR m.i % 25 = 1) AND m.arrival < ${chain})`,
      ),
    );
    // Oversized messages: their attachments folder and two attachments.
    await tx.execute(
      sql.raw(`
      ${insert}
      SELECT '${tenantId}'::uuid, '${mailbox}'::uuid, m.arrival, ${OPEN}, ${hash(`m.i::text || 'att' || a::text`)},
             CASE WHEN a = 0 THEN 'folder' ELSE 'file' END::manifest_object_kind,
             CASE WHEN a = 0 THEN base ELSE base || '/attachment ' || a || '.pdf' END,
             CASE WHEN a = 0 THEN regexp_replace(base, '^.*/', '') ELSE 'attachment ' || a || '.pdf' END,
             CASE WHEN a = 0 THEN m.folder ELSE base END,
             CASE WHEN a = 0 THEN 0 ELSE 400000 END, NULL, 'att-' || m.i || '-' || a, NULL,
             CASE WHEN a = 0 THEN NULL ELSE ${chunk(`m.i::text || a::text`)} END,
             CASE WHEN a = 0 THEN jsonb_build_object('folderKind', 'attachments', 'folderPath', m.folder_path)
                  ELSE jsonb_build_object('messagePath', m.folder || '/Subject ' || m.i || '.' || to_hex(m.i) || '.json',
                                          'name', 'attachment ' || a || '.pdf', 'contentType', 'application/pdf',
                                          'isInline', 'false', 'folderPath', m.folder_path) END,
             false
      FROM fixture_messages m,
           LATERAL (SELECT m.folder || '/Subject ' || m.i || '.' || to_hex(m.i) || '.attachments' AS base) b,
           generate_series(0, 2) a
      WHERE m.format = 'json'`),
    );
    // A calendar and contacts, below area roots without rows of their own.
    await tx.execute(
      sql.raw(`
      ${insert}
      SELECT '${tenantId}'::uuid, '${mailbox}'::uuid, 1 + (i % ${chain}), ${OPEN}, ${hash("'event' || i::text")}, 'event'::manifest_object_kind,
             'calendar/Calendar/Meeting ' || i || '.' || to_hex(i) || '.json',
             'Meeting ' || i || '.' || to_hex(i) || '.json', 'calendar/Calendar', 3000, NULL::timestamptz,
             'event-' || i, NULL, ${chunk("'event' || i::text")},
             jsonb_build_object('subject', 'Meeting ' || i, 'eventType', 'singleInstance',
               'start', to_char(timestamp '2025-01-01' + i * interval '3 hours', 'YYYY-MM-DD"T"HH24:MI:SS".0000000"'),
               'end', to_char(timestamp '2025-01-01' + i * interval '3 hours' + interval '1 hour', 'YYYY-MM-DD"T"HH24:MI:SS".0000000"'),
               'calendarName', 'Calendar'),
             false
      FROM generate_series(1, 3000) i
      UNION ALL
      SELECT '${tenantId}'::uuid, '${mailbox}'::uuid, 1 + (i % ${chain}), ${OPEN}, ${hash("'contact' || i::text")}, 'contact'::manifest_object_kind,
             'contacts/Contacts/Contact ' || i || '.' || to_hex(i) || '.json',
             'Contact ' || i || '.' || to_hex(i) || '.json', 'contacts/Contacts', 1500, NULL::timestamptz,
             'contact-' || i, NULL, ${chunk("'contact' || i::text")},
             jsonb_build_object('displayName', 'Contact ' || i), false
      FROM generate_series(1, 2000) i`),
    );

    if (files > 0) {
      await tx.execute(
        sql.raw(`
        CREATE TEMP TABLE fixture_drive_folders ON COMMIT DROP AS
        WITH l1 AS (SELECT 'Folder ' || lpad(a::text, 2, '0') AS path FROM generate_series(1, 20) a),
             l2 AS (SELECT l1.path || '/Project ' || b AS path FROM l1, generate_series(1, 10) b),
             l3 AS (SELECT l2.path || '/Part ' || c AS path FROM l2, generate_series(1, 10) c),
             l4 AS (SELECT l3.path || '/Detail ' || d AS path FROM l3, generate_series(1, 9) d),
             every AS (SELECT path FROM l1 UNION ALL SELECT path FROM l2
                       UNION ALL SELECT path FROM l3 UNION ALL SELECT path FROM l4)
        SELECT row_number() OVER (ORDER BY path) AS no, path,
               regexp_replace(path, '^.*/', '') AS name,
               CASE WHEN strpos(path, '/') = 0 THEN '' ELSE regexp_replace(path, '/[^/]*$', '') END AS parent
        FROM every`),
      );
      await tx.execute(
        sql.raw(`
        ${insert}
        SELECT '${tenantId}'::uuid, '${drive}'::uuid, 1, ${OPEN}, ${hash("f.path")}, 'folder', f.path, f.name, f.parent,
               0, timestamptz '2024-06-01', 'drive-folder-' || f.no, NULL, NULL,
               jsonb_build_object('etag', md5(f.path)), false
        FROM fixture_drive_folders f`),
      );
      await tx.execute(
        sql.raw(`
        CREATE TEMP TABLE fixture_files ON COMMIT DROP AS
        SELECT i, f.path || '/Document ' || i || '.docx' AS path, 'Document ' || i || '.docx' AS name,
               f.path AS parent, 1 + (i % ${chain}) AS arrival
        FROM generate_series(1, ${files}) i
        JOIN fixture_drive_folders f
          ON f.no = 1 + ((i::bigint * 7919) % (SELECT count(*) FROM fixture_drive_folders))`),
      );
      const file = (first: string, last: string, version: string) => `
        ${insert}
        SELECT '${tenantId}'::uuid, '${drive}'::uuid, ${first}, ${last}, ${hash(`x.path || ${version}::text`)}, 'file',
               x.path, x.name, x.parent, 50000 + x.i % 900000, timestamptz '2025-01-01' + x.i * interval '1 minute',
               'drive-' || x.i, NULL, ${chunk(`x.path || ${version}::text`)},
               jsonb_build_object('etag', md5(x.path || ${version}::text), 'contentType',
                 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                 'lastModifiedBy', 'Erika Mustermann'),
               false
        FROM fixture_files x`;
      const fileChange = `(x.arrival + 1 + (x.i / 10) % (${chain} - x.arrival))`;
      await tx.execute(
        sql.raw(
          `${file("x.arrival", `${fileChange} - 1`, "1")} WHERE x.i % 10 = 0 AND x.arrival < ${chain}`,
        ),
      );
      await tx.execute(
        sql.raw(`${file(fileChange, `${OPEN}`, "2")} WHERE x.i % 10 = 0 AND x.arrival < ${chain}`),
      );
      await tx.execute(
        sql.raw(
          `${file("x.arrival", `${OPEN}`, "1")} WHERE NOT (x.i % 10 = 0 AND x.arrival < ${chain})`,
        ),
      );
      // The versions OneDrive kept, in the `<file>:versions/<id>` namespace.
      await tx.execute(
        sql.raw(`
        ${insert}
        SELECT '${tenantId}'::uuid, '${drive}'::uuid, x.arrival, ${OPEN}, ${hash("x.path || 'v' || v::text")}, 'file',
               x.path || ':versions/' || v || '.0', v || '.0', x.path || ':versions',
               40000 + v, timestamptz '2024-01-01' + v * interval '1 day', 'drive-' || x.i || '#' || v, NULL,
               ${chunk("x.path || 'v' || v::text")},
               jsonb_build_object('versionId', v || '.0', 'lastModifiedBy', 'Max Beispiel',
                                  'lastModifiedDateTime', '2024-01-0' || v || 'T08:00:00Z'),
               false
        FROM fixture_files x, generate_series(1, 3) v
        WHERE x.i % 5 = 0`),
      );
    }
  });
  await db.execute(sql`ANALYZE manifest_versions`);
  await db.execute(sql`ANALYZE snapshots`);

  const deep = await db.execute<{ parent: string; path: string }>(sql`
    SELECT parent_path AS parent, path FROM manifest_versions
    WHERE protected_object_id = ${drive}::uuid AND kind = 'file'
      AND parent_path LIKE '%/%/%/%' AND strpos(path, ':versions/') = 0
      AND EXISTS (SELECT 1 FROM manifest_versions v
                  WHERE v.protected_object_id = ${drive}::uuid
                    AND v.parent_path = manifest_versions.path || ':versions')
    LIMIT 1
  `);
  return {
    tenantId,
    mailbox,
    drive,
    mailboxSnapshots,
    driveSnapshots,
    deepFolder: deep.rows[0]?.parent ?? "",
    versionedFile: deep.rows[0]?.path ?? "",
  };
}
