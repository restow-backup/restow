import { Link } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import type * as React from "react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { CauseLine, FailureExplanation, useCauseTitle } from "@/features/failures";
import type { Failure } from "@/features/failures";
import { jobDetailTo } from "@/features/jobs/paths";
import { cn } from "@/lib/utils";

import { objectTitle } from "./presenters";
import type { ProtectedObject } from "./types";

/**
 * The cause of a failed backup or a failed login test, inside a row of the
 * objects table. A row has room for one line, not for a full explanation: the
 * backup cause links to its job (which explains it in full); the login cause
 * opens the full explanation (what happened, why, what to do) in a popover.
 */

/** The cause of the latest backup run as one line, with the way to the job that explains it. */
export function BackupCause({
  failure,
  jobId,
  linkLabel,
}: {
  failure: Failure;
  jobId: string;
  /** The translated label of the link to the job. */
  linkLabel: string;
}) {
  return (
    <div className="space-y-0.5">
      <CauseLine failure={failure} className="block" />
      <Link
        to={jobDetailTo(jobId)}
        className="inline-flex items-center gap-1 text-xs font-medium underline-offset-4 hover:underline"
      >
        {linkLabel}
        <ArrowRight className="size-3" aria-hidden="true" />
      </Link>
    </div>
  );
}

/** A button that names the cause and opens its explanation. */
export function CauseDetails({
  failure,
  children,
  className,
}: {
  failure: Failure;
  /** The explanation shown in the popover. */
  children: React.ReactNode;
  className?: string;
}) {
  const causeTitle = useCauseTitle();
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-cause={failure.code}
          className={cn(
            "block max-w-full break-words text-left text-xs text-muted-foreground underline decoration-dotted underline-offset-2 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
            className,
          )}
        >
          {causeTitle(failure.code, failure)}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="max-h-[70vh] w-[28rem] max-w-[calc(100vw-2rem)] overflow-y-auto p-0"
      >
        {children}
      </PopoverContent>
    </Popover>
  );
}

/** What went wrong with the login of one IMAP account, and what to do about it. */
export function CredentialFailureExplanation({
  object,
  failure,
}: {
  object: ProtectedObject;
  failure: Failure;
}) {
  const credential = object.credential;
  return (
    <FailureExplanation
      failure={failure}
      message={credential?.error ?? null}
      subject={{ kind: "credential", name: objectTitle(object) }}
      sourceId={object.sourceId}
      at={credential?.checkedAt ?? null}
      className="border-0"
    />
  );
}

/** The cause of a failed login test as a line that opens the full explanation. */
export function CredentialCause({
  object,
  failure,
}: {
  object: ProtectedObject;
  failure: Failure;
}) {
  return (
    <CauseDetails failure={failure}>
      <CredentialFailureExplanation object={object} failure={failure} />
    </CauseDetails>
  );
}
