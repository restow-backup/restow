/**
 * Exchange Online journal report parsing.
 *
 * A journal report is itself a MIME message: a plain-text envelope (Sender,
 * Subject, Message-ID, one labelled line per envelope recipient) plus the
 * original message attached as `message/rfc822`. The envelope labels a
 * recipient's role directly — `To:`, `Cc:` or `Bcc:` — one recipient per line
 * (docs/IMAP.md: the envelope text carries recipients with To/Cc/Bcc
 * labelling); an unlabelled `Recipient:` line is also accepted for reports
 * that do not label the role, and is classified against the original
 * message's own To/Cc headers instead (whatever is left over is Bcc). An
 * `On-Behalf-Of:` line, when present, names the mailbox a delegate sent for.
 * A recipient line may carry an annotation after its address, separated by
 * either `,` or `;`: `Expanded from:`/`Expanded:` for a distribution group,
 * `Forwarded by:`/`Forwarded:` for an auto-forward.
 *
 * Journaling captures the full SMTP envelope, so a recipient that never shows
 * up in the original message's To/Cc headers was a Bcc recipient — that is
 * one way Bcc is recoverable when a report only carries unlabelled
 * `Recipient:` lines; an explicit `Bcc:` line recovers it directly, with no
 * need to compare against the original at all (docs/ARCHIVE.md,
 * docs/IMAP.md).
 *
 * {@link parseJournalReport} never throws and never drops a report: anything
 * it cannot make sense of is recorded as a flag on the result, and the
 * original bytes always end up in `original` (falling back to the raw report
 * itself when no `message/rfc822` part is found), so the caller can archive
 * it as-is on error rather than lose it (docs/ARCHIVE.md: a report that
 * cannot be fully understood is still archived, marked incomplete, never
 * dropped).
 *
 * The report comes from the outside world (whatever reaches the journal
 * address) and mailparser is not linear for every input: the receiver runs
 * this code in an isolated child process with a time and memory limit
 * (./journal-isolated.ts, {@link parseJournalReportTask}), never on the event
 * loop of the process that answers SMTP and HTTP. The parse itself only does
 * what the details need (see PARSER_OPTIONS, headerBlock and the recipient
 * cap), so an honest report of the size limit stays far below that memory.
 */
import type { AddressObject, ParsedMail } from "mailparser";
import { simpleParser } from "mailparser";

/** How an envelope recipient relates to the original message's visible headers. */
export type JournalRecipientType = "to" | "cc" | "bcc";

export interface JournalRecipient {
  readonly address: string;
  readonly type: JournalRecipientType;
  /** Set when the envelope line named a distribution group this address was expanded from. */
  readonly expandedFrom?: string;
  /** Set when the envelope line named a mailbox that auto-forwarded to this address. */
  readonly forwardedBy?: string;
}

/** The envelope fields a journal report carries, independent of the original message. */
export interface JournalEnvelope {
  readonly sender: string | null;
  readonly subject: string | null;
  readonly messageId: string | null;
  /** The mailbox a delegate sent on behalf of, from an `On-Behalf-Of:` envelope line, or null. */
  readonly onBehalfOf: string | null;
  readonly recipients: readonly JournalRecipient[];
}

/**
 * Why a report could not be fully understood. Never a reason to drop it —
 * only ever recorded alongside whatever could be recovered.
 */
export type JournalFlag =
  | "report-unparseable"
  /** The parse ran over its time limit; the report was archived as received, without its details. */
  | "report-parse-timeout"
  /** The parse ran over its memory limit; the report was archived as received, without its details. */
  | "report-parse-memory-limit"
  | "envelope-body-missing"
  | "envelope-unparseable"
  | "sender-missing"
  | "message-id-missing"
  | "recipients-missing"
  | "original-message-missing"
  | "original-message-unparseable"
  | "recipient-classification-degraded"
  /** The envelope named more than {@link MAX_ENVELOPE_RECIPIENTS} recipients; the rest are only in the archived bytes. */
  | "recipients-truncated";

export interface ParsedJournalReport {
  readonly envelope: JournalEnvelope;
  /**
   * The original message, byte-exact. The `message/rfc822` attachment when
   * one was found; otherwise the raw report bytes themselves, so nothing is
   * ever discarded.
   */
  readonly original: Buffer;
  /** True when `original` is the raw report (no `message/rfc822` part was recovered). */
  readonly originalIsRawReport: boolean;
  readonly flags: readonly JournalFlag[];
}

const ENVELOPE_LINE = /^(Sender|Subject|Message-ID|On-Behalf-Of|To|Cc|Bcc|Recipient)\s*:\s*(.*)$/i;

/**
 * Most envelope recipients kept as details of one report. Far more than Exchange
 * Online puts on a message (also after expanding distribution groups), and it
 * keeps a report made of millions of recipient lines from growing the parser's
 * memory without bound; the archived bytes always keep every line.
 */
export const MAX_ENVELOPE_RECIPIENTS = 100_000;

/**
 * What the journal parse asks of mailparser: the envelope text and the
 * attachments, nothing else. Its HTML rendering of the text and the links in
 * it (`textAsHtml`) is never used here and costs several times the size of the
 * report (30 MB of `<` took a gigabyte of heap); an HTML body above 2 MiB is
 * not converted to text (mailparser then rejects the report, which is archived
 * as received, flagged `report-unparseable`).
 */
const PARSER_OPTIONS = {
  skipTextToHtml: true,
  skipTextLinks: true,
  skipImageLinks: true,
  maxHtmlLengthToParse: 2 * 1024 * 1024,
} as const;

/**
 * The header block of a message: everything up to and including the first
 * empty line, or the whole message when there is none. Only the original's
 * headers are used (subject, Message-ID, To and Cc), so its body, up to the
 * size of the report, is never parsed a second time.
 */
function headerBlock(message: Buffer): Buffer {
  const ends = [message.indexOf("\r\n\r\n"), message.indexOf("\n\n")].filter((index) => index >= 0);
  if (ends.length === 0) {
    return message;
  }
  const end = Math.min(...ends);
  return message.subarray(0, end + (message[end] === 0x0d ? 4 : 2));
}
const EXPANDED_FROM = /Expanded(?:\s+from)?\s*:\s*([^,;]+)/i;
const FORWARDED_BY = /Forwarded(?:\s+by)?\s*:\s*([^,;]+)/i;

/** Recipient-type labels that name their role directly, as opposed to plain `Recipient:`. */
const LABELLED_RECIPIENT_TYPE: Record<string, JournalRecipientType> = {
  to: "to",
  cc: "cc",
  bcc: "bcc",
};

/** Split "address" from an optional ", annotation" / "; annotation" tail. */
function splitAddressAndAnnotation(value: string): { address: string; annotation: string } {
  const separatorIndex = value.search(/[,;]/);
  if (separatorIndex === -1) {
    return { address: value.trim(), annotation: "" };
  }
  return {
    address: value.slice(0, separatorIndex).trim(),
    annotation: value.slice(separatorIndex + 1).trim(),
  };
}

/** Parse the journal report's plain-text envelope body (not the original message). */
function parseEnvelopeText(text: string): {
  sender: string | null;
  subject: string | null;
  messageId: string | null;
  onBehalfOf: string | null;
  recipients: JournalRecipient[];
  /** Addresses whose type came straight from a `To:`/`Cc:`/`Bcc:` line, not inferred. */
  labelledAddresses: Set<string>;
  flags: JournalFlag[];
} {
  let sender: string | null = null;
  let subject: string | null = null;
  let messageId: string | null = null;
  let onBehalfOf: string | null = null;
  const recipients: JournalRecipient[] = [];
  const labelledAddresses = new Set<string>();
  let matchedAnyLine = false;
  let truncated = false;

  // Line by line without an array of all lines: a report may be one line or millions.
  for (let start = 0; start < text.length; ) {
    const newline = text.indexOf("\n", start);
    const end = newline === -1 ? text.length : newline;
    const line = text.slice(start, end).trim();
    start = end + 1;
    if (line.length === 0) {
      continue;
    }
    const match = ENVELOPE_LINE.exec(line);
    if (!match) {
      continue;
    }
    matchedAnyLine = true;
    const field = (match[1] as string).toLowerCase();
    const value = (match[2] as string).trim();
    if (field === "sender") {
      sender = value.length > 0 ? value : sender;
    } else if (field === "subject") {
      subject = value.length > 0 ? value : subject;
    } else if (field === "message-id") {
      messageId = value.length > 0 ? value : messageId;
    } else if (field === "on-behalf-of") {
      onBehalfOf = value.length > 0 ? value : onBehalfOf;
    } else {
      // to, cc, bcc, recipient: one recipient per line, with an optional
      // ", annotation" or "; annotation" tail.
      const { address: addressPart, annotation } = splitAddressAndAnnotation(value);
      const address = addressPart.toLowerCase();
      if (address.length === 0) {
        continue;
      }
      if (recipients.length >= MAX_ENVELOPE_RECIPIENTS) {
        truncated = true;
        continue;
      }
      const expandedFrom = EXPANDED_FROM.exec(annotation)?.[1]?.trim();
      const forwardedBy = FORWARDED_BY.exec(annotation)?.[1]?.trim();
      const labelledType = LABELLED_RECIPIENT_TYPE[field];
      if (labelledType) {
        labelledAddresses.add(address);
      }
      recipients.push({
        address,
        // A labelled line's type is authoritative. An unlabelled `Recipient:`
        // line is classified against the original message below; "bcc" is
        // the safe default until we can prove otherwise.
        type: labelledType ?? "bcc",
        ...(expandedFrom ? { expandedFrom } : {}),
        ...(forwardedBy ? { forwardedBy } : {}),
      });
    }
  }

  const flags: JournalFlag[] = [];
  if (!matchedAnyLine) {
    flags.push("envelope-unparseable");
  } else {
    if (sender === null) {
      flags.push("sender-missing");
    }
    if (recipients.length === 0) {
      flags.push("recipients-missing");
    }
    if (truncated) {
      flags.push("recipients-truncated");
    }
  }
  return { sender, subject, messageId, onBehalfOf, recipients, labelledAddresses, flags };
}

/** Every address (lower-cased) in a mailparser address field, in any of its shapes. */
function addressSet(field: AddressObject | AddressObject[] | undefined): Set<string> {
  const result = new Set<string>();
  if (!field) {
    return result;
  }
  const objects = Array.isArray(field) ? field : [field];
  for (const object of objects) {
    for (const entry of object.value) {
      if (entry.address) {
        result.add(entry.address.toLowerCase());
      }
    }
  }
  return result;
}

/** Parse a raw journal report (the full MIME bytes received over SMTP) into its parts. */
export async function parseJournalReport(rawReportBytes: Buffer): Promise<ParsedJournalReport> {
  let report: ParsedMail;
  try {
    report = await simpleParser(rawReportBytes, PARSER_OPTIONS);
  } catch {
    return {
      envelope: { sender: null, subject: null, messageId: null, onBehalfOf: null, recipients: [] },
      original: rawReportBytes,
      originalIsRawReport: true,
      flags: ["report-unparseable", "original-message-missing"],
    };
  }

  const envelopeText = report.text ?? "";
  const flags: JournalFlag[] = [];
  let parsedEnvelope: ReturnType<typeof parseEnvelopeText>;
  if (envelopeText.trim().length === 0) {
    flags.push("envelope-body-missing");
    parsedEnvelope = {
      sender: null,
      subject: null,
      messageId: null,
      onBehalfOf: null,
      recipients: [],
      labelledAddresses: new Set(),
      flags: [],
    };
  } else {
    parsedEnvelope = parseEnvelopeText(envelopeText);
    flags.push(...parsedEnvelope.flags);
  }

  const originalAttachment = report.attachments.find(
    (attachment) => attachment.contentType.toLowerCase() === "message/rfc822",
  );

  let original: Buffer;
  let originalIsRawReport: boolean;
  let originalParsed: ParsedMail | null = null;
  if (originalAttachment) {
    original = Buffer.from(originalAttachment.content);
    originalIsRawReport = false;
    try {
      const candidate = await simpleParser(headerBlock(original), PARSER_OPTIONS);
      // mailparser does not throw on content that is not really a MIME
      // message (it falls back to treating it as an opaque body); a message
      // with no headers at all is the signal that the attachment was not
      // actually a message/rfc822 part, so it is not trusted for fallback
      // fields or recipient classification below.
      if (candidate.headers.size > 0) {
        originalParsed = candidate;
      } else {
        flags.push("original-message-unparseable");
      }
    } catch {
      flags.push("original-message-unparseable");
    }
  } else {
    original = rawReportBytes;
    originalIsRawReport = true;
    flags.push("original-message-missing");
  }

  // Fall back to the original message's own headers when the envelope text
  // did not carry them (some journaling configurations omit Subject/Message-ID
  // from the envelope since the original already has them).
  const subject =
    parsedEnvelope.subject ??
    (typeof originalParsed?.subject === "string" ? originalParsed.subject : null);
  const messageId = parsedEnvelope.messageId ?? originalParsed?.messageId ?? null;
  if (messageId === null) {
    flags.push("message-id-missing");
  }

  let recipients = parsedEnvelope.recipients;
  // Only unlabelled `Recipient:` entries need classification; a `To:`/`Cc:`/
  // `Bcc:` line already named its own type and is never second-guessed.
  const needsClassification = recipients.some(
    (recipient) => !parsedEnvelope.labelledAddresses.has(recipient.address),
  );
  if (needsClassification) {
    if (originalParsed) {
      const toSet = addressSet(originalParsed.to);
      const ccSet = addressSet(originalParsed.cc);
      recipients = recipients.map((recipient) =>
        parsedEnvelope.labelledAddresses.has(recipient.address)
          ? recipient
          : {
              ...recipient,
              type: toSet.has(recipient.address)
                ? "to"
                : ccSet.has(recipient.address)
                  ? "cc"
                  : "bcc",
            },
      );
    } else {
      // No original headers to compare against: every unlabelled recipient
      // is kept as "bcc" (the safe default already set above), but the
      // classification is not actually proven.
      flags.push("recipient-classification-degraded");
    }
  }

  const envelope: JournalEnvelope = {
    sender: parsedEnvelope.sender,
    subject,
    messageId,
    onBehalfOf: parsedEnvelope.onBehalfOf,
    recipients,
  };

  return { envelope, original, originalIsRawReport, flags };
}

/**
 * What {@link parseJournalReportTask} hands back across the process boundary:
 * the parsed report without a second copy of the raw bytes. `original` is
 * null when it is the raw report itself (the caller still holds those bytes).
 */
export interface JournalReportTransfer {
  readonly envelope: JournalEnvelope;
  readonly original: Uint8Array | null;
  readonly originalIsRawReport: boolean;
  readonly flags: readonly JournalFlag[];
}

/**
 * Entry point of the isolated child process (../mailfiles/isolate.ts):
 * {@link parseJournalReport} on the bytes the process received. Use
 * `parseJournalReportIsolated` (./journal-isolated.ts) outside of it.
 */
export async function parseJournalReportTask(input: Buffer): Promise<JournalReportTransfer> {
  const parsed = await parseJournalReport(input);
  return {
    envelope: parsed.envelope,
    original: parsed.originalIsRawReport ? null : parsed.original,
    originalIsRawReport: parsed.originalIsRawReport,
    flags: parsed.flags,
  };
}
