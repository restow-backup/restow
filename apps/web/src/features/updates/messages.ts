import * as React from "react";
import { useTranslation } from "react-i18next";

import { formatDateTime } from "@/lib/format";

import { type BuildSwitchTarget, UPDATE_MESSAGE_CODES, type UpdateMessage } from "./api";
import "./i18n";
import { failureKey, isFailureCode, maintenanceMessageKey } from "./presenters";

/** The codes whose `code` parameter names the failure that ended the run. */
const FAILURE_MESSAGE_CODES: ReadonlySet<string> = new Set([
  "run.unchanged",
  "run.rolled_back",
  "run.needs_attention",
]);

export function isKnownMessageCode(code: string): boolean {
  return (UPDATE_MESSAGE_CODES as readonly string[]).includes(code);
}

/** What the message templates need, from the updater's parameters. */
export interface MessageFormatting {
  /** Translate a key of the `updates` namespace. */
  translate: (key: string) => string;
  language: string;
}

/**
 * The parameters a message template is filled with. A failure code becomes its
 * translated reason, a start time becomes a local date and time, and the
 * placeholder the updater uses when the previous version was unknown reads as
 * a word.
 */
export function messageParams(
  message: UpdateMessage,
  { translate, language }: MessageFormatting,
): Record<string, string | number> {
  const params: Record<string, string | number> = { ...message.params };
  if (FAILURE_MESSAGE_CODES.has(message.code)) {
    const code = String(message.params.code ?? "");
    params.reason = translate(failureKey(isFailureCode(code) ? code : "unknown"));
  }
  if (typeof params.startsAt === "string") {
    params.startsAt = formatDateTime(params.startsAt, language) ?? params.startsAt;
  }
  // "unknown" is the updater's placeholder; a missing version is one the page was not told
  // (the public status of the edge names none).
  if (params.version === "unknown" || params.version === undefined) {
    params.version = translate("maintenance.versionUnknown");
  }
  return params;
}

/**
 * The translated text of an updater message, or `null` when there is none: a
 * code this version does not know is never shown as a raw code.
 */
export function useUpdateMessage(): (
  message: UpdateMessage | null | undefined,
  switchTo?: BuildSwitchTarget | null,
) => string | null {
  const { t, i18n } = useTranslation("updates");
  const language = i18n.resolvedLanguage ?? i18n.language;
  return React.useCallback(
    (message, switchTo) => {
      if (!message || !isKnownMessageCode(message.code)) {
        return null;
      }
      const key = maintenanceMessageKey(message.code, switchTo);
      if (!i18n.exists(`updates:${key}`)) {
        return null;
      }
      const params = messageParams(message, { translate: (id) => t(id), language });
      return t(key, params);
    },
    [t, i18n, language],
  );
}
