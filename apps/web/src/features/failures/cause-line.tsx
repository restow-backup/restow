import * as React from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";

import type { Failure, ItemCauseCount } from "./api";
import { textVariables } from "./presenters";

/**
 * The cause of a failure in one short line, for lists and tables: the
 * headline of the cause, with the fuller explanation as its title (hover text). Codes this
 * version has no text for read as "cause could not be identified".
 */

/** The translated headline of a cause code. */
export function useCauseTitle(): (code: string, failure?: Pick<Failure, "params">) => string {
  const { t, i18n } = useTranslation("failures");
  return React.useCallback(
    (code, failure) => {
      const known = i18n.exists(`failures:cause.${code}.title`);
      return t(`cause.${known ? code : "unknown"}.title`, textVariables(failure ?? { params: {} }));
    },
    [t, i18n],
  );
}

export function CauseLine({
  failure,
  className,
}: {
  failure: Failure;
  className?: string;
}) {
  const { t, i18n } = useTranslation("failures");
  const code = i18n.exists(`failures:cause.${failure.code}.title`) ? failure.code : "unknown";
  const variables = textVariables(failure);
  return (
    <span
      className={cn("break-words text-xs text-muted-foreground", className)}
      data-cause={failure.code}
      title={t(`cause.${code}.why`, variables)}
    >
      {t(`cause.${code}.title`, variables)}
    </span>
  );
}

/**
 * The causes behind the failed items of a finished job: "12 items: The item is
 * too large. 2 items: ...". Codes stand alone here, without parameters.
 */
export function ItemCauseLines({
  causes,
  className,
}: {
  causes: readonly ItemCauseCount[];
  className?: string;
}) {
  const { t } = useTranslation("failures");
  const title = useCauseTitle();
  if (causes.length === 0) {
    return null;
  }
  return (
    <ul className={cn("space-y-0.5 text-xs text-muted-foreground", className)}>
      {causes.map((cause) => (
        <li key={cause.code} data-cause={cause.code}>
          {t("what.itemGroup", { count: cause.count })}: {title(cause.code)}
        </li>
      ))}
    </ul>
  );
}
