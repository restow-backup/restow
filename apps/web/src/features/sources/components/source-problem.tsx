import { TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { FailureExplanation } from "@/features/failures";
import { describeSourceProblem } from "../presenters";
import type { SourceDto } from "../types";

/**
 * Why a source is in error, above its connection cards: what happened, why
 * and what to do when the server classified the cause. A source whose error
 * was recorded before causes were kept still shows the recorded message, in
 * the old alert. The check panels below keep their own details (permission
 * checklist, server words); this is the one place that explains.
 */
export function SourceProblem({ source }: { source: SourceDto }) {
  const { t } = useTranslation("sources");
  const problem = describeSourceProblem(source);
  if (!problem) {
    return null;
  }
  if (problem.kind === "classified") {
    return (
      <FailureExplanation
        failure={problem.failure}
        message={problem.message}
        subject={{ kind: "source", name: source.name }}
        sourceId={source.id}
        at={problem.at}
        skipTargets={["source"]}
      />
    );
  }
  return (
    <Alert variant="destructive">
      <TriangleAlert />
      <AlertTitle>{t("detail.syncProblem.title")}</AlertTitle>
      <AlertDescription className="break-words">
        {t("detail.syncProblem.description", { message: problem.message })}
      </AlertDescription>
    </Alert>
  );
}
