import { createHash } from "node:crypto";
import { type Logger, waitForJobs } from "./api-seed.js";
import { DEMO_TENANTS, type DemoMailbox } from "./company.js";
import { type GeneratedMessagePlan, planMessages } from "./generate-mail.js";
import { type ApiClient, ApiRequestError } from "./http-client.js";
import { buildMbox } from "./mbox.js";

/**
 * The demo's mail archive (deploy/demo/README.md, "The mail archive").
 *
 * Restow 0.1.0 has no continuous IMAP archive sync: an archive item is written
 * by the journal receiver (Business, needs a TLS certificate and Exchange Online)
 * or by a mail file import with "archive at the same time" (docs/IMPORT.md,
 * docs/ARCHIVE.md). The demo has no Exchange, so it uses the import: for one
 * mailbox per tenant the seed uploads the same synthetic mail the Dovecot
 * mailbox holds, as one mbox file per folder, through the real import API, with
 * archiving switched on. The worker then does what it does for any import: it
 * stores each message byte-exact, chains it into the tenant's hash chain, sets
 * its retention date from the archive's fixed default policy (8 years from the
 * end of the year of capture) and indexes it for full text search. Every archive
 * item is stamped with the moment it was captured, which is the import; the
 * mail's own date stays in `sent_at`. Archive rows cannot be moved back in time
 * (the table is append-only and the chain hash covers the capture time), so
 * unlike the backup history they stay current.
 */

export interface ArchiveMailbox {
  tenantSlug: string;
  login: string;
  /** The imported mailbox's name, shown on the archive page and in the sources. */
  name: string;
  /** One example legal hold on the mailbox, with its reason; none when absent. */
  legalHoldReason?: string;
}

export const ARCHIVE_MAILBOXES: readonly ArchiveMailbox[] = [
  {
    tenantSlug: "example-trading",
    login: "accounting@example.org",
    name: "Accounting (mail archive)",
    legalHoldReason:
      "Example legal hold: accounting mail is kept for the pending 2025 tax audit. Sample data for the Restow demo.",
  },
  {
    tenantSlug: "birchwood-consulting",
    login: "sales@example.org",
    name: "Sales (mail archive)",
  },
];

export interface ArchiveUpload {
  /** The mbox file name, which becomes the folder of the imported mailbox. */
  fileName: string;
  folder: string;
  messages: number;
  bytes: Buffer;
}

function header(eml: string, name: string): string {
  const match = new RegExp(`^${name}: (.*)$`, "im").exec(eml);
  return match?.[1]?.trim() ?? "";
}

/** The envelope sender for an mbox `From ` line: the address in the From header. */
export function senderOf(eml: string): string {
  const from = header(eml, "From");
  return /<([^>]+)>/.exec(from)?.[1] ?? (from || "unknown@example.org");
}

export function subjectOf(eml: string): string {
  return header(eml, "Subject");
}

/**
 * Pure: the mbox files of one mailbox's synthetic mail, one per folder (INBOX, Sent,
 * Archive), in date order. The same plan the Dovecot mailbox was filled from.
 */
export function planArchiveUploads(
  plans: readonly GeneratedMessagePlan[],
  login: string,
): ArchiveUpload[] {
  const byFolder = new Map<string, GeneratedMessagePlan[]>();
  for (const plan of plans) {
    if (plan.mailboxLogin !== login) {
      continue;
    }
    const folder = plan.folder ?? "INBOX";
    byFolder.set(folder, [...(byFolder.get(folder) ?? []), plan]);
  }
  return [...byFolder.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([folder, messages]) => {
      const ordered = [...messages].sort((a, b) => a.date.getTime() - b.date.getTime());
      return {
        fileName: `${folder}.mbox`,
        folder,
        messages: ordered.length,
        bytes: buildMbox(
          ordered.map((message) => ({
            from: senderOf(message.eml),
            date: message.date,
            eml: message.eml,
          })),
        ),
      };
    });
}

interface UploadView {
  id: string;
  segmentSize: number;
  segmentCount: number;
}

/** The segments of an upload, in order: `segmentSize` bytes each, the last one shorter. */
export function segmentsOf(bytes: Buffer, segmentSize: number): Buffer[] {
  const segments: Buffer[] = [];
  for (let offset = 0; offset < bytes.length; offset += segmentSize) {
    segments.push(bytes.subarray(offset, offset + segmentSize));
  }
  return segments;
}

async function expectOk<T>(
  answer: { status: number; body: T },
  method: string,
  path: string,
): Promise<T> {
  if (answer.status >= 400) {
    throw new ApiRequestError(method, path, answer.status, answer.body);
  }
  return answer.body;
}

/** The import API's upload protocol (docs/IMPORT.md): announce, send segments with checksums, complete. */
async function upload(client: ApiClient, tenantId: string, file: ArchiveUpload): Promise<string> {
  const options = { tenantId, seed: true };
  const created = await client.post<UploadView>(
    "/api/v1/imports/uploads",
    { fileName: file.fileName, size: file.bytes.length },
    options,
  );
  const segments = segmentsOf(file.bytes, created.segmentSize);
  if (segments.length !== created.segmentCount) {
    throw new Error(
      `${file.fileName}: the server expects ${created.segmentCount} segments, the file has ${segments.length}`,
    );
  }
  for (const [index, segment] of segments.entries()) {
    const path = `/api/v1/imports/uploads/${created.id}/segments/${index}`;
    await expectOk(
      await client.request("PUT", path, {
        ...options,
        rawBody: segment,
        headers: {
          "content-type": "application/octet-stream",
          "x-segment-sha256": createHash("sha256").update(segment).digest("hex"),
        },
      }),
      "PUT",
      path,
    );
  }
  await client.post(`/api/v1/imports/uploads/${created.id}/complete`, {}, options);
  return created.id;
}

export interface ArchiveSeedOptions {
  client: ApiClient;
  /** Tenant id by slug. */
  tenants: ReadonlyMap<string, string>;
  seed: number;
  historyDays: number;
  messagesPerMailbox: number;
  /** The clock the mail corpus was planned with, so the archive holds the very same messages. */
  now: Date;
  jobTimeoutMs: number;
  log: Logger;
}

export interface ArchiveSeedResult {
  tenants: ReadonlyArray<{
    tenantSlug: string;
    tenantId: string;
    objectId: string;
    messages: number;
    /** A subject of an archived message, for a search that must find it. */
    sampleSubject: string;
    legalHoldId: string | null;
    chainOk: boolean;
    archived: number;
  }>;
  failures: number;
}

export async function seedArchive(options: ArchiveSeedOptions): Promise<ArchiveSeedResult> {
  const { client, log } = options;
  const mailboxes: DemoMailbox[] = DEMO_TENANTS.flatMap((tenant) => tenant.mailboxes);
  const plans = planMessages({
    seed: options.seed,
    messagesPerMailbox: options.messagesPerMailbox,
    historyDays: options.historyDays,
    now: options.now,
    mailboxes,
  });
  const out: Array<ArchiveSeedResult["tenants"][number]> = [];
  let failures = 0;
  for (const mailbox of ARCHIVE_MAILBOXES) {
    const tenantId = options.tenants.get(mailbox.tenantSlug);
    if (!tenantId) {
      throw new Error(`tenant "${mailbox.tenantSlug}" was not created`);
    }
    const uploads = planArchiveUploads(plans, mailbox.login);
    const messages = uploads.reduce((sum, file) => sum + file.messages, 0);
    log(`archiving ${messages} messages of ${mailbox.login} (${uploads.length} mbox files)...`);
    const uploadIds: string[] = [];
    for (const file of uploads) {
      uploadIds.push(await upload(client, tenantId, file));
    }
    const created = await client.post<{ id: string; jobId: string; objectId: string }>(
      "/api/v1/imports",
      {
        name: mailbox.name,
        files: uploadIds.map((uploadId) => ({ origin: "upload", uploadId })),
        archive: true,
      },
      { tenantId, seed: true },
    );
    const outcome = await waitForJobs(client, tenantId, [created.jobId], options.jobTimeoutMs);
    failures += outcome.failed;

    let legalHoldId: string | null = null;
    if (mailbox.legalHoldReason) {
      const hold = await client.post<{ id: string }>(
        "/api/v1/archive/legal-holds",
        { reason: mailbox.legalHoldReason, protectedObjectId: created.objectId },
        { tenantId, seed: true },
      );
      legalHoldId = hold.id;
    }
    const chain = await client.get<{ ok: boolean; checked: number }>(
      "/api/v1/archive/chain/verify",
      { tenantId },
    );
    const sample = plans.find((plan) => plan.mailboxLogin === mailbox.login);
    out.push({
      tenantSlug: mailbox.tenantSlug,
      tenantId,
      objectId: created.objectId,
      messages,
      sampleSubject: sample ? subjectOf(sample.eml) : "",
      legalHoldId,
      chainOk: chain.ok,
      archived: chain.checked,
    });
    log(
      `archive of ${mailbox.tenantSlug}: ${chain.checked} items, chain ${chain.ok ? "verified" : "BROKEN"}${legalHoldId ? ", legal hold placed" : ""}`,
    );
    if (!chain.ok) {
      failures += 1;
    }
  }
  return { tenants: out, failures };
}
