/**
 * Check 6: journal receipt. The tenant's journal address comes from the API
 * the way an administrator gets it from the archive page; a synthetic Exchange
 * journal report goes to the SMTP receiver of the api the way Exchange Online
 * would send it (STARTTLS, always; the stack serves a throwaway self-signed
 * certificate that the client trusts and checks by host name); the archive must
 * hold the item, the hash chain must verify, and the export must carry
 * checksums (when this build has an export). Plain text is refused with 530.
 *
 * The receiver belongs to the Business edition, so this check runs in the full
 * build only (the Community build has no receiver). Its capability comes from
 * the Service Provider license key check 3 installed (lib/license.mjs, signed
 * by the run's throwaway test signer); the api was restarted after that,
 * because the receiver reads its capability when the api starts.
 */
import { X509Certificate } from "node:crypto";
import { buildMessage, sha256 } from "../lib/corpus.mjs";
import { checkChecksummedZip, exportToEntries } from "../lib/exports.mjs";
import { buildJournalReport } from "../lib/journal-report.mjs";
import { createTenant } from "../lib/restow.mjs";
import { sendMail } from "../lib/smtp-lite.mjs";
import { JOURNAL_HOST } from "../lib/stack.mjs";

export async function journal(ctx, check) {
  const { stack, api } = ctx;
  const port = stack.ports.journal;
  // What Exchange Online's connector does: always STARTTLS, and the certificate must be
  // the trusted one for the journal host name.
  const trust = { ca: stack.journalCertificate.certPem, servername: JOURNAL_HOST };
  const certificateFingerprint = new X509Certificate(stack.journalCertificate.certPem)
    .fingerprint256;
  const smtp = (options) =>
    sendMail({
      host: "127.0.0.1",
      port,
      from: "journal@contoso.onmicrosoft.com",
      tls: trust,
      ...options,
    });

  await check.step(
    "the installation has the Business capability through its installed license key",
    async () => {
      const license = await api.get("/api/v1/license");
      if (!["business", "service_provider"].includes(license.edition) || license.source !== "key") {
        throw new Error(
          `the edition is ${license.edition} (from ${license.source}); the journal receiver needs a Business or Service Provider key`,
        );
      }
      return `edition ${license.edition} from the key installed in check 3`;
    },
  );

  const tenant = await check.step("create a tenant", async () =>
    createTenant(api, "Smoke Journal Tenant", "smoke-journal"),
  );
  const tenantId = tenant.id;

  let firstAddress = "";
  await check.step(
    "the API hands out the tenant's journal address on the installation's journal host",
    async () => {
      const setup = await api.get("/api/v1/archive/journal", { tenantId });
      const host = JOURNAL_HOST.replaceAll(".", "\\.");
      if (!new RegExp(`^journal\\+[a-z2-7]{32}@${host}$`, "u").test(setup.address ?? "")) {
        throw new Error(`the journal address is ${JSON.stringify(setup.address)}`);
      }
      if (setup.receiver?.listening !== true || setup.status !== "no_reports") {
        throw new Error(
          `the receiver is ${JSON.stringify(setup.receiver)}, the status ${setup.status}; expected a listening receiver and no reports yet`,
        );
      }
      if (setup.requirements?.smtpPort !== port) {
        throw new Error(`the setup reports SMTP port ${setup.requirements?.smtpPort}, not ${port}`);
      }
      if (setup.requirements?.tlsConfigured !== true) {
        throw new Error("the setup does not report a configured TLS certificate");
      }
      const again = await api.get("/api/v1/archive/journal", { tenantId });
      if (again.address !== setup.address) {
        throw new Error("a second view of the setup issued another address");
      }
      firstAddress = setup.address;
      return `journal+<32 character token>@${JOURNAL_HOST}, receiver listening, no reports yet`;
    },
  );

  await check.step(
    "TLS is required: plain text is refused with 530, after STARTTLS the receiver presents the configured certificate",
    async () => {
      const plain = await sendMail({
        host: "127.0.0.1",
        port,
        from: "journal@contoso.onmicrosoft.com",
        to: firstAddress,
        message: "Subject: plain text\r\n\r\nplain text",
      });
      if (plain.accepted || plain.final.code !== 530) {
        throw new Error(`a plain-text session got ${JSON.stringify(plain.final)}, expected 530`);
      }
      const secure = await smtp({
        to: `journal+unknown@${JOURNAL_HOST}`,
        message: "Subject: nobody\r\n\r\nnobody",
      });
      if (secure.tls?.fingerprint256 !== certificateFingerprint) {
        throw new Error(
          `the receiver presented ${secure.tls?.fingerprint256}, not the stack's certificate ${certificateFingerprint}`,
        );
      }
      if (secure.final.code !== 550) {
        throw new Error(
          `after STARTTLS the session got ${JSON.stringify(secure.final)}, expected the 550 for an unknown recipient`,
        );
      }
      return `plain text refused with ${plain.final.code}; ${secure.tls.protocol} after STARTTLS, certificate ${certificateFingerprint.slice(0, 23)}...`;
    },
  );

  // Rotating invalidates the first address at once; the reports below use the new one.
  let address = "";
  await check.step("rotating the address issues a new one", async () => {
    const rotated = await api.post("/api/v1/archive/journal/rotate", undefined, { tenantId });
    if (!rotated.address || rotated.address === firstAddress) {
      throw new Error(`the rotated address is ${JSON.stringify(rotated.address)}`);
    }
    address = rotated.address;
    return "a different address";
  });

  await check.step("the receiver refuses the address that was rotated away", async () => {
    const result = await smtp({
      to: firstAddress,
      message: "Subject: rotated away\r\n\r\nrotated away",
    });
    if (result.accepted || result.final.code !== 550) {
      throw new Error(`the old address got ${JSON.stringify(result.final)}`);
    }
    return `refused with ${result.final.code}`;
  });

  await check.step(
    "the receiver refuses an unknown journal address before it reads any data",
    async () => {
      const result = await smtp({
        to: `journal+unknown@${JOURNAL_HOST}`,
        message: "Subject: nobody\r\n\r\nnobody",
      });
      if (result.accepted || result.final.code !== 550) {
        throw new Error(`an unknown recipient got ${JSON.stringify(result.final)}`);
      }
      return `refused with ${result.final.code}`;
    },
  );

  const sent = [];
  const originals = [];
  async function deliver(index, subject, to, bcc) {
    const original = buildMessage({ seed: 77, index, mailbox: to[0] });
    originals.push(original);
    const report = buildJournalReport({
      journalAddress: address,
      original,
      sender: `sender${index}@smoke.test`,
      subject,
      messageId: `<smoke-77-${index}@smoke.test>`,
      to,
      bcc,
    });
    const result = await smtp({
      to: address,
      message: report.toString("latin1"),
    });
    if (!result.accepted || result.final.code !== 250) {
      throw new Error(`the report was not accepted: ${JSON.stringify(result.final)}`);
    }
    sent.push({ index, subject, messageId: `<smoke-77-${index}@smoke.test>`, bcc });
  }

  await check.step("deliver two journal reports over SMTP and get 250 for each", async () => {
    await deliver(1, "Quarterly numbers smokeone", ["bob@smoke.test"], ["carol@smoke.test"]);
    await deliver(2, "Wartungsfenster smoketwo", ["bob@smoke.test", "dave@smoke.test"], []);
    return "2 reports accepted";
  });

  await check.step("the journal setup shows the reports that arrived", async () => {
    const seen = await api.get("/api/v1/archive/journal", { tenantId });
    if (seen.address !== address) {
      throw new Error("the setup shows another address than the one the reports went to");
    }
    if (seen.status !== "receiving" || !seen.lastReportAt) {
      throw new Error(`status ${seen.status}, last report ${seen.lastReportAt}`);
    }
    if (seen.counts?.last24Hours !== 2 || seen.counts?.last7Days !== 2) {
      throw new Error(`counts ${JSON.stringify(seen.counts)}, 2 reports were delivered`);
    }
    return `receiving, ${seen.counts.last24Hours} reports in 24 hours`;
  });

  await check.step(
    "both items are in the archive, with the Bcc recipient from the envelope",
    async () => {
      const found = await api.get("/api/v1/archive/search?limit=10", { tenantId });
      if (found.total !== 2) {
        throw new Error(`the archive holds ${found.total} items, 2 were delivered`);
      }
      const first = found.items.find((item) => item.subject?.includes("smokeone"));
      if (!first) {
        throw new Error("the first report is not in the search results");
      }
      const item = await api.get(`/api/v1/archive/items/${first.id}`, { tenantId });
      const bcc = item.envelope?.recipients?.find((recipient) => recipient.type === "bcc");
      if (bcc?.address !== "carol@smoke.test") {
        throw new Error(`the Bcc recipient is ${JSON.stringify(bcc)}`);
      }
      if (item.source !== "journal" || item.flags.length > 0) {
        throw new Error(`source ${item.source}, flags ${JSON.stringify(item.flags)}`);
      }
      if (!/^[0-9a-f]{64}$/u.test(item.itemHash) || !/^[0-9a-f]{64}$/u.test(item.chainHash)) {
        throw new Error("the item carries no SHA-256 hashes");
      }
      const text = await api.get("/api/v1/archive/search?q=smoketwo&limit=10", { tenantId });
      if (text.total !== 1) {
        throw new Error(`a full text search for the second subject finds ${text.total} items`);
      }
      return `2 items, Bcc kept, item hash ${item.itemHash.slice(0, 12)}`;
    },
  );

  await check.step("the hash chain verifies and links the two items", async () => {
    const chain = await api.get("/api/v1/archive/chain/verify", { tenantId });
    if (chain.ok !== true || chain.checked !== 2 || chain.brokenAt !== null) {
      throw new Error(`chain verification: ${JSON.stringify(chain)}`);
    }
    const rows = (
      await stack.sql(
        `select chain_hash || ' ' || coalesce(prev_chain_hash, 'none') from archive_items where tenant_id = '${tenantId}' order by received_at, created_at`,
      )
    )
      .split("\n")
      .map((line) => line.split(" "));
    if (rows.length !== 2 || rows[0][1] !== "none" || rows[1][1] !== rows[0][0]) {
      throw new Error("the second item does not continue the chain of the first");
    }
    return "2 items checked, the second continues the first";
  });

  await check.step(
    "export the archive as an EML ZIP: the stored originals byte for byte, with checksums",
    async () => {
      const found = await api.get("/api/v1/archive/search?limit=10", { tenantId });
      const { entries } = await exportToEntries(api, tenantId, {
        origin: "archive",
        selection: { itemIds: found.items.map((item) => item.id) },
        format: "eml_zip",
        reason: "release smoke check 6",
      });
      const files = checkChecksummedZip(entries, { extension: ".eml" });
      if (files.length !== 2) {
        throw new Error(`${files.length} messages exported, 2 are archived`);
      }
      const exported = new Set(files.map((file) => file.sha256));
      const missing = originals.filter((bytes) => !exported.has(sha256(bytes))).length;
      if (missing > 0) {
        throw new Error(`${missing} of the 2 archived originals did not come back byte for byte`);
      }
      return "2 messages equal by SHA-256 to the originals inside the journal reports; SHA256SUMS and MANIFEST.csv consistent";
    },
  );
}
