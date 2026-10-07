import type { FailedItemLocation, WarningState } from "@restow/core";
import type { WarningAcknowledgement } from "@restow/db";
import type { FailureDto } from "../failures/dto.js";
import type { WarningFact, WarningTargetKind } from "./state.js";

/**
 * What the warnings feature answers (apps/web/src/features/warnings/api.ts mirrors it). A
 * warning is a backup that went through but left items behind; see
 * packages/core/src/failures/warnings.ts for the rules of acknowledging one.
 */

export type WarningSubjectKind = "mailbox" | "onedrive" | "imap" | "server" | "client";

export interface WarningTargetDto {
  kind: WarningTargetKind;
  id: string;
  subjectKind: WarningSubjectKind;
  name: string;
  /** The address of a mailbox, the operating system of a machine. */
  detail: string | null;
}

export interface WarningAcknowledgementDto {
  acknowledgedAt: string;
  /** Who acknowledged (an address, or the label kept when the account is gone). */
  acknowledgedBy: string;
  note: string | null;
  /** The causes it covers. */
  causes: string[];
  /** The run that was looked at. */
  runId: string | null;
  /** It no longer counts: a new cause appeared, or a run failed outright since. */
  superseded: boolean;
}

export interface WarningCauseCountDto {
  code: string;
  count: number;
}

export interface WarningLatestRunDto {
  id: string;
  outcome: "succeeded" | "partial" | "failed";
  finishedAt: string;
  failedItems: number;
}

export interface WarningSummaryDto {
  target: WarningTargetDto;
  state: WarningState;
  latestRun: WarningLatestRunDto | null;
  /** Failed items of the newest run per cause, most frequent first. */
  causes: WarningCauseCountDto[];
  /** Causes the acknowledgement does not cover (what made the warning come back). */
  newCauses: string[];
  acknowledgement: WarningAcknowledgementDto | null;
}

export interface WarningListDto {
  items: WarningSummaryDto[];
  counts: { open: number; acknowledged: number; failed: number };
  /** More warnings than the list carries. */
  truncated: boolean;
}

export type RunOutcomeName =
  | "queued"
  | "running"
  | "succeeded"
  | "partial"
  | "failed"
  | "cancelled";

/** One of the newest backup runs of the object. */
export interface WarningRunDto {
  id: string;
  outcome: RunOutcomeName;
  startedAt: string | null;
  finishedAt: string | null;
  failedItems: number;
  /** Why the run failed outright; null when it did not. */
  failure: FailureDto | null;
}

/** An item (a message, a file) the run could not back up. */
export interface FailedItemDto {
  /** The reference as the engine recorded it (an object path, a file path or an item id). */
  ref: string;
  location: FailedItemLocation;
  /** The item's own date (a message's received time); null when unknown. */
  itemDate: string | null;
  /** When the run gave up on it. */
  failedAt: string | null;
  /** Runs in a row the item failed in. */
  attempts: number;
  /** The raw message (Graph status, code and text; never a secret). */
  message: string;
  failure: FailureDto | null;
}

export interface WarningGroupDto {
  /** The cause with the explanation of its newest example. */
  failure: FailureDto;
  count: number;
}

export interface WarningDetailDto extends WarningSummaryDto {
  /** The newest backup runs of the object, newest first. */
  runs: WarningRunDto[];
  /** The run the items belong to (the newest finished one); null without one. */
  focusRunId: string | null;
  /** The failed items of that run, the first ones the server keeps. */
  items: FailedItemDto[];
  /** How many items failed in that run (may exceed `items`). */
  itemCount: number;
  /** Those failed items by cause, each with what happened, why and what to do. */
  groups: WarningGroupDto[];
  /** Whether the current state can be acknowledged, and why not. */
  acknowledge: { allowed: boolean; refusal: "no_warning" | "failed" | null };
  docsUrl: string;
}

export interface AcknowledgeResultDto {
  acknowledged: WarningSummaryDto[];
  skipped: { kind: WarningTargetKind; id: string; reason: "no_warning" | "failed" | "not_found" }[];
}

export function causeCountsDto(counts: Record<string, number>): WarningCauseCountDto[] {
  return Object.entries(counts)
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
}

export function acknowledgementDto(
  row: WarningAcknowledgement | null,
  superseded: boolean,
): WarningAcknowledgementDto | null {
  return row
    ? {
        acknowledgedAt: row.acknowledgedAt.toISOString(),
        acknowledgedBy: row.acknowledgedBy,
        note: row.note,
        causes: [...row.causes].sort(),
        runId: row.runId,
        superseded,
      }
    : null;
}

export function summaryDto(target: WarningTargetDto, fact: WarningFact): WarningSummaryDto {
  const latest = fact.latest;
  return {
    target,
    state: fact.evaluation.state,
    latestRun: latest
      ? {
          id: latest.runId,
          outcome: latest.outcome,
          finishedAt: latest.finishedAt,
          failedItems: latest.failedItems,
        }
      : null,
    causes: causeCountsDto(fact.causeCounts),
    newCauses: [...fact.evaluation.newCauses],
    acknowledgement: acknowledgementDto(fact.ack, fact.evaluation.ackSuperseded),
  };
}
