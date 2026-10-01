import { ChevronDown, TriangleAlert } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { StatusBadge } from "@/components/kit";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { FailureExplanation, useCauseTitle } from "@/features/failures";

import type { Attention, EndpointDetail, EndpointProblem } from "../api.js";
import { attentionMessage, attentionTone, isKnownAttention, sortAttention } from "../presenters.js";

/** A problem of the machine: one line when closed, the full explanation when open. */
function ProblemEntry({
  problem,
  defaultOpen,
}: { problem: EndpointProblem; defaultOpen: boolean }) {
  const { t } = useTranslation("endpoints");
  const causeTitle = useCauseTitle();
  const [open, setOpen] = React.useState(defaultOpen);
  const tone = attentionTone(problem.attention);
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      data-attention={problem.attention}
      className="rounded-lg border bg-card"
    >
      <CollapsibleTrigger className="group flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
        <StatusBadge tone={tone} icon={TriangleAlert} className="shrink-0 whitespace-nowrap">
          {t(`attention.${problem.attention}.label`)}
        </StatusBadge>
        <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
          {causeTitle(problem.failure.code, problem.failure)}
        </span>
        <ChevronDown
          aria-hidden="true"
          className="size-4 shrink-0 transition-transform group-data-[state=open]:rotate-180"
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="px-3 pb-3">
        <FailureExplanation
          failure={problem.failure}
          subject={{ kind: "none" }}
          hideWhat
          tone={tone === "destructive" ? "destructive" : "warning"}
        />
      </CollapsibleContent>
    </Collapsible>
  );
}

/** The plain sentence for a reason the server gives no explanation for (a machine that never connected). */
function PlainAlert({ detail, item }: { detail: EndpointDetail; item: Attention }) {
  const { t } = useTranslation("endpoints");
  const message = attentionMessage(item, detail.settings);
  return (
    <Alert
      variant={attentionTone(item) === "destructive" ? "destructive" : "warning"}
      data-attention={item}
    >
      <TriangleAlert />
      <AlertDescription>
        <p className="font-medium text-foreground">{t(`attention.${item}.label`)}</p>
        <p>{t(message.key, message.values)}</p>
      </AlertDescription>
    </Alert>
  );
}

/**
 * What an admin should look at first, heaviest first. Every reason the server
 * explains (`problems`) shows with the shared failure explanation: what
 * happened, why, what to do. The others (and an older server without
 * explanations) show a plain sentence.
 */
export function AttentionArea({ detail }: { detail: EndpointDetail }) {
  if (detail.status !== "active") {
    return null;
  }
  const attention = sortAttention(detail.attention.filter(isKnownAttention));
  if (attention.length === 0) {
    return null;
  }
  return (
    <div className="space-y-2" data-slot="attention-alerts">
      {attention.map((item, index) => {
        const problem = (detail.problems ?? []).find((entry) => entry.attention === item);
        return problem ? (
          <ProblemEntry key={item} problem={problem} defaultOpen={index === 0} />
        ) : (
          <PlainAlert key={item} detail={detail} item={item} />
        );
      })}
    </div>
  );
}
