import { type StatusTone, toneOf, VERIFICATION_META } from "@/components/kit";
import type { Failure } from "@/features/failures";
import { FailureExplanation, useCauseTitle } from "@/features/failures";
import type { Reason } from "@/features/verify/api";
import { ReasonList } from "@/features/verify/components/status";
import { findingBlocks } from "@/features/verify/presenters";
import { cn } from "@/lib/utils";

/**
 * The tone of a finding: its severity's verification meta (status meta), so a yellow finding is
 * the attention tone (orange) with or without an explanation, as in the plain list.
 */
export function findingTone(
  severity: Reason["severity"],
): Extract<StatusTone, "attention" | "destructive"> {
  return toneOf(VERIFICATION_META[severity]) as Extract<StatusTone, "attention" | "destructive">;
}

/**
 * Every finding of a report, red ones first; a yellow finding needs attention,
 * it is not a failed restore. A finding the server explained
 * comes with why it is not green and what to do (the report page already
 * names the object, so the explanation skips "what happened"); a finding it
 * could not explain keeps the translated line it always had.
 */
export function ReasonFindings({
  reasons,
  objectName,
  className,
}: {
  reasons: readonly Reason[];
  /** The object the report is about; only used where a sentence needs it. */
  objectName: string;
  className?: string;
}) {
  const blocks = findingBlocks(reasons);
  return (
    <div className={cn("space-y-3", className)}>
      {blocks.map((block, index) =>
        block.kind === "plain" ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: blocks are derived from the list and have no identity beyond their position
          <ReasonList key={index} reasons={block.reasons} />
        ) : (
          <FailureExplanation
            // biome-ignore lint/suspicious/noArrayIndexKey: the same code may appear twice with different counts
            key={index}
            failure={block.failure}
            subject={{ kind: "verify", object: objectName }}
            hideWhat
            skipTargets={["verify"]}
            tone={findingTone(block.reason.severity)}
            icon={VERIFICATION_META[block.reason.severity].icon}
          />
        ),
      )}
    </div>
  );
}

/**
 * The cause of one failed item (or test-restore item) under its path: the
 * headline of the cause, opening to the full explanation. The row already
 * names the item, so the explanation skips "what happened".
 */
export function ItemCause({
  failure,
  item,
  className,
}: {
  failure: Failure;
  /** The item's path, as the row shows it. */
  item: string;
  className?: string;
}) {
  const causeTitle = useCauseTitle();
  return (
    <details className={cn("mt-1", className)} data-cause={failure.code}>
      <summary className="cursor-pointer select-none break-words text-xs text-muted-foreground hover:text-foreground">
        {causeTitle(failure.code, failure)}
      </summary>
      <FailureExplanation
        failure={failure}
        subject={{ kind: "item", item }}
        hideWhat
        className="mt-2"
      />
    </details>
  );
}
