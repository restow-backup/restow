import { failureVariables } from "@restow/i18n";

import type { Failure } from "./api";

/**
 * Pure helpers behind the failure explanation: which keys to look up, which
 * technical details to list and in which order. No visible text lives here.
 */

/** The order technical details are listed in (support asks for the ids first). */
const TECHNICAL_ORDER = [
  "httpStatus",
  "errorCode",
  "innerErrorCode",
  "requestId",
  "clientRequestId",
  "serverDate",
  "endpoint",
  "aadsts",
  "correlationId",
  "imapCommand",
  "imapStatus",
  "imapCode",
  "imapResponse",
  "systemCode",
  "host",
  "port",
  "syscall",
  "path",
  "sqlState",
  "errorName",
  "message",
] as const;

export interface TechnicalRow {
  /** The key as the API sent it; `failures:technicalKeys.<key>` names it when known. */
  key: string;
  value: string;
}

/** The technical details as rows, known keys first in a fixed order, the rest by name. */
export function technicalRows(failure: Pick<Failure, "technical">): TechnicalRow[] {
  const entries = Object.entries(failure.technical);
  const rank = (key: string) => {
    const index = (TECHNICAL_ORDER as readonly string[]).indexOf(key);
    return index === -1 ? TECHNICAL_ORDER.length : index;
  };
  return entries
    .sort(([a], [b]) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => ({ key, value: String(value) }));
}

/** The plain-text block copied for a support case. */
export function supportText(failure: Failure, rows: readonly TechnicalRow[]): string {
  return [
    `code: ${failure.code}`,
    `time: ${failure.occurredAt}`,
    ...(failure.step ? [`step: ${failure.step}`] : []),
    ...rows.map((row) => `${row.key}: ${row.value}`),
  ].join("\n");
}

/** Variables for the cause and step texts; every one the texts may use, with neutral defaults. */
export function textVariables(failure: Pick<Failure, "params">): Record<string, string | number> {
  return failureVariables(failure.params);
}

/**
 * The tone of the explanation: a failure Restow is retrying by itself is a
 * warning, one that needs a person is an error.
 */
export function failureTone(
  failure: Pick<Failure, "transient" | "retry"> | null,
  options: { willRetry: boolean },
): "warning" | "destructive" {
  return failure?.transient === true && options.willRetry ? "warning" : "destructive";
}
